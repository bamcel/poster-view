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
async fn raw_inspect(url: &str) -> Result<Value, HttpError> {
    validate_url(url)?;
    let normalized = channel_playlists_url(url);
    let _permit = INSPECTIONS.acquire().await.map_err(err)?;
    let mut command = base();
    command.args([
        "--dump-single-json",
        "--skip-download",
        "--flat-playlist",
        "--playlist-end",
        "10000",
        "--",
        &normalized,
    ]);
    serde_json::from_slice(&output(command, Duration::from_secs(180)).await?).map_err(err)
}
fn text(v: &Value, key: &str) -> String {
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
pub(super) async fn inspect(url: &str) -> Result<Value, HttpError> {
    let v = raw_inspect(url).await?;
    let playlist = v["entries"].as_array();
    let entries = match playlist {
        Some(entries) => entries
            .iter()
            .enumerate()
            .filter(|(_, v)| valid_id(&text(v, "id")))
            .map(|(i, e)| entry(e, &v, i))
            .collect::<Vec<_>>(),
        None => vec![entry(&v, &Value::Null, 0)],
    };
    let formats=v["formats"].as_array().map(|fs|fs.iter().map(|f|json!({"format_id":f["format_id"],"height":f["height"],"fps":f["fps"],"vcodec":f["vcodec"],"acodec":f["acodec"],"ext":f["ext"]})).collect::<Vec<_>>()).unwrap_or_default();
    Ok(
        json!({"id":v["id"],"title":v["title"],"description":v["description"],"channel":v["channel"],"channel_id":v["channel_id"],"kind":if is_channel_url(url){"channel"}else if playlist.is_some(){"playlist"}else{"video"},"entries":entries,"formats":formats}),
    )
}
async fn await_cancel(state: &AppState, job: &Job) {
    loop {
        if cancelled(state, &job.id).await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}
async fn job_raw_inspect(state: &AppState, job: &Job, url: &str) -> Result<Value, HttpError> {
    tokio::select! {result=raw_inspect(url)=>result,_=await_cancel(state,job)=>Err(err("Download cancelled."))}
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
    let limits = format!("[height<={}][fps<=?{}]", s.max_height, s.max_fps);
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
    if s.fallback == "best" {
        format!(
            "{selected}/bv{limits}{compatibility_video}+ba{compatibility_audio}/b{limits}{compatibility_video}{compatibility_audio}"
        )
    } else {
        selected
    }
}
pub(super) fn conversion_args(s: &Settings, input: &Path, output: &Path) -> Vec<String> {
    vec![
        "-nostdin".into(),
        "-n".into(),
        "-i".into(),
        input.to_string_lossy().into(),
        "-map".into(),
        "0:v:0".into(),
        "-map".into(),
        "0:a:0?".into(),
        "-c:v".into(),
        match s.video_codec.as_str() {
            "h264" => "libx264",
            "vp9" => "libvpx-vp9",
            "av1" => "libsvtav1",
            _ if s.container == "webm" => "libvpx-vp9",
            _ => "copy",
        }
        .into(),
        "-c:a".into(),
        match s.audio_codec.as_str() {
            "aac" => "aac",
            "opus" => "libopus",
            _ if s.container == "webm" => "libopus",
            _ => "copy",
        }
        .into(),
        output.to_string_lossy().into(),
    ]
}
async fn cancellable(state: &AppState, job: &Job, mut command: Command) -> Result<(), HttpError> {
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
    let progress_reader = tokio::spawn(async move {
        if let Some(stdout) = stdout {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(data) = line.strip_prefix("PVPROGRESS:") {
                    if let Ok(value) = serde_json::from_str::<Value>(data) {
                        let _lock = progress_state.ytdl_lock.lock().await;
                        if let Ok(mut jobs) =
                            super::load::<Vec<Job>>(&progress_state, "plugin-ytdl-jobs")
                        {
                            if let Some(job) = jobs
                                .iter_mut()
                                .find(|j| j.id == id && j.status != "cancelled")
                            {
                                let total = value["total_bytes"]
                                    .as_f64()
                                    .or_else(|| value["total_bytes_estimate"].as_f64());
                                job.progress = total.filter(|t| *t > 0.0).and_then(|t| {
                                    value["downloaded_bytes"]
                                        .as_f64()
                                        .map(|n| (100.0 * n / t).clamp(0.0, 100.0))
                                });
                                job.speed = value["speed"]
                                    .as_f64()
                                    .map(|s| format!("{:.1} KiB/s", s / 1024.0));
                                job.eta = value["eta"].as_f64().map(|s| format!("{s:.0}s"));
                            }
                            let _ = super::save(&progress_state, "plugin-ytdl-jobs", &jobs);
                        }
                    }
                }
            }
        }
    });
    let deadline = tokio::time::Instant::now() + Duration::from_secs(24 * 3600);
    loop {
        if cancelled(state, &job.id).await || tokio::time::Instant::now() > deadline {
            drop(tree);
            let _ = child.wait().await;
            reader.abort();
            progress_reader.abort();
            return Err(err("Download cancelled or timed out."));
        }
        if let Some(status) = child.try_wait().map_err(err)? {
            tree.0 = None;
            let message = reader.await.unwrap_or_default();
            let _ = progress_reader.await;
            if status.success() {
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
    if !super::load::<Settings>(state, "plugin-ytdl")?.enabled {
        return Err(err("YTDL plugin is disabled."));
    }
    validate_settings(state, &job.settings)?;
    let library = posterview_infra_sqlite::ServerStore::new(state.runtime.data_dir())
        .native_libraries()
        .map_err(err)?
        .into_iter()
        .find(|l| l.id == job.settings.library_id)
        .ok_or_else(|| err("Library no longer exists."))?;
    let mut allowed_channels = Vec::new();
    for configured in &library.options.youtube_channels {
        if configured.starts_with("UC") && valid_id(configured) {
            allowed_channels.push(configured.clone());
        } else {
            let url = if configured.starts_with("https://") {
                configured.clone()
            } else {
                format!(
                    "https://www.youtube.com/{}",
                    configured.trim_start_matches('/')
                )
            };
            let value = job_raw_inspect(state, job, &url).await?;
            let channel = text(&value, "channel_id");
            if !valid_id(&channel) {
                return Err(err("Configured channel cannot be resolved."));
            }
            allowed_channels.push(channel);
        }
    }
    let mut first_channel = None;
    let mut channel_metadata = std::collections::HashMap::new();
    update(state, &job.id, "inspecting", None, None).await?;
    let inspection = tokio::select! {result=inspect(&job.url)=>result?,_=await_cancel(state,job)=>return Err(err("Download cancelled."))};
    {
        let _lock = state.ytdl_lock.lock().await;
        let mut jobs = super::load::<Vec<Job>>(state, "plugin-ytdl-jobs")?;
        if let Some(saved) = jobs.iter_mut().find(|saved| saved.id == job.id) {
            saved.title = text(&inspection, "title");
        }
        super::save(state, "plugin-ytdl-jobs", &jobs)?;
    }
    let entries = inspection["entries"]
        .as_array()
        .ok_or_else(|| err("No videos found."))?;
    let selected = entries
        .iter()
        .filter(|e| job.video_ids.is_empty() || job.video_ids.contains(&text(e, "id")))
        .collect::<Vec<_>>();
    if selected.is_empty() {
        return Err(err("No selected videos are available."));
    }
    let stage_root = state.runtime.data_dir().join("ytdl");
    std::fs::create_dir_all(&stage_root).map_err(err)?;
    let mut scopes = Vec::new();
    for (index, e) in selected.iter().enumerate() {
        if cancelled(state, &job.id).await {
            return Err(err("Download cancelled."));
        }
        let id = text(e, "id");
        if !valid_id(&id) {
            return Err(err("Invalid video identity."));
        }
        let url = format!("https://www.youtube.com/watch?v={id}");
        let info = job_raw_inspect(state, job, &url).await?;
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
        if !allowed_channels.is_empty() && !allowed_channels.contains(&channel) {
            return Err(err("Video is outside the library's configured channels."));
        }
        if library.options.youtube_mode == "single_channel" {
            if first_channel
                .as_ref()
                .is_some_and(|first| first != &channel)
            {
                return Err(err(
                    "Single-channel libraries cannot contain multiple channels.",
                ));
            }
            let existing = std::fs::read_dir(
                state
                    .metadata
                    .directory(&job.settings.directory, true)?
                    .join("channels"),
            );
            if existing.is_ok_and(|entries| {
                entries.flatten().any(|e| {
                    e.file_type().is_ok_and(|t| t.is_dir()) && e.file_name() != channel.as_str()
                })
            }) {
                return Err(err(
                    "This single-channel library already contains another channel.",
                ));
            }
            first_channel = Some(channel.clone());
        }
        let channel_relative = format!("channels/{channel}");
        let mut folder = job.settings.directory.clone();
        for part in ["channels", channel.as_str(), id.as_str()] {
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
            "{}{channel_relative}/{id}",
            if job.settings.directory.is_empty() {
                String::new()
            } else {
                format!("{}/", job.settings.directory)
            }
        );
        let target = state.metadata.directory(&relative, false)?;
        let media = target.join(format!("{id}.{}", job.settings.container));
        if !["mp4", "mkv", "webm"]
            .iter()
            .any(|ext| target.join(format!("{id}.{ext}")).exists())
        {
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
            let mut command = base();
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
                    &format(&job.settings),
                    "--merge-output-format",
                    download_container,
                    "--remux-video",
                    download_container,
                    "--output",
                ])
                .arg(template);
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
            cancellable(state, job, command).await?;
            let source = stage.path().join(format!("{id}.{download_container}"));
            let source = if job.settings.convert {
                update(state, &job.id, "processing", None, None).await?;
                let converted = stage
                    .path()
                    .join(format!("converted.{}", job.settings.container));
                let mut ff = Command::new("ffmpeg");
                ff.args(conversion_args(&job.settings, &source, &converted));
                cancellable(state, job, ff).await?;
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
                if name.starts_with(&format!("{id}."))
                    && !["mp4", "mkv", "webm"]
                        .iter()
                        .any(|ext| name.ends_with(&format!(".{ext}")))
                    && !name.contains(".part")
                {
                    publish(&file.path(), &target.join(name.as_ref()))?;
                }
            }
            super::nfo::write(&target, &info, e, &inspection, channel_info)?;
            if cancelled(state, &job.id).await {
                return Err(err("Download cancelled."));
            }
            publish(&source, &media)?;
        }
        update(state, &job.id, "importing", None, None).await?;
        super::nfo::write(&target, &info, e, &inspection, channel_info)?;
        let scope = format!(
            "{}{channel_relative}",
            if job.settings.directory.is_empty() {
                String::new()
            } else {
                format!("{}/", job.settings.directory)
            }
        );
        scopes.push(scope);
    }
    scopes.sort();
    scopes.dedup();
    crate::native::start_scan_scoped(state.clone(), job.settings.library_id.clone(), Some(scopes))
        .await?;
    // A completed job must be visible in the catalog before clients invalidate it.
    tokio::time::timeout(Duration::from_secs(3600), async {
        loop {
            if cancelled(state, &job.id).await {
                return Err(err("Download cancelled."));
            }
            let importing = state
                .active_native_scans
                .lock()
                .map_err(err)?
                .contains(&job.settings.library_id);
            if !importing {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    })
    .await
    .map_err(|_| err("Library import timed out. Retry to rescan the downloaded files."))??;
    update(state, &job.id, "completed", None, Some(100.0)).await
}
fn publish(source: &Path, target: &Path) -> Result<(), HttpError> {
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
            speed: None,
            eta: None,
            error: None,
            created_at: String::new(),
            settings: Settings::default(),
            video_ids: vec![],
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
        assert!(cancellable(&state, &job, command).await.is_err());
        assert!(before.elapsed() < Duration::from_secs(10));
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
