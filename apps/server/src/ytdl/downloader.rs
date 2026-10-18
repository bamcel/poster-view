use super::{AppState, HttpError, Job, Settings, cancelled, err, update, validate_settings};
use serde_json::{Value, json};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    process::Command,
};
static INSPECTIONS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
pub(super) fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
pub(super) fn validate_url(raw: &str) -> Result<(), HttpError> {
    let url = reqwest::Url::parse(raw).map_err(err)?;
    if url.scheme() != "https"
        || !matches!(
            url.host_str(),
            Some(
                "youtube.com"
                    | "www.youtube.com"
                    | "m.youtube.com"
                    | "youtu.be"
                    | "www.youtu.be"
                    | "music.youtube.com"
            )
        )
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return Err(err("Use an HTTPS YouTube video, playlist, or channel URL."));
    }
    Ok(())
}
pub(super) fn is_channel_url(url: &str) -> bool {
    reqwest::Url::parse(url).is_ok_and(|u| {
        u.path().starts_with("/@")
            || u.path().starts_with("/channel/")
            || u.path().starts_with("/c/")
            || u.path().starts_with("/user/")
    })
}
fn channel_playlists_url(raw: &str) -> String {
    if !is_channel_url(raw) {
        return raw.into();
    }
    let Ok(mut url) = reqwest::Url::parse(raw) else {
        return raw.into();
    };
    let segments = url
        .path()
        .split('/')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();
    let channel = if segments.first().is_some_and(|s| s.starts_with('@')) {
        segments.first().copied().unwrap_or_default().to_string()
    } else {
        segments
            .iter()
            .take(2)
            .copied()
            .collect::<Vec<_>>()
            .join("/")
    };
    url.set_path(&format!("/{channel}/playlists"));
    url.set_query(None);
    url.set_fragment(None);
    url.to_string()
}
fn isolate(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().process_group(0);
    }
    #[cfg(windows)]
    {
        command.creation_flags(0x0800_0000);
    }
}
// Dropping an inspection future or cancelling a download also stops extractor
// JavaScript and FFmpeg descendants, not just the yt-dlp parent.
struct ProcessTree(Option<u32>);
impl Drop for ProcessTree {
    fn drop(&mut self) {
        let Some(id) = self.0 else {
            return;
        };
        #[cfg(unix)]
        {
            use nix::{
                sys::signal::{Signal, killpg},
                unistd::Pid,
            };
            if let Ok(pid) = i32::try_from(id) {
                let _ = killpg(Pid::from_raw(pid), Signal::SIGKILL);
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &id.to_string(), "/T", "/F"])
                .creation_flags(0x0800_0000)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }
}
fn base() -> Command {
    let mut command = Command::new("yt-dlp");
    command.args([
        "--ignore-config",
        "--use-extractors",
        "youtube.*",
        "--js-runtimes",
        "node",
        "--no-remote-components",
        "--no-plugin-dirs",
        "--no-warnings",
        "--no-color",
        "--socket-timeout",
        "30",
        "--retries",
        "3",
        "--extractor-retries",
        "3",
    ]);
    command.kill_on_drop(true);
    command
}
async fn output(mut command: Command, timeout: Duration) -> Result<Vec<u8>, HttpError> {
    isolate(&mut command);
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(err)?;
    let mut tree = ProcessTree(child.id());
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| err("Metadata output unavailable."))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| err("Metadata diagnostics unavailable."))?;
    let result = tokio::time::timeout(timeout, async {
        let (bytes, diagnostics) = tokio::try_join!(
            bounded_read(stdout, 32 * 1024 * 1024, false),
            bounded_read(stderr, 20000, true)
        )?;
        let status = child.wait().await.map_err(err)?;
        if !status.success() {
            return Err(err(String::from_utf8_lossy(&diagnostics)
                .chars()
                .take(2000)
                .collect::<String>()));
        }
        Ok(bytes)
    })
    .await
    .map_err(|_| err("Downloader timed out."))?;
    if result.is_ok() {
        tree.0 = None;
    }
    result
}
async fn bounded_read<R: tokio::io::AsyncRead + Unpin>(
    mut reader: R,
    limit: usize,
    truncate: bool,
) -> Result<Vec<u8>, HttpError> {
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 8192];
    loop {
        let size = reader.read(&mut chunk).await.map_err(err)?;
        if size == 0 {
            return Ok(bytes);
        }
        let keep = size.min(limit.saturating_sub(bytes.len()));
        bytes.extend_from_slice(&chunk[..keep]);
        if keep < size && !truncate {
            return Err(err("Metadata response exceeds the size limit."));
        }
    }
}
async fn raw_inspect(state: &AppState, url: &str) -> Result<Value, HttpError> {
    validate_url(url)?;
    let normalized = channel_playlists_url(url);
    raw_inspect_direct(state, &normalized).await
}
async fn raw_inspect_direct(state: &AppState, url: &str) -> Result<Value, HttpError> {
    validate_url(url)?;
    let _permit = INSPECTIONS.acquire().await.map_err(err)?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(180);
    let mut cookies = None;
    loop {
        let mut command = base();
        if let Some(file) = &cookies {
            let file: &tempfile::NamedTempFile = file;
            command.arg("--cookies").arg(file.path());
        }
        command.args([
            "--dump-single-json",
            "--skip-download",
            "--flat-playlist",
            "--playlist-end",
            "10000",
            "--",
            url,
        ]);
        let result = output(
            command,
            deadline.saturating_duration_since(tokio::time::Instant::now()),
        )
        .await;
        match result {
            Ok(bytes) => {
                return serde_json::from_slice(&bytes).map_err(|error| {
                    if cookies.is_some() {
                        err(super::cookies::redact(&error.to_string()))
                    } else {
                        err(error)
                    }
                });
            }
            Err(error)
                if cookies.is_none() && super::cookies::authentication_required(&error.detail) =>
            {
                cookies = super::cookies::request_file(state).await?;
                if cookies.is_none() {
                    return Err(error);
                }
            }
            Err(error) if cookies.is_some() => {
                return Err(err(super::cookies::redact(&error.detail)));
            }
            Err(error) => return Err(error),
        }
    }
}
pub(super) fn text(v: &Value, key: &str) -> String {
    v[key].as_str().unwrap_or_default().to_string()
}
fn entry(v: &Value, parent: &Value, index: usize) -> Value {
    let id = text(v, "id");
    let extracted = text(v, "url");
    let webpage = text(v, "webpage_url");
    let url = if validate_url(&extracted).is_ok() {
        extracted
    } else if validate_url(&webpage).is_ok() {
        webpage
    } else {
        format!("https://www.youtube.com/watch?v={id}")
    };
    let kind = if v["_type"].as_str() == Some("playlist") || url.contains("/playlist?") {
        "playlist"
    } else {
        "video"
    };
    json!({"id":id,"url":url,"kind":kind,"title":text(v,"title"),"description":text(v,"description"),"channel":text(v,"channel"),"channel_id":text(v,"channel_id"),"upload_date":text(v,"upload_date"),"duration":v["duration"],"thumbnail":v["thumbnail"],"playlist_id":text(parent,"id"),"playlist_title":text(parent,"title"),"playlist_index":v["playlist_index"].as_u64().unwrap_or((index+1) as u64)})
}
pub(super) async fn inspect(state: &AppState, url: &str) -> Result<Value, HttpError> {
    let v = raw_inspect(state, url).await?;
    Ok(inspection_value(&v, url, false))
}
pub(super) async fn inspect_channel_videos(
    state: &AppState,
    url: &str,
) -> Result<Value, HttpError> {
    validate_url(url)?;
    if !is_channel_url(url) {
        return Err(err("Choose a channel URL."));
    }
    let mut normalized = reqwest::Url::parse(&channel_playlists_url(url)).map_err(err)?;
    let path = normalized.path().trim_end_matches("/playlists").to_string();
    normalized.set_path(&format!("{path}/videos"));
    let v = raw_inspect_direct(state, normalized.as_str()).await?;
    Ok(inspection_value(&v, url, true))
}
fn inspection_value(v: &Value, url: &str, channel_uploads: bool) -> Value {
    let playlist = v["entries"].as_array();
    let entries = match playlist {
        Some(entries) => entries
            .iter()
            .enumerate()
            .filter(|(_, v)| valid_id(&text(v, "id")))
            .map(|(i, e)| entry(e, if channel_uploads { &Value::Null } else { v }, i))
            .collect::<Vec<_>>(),
        None => vec![entry(v, &Value::Null, 0)],
    };
    let formats=v["formats"].as_array().map(|fs|fs.iter().map(|f|json!({"format_id":f["format_id"],"height":f["height"],"fps":f["fps"],"vcodec":f["vcodec"],"acodec":f["acodec"],"ext":f["ext"]})).collect::<Vec<_>>()).unwrap_or_default();
    json!({"id":v["id"],"title":v["title"],"description":v["description"],"channel":v["channel"],"channel_id":v["channel_id"],"kind":if is_channel_url(url){"channel"}else if playlist.is_some(){"playlist"}else{"video"},"entries":entries,"formats":formats})
}
pub(super) async fn await_cancel(state: &AppState, job: &Job) {
    loop {
        if cancelled(state, &job.id).await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}
pub(super) async fn job_raw_inspect(
    state: &AppState,
    job: &Job,
    url: &str,
) -> Result<Value, HttpError> {
    tokio::select! {result=raw_inspect(state,url)=>result,_=await_cancel(state,job)=>Err(err("Download cancelled."))}
}
pub(super) async fn dependencies() -> Value {
    async fn version(program: &str, arg: &str) -> Option<String> {
        let mut c = Command::new(program);
        c.arg(arg).kill_on_drop(true);
        tokio::time::timeout(Duration::from_secs(5), c.output())
            .await
            .ok()?
            .ok()
            .filter(|o| o.status.success())
            .map(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .next()
                    .unwrap_or_default()
                    .to_string()
            })
    }
    let (yt, ff, js) = tokio::join!(
        version("yt-dlp", "--version"),
        version("ffmpeg", "-version"),
        version("node", "--version")
    );
    json!({"yt_dlp":yt,"ffmpeg":ff,"js_runtime":js})
}
pub(super) fn format(s: &Settings) -> String {
    let limits = match s.quality {
        None => format!("[height<={}][fps<=?{}]", s.max_height, s.max_fps),
        Some(0) => format!("[fps<=?{}]", s.max_fps),
        Some(height) => format!("[height={height}][fps<=?{}]", s.max_fps),
    };
    let compatibility_video = if !s.convert && s.container == "webm" {
        "[vcodec~='^(vp9|vp09|av01)']"
    } else {
        ""
    };
    let compatibility_audio = if !s.convert && s.container == "webm" {
        "[acodec=opus]"
    } else {
        ""
    };
    let video = if s.convert || s.video_codec == "auto" {
        String::new()
    } else if s.quality.is_some() && s.video_codec == "h264" {
        "[vcodec~='^(avc1|h264)']".into()
    } else if s.quality.is_some() && s.video_codec == "vp9" {
        "[vcodec~='^(vp9|vp09)']".into()
    } else if s.quality.is_some() && s.video_codec == "av1" {
        "[vcodec~='^(av01|av1)']".into()
    } else if s.video_codec == "hevc" {
        "[vcodec~='^(hev1|hvc1|hevc|h265)']".into()
    } else {
        format!(
            "[vcodec^={}]",
            match s.video_codec.as_str() {
                "h264" => "avc1",
                "vp9" => "vp9",
                _ => "av01",
            }
        )
    };
    let audio = if s.convert || s.audio_codec == "auto" {
        String::new()
    } else if s.quality.is_some() && s.audio_codec == "aac" {
        "[acodec~='^(mp4a|aac)']".into()
    } else {
        format!(
            "[acodec^={}]",
            if s.audio_codec == "aac" {
                "mp4a"
            } else {
                "opus"
            }
        )
    };
    let selected = format!(
        "bv{limits}{video}{compatibility_video}+ba{audio}{compatibility_audio}/b{limits}{video}{audio}{compatibility_video}{compatibility_audio}"
    );
    if s.fallback == "best" && s.quality.is_none() {
        format!(
            "{selected}/bv{limits}{compatibility_video}+ba{compatibility_audio}/b{limits}{compatibility_video}{compatibility_audio}"
        )
    } else {
        selected
    }
}
#[derive(Debug, PartialEq)]
enum QualityChoice {
    Legacy,
    Height(u32),
    Skip(String),
}
fn codec_matches(codec: &str, preference: &str, video: bool) -> bool {
    if preference == "auto" {
        return true;
    }
    let prefixes: &[&str] = match (preference, video) {
        ("h264", true) => &["avc1", "h264"],
        ("hevc", true) => &["hev1", "hvc1", "hevc", "h265"],
        ("vp9", true) => &["vp9", "vp09"],
        ("av1", true) => &["av01", "av1"],
        ("aac", false) => &["mp4a", "aac"],
        ("opus", false) => &["opus"],
        _ => &[],
    };
    prefixes.iter().any(|p| codec.starts_with(p))
}
fn source_codec_allowed(s: &Settings, codec: &str, video: bool) -> bool {
    if codec.is_empty() || codec == "none" {
        return false;
    }
    if s.convert {
        return true;
    }
    if s.container == "webm"
        && if video {
            !codec_matches(codec, "vp9", true) && !codec_matches(codec, "av1", true)
        } else {
            !codec_matches(codec, "opus", false)
        }
    {
        return false;
    }
    codec_matches(
        codec,
        if video {
            &s.video_codec
        } else {
            &s.audio_codec
        },
        video,
    )
}
fn choose_quality(s: &Settings, info: &Value) -> QualityChoice {
    let Some(requested) = s.quality else {
        return QualityChoice::Legacy;
    };
    let formats = info["formats"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let has_audio = formats.iter().any(|f| {
        f["vcodec"].as_str() == Some("none")
            && source_codec_allowed(s, f["acodec"].as_str().unwrap_or("none"), false)
    });
    let mut heights = formats
        .iter()
        .filter(|f| {
            source_codec_allowed(s, f["vcodec"].as_str().unwrap_or("none"), true)
                && f["fps"]
                    .as_f64()
                    .is_none_or(|fps| fps <= f64::from(s.max_fps))
                && (source_codec_allowed(s, f["acodec"].as_str().unwrap_or("none"), false)
                    || (has_audio && f["acodec"].as_str() == Some("none")))
        })
        .filter_map(|f| {
            f["height"]
                .as_u64()
                .and_then(|h| u32::try_from(h).ok())
                .filter(|h| *h > 0)
        })
        .collect::<Vec<_>>();
    heights.sort_unstable();
    heights.dedup();
    let height = if requested == 0 {
        heights.last().copied()
    } else if heights.contains(&requested) {
        Some(requested)
    } else {
        match s.fallback.as_str() {
            "highest" => heights.last().copied(),
            "next_highest" => heights.iter().copied().find(|h| *h > requested),
            "next_lowest" => heights.iter().copied().rev().find(|h| *h < requested),
            "best" => heights.iter().copied().rev().find(|h| *h < requested),
            _ => None,
        }
    };
    height.map(QualityChoice::Height).unwrap_or_else(||QualityChoice::Skip(format!("{}: requested {} quality is unavailable with the selected codec, container, and frame rate",text(info,"id"),if requested==0{"highest".into()}else{format!("{requested}p")})))
}
pub(super) fn conversion_args(s: &Settings, input: &Path, output: &Path) -> Vec<String> {
    let mut args = vec![
        "-nostdin".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-stats_period".into(),
        "1".into(),
        "-nostats".into(),
        "-n".into(),
    ];
    match s.hardware_backend.as_str() {
        "qsv" => args.extend([
            "-init_hw_device".into(),
            "qsv=qs".into(),
            "-filter_hw_device".into(),
            "qs".into(),
        ]),
        "vaapi" => args.extend(["-vaapi_device".into(), "/dev/dri/renderD128".into()]),
        _ => {}
    }
    let video_encoder = if s.hardware_backend != "cpu" {
        format!("{}_{}", s.video_codec, s.hardware_backend)
    } else {
        match s.video_codec.as_str() {
            "h264" => "libx264",
            "hevc" => "libx265",
            "vp9" => "libvpx-vp9",
            "av1" => "libsvtav1",
            _ if s.container == "webm" => "libvpx-vp9",
            _ => "copy",
        }
        .into()
    };
    args.extend([
        "-i".into(),
        input.to_string_lossy().into(),
        "-map".into(),
        "0:v:0".into(),
        "-map".into(),
        "0:a:0?".into(),
        "-c:v".into(),
        video_encoder,
        "-c:a".into(),
        match s.audio_codec.as_str() {
            "aac" => "aac",
            "opus" => "libopus",
            _ if s.container == "webm" => "libopus",
            _ => "copy",
        }
        .into(),
    ]);
    match s.hardware_backend.as_str() {
        "nvenc" => args.extend([
            "-rc".into(),
            "vbr".into(),
            "-cq".into(),
            s.crf.to_string(),
            "-b:v".into(),
            "0".into(),
        ]),
        "qsv" => args.extend([
            "-global_quality".into(),
            s.crf.to_string(),
            "-vf".into(),
            "format=nv12,hwupload=extra_hw_frames=64".into(),
        ]),
        "vaapi" => args.extend([
            "-qp".into(),
            s.crf.to_string(),
            "-vf".into(),
            "format=nv12,hwupload".into(),
        ]),
        _ => {}
    }
    if s.hardware_backend == "cpu" && (s.video_codec != "auto" || s.container == "webm") {
        args.extend(["-crf".into(), s.crf.to_string()]);
        if s.video_codec == "vp9" || (s.video_codec == "auto" && s.container == "webm") {
            args.extend(["-b:v".into(), "0".into()]);
        }
    }
    args.push(output.to_string_lossy().into());
    args
}
// Streams may restart at zero for audio. Keep the playlist's progress monotonic;
// publication accounts for the last five percent of each video.
pub(super) fn record_stream_progress(job: &mut Job, stream_progress: Option<f64>) {
    if job.total_videos > 0
        && let Some(percent) = stream_progress
    {
        let aggregate = (job.completed_videos as f64
            + percent / 100.0
                * if job.settings.effective().convert {
                    0.5
                } else {
                    0.95
                })
            / job.total_videos as f64
            * 100.0;
        job.progress = Some(job.progress.unwrap_or(0.0).max(aggregate));
    }
}

#[derive(Clone, Default)]
struct EncodingProgress {
    seconds: Option<f64>,
    speed: Option<f64>,
    fps: Option<f64>,
    frame: Option<u64>,
}
impl EncodingProgress {
    fn line(&mut self, line: &str) -> bool {
        let Some((key, value)) = line.split_once('=') else {
            return false;
        };
        let number = || {
            value
                .trim()
                .trim_end_matches('x')
                .parse::<f64>()
                .ok()
                .filter(|n| n.is_finite() && *n >= 0.0)
        };
        match key {
            "out_time_us" => self.seconds = number().map(|n| n / 1_000_000.0),
            "speed" => self.speed = number().filter(|n| *n > 0.0),
            "fps" => self.fps = number(),
            "frame" => self.frame = value.trim().parse().ok(),
            "progress" => return matches!(value, "continue" | "end"),
            _ => {}
        }
        false
    }
    fn record(&self, job: &mut Job, duration: Option<f64>) {
        let duration = duration.filter(|d| d.is_finite() && *d > 0.0);
        if let Some((seconds, duration)) = self.seconds.zip(duration) {
            let percent = (seconds / duration * 100.0).clamp(0.0, 100.0);
            job.encoding_progress = Some(job.encoding_progress.unwrap_or(0.0).max(percent));
            if job.total_videos > 0 {
                let aggregate = (job.completed_videos as f64 + 0.5 + percent / 100.0 * 0.45)
                    / job.total_videos as f64
                    * 100.0;
                job.progress = Some(job.progress.unwrap_or(0.0).max(aggregate));
            }
            job.eta = self
                .speed
                .map(|speed| format!("{:.0}s", (duration - seconds).max(0.0) / speed));
        } else {
            job.eta = None;
        }
        let mut activity = Vec::new();
        if let Some(frame) = self.frame {
            activity.push(format!("frame {frame}"));
        }
        if let Some(seconds) = self.seconds {
            activity.push(format!("{seconds:.1}s encoded"));
        }
        if let Some(fps) = self.fps {
            activity.push(format!("{fps:.1} fps"));
        }
        if let Some(speed) = self.speed {
            activity.push(format!("{speed:.2}x"));
        }
        job.speed = (!activity.is_empty()).then(|| activity.join(" · "));
    }
}

pub(super) async fn video_progress(
    state: &AppState,
    id: &str,
    total: usize,
    completed: usize,
    title: Option<String>,
) -> Result<(), HttpError> {
    let _lock = state.ytdl_lock.lock().await;
    let mut jobs = super::load::<Vec<Job>>(state, "plugin-ytdl-jobs")?;
    if let Some(job) = jobs
        .iter_mut()
        .find(|j| j.id == id && j.status != "cancelled")
    {
        let next_video = job.completed_videos != completed || job.current_video_title.is_none();
        job.total_videos = total;
        job.completed_videos = completed;
        if next_video {
            job.encoding_progress = None;
            job.speed = None;
            job.eta = None;
        }
        job.current_video_title = title;
        job.progress = Some(completed as f64 / total.max(1) as f64 * 100.0);
    }
    super::save(state, "plugin-ytdl-jobs", &jobs)
}

fn progress_flush_due(last: Option<tokio::time::Instant>, now: tokio::time::Instant) -> bool {
    last.is_none_or(|last| now.duration_since(last) >= Duration::from_secs(1))
}

async fn persist_progress(
    state: &AppState,
    id: &str,
    encoding: &EncodingProgress,
    duration: Option<Option<f64>>,
    download: Option<&Value>,
) -> Result<(), HttpError> {
    let guard = state.ytdl_lock.clone().lock_owned().await;
    let state = state.clone();
    let id = id.to_owned();
    let encoding = encoding.clone();
    let download = download.cloned();
    tokio::task::spawn_blocking(move || {
        // Keep the queue lock until the atomic file replacement has settled,
        // including if the async reader is cancelled while this write runs.
        let _guard = guard;
        let mut jobs = super::load::<Vec<Job>>(&state, "plugin-ytdl-jobs")?;
        let Some(job) = jobs.iter_mut().find(|job| {
            job.id == id
                && if duration.is_some() {
                    job.status == "processing"
                } else {
                    job.status == "downloading"
                }
        }) else {
            return Ok(());
        };
        if let Some(duration) = duration {
            encoding.record(job, duration);
        } else if let Some(value) = download {
            let total = value["total_bytes"]
                .as_f64()
                .or_else(|| value["total_bytes_estimate"].as_f64());
            let percent = total.filter(|total| *total > 0.0).and_then(|total| {
                value["downloaded_bytes"]
                    .as_f64()
                    .map(|bytes| (100.0 * bytes / total).clamp(0.0, 100.0))
            });
            record_stream_progress(job, percent);
            job.speed = value["speed"]
                .as_f64()
                .filter(|speed| speed.is_finite() && *speed >= 0.0)
                .map(download_speed);
            job.eta = value["eta"]
                .as_f64()
                .map(|seconds| format!("{seconds:.0}s"));
        }
        super::save(&state, "plugin-ytdl-jobs", &jobs)
    })
    .await
    .map_err(err)?
}

async fn cancellable(
    state: &AppState,
    job: &Job,
    mut command: Command,
    encoding_duration: Option<Option<f64>>,
) -> Result<(), HttpError> {
    if encoding_duration.is_some() {
        let _lock = state.ytdl_lock.lock().await;
        let mut jobs = super::load::<Vec<Job>>(state, "plugin-ytdl-jobs")?;
        if let Some(saved) = jobs
            .iter_mut()
            .find(|j| j.id == job.id && j.status == "processing")
        {
            saved.speed = Some("Starting encoder".into());
            saved.eta = None;
        }
        super::save(state, "plugin-ytdl-jobs", &jobs)?;
    }
    isolate(&mut command);
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(err)?;
    let mut tree = ProcessTree(child.id());
    let stderr = child.stderr.take();
    let reader = tokio::spawn(async move {
        if let Some(stderr) = stderr {
            bounded_read(stderr, 20000, true).await.unwrap_or_default()
        } else {
            Vec::new()
        }
    });
    let progress_state = state.clone();
    let id = job.id.clone();
    let stdout = child.stdout.take();
    let mut progress_reader = Some(tokio::spawn(async move {
        if let Some(stdout) = stdout {
            let mut lines = BufReader::new(stdout).lines();
            let mut encoding = EncodingProgress::default();
            let mut latest_download = None;
            let mut dirty = false;
            let mut last_flush = None;
            while let Some(line) = lines.next_line().await.map_err(err)? {
                let changed = if encoding_duration.is_some() {
                    encoding.line(&line)
                } else if let Some(data) = line.strip_prefix("PVPROGRESS:") {
                    if let Ok(value) = serde_json::from_str::<Value>(data) {
                        latest_download = Some(value);
                        true
                    } else {
                        false
                    }
                } else {
                    false
                };
                dirty |= changed;
                let now = tokio::time::Instant::now();
                if dirty && progress_flush_due(last_flush, now) {
                    persist_progress(
                        &progress_state,
                        &id,
                        &encoding,
                        encoding_duration,
                        latest_download.as_ref(),
                    )
                    .await?;
                    last_flush = Some(now);
                    dirty = false;
                }
            }
            // EOF is a durable boundary even when the final sample arrived
            // inside the coalescing window.
            if dirty {
                persist_progress(
                    &progress_state,
                    &id,
                    &encoding,
                    encoding_duration,
                    latest_download.as_ref(),
                )
                .await?;
            }
        }
        Ok::<_, HttpError>(())
    }));
    let deadline = tokio::time::Instant::now() + Duration::from_secs(24 * 3600);
    loop {
        if progress_reader
            .as_ref()
            .is_some_and(|reader| reader.is_finished())
        {
            let outcome = progress_reader
                .take()
                .unwrap()
                .await
                .map_err(err)
                .and_then(|outcome| outcome);
            if let Err(error) = outcome {
                drop(tree);
                let _ = child.wait().await;
                reader.abort();
                return Err(error);
            }
        }
        if cancelled(state, &job.id).await || tokio::time::Instant::now() > deadline {
            drop(tree);
            let _ = child.wait().await;
            reader.abort();
            if let Some(reader) = progress_reader.take() {
                reader.abort();
            }
            return Err(err("Download cancelled or timed out."));
        }
        if let Some(status) = child.try_wait().map_err(err)? {
            tree.0 = None;
            let message = reader.await.unwrap_or_default();
            if let Some(reader) = progress_reader.take() {
                reader.await.map_err(err)??;
            }
            if status.success() {
                if encoding_duration.is_some() {
                    // Some FFmpeg versions report the last frame's start time,
                    // not the full duration. A successful exit is authoritative.
                    let _lock = state.ytdl_lock.lock().await;
                    let mut jobs = super::load::<Vec<Job>>(state, "plugin-ytdl-jobs")?;
                    if let Some(saved) = jobs
                        .iter_mut()
                        .find(|saved| saved.id == job.id && saved.status == "processing")
                    {
                        saved.encoding_progress = Some(100.0);
                        saved.eta = Some("0s".into());
                        if saved.total_videos > 0 {
                            let aggregate = (saved.completed_videos as f64 + 0.95)
                                / saved.total_videos as f64
                                * 100.0;
                            saved.progress = Some(saved.progress.unwrap_or(0.0).max(aggregate));
                        }
                    }
                    super::save(state, "plugin-ytdl-jobs", &jobs)?;
                }
                return Ok(());
            }
            return Err(err(String::from_utf8_lossy(&message)
                .chars()
                .take(2000)
                .collect::<String>()));
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}
pub(super) async fn run(state: &AppState, job: &Job) -> Result<(), HttpError> {
    if job.metadata_only {
        return super::refresh::run(state, job).await;
    }
    let mut effective_job = job.clone();
    effective_job.settings = job.settings.effective();
    let job = &effective_job;
    if !super::load::<Settings>(state, "plugin-ytdl")?.enabled {
        return Err(err("YTDL plugin is disabled."));
    }
    let destination = validate_settings(state, &job.settings)?;
    let existing_ids = if job.settings.skip_existing {
        super::refresh::local_videos(&destination)?
    } else {
        std::collections::HashSet::new()
    };
    update(state, &job.id, "inspecting", None, None).await?;
    let inspect_source = async {
        if is_channel_url(&job.url) {
            inspect_channel_videos(state, &job.url).await
        } else {
            inspect(state, &job.url).await
        }
    };
    let inspection = tokio::select! {result=inspect_source=>result?,_=await_cancel(state,job)=>return Err(err("Download cancelled."))};
    run_inspection(state, job, &destination, &existing_ids, &inspection).await
}

async fn run_inspection(
    state: &AppState,
    job: &Job,
    destination: &Path,
    existing_ids: &std::collections::HashSet<String>,
    inspection: &Value,
) -> Result<(), HttpError> {
    let metadata_ids = if job.settings.skip_existing_metadata {
        super::refresh::local_metadata(destination)?
    } else {
        std::collections::HashSet::new()
    };
    let mut encoder_validated = false;
    let mut channel_metadata = std::collections::HashMap::new();
    let mut channel_artwork = std::collections::HashSet::new();
    {
        let _lock = state.ytdl_lock.lock().await;
        let mut jobs = super::load::<Vec<Job>>(state, "plugin-ytdl-jobs")?;
        if let Some(saved) = jobs.iter_mut().find(|saved| saved.id == job.id) {
            saved.title = text(inspection, "title");
        }
        super::save(state, "plugin-ytdl-jobs", &jobs)?;
    }
    let entries = inspection["entries"]
        .as_array()
        .ok_or_else(|| err("No videos found."))?;
    let mut seen = std::collections::HashSet::new();
    let selected = entries
        .iter()
        .filter(|e| {
            (job.video_ids.is_empty() || job.video_ids.contains(&text(e, "id")))
                && seen.insert(text(e, "id"))
        })
        .collect::<Vec<_>>();
    if selected.is_empty() {
        return Err(err("No selected videos are available."));
    }
    let stage_root = state.runtime.data_dir().join("ytdl");
    std::fs::create_dir_all(&stage_root).map_err(err)?;

    for (index, e) in selected.iter().enumerate() {
        if cancelled(state, &job.id).await {
            return Err(err("Download cancelled."));
        }
        let id = text(e, "id");
        if !valid_id(&id) {
            return Err(err("Invalid video identity."));
        }
        if existing_ids.contains(&id) || metadata_ids.contains(&id) {
            super::outcome(state, &job.id, e, Ok(super::Outcome::Existing)).await?;
            video_progress(state, &job.id, selected.len(), index + 1, None).await?;
            continue;
        }
        let url = format!("https://www.youtube.com/watch?v={id}");
        video_progress(
            state,
            &job.id,
            selected.len(),
            index,
            Some(text(e, "title")),
        )
        .await?;
        let result: Result<super::Outcome, HttpError> = async {
            let info = job_raw_inspect(state, job, &url).await?;
            video_progress(
                state,
                &job.id,
                selected.len(),
                index,
                Some(text(&info, "title")),
            )
            .await?;
            let channel = text(&info, "channel_id");
            if !valid_id(&channel) {
                return Err(err("Video has no stable channel ID."));
            }
            if !channel_metadata.contains_key(&channel) {
                let data = job_raw_inspect(
                    state,
                    job,
                    &format!("https://www.youtube.com/channel/{channel}/playlists"),
                )
                .await?;
                channel_metadata.insert(channel.clone(), data);
            }
            let channel_info = channel_metadata
                .get(&channel)
                .ok_or_else(|| err("Channel metadata unavailable."))?;
            let (channel_folder, video_folder) = super::naming::folder_names(
                destination,
                &channel,
                &id,
                &text(&info, "channel"),
                &text(&info, "title"),
            )?;
            let channel_relative = channel_folder.clone();
            let mut folder = job.settings.directory.clone();
            for part in [channel_folder.as_str(), video_folder.as_str()] {
                let parent = state.metadata.directory(&folder, true)?;
                let next = parent.join(part);
                if !next.exists() {
                    std::fs::create_dir(&next).map_err(err)?;
                }
                folder = if folder.is_empty() {
                    part.into()
                } else {
                    format!("{folder}/{part}")
                };
                state.metadata.directory(&folder, false)?;
            }
            // Revalidate every component to reject linked folders introduced after configuration.
            let relative = format!(
                "{}{channel_relative}/{video_folder}",
                if job.settings.directory.is_empty() {
                    String::new()
                } else {
                    format!("{}/", job.settings.directory)
                }
            );
            let target = state.metadata.directory(&relative, false)?;
            if channel_artwork.insert(channel.clone()) {
                super::artwork::download(target.parent().ok_or_else(|| err("Missing channel directory."))?, channel_info).await?;
            }
            let existing = super::naming::existing_media(&target)?;
            let preserve_metadata = job.settings.skip_existing_metadata
                && super::naming::video_identity(&target)?.is_some();
            let stem = if let Some(media) = &existing {
                media
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .ok_or_else(|| err("Existing video filename is not valid UTF-8."))?
                    .to_string()
            } else {
                super::naming::stem(&info, &job.settings.filename_convention)?
            };
            let media = target.join(format!("{stem}.{}", job.settings.container));
            // Reserve stable identities before staging so retries reuse readable folders
            // even if titles change or a previous download did not finish publishing.
            if !preserve_metadata {
                super::nfo::write_named(&target, &stem, &info, e, inspection, channel_info)?;
            }
            if existing.is_none() {
                if !encoder_validated && job.settings.convert && job.settings.hardware_backend != "cpu"
                {
                    crate::playback::validate_download_encoder(
                        state,
                        &job.settings.video_codec,
                        &job.settings.hardware_backend,
                    )
                    .await?;
                    encoder_validated = true;
                }
                let mut download_settings = job.settings.clone();
                match choose_quality(&job.settings, &info) {
                    QualityChoice::Legacy => {}
                    QualityChoice::Height(height) => download_settings.quality = Some(height),
                    QualityChoice::Skip(reason) => {
                        let _ = reason;
                        return Ok(super::Outcome::Skipped);
                    }
                }
                let stage = tempfile::tempdir_in(&stage_root).map_err(err)?;
                update(
                    state,
                    &job.id,
                    "downloading",
                    None,
                    Some(index as f64 / selected.len() as f64 * 100.0),
                )
                .await?;
                let template = stage.path().join(format!("{id}.%(ext)s"));
                let download_container = if job.settings.convert {
                    "mkv"
                } else {
                    job.settings.container.as_str()
                };
                let mut cookies = None;
                let mut stream_retry = false;
                loop {
                    let mut command = base();
                    command.arg("--check-formats");
                    if let Some(file) = &cookies {
                        let file: &tempfile::NamedTempFile = file;
                        command.arg("--cookies").arg(file.path());
                    }
                    command.args([
                        "--newline",
                        "--progress",
                        "--progress-delta",
                        "1",
                        "--progress-template",
                        "download:PVPROGRESS:%(progress)j",
                    ]);
                    command
                        .args([
                            "--no-playlist",
                            "--no-overwrites",
                            "--format",
                            &format(&download_settings),
                            "--merge-output-format",
                            download_container,
                            "--remux-video",
                            download_container,
                            "--output",
                        ])
                        .arg(&template);
                    if job.settings.thumbnail {
                        command.args(["--write-thumbnail", "--convert-thumbnails", "jpg"]);
                    }
                    if job.settings.subtitles {
                        command.args([
                            "--write-subs",
                            "--sub-langs",
                            &job.settings.subtitle_languages.join(","),
                        ]);
                    }
                    if job.settings.chapters {
                        command.arg("--embed-chapters");
                    }
                    command.args(["--", &url]);
                    match cancellable(state, job, command, None).await {
                        Ok(()) => break,
                        Err(error) if cookies.is_some() => {
                            return Err(err(super::cookies::redact(&error.detail)));
                        }
                        Err(error) if super::cookies::authentication_required(&error.detail) => {
                            cookies = super::cookies::request_file(state).await?;
                            if cookies.is_none() { return Err(error); }
                        }
                        Err(error) if media_forbidden(&error.detail) && !stream_retry => {
                            stream_retry = true;
                            if cancelled(state, &job.id).await {
                                return Err(err("Download cancelled."));
                            }
                            // Re-run extraction instead of retrying the same rejected signed URL.
                            tokio::time::sleep(Duration::from_secs(3)).await;
                        }
                        Err(error) if media_forbidden(&error.detail) => {
                            return Err(err(format!(
                                "YouTube rejected the video stream (HTTP 403) after a fresh extraction retry. Completed videos are kept. This can require an updated yt-dlp or YouTube access verification. Details: {}",
                                error.detail
                            )));
                        }
                        Err(error) => return Err(error),
                    }
                }
                let source = stage.path().join(format!("{id}.{download_container}"));
                let source = if job.settings.convert {
                    update(state, &job.id, "processing", None, None).await?;
                    let converted = stage
                        .path()
                        .join(format!("converted.{}", job.settings.container));
                    let mut ff = Command::new("ffmpeg");
                    ff.args(conversion_args(&job.settings, &source, &converted));
                    cancellable(state, job, ff, Some(info["duration"].as_f64())).await?;
                    converted
                } else {
                    source
                };
                if cancelled(state, &job.id).await {
                    return Err(err("Download cancelled."));
                }
                for file in std::fs::read_dir(stage.path()).map_err(err)? {
                    let file = file.map_err(err)?;
                    let name = file.file_name();
                    let name = name.to_string_lossy();
                    if let Some(name) = super::naming::sidecar_name(&name, &id, &stem) {
                        publish(&file.path(), &target.join(name))?;
                    }
                }
                if !preserve_metadata {
                    super::nfo::write_named(&target, &stem, &info, e, inspection, channel_info)?;
                }
                if cancelled(state, &job.id).await {
                    return Err(err("Download cancelled."));
                }
                publish_with_modified(&source, &media, upload_modified_time(&info))?;
            }

            if !preserve_metadata {
                super::nfo::write_named(&target, &stem, &info, e, inspection, channel_info)?;
            }
            if existing.is_none() {
                set_video_folder_modified(&target, upload_modified_time(&info))?;
            }
            Ok(if existing.is_some() { super::Outcome::Updated } else { super::Outcome::Downloaded })
        }
        .await;
        match result {
            Err(error) if !upstream_failure(&error.detail) => return Err(error),
            result => super::outcome(state, &job.id, e, result).await?,
        }
        video_progress(state, &job.id, selected.len(), index + 1, None).await?;
    }
    super::finish(state, &job.id).await
}
pub(super) fn upstream_failure(detail: &str) -> bool {
    let lower = detail.to_ascii_lowercase();
    if [
        "permission denied",
        "no space left",
        "download cancelled",
        "metadata refresh cancelled",
        "gpu encoder",
    ]
    .iter()
    .any(|message| lower.contains(message))
    {
        return false;
    }
    [
        "http error",
        "sign in",
        "sign-in",
        "cookies",
        "age-restricted",
        "age restricted",
        "private video",
        "requested format is not available",
        "video has been removed",
        "join this channel",
        "video unavailable",
        "video is unavailable",
        "removed by",
        "members-only",
        "not available in your country",
        "youtube rejected the video stream",
    ]
    .iter()
    .any(|message| lower.contains(message))
}

fn media_forbidden(detail: &str) -> bool {
    detail.contains("unable to download video data") && detail.contains("HTTP Error 403")
}
fn download_speed(bytes_per_second: f64) -> String {
    if bytes_per_second >= 1_000_000.0 {
        format!("{:.1} MB/s", bytes_per_second / 1_000_000.0)
    } else {
        format!("{:.1} KB/s", bytes_per_second / 1_000.0)
    }
}
fn upload_modified_time(info: &Value) -> Option<std::time::SystemTime> {
    info["timestamp"]
        .as_i64()
        .or_else(|| info["release_timestamp"].as_i64())
        .and_then(|stamp| chrono::DateTime::from_timestamp(stamp, 0))
        .or_else(|| {
            info["upload_date"]
                .as_str()
                .and_then(|date| chrono::NaiveDate::parse_from_str(date, "%Y%m%d").ok())
                .and_then(|date| date.and_hms_opt(0, 0, 0))
                .map(|date| date.and_utc())
        })
        .map(Into::into)
}
// Apply only after the final sidecar write: creating/replacing children updates
// the directory timestamp independently of the media file's timestamp.
fn set_video_folder_modified(
    directory: &Path,
    modified: Option<std::time::SystemTime>,
) -> Result<(), HttpError> {
    let Some(modified) = modified else {
        return Ok(());
    };
    #[cfg(windows)]
    let folder = {
        use std::os::windows::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .access_mode(0x100) // FILE_WRITE_ATTRIBUTES
            .custom_flags(0x02000000) // FILE_FLAG_BACKUP_SEMANTICS permits directories
            .open(directory)
            .map_err(err)?
    };
    #[cfg(not(windows))]
    let folder = std::fs::File::open(directory).map_err(err)?;
    folder
        .set_times(std::fs::FileTimes::new().set_modified(modified))
        .map_err(err)
}
fn publish(source: &Path, target: &Path) -> Result<(), HttpError> {
    publish_with_modified(source, target, None)
}
fn publish_with_modified(
    source: &Path,
    target: &Path,
    modified: Option<std::time::SystemTime>,
) -> Result<(), HttpError> {
    if target.exists() {
        return Ok(());
    }
    let parent = target.parent().ok_or_else(|| err("Missing destination."))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(err)?;
    std::io::copy(
        &mut std::fs::File::open(source).map_err(err)?,
        &mut temporary,
    )
    .map_err(err)?;
    if let Some(modified) = modified {
        temporary
            .as_file()
            .set_times(std::fs::FileTimes::new().set_modified(modified))
            .map_err(err)?;
    }
    temporary.as_file().sync_all().map_err(err)?;
    match temporary.persist_noclobber(target) {
        Ok(_) => Ok(()),
        Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(err(e.error)),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_upstream_restrictions_are_recoverable_per_video() {
        for message in [
            "ERROR: Sign in to confirm your age. Use --cookies",
            "HTTP Error 403: Forbidden",
            "Private video",
            "Video unavailable",
        ] {
            assert!(upstream_failure(message));
        }
        for message in [
            "Download cancelled.",
            "Permission denied",
            "Permission denied: /media/cookies/Private video.mp4",
            "No space left on device",
            "The selected GPU encoder is unavailable.",
            "Invalid download mode.",
        ] {
            assert!(!upstream_failure(message));
        }
    }
    #[test]
    fn only_media_403_triggers_fresh_extraction_retry() {
        assert!(media_forbidden(
            "ERROR: unable to download video data: HTTP Error 403: Forbidden"
        ));
        assert!(!media_forbidden(
            "ERROR: HTTP Error 403: Forbidden downloading subtitles"
        ));
        assert!(!media_forbidden("Download cancelled."));
        assert!(!media_forbidden(
            "ERROR: unable to download video data: HTTP Error 404"
        ));
    }
    #[test]
    fn download_speed_uses_readable_decimal_units() {
        assert_eq!(download_speed(42_955.3 * 1024.0), "44.0 MB/s");
        assert_eq!(download_speed(1_000_000.0), "1.0 MB/s");
        assert_eq!(download_speed(512_000.0), "512.0 KB/s");
        assert_eq!(download_speed(0.0), "0.0 KB/s");
    }
    fn progress_fixture() -> Job {
        Job {
            id: "progress-fixture".into(),
            url: String::new(),
            title: String::new(),
            status: "processing".into(),
            progress: None,
            total_videos: 7,
            completed_videos: 1,
            downloaded_videos: 0,
            existing_videos: 0,
            updated_videos: 0,
            skipped_videos: 0,
            failed_videos: 0,
            failed_entries: Vec::new(),
            current_video_title: None,
            speed: None,
            eta: None,
            error: None,
            created_at: String::new(),
            settings: Settings {
                convert: true,
                ..Default::default()
            },
            finished_at: None,
            encoding_progress: None,
            video_ids: vec![],
            metadata_only: false,
        }
    }
    #[tokio::test]
    async fn skip_existing_bypasses_per_video_inspection_quality_and_encoding() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        let destination = temp.path().join("media/downloads");
        let video = destination.join("UCfixture/fixture");
        std::fs::create_dir_all(&video).unwrap();
        let nfo = "<episodedetails><title>Keep title</title><youtube><video_id>fixture</video_id></youtube></episodedetails>";
        std::fs::write(video.join("low-quality.nfo"), nfo).unwrap();
        std::fs::write(video.join("low-quality.mp4"), b"existing 480p video").unwrap();
        let mut job = progress_fixture();
        job.settings.skip_existing = true;
        job.settings.quality = Some(2160);
        job.settings.hardware_backend = "unavailable-encoder".into();
        job.settings.convert = true;
        super::super::save(&state, "plugin-ytdl-jobs", &vec![job.clone()]).unwrap();
        let index = super::super::refresh::local_videos(&destination).unwrap();
        // This inspected playlist entry has no usable full video metadata. If the
        // skip is late, the worker would try yt-dlp/encoding and this fixture fails.
        run_inspection(
            &state,
            &job,
            &destination,
            &index,
            &json!({"title":"Fixture playlist", "entries":[{"id":"fixture", "title":"New title"}]}),
        )
        .await
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(video.join("low-quality.nfo")).unwrap(),
            nfo
        );
        assert_eq!(
            std::fs::read(video.join("low-quality.mp4")).unwrap(),
            b"existing 480p video"
        );
        assert_eq!(std::fs::read_dir(video).unwrap().count(), 2);
        let saved = super::super::load::<Vec<Job>>(&state, "plugin-ytdl-jobs").unwrap();
        assert_eq!(saved[0].completed_videos, 1);
        assert_eq!(saved[0].status, "completed");
    }
    #[tokio::test]
    async fn existing_metadata_skips_individual_extraction_without_skip_existing_videos() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        let destination = temp.path().join("media/downloads");
        let video = destination.join("Channel/Video");
        std::fs::create_dir_all(&video).unwrap();
        let nfo = "<episodedetails><title>Keep custom title</title><youtube><video_id>fixture</video_id></youtube></episodedetails>";
        std::fs::write(video.join("video.nfo"), nfo).unwrap();
        std::fs::write(video.join("video.mp4"), b"video").unwrap();
        let mut job = progress_fixture();
        job.settings.skip_existing = false;
        job.settings.skip_existing_metadata = true;
        super::super::save(&state, "plugin-ytdl-jobs", &vec![job.clone()]).unwrap();
        run_inspection(
            &state,
            &job,
            &destination,
            &Default::default(),
            &json!({"entries":[{"id":"fixture", "title":"Changed remote title"}]}),
        )
        .await
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(video.join("video.nfo")).unwrap(),
            nfo
        );
        let saved: Vec<Job> = super::super::load(&state, "plugin-ytdl-jobs").unwrap();
        assert_eq!(saved[0].existing_videos, 1);
        assert_eq!(saved[0].status, "completed");
    }
    #[test]
    fn encoding_progress_parses_batches_and_aggregates_without_regression() {
        let mut progress = EncodingProgress::default();
        for line in [
            "frame=1500",
            "fps=30.0",
            "out_time_us=50000000",
            "speed=2.0x",
        ] {
            assert!(!progress.line(line));
        }
        assert!(progress.line("progress=continue"));
        let mut job = progress_fixture();
        record_stream_progress(&mut job, Some(100.0));
        assert!((job.progress.unwrap() - 150.0 / 7.0).abs() < 0.001);
        progress.record(&mut job, Some(100.0));
        assert_eq!(job.encoding_progress, Some(50.0));
        assert_eq!(job.eta.as_deref(), Some("25s"));
        assert!(job.speed.as_ref().unwrap().contains("30.0 fps"));
        let aggregate = job.progress.unwrap();
        assert!((aggregate - 172.5 / 7.0).abs() < 0.001);
        progress.line("out_time_us=10000000");
        progress.record(&mut job, Some(100.0));
        assert_eq!(job.encoding_progress, Some(50.0));
        assert_eq!(job.progress, Some(aggregate));
        progress.line("out_time_us=110000000");
        assert!(progress.line("progress=end"));
        progress.record(&mut job, Some(100.0));
        assert_eq!(job.encoding_progress, Some(100.0));
        assert!((job.progress.unwrap() - 195.0 / 7.0).abs() < 0.001);
    }
    #[test]
    fn unknown_duration_reports_activity_without_fabricated_percent() {
        let mut progress = EncodingProgress::default();
        progress.line("out_time_us=50000000");
        progress.line("speed=N/A");
        progress.line("fps=24.0");
        for duration in [None, Some(0.0), Some(-1.0), Some(f64::NAN)] {
            let mut job = progress_fixture();
            progress.record(&mut job, duration);
            assert_eq!(job.encoding_progress, None);
            assert_eq!(job.progress, None);
            assert_eq!(job.eta, None);
            assert!(job.speed.as_ref().unwrap().contains("50.0s encoded"));
        }
    }
    #[test]
    fn progress_samples_are_coalesced_within_one_second() {
        let start = tokio::time::Instant::now();
        assert!(progress_flush_due(None, start));
        assert!(!progress_flush_due(
            Some(start),
            start + Duration::from_millis(999)
        ));
        assert!(progress_flush_due(
            Some(start),
            start + Duration::from_secs(1)
        ));
    }

    #[tokio::test]
    async fn pending_progress_preserves_cancelled_and_removed_jobs() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        let mut job = progress_fixture();
        job.status = "cancelled".into();
        super::super::save(&state, "plugin-ytdl-jobs", &vec![job.clone()]).unwrap();
        let sample = json!({"downloaded_bytes": 100, "total_bytes": 100});
        persist_progress(
            &state,
            &job.id,
            &EncodingProgress::default(),
            None,
            Some(&sample),
        )
        .await
        .unwrap();
        let saved: Vec<Job> = super::super::load(&state, "plugin-ytdl-jobs").unwrap();
        assert_eq!(saved[0].status, "cancelled");
        assert_eq!(saved[0].progress, job.progress);
        super::super::save(&state, "plugin-ytdl-jobs", &Vec::<Job>::new()).unwrap();
        persist_progress(
            &state,
            &job.id,
            &EncodingProgress::default(),
            None,
            Some(&sample),
        )
        .await
        .unwrap();
        assert!(
            super::super::load::<Vec<Job>>(&state, "plugin-ytdl-jobs")
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn progress_storage_errors_are_returned() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        std::fs::write(
            state.runtime.data_dir().join("ytdl-jobs.json"),
            b"invalid queue",
        )
        .unwrap();
        assert!(
            persist_progress(
                &state,
                "fixture",
                &EncodingProgress::default(),
                None,
                Some(&json!({}))
            )
            .await
            .is_err()
        );
    }

    #[tokio::test]
    async fn ffmpeg_fixture_persists_encoding_progress() {
        if !std::process::Command::new("ffmpeg")
            .arg("-version")
            .output()
            .is_ok_and(|o| o.status.success())
        {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        let job = progress_fixture();
        super::super::save(&state, "plugin-ytdl-jobs", &vec![job.clone()]).unwrap();
        let mut command = Command::new("ffmpeg");
        command.args([
            "-nostdin",
            "-f",
            "lavfi",
            "-i",
            "color=s=32x32:r=10:d=1",
            "-progress",
            "pipe:1",
            "-stats_period",
            "0.1",
            "-nostats",
            "-f",
            "null",
            "-",
        ]);
        // Deliberately overestimate duration: completion must use process success,
        // not assume the final FFmpeg timestamp reaches the metadata duration.
        cancellable(&state, &job, command, Some(Some(2.0)))
            .await
            .unwrap();
        let saved = super::super::load::<Vec<Job>>(&state, "plugin-ytdl-jobs").unwrap();
        assert_eq!(saved[0].encoding_progress, Some(100.0));
        assert_eq!(saved[0].eta.as_deref(), Some("0s"));
        assert!((saved[0].progress.unwrap() - 195.0 / 7.0).abs() < 0.001);
        assert!(saved[0].speed.as_ref().unwrap().contains("encoded"));
    }
    fn quality_fixture(heights: &[u32]) -> Value {
        let mut formats = heights
            .iter()
            .map(|h| json!({"height":h,"fps":30,"vcodec":"avc1.640028","acodec":"none"}))
            .collect::<Vec<_>>();
        formats.push(json!({"vcodec":"none","acodec":"mp4a.40.2"}));
        json!({"id":"fixture","formats":formats})
    }
    #[test]
    fn direct_download_uses_quality_without_custom_codec_filters_or_encoding() {
        let custom = Settings {
            download_mode: "direct".into(),
            quality: Some(1440),
            convert: true,
            video_codec: "hevc".into(),
            audio_codec: "aac".into(),
            hardware_backend: "nvenc".into(),
            container: "webm".into(),
            ..Default::default()
        };
        let direct = custom.effective();
        assert!(!direct.convert);
        assert_eq!(direct.container, "mkv");
        assert_eq!(direct.hardware_backend, "cpu");
        assert_eq!(direct.video_codec, "auto");
        assert_eq!(direct.audio_codec, "auto");
        assert!(format(&direct).contains("[height=1440]"));
        assert!(!format(&direct).contains("vcodec"));
        assert_eq!(
            choose_quality(&direct, &quality_fixture(&[720, 1440, 2160])),
            QualityChoice::Height(1440)
        );
        assert!(custom.convert);
        assert_eq!(custom.video_codec, "hevc");
        let mut restored = custom.clone();
        restored.download_mode = "custom".into();
        assert!(restored.effective().convert);
        assert_eq!(restored.effective().hardware_backend, "nvenc");
        let legacy: Settings = serde_json::from_value(json!({})).unwrap();
        assert_eq!(legacy.download_mode, "custom");
    }
    #[test]
    fn exact_highest_and_nearest_quality_are_distinct() {
        let mut s = Settings {
            quality: Some(1080),
            fallback: "highest".into(),
            ..Default::default()
        };
        let info = quality_fixture(&[480, 720, 1440, 2160, 8640]);
        assert_eq!(
            choose_quality(&s, &quality_fixture(&[720, 1080, 2160])),
            QualityChoice::Height(1080)
        );
        assert_eq!(choose_quality(&s, &info), QualityChoice::Height(8640));
        s.fallback = "next_highest".into();
        assert_eq!(choose_quality(&s, &info), QualityChoice::Height(1440));
        s.fallback = "next_lowest".into();
        assert_eq!(choose_quality(&s, &info), QualityChoice::Height(720));
        s.fallback = "best".into();
        assert_eq!(choose_quality(&s, &info), QualityChoice::Height(720));
        assert!(matches!(
            choose_quality(&s, &quality_fixture(&[2160])),
            QualityChoice::Skip(_)
        ));
        s.quality = Some(0);
        assert_eq!(choose_quality(&s, &info), QualityChoice::Height(8640));
        assert!(!format(&s).contains("height"));
        s.quality = Some(2160);
        assert!(format(&s).contains("[height=2160]"));
    }
    #[test]
    fn unavailable_quality_skips_only_that_playlist_entry() {
        let s = Settings {
            quality: Some(1080),
            fallback: "skip".into(),
            ..Default::default()
        };
        let choices = [
            quality_fixture(&[1080]),
            quality_fixture(&[720]),
            quality_fixture(&[480, 1080]),
        ]
        .iter()
        .map(|info| choose_quality(&s, info))
        .collect::<Vec<_>>();
        assert_eq!(choices[0], QualityChoice::Height(1080));
        assert!(matches!(choices[1], QualityChoice::Skip(_)));
        assert_eq!(choices[2], QualityChoice::Height(1080));
        let strict = Settings {
            fallback: "strict".into(),
            ..s.clone()
        };
        assert!(matches!(
            choose_quality(&strict, &quality_fixture(&[720])),
            QualityChoice::Skip(_)
        ));
    }
    #[test]
    fn quality_candidates_obey_codec_fps_container_and_audio() {
        let info = json!({"id":"fixture","formats":[{"height":720,"fps":30,"vcodec":"avc1","acodec":"none"},{"height":1080,"fps":120,"vcodec":"avc1","acodec":"none"},{"height":2160,"fps":60,"vcodec":"vp09","acodec":"none"},{"vcodec":"none","acodec":"mp4a"},{"vcodec":"none","acodec":"opus"}]});
        let mut s = Settings {
            quality: Some(0),
            video_codec: "h264".into(),
            audio_codec: "aac".into(),
            ..Default::default()
        };
        assert_eq!(choose_quality(&s, &info), QualityChoice::Height(720));
        s.convert = true;
        assert_eq!(choose_quality(&s, &info), QualityChoice::Height(2160));
        s.convert = false;
        s.video_codec = "auto".into();
        s.audio_codec = "auto".into();
        s.container = "webm".into();
        assert_eq!(choose_quality(&s, &info), QualityChoice::Height(2160));
        s.audio_codec = "aac".into();
        assert!(matches!(choose_quality(&s, &info), QualityChoice::Skip(_)));
        s.quality = None;
        assert_eq!(choose_quality(&s, &info), QualityChoice::Legacy);
    }
    #[test]
    fn channel_uploads_do_not_become_a_fabricated_playlist() {
        let v = inspection_value(
            &json!({"id":"UCchannel","title":"Channel","entries":[{"id":"vid","title":"Video"}]}),
            "https://www.youtube.com/@channel",
            true,
        );
        assert_eq!(v["kind"], "channel");
        assert_eq!(v["entries"][0]["playlist_id"], "");
        assert_eq!(
            v["entries"][0]["url"],
            "https://www.youtube.com/watch?v=vid"
        );
        let playlist = inspection_value(
            &json!({"id":"PLid","title":"Playlist","entries":[{"id":"vid"}]}),
            "https://www.youtube.com/playlist?list=PLid",
            false,
        );
        assert_eq!(playlist["entries"][0]["playlist_id"], "PLid");
    }
    #[test]
    fn upload_time_uses_exact_timestamp_then_midnight_utc() {
        let expected = |stamp| std::time::UNIX_EPOCH + Duration::from_secs(stamp);
        assert_eq!(
            upload_modified_time(&json!({"timestamp":1767354321,"upload_date":"20260102"})),
            Some(expected(1767354321))
        );
        assert_eq!(
            upload_modified_time(&json!({"release_timestamp":1767354321})),
            Some(expected(1767354321))
        );
        assert_eq!(
            upload_modified_time(&json!({"upload_date":"20260102"})),
            Some(expected(1767312000))
        );
        assert_eq!(
            upload_modified_time(&json!({"upload_date":"20260231"})),
            None
        );
        assert_eq!(upload_modified_time(&json!({})), None);
    }
    #[test]
    fn published_video_has_upload_modified_time_and_existing_file_is_preserved() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.mp4");
        let target = dir.path().join("video.mp4");
        std::fs::write(&source, b"video").unwrap();
        let modified = upload_modified_time(&json!({"upload_date":"20260102"})).unwrap();
        publish_with_modified(&source, &target, Some(modified)).unwrap();
        assert_eq!(
            std::fs::metadata(&target).unwrap().modified().unwrap(),
            modified
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"video");
        publish_with_modified(&source, &target, Some(std::time::UNIX_EPOCH)).unwrap();
        assert_eq!(
            std::fs::metadata(&target).unwrap().modified().unwrap(),
            modified
        );
    }
    #[test]
    fn video_folder_gets_upload_date_after_sidecars_without_changing_channel_or_files() {
        let channel = tempfile::tempdir().unwrap();
        let video = channel.path().join("Video");
        std::fs::create_dir(&video).unwrap();
        let media = video.join("video.mp4");
        let nfo = video.join("video.nfo");
        std::fs::write(&media, b"video").unwrap();
        std::fs::write(&nfo, b"metadata").unwrap();
        let channel_time = std::fs::metadata(channel.path())
            .unwrap()
            .modified()
            .unwrap();
        let media_time = std::fs::metadata(&media).unwrap().modified().unwrap();
        let nfo_time = std::fs::metadata(&nfo).unwrap().modified().unwrap();
        let upload = upload_modified_time(&json!({"upload_date":"20260102"})).unwrap();
        set_video_folder_modified(&video, Some(upload)).unwrap();
        assert_eq!(
            std::fs::metadata(&video).unwrap().modified().unwrap(),
            upload
        );
        assert_eq!(
            std::fs::metadata(channel.path())
                .unwrap()
                .modified()
                .unwrap(),
            channel_time
        );
        assert_eq!(
            std::fs::metadata(&media).unwrap().modified().unwrap(),
            media_time
        );
        assert_eq!(
            std::fs::metadata(&nfo).unwrap().modified().unwrap(),
            nfo_time
        );
        set_video_folder_modified(&video, None).unwrap();
        assert_eq!(
            std::fs::metadata(&video).unwrap().modified().unwrap(),
            upload
        );
    }
    #[tokio::test]
    async fn metadata_output_is_bounded() {
        assert!(bounded_read(&b"12345"[..], 4, false).await.is_err());
        assert_eq!(bounded_read(&b"12345"[..], 4, true).await.unwrap(), b"1234");
    }
    #[tokio::test]
    async fn cancelled_fixture_process_is_stopped() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        let job = Job {
            id: "process-fixture".into(),
            url: "https://youtube.com/watch?v=fixture".into(),
            title: "Fixture".into(),
            status: "cancelled".into(),
            progress: None,
            total_videos: 0,
            completed_videos: 0,
            downloaded_videos: 0,
            existing_videos: 0,
            updated_videos: 0,
            skipped_videos: 0,
            failed_videos: 0,
            failed_entries: Vec::new(),
            current_video_title: None,
            speed: None,
            eta: None,
            error: None,
            created_at: String::new(),
            settings: Settings::default(),
            finished_at: None,
            encoding_progress: None,
            video_ids: vec![],
            metadata_only: false,
        };
        super::super::save(&state, "plugin-ytdl-jobs", &vec![job.clone()]).unwrap();
        #[cfg(windows)]
        let mut command = Command::new("powershell.exe");
        #[cfg(windows)]
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 30",
        ]);
        #[cfg(not(windows))]
        let mut command = Command::new("sh");
        #[cfg(not(windows))]
        command.args(["-c", "sleep 30"]);
        let before = std::time::Instant::now();
        assert!(cancellable(&state, &job, command, None).await.is_err());
        assert!(before.elapsed() < Duration::from_secs(10));
    }
    #[test]
    fn hevc_selects_source_formats_or_converts_with_x265() {
        let mut settings = Settings {
            video_codec: "hevc".into(),
            fallback: "strict".into(),
            ..Default::default()
        };
        assert!(format(&settings).contains("[vcodec~='^(hev1|hvc1|hevc|h265)']"));
        settings.convert = true;
        assert!(!format(&settings).contains("hev1"));
        let args = conversion_args(&settings, Path::new("input.mkv"), Path::new("output.mp4"));
        assert!(args.windows(2).any(|pair| pair == ["-c:v", "libx265"]));
    }
    #[test]
    fn webm_selection_and_conversion_use_compatible_codecs() {
        let settings = Settings {
            container: "webm".into(),
            ..Settings::default()
        };
        let expression = format(&settings);
        assert!(expression.contains("[acodec=opus]"));
        assert!(expression.contains("vp09"));
        let converted =
            conversion_args(&settings, Path::new("input.mkv"), Path::new("output.webm"));
        assert!(converted.iter().any(|arg| arg == "libvpx-vp9"));
        assert!(converted.iter().any(|arg| arg == "libopus"));
    }

    #[test]
    fn channel_inspection_lists_playlists() {
        assert_eq!(
            channel_playlists_url("https://www.youtube.com/@creator/videos?sort=new"),
            "https://www.youtube.com/@creator/playlists"
        );
        assert_eq!(
            channel_playlists_url("https://www.youtube.com/channel/UCid/about"),
            "https://www.youtube.com/channel/UCid/playlists"
        );
        let v = entry(
            &json!({"id":"PLid","url":"https://www.youtube.com/playlist?list=PLid","title":"Playlist"}),
            &Value::Null,
            0,
        );
        assert_eq!(v["kind"], "playlist");
        assert_eq!(v["url"], "https://www.youtube.com/playlist?list=PLid");
    }
    #[test]
    fn url_boundary() {
        for u in [
            "http://youtube.com/watch?v=x",
            "https://youtube.com.evil.test/x",
            "https://user@youtube.com/x",
            "https://youtube.com:444/x",
            "file:///tmp/x",
        ] {
            assert!(validate_url(u).is_err(), "{u}");
        }
        assert!(validate_url("https://www.youtube.com/watch?v=a-b_1").is_ok());
        assert!(!valid_id("../escape"));
    }
    #[test]
    fn format_keeps_limits_on_fallback() {
        let s = Settings {
            quality: None,
            video_codec: "h264".into(),
            audio_codec: "aac".into(),
            ..Default::default()
        };
        let f = format(&s);
        assert!(f.contains("vcodec^=avc1"));
        assert!(f.ends_with("/bv[height<=1080][fps<=?60]+ba/b[height<=1080][fps<=?60]"));
    }
    #[test]
    fn conversion_is_explicit() {
        let s = Settings {
            video_codec: "av1".into(),
            audio_codec: "opus".into(),
            ..Default::default()
        };
        let args = conversion_args(&s, Path::new("input.mp4"), Path::new("output.mkv"));
        assert!(args.contains(&"libsvtav1".to_string()));
        assert!(args.contains(&"libopus".to_string()));
        assert!(args.contains(&"-n".to_string()));
    }
    #[test]
    fn conversion_crf_applies_to_encoders_but_not_stream_copy() {
        for codec in ["h264", "hevc", "vp9", "av1", "auto"] {
            let mut settings = Settings {
                video_codec: codec.into(),
                convert: true,
                ..Default::default()
            };
            let args = conversion_args(&settings, Path::new("in.mp4"), Path::new("out.mkv"));
            assert_eq!(
                args.windows(2).any(|p| p == ["-crf", "23"]),
                codec != "auto"
            );
            assert_eq!(args.windows(2).any(|p| p == ["-b:v", "0"]), codec == "vp9");
            settings.crf = 19;
            settings.container = "webm".into();
            let args = conversion_args(&settings, Path::new("in.mp4"), Path::new("out.webm"));
            assert!(args.windows(2).any(|p| p == ["-crf", "19"]));
            assert_eq!(args.last().unwrap(), "out.webm");
        }
    }
    #[test]
    fn hardware_encoding_uses_selected_codec_quality_and_progress() {
        for backend in ["nvenc", "qsv", "vaapi"] {
            for codec in ["h264", "hevc", "av1"] {
                let settings = Settings {
                    convert: true,
                    hardware_backend: backend.into(),
                    video_codec: codec.into(),
                    crf: 21,
                    ..Default::default()
                };
                let args = conversion_args(&settings, Path::new("in.mkv"), Path::new("out.mkv"));
                assert!(
                    args.windows(2)
                        .any(|p| p == ["-c:v", &format!("{codec}_{backend}")])
                );
                assert!(args.windows(2).any(|p| p == ["-progress", "pipe:1"]));
                assert!(!args.iter().any(|arg| arg == "-crf"));
                assert!(args.windows(2).any(|p| p
                    == [
                        match backend {
                            "nvenc" => "-cq",
                            "qsv" => "-global_quality",
                            _ => "-qp",
                        },
                        "21"
                    ]));
                match backend {
                    "nvenc" => {
                        assert!(args.windows(2).any(|p| p == ["-rc", "vbr"]));
                        assert!(args.windows(2).any(|p| p == ["-b:v", "0"]));
                        assert!(!args.iter().any(|arg| arg == "-vf"));
                    }
                    "qsv" => {
                        assert!(args.windows(2).any(|p| p == ["-init_hw_device", "qsv=qs"]));
                        assert!(args.windows(2).any(|p| p == ["-filter_hw_device", "qs"]));
                        assert!(
                            args.windows(2)
                                .any(|p| p == ["-vf", "format=nv12,hwupload=extra_hw_frames=64"])
                        );
                    }
                    _ => {
                        assert!(
                            args.windows(2)
                                .any(|p| p == ["-vaapi_device", "/dev/dri/renderD128"])
                        );
                        assert!(
                            args.windows(2)
                                .any(|p| p == ["-vf", "format=nv12,hwupload"])
                        );
                    }
                }
                assert_eq!(args.last().unwrap(), "out.mkv");
            }
        }
    }

    #[test]
    fn cpu_conversion_does_not_require_gpu_devices() {
        let settings = Settings {
            convert: true,
            video_codec: "hevc".into(),
            ..Default::default()
        };
        let args = conversion_args(&settings, Path::new("in.mkv"), Path::new("out.mkv"));
        assert!(args.windows(2).any(|p| p == ["-c:v", "libx265"]));
        for option in [
            "-vaapi_device",
            "-init_hw_device",
            "-filter_hw_device",
            "-vf",
            "-cq",
            "-qp",
            "-global_quality",
        ] {
            assert!(!args.iter().any(|arg| arg == option));
        }
    }
    #[test]
    fn publishing_preserves_original() {
        let t = tempfile::tempdir().unwrap();
        let a = t.path().join("a");
        let b = t.path().join("b");
        std::fs::write(&a, "new").unwrap();
        std::fs::write(&b, "original").unwrap();
        publish(&a, &b).unwrap();
        assert_eq!(std::fs::read_to_string(b).unwrap(), "original");
    }
}
