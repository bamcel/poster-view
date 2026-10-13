//! Temporary segmented delivery. Every generation owns one bounded producer.
use super::{
    HttpError, PlaybackStore, SessionInput, Source, VIDEO_DEMUXERS, bad, command, container,
    failure, manifest, number, planner, run,
};
use crate::transcoding::Settings;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU32, Ordering},
    },
    time::Duration,
};
use tokio::process::{Child, Command};

struct Slot(Arc<AtomicU32>);
impl Drop for Slot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}
pub(super) struct Producer {
    child: Child,
    pub(super) dir: PathBuf,
    pub(super) suspended: bool,
    pub(super) buffer_seconds: f64,
    pub(super) cache_bytes: u64,
    throttle: bool,
    _slot: Option<Slot>,
}
impl Producer {
    pub(super) async fn stop(mut self) {
        self.suspend(false);
        let _ = self.child.kill().await;
        let _ = tokio::time::timeout(Duration::from_secs(3), self.child.wait()).await;
        remove_owned(&self.dir);
    }
    pub(super) fn suspend(&mut self, suspend: bool) {
        if self.suspended == suspend {
            return;
        }
        #[cfg(unix)]
        if let Some(pid) = self.child.id() {
            use nix::{
                sys::signal::{Signal, kill},
                unistd::Pid,
            };
            if kill(
                Pid::from_raw(pid as i32),
                if suspend {
                    Signal::SIGSTOP
                } else {
                    Signal::SIGCONT
                },
            )
            .is_ok()
            {
                self.suspended = suspend;
            }
        }
        #[cfg(not(unix))]
        {
            let _ = suspend;
        }
    }
    pub(super) fn maintain(&mut self, position: f64, paused: bool, speed: f64) -> bool {
        if let Ok(Some(status)) = self.child.try_wait() {
            self._slot.take();
            if !status.success() {
                return false;
            }
        }
        manifest::prune_consumed(&self.dir, position);
        let lead = manifest::playlist_seconds(&self.dir.join("index.m3u8")) - position;
        let limit = self.buffer_seconds * speed.clamp(0.25, 4.0);
        if self.throttle {
            if lead >= limit || paused && lead > 12.0 {
                self.suspend(true);
            } else if self.suspended && !paused && lead < (limit * 0.5).min(limit - 1.0) {
                self.suspend(false);
            }
        }
        directory_bytes(&self.dir) <= self.cache_bytes
    }
    pub(super) fn progress(&self) -> (Option<f64>, Option<f64>) {
        let text = std::fs::read_to_string(self.dir.join("progress.txt")).unwrap_or_default();
        let value = |key: &str| {
            text.lines()
                .filter_map(|line| line.strip_prefix(key))
                .next_back()
                .and_then(|v| v.trim_end_matches('x').parse::<f64>().ok())
                .filter(|v| v.is_finite() && *v >= 0.0)
        };
        (value("fps="), value("speed="))
    }
}
#[derive(Serialize, Deserialize)]
struct Owner {
    id: String,
    instance: String,
    pid: Option<u32>,
}
fn owned(dir: &Path) -> Option<Owner> {
    if std::fs::symlink_metadata(dir)
        .ok()?
        .file_type()
        .is_symlink()
    {
        return None;
    }
    let name = dir.file_name()?.to_str()?;
    let (id, generation) = name.split_once(".g").unwrap_or((name, "0"));
    uuid::Uuid::parse_str(id).ok()?;
    generation.parse::<u64>().ok()?;
    let path = dir.join("owner.json");
    if std::fs::symlink_metadata(&path)
        .ok()?
        .file_type()
        .is_symlink()
    {
        return None;
    }
    let data = std::fs::read(path).ok()?;
    if data.len() > 4096 {
        return None;
    }
    let owner: Owner = serde_json::from_slice(&data).ok()?;
    (owner.id == id).then_some(owner)
}
fn remove_owned(dir: &Path) {
    if owned(dir).is_none() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let paths = entries
        .flatten()
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    if paths.iter().any(|path| {
        let safe_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| {
                matches!(name, "owner.json" | "progress.txt" | "ffmpeg.log")
                    || manifest::safe_segment(name.strip_suffix(".tmp").unwrap_or(name))
            });
        !safe_name
            || std::fs::symlink_metadata(path).map_or(true, |meta| {
                !meta.is_file() || meta.file_type().is_symlink()
            })
    }) {
        return;
    }
    // Keep the marker until every generated file was removed. A transient open
    // file must not leave an unmarked directory that future cleanup cannot own.
    for path in paths
        .iter()
        .filter(|path| path.file_name().is_none_or(|name| name != "owner.json"))
    {
        if std::fs::remove_file(path).is_err() {
            return;
        }
    }
    if std::fs::remove_file(dir.join("owner.json")).is_err() {
        return;
    }
    let _ = std::fs::remove_dir(dir);
}
#[cfg(any(unix, test))]
fn orphan_ffmpeg(args: &[u8], index: &Path) -> bool {
    let mut arguments = args.split(|byte| *byte == 0);
    let executable = arguments.next().unwrap_or_default();
    executable.rsplit(|byte| *byte == b'/').next() == Some(b"ffmpeg".as_slice())
        && arguments.any(|argument| argument == index.as_os_str().as_encoded_bytes())
}
pub(super) fn directory_bytes(dir: &Path) -> u64 {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| std::fs::symlink_metadata(entry.path()).ok())
        .filter(|meta| meta.is_file())
        .map(|meta| meta.len())
        .sum()
}
pub(super) fn total_bytes(store: &PlaybackStore) -> u64 {
    let roots = store
        .cache_roots
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .iter()
        .cloned()
        .collect::<Vec<_>>();
    roots
        .iter()
        .flat_map(|root| std::fs::read_dir(root).into_iter().flatten().flatten())
        .map(|entry| entry.path())
        .filter(|path| owned(path).is_some())
        .map(|path| directory_bytes(&path))
        .fold(0, u64::saturating_add)
}
pub(super) async fn sweep_abandoned(
    store: &PlaybackStore,
    active: &std::collections::HashSet<String>,
) {
    let roots = store
        .cache_roots
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .iter()
        .cloned()
        .collect::<Vec<_>>();
    let mut attempts = 0usize;
    for root in roots {
        for entry in std::fs::read_dir(root)
            .into_iter()
            .flatten()
            .flatten()
            .take(4096)
        {
            let dir = entry.path();
            let Some(owner) = owned(&dir) else {
                continue;
            };
            if owner.instance != store.instance || active.contains(&owner.id) {
                continue;
            }
            // Creation registers its session before making a directory. Recheck
            // absent IDs so a newly-created job cannot be swept from an older
            // snapshot. Session UUIDs are never reused.
            let sessions = store.sessions.lock().await;
            if sessions.contains_key(&owner.id) {
                continue;
            }
            if attempts >= 32 {
                return;
            }
            attempts += 1;
            #[cfg(unix)]
            if let Some(pid) = owner.pid {
                let args = std::fs::read(format!("/proc/{pid}/cmdline")).unwrap_or_default();
                if orphan_ffmpeg(&args, &dir.join("index.m3u8")) {
                    let _ = nix::sys::signal::kill(
                        nix::unistd::Pid::from_raw(pid as i32),
                        nix::sys::signal::Signal::SIGKILL,
                    );
                }
            }
            remove_owned(&dir);
            drop(sessions);
        }
    }
}
fn generation_dir(
    store: &PlaybackStore,
    settings: &Settings,
    id: &str,
    generation: u64,
) -> Result<PathBuf, HttpError> {
    let base = if settings.temporary_path.is_empty() {
        store.root.clone()
    } else {
        PathBuf::from(&settings.temporary_path)
    };
    let root = base.join("posterview-playback");
    std::fs::create_dir_all(&root)
        .map_err(|_| failure("Playback temporary storage is not writable."))?;
    let root = root
        .canonicalize()
        .map_err(|_| failure("Playback temporary storage is unavailable."))?;
    store
        .cache_roots
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(root.clone());
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            let dir = entry.path();
            if let Some(owner) = owned(&dir) {
                if owner.instance != store.instance {
                    #[cfg(unix)]
                    if let Some(pid) = owner.pid {
                        let args =
                            std::fs::read(format!("/proc/{pid}/cmdline")).unwrap_or_default();
                        if orphan_ffmpeg(&args, &dir.join("index.m3u8")) {
                            let _ = nix::sys::signal::kill(
                                nix::unistd::Pid::from_raw(pid as i32),
                                nix::sys::signal::Signal::SIGKILL,
                            );
                        }
                    }
                    remove_owned(&dir);
                }
            }
        }
    }
    let dir = root.join(format!("{id}.g{generation}"));
    std::fs::create_dir(&dir)
        .map_err(|_| failure("Unable to create playback generation storage."))?;
    let marker = std::fs::write(
        dir.join("owner.json"),
        serde_json::to_vec(&Owner {
            id: id.into(),
            instance: store.instance.clone(),
            pid: None,
        })
        .unwrap(),
    );
    if marker.is_err() {
        let _ = std::fs::remove_file(dir.join("owner.json"));
        let _ = std::fs::remove_dir(&dir);
        return Err(failure("Unable to mark playback storage ownership."));
    }
    Ok(dir)
}
pub(super) async fn copy_seek_start(source: &Source, position: f64) -> Result<f64, HttpError> {
    if position < 0.01 {
        return Ok(0.0);
    }
    let temp = tempfile::NamedTempFile::new()
        .map_err(|_| failure("Unable to inspect video seek point."))?;
    let mut cmd = command("ffprobe");
    cmd.args([
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-format_whitelist",
        VIDEO_DEMUXERS,
        "-select_streams",
        "v:0",
        "-read_intervals",
    ])
    .arg(format!("{position:.6}%+#1"))
    .args([
        "-show_packets",
        "-show_entries",
        "packet=pts_time,flags",
        "-of",
        "json",
    ])
    .arg(&source.path)
    .stdout(
        temp.reopen()
            .map_err(|_| failure("Unable to inspect seek point."))?,
    );
    run(&mut cmd, Duration::from_secs(15), "Video seek inspection").await?;
    if std::fs::metadata(temp.path()).map_or(true, |meta| meta.len() > 65536) {
        return Err(failure("Unexpected video seek inspection output."));
    }
    let probe: Value = serde_json::from_slice(
        &tokio::fs::read(temp.path())
            .await
            .map_err(|_| failure("Unable to read seek inspection."))?,
    )
    .map_err(|_| failure("Invalid seek inspection."))?;
    let packet = probe["packets"]
        .as_array()
        .and_then(|p| p.first())
        .ok_or_else(|| failure("No seekable video keyframe was found."))?;
    let start = number(&packet["pts_time"])
        .filter(|p| *p >= 0.0 && *p <= position)
        .ok_or_else(|| failure("No valid video seek point was found."))?;
    if !packet["flags"].as_str().is_some_and(|f| f.contains('K')) {
        return Err(failure(
            "This copied video cannot seek to that position. Retry from the beginning.",
        ));
    }
    Ok(start)
}
pub(super) fn audio_budget(plan: &planner::Plan) -> u64 {
    plan.audio.as_ref().map_or(0, |audio| {
        if plan.convert_audio {
            192_000
        } else {
            super::number(&audio["bit_rate"])
                .or_else(|| super::number(&audio["tags"]["BPS"]))
                .or_else(|| super::number(&audio["tags"]["BPS-eng"]))
                .filter(|rate| *rate > 0.0)
                .map_or(512_000, |rate| rate as u64)
        }
    })
}
pub(super) fn video_bitrate(plan: &planner::Plan) -> u64 {
    if plan.bitrate_limit > 0 {
        plan.bitrate_limit
            .saturating_sub(audio_budget(plan))
            .max(300_000)
    } else {
        match plan.height {
            0 | 2160.. => 16_000_000,
            1080.. => 8_000_000,
            720.. => 4_000_000,
            _ => 2_000_000,
        }
    }
}
pub(super) struct Delivery<'a> {
    pub(super) source: &'a Source,
    pub(super) probe: &'a Value,
    pub(super) plan: &'a planner::Plan,
    pub(super) input: &'a SessionInput,
    pub(super) settings: &'a Settings,
    pub(super) select_in_stream: bool,
}
pub(super) fn hls_command(
    delivery: &Delivery<'_>,
    encoder: Option<(&str, &str)>,
    dir: &Path,
) -> Result<Command, HttpError> {
    let Delivery {
        source,
        probe,
        plan,
        input,
        settings,
        select_in_stream,
    } = *delivery;
    let authorized = planner::plan_for_delivery(
        probe,
        &container(&source.path),
        input,
        settings,
        select_in_stream,
    )?;
    if authorized.method != plan.method
        || authorized.output_codec != plan.output_codec
        || authorized.video != plan.video
        || authorized.audio != plan.audio
        || authorized.convert_audio != plan.convert_audio
        || authorized.height != plan.height
        || authorized.bitrate_limit != plan.bitrate_limit
        || authorized.bandwidth_adaptation != plan.bandwidth_adaptation
        || authorized.hdr != plan.hdr
        || (plan.method == "transcode") != encoder.is_some()
        || plan.method == "direct"
    {
        return Err(bad(
            "Playback producer does not match the authorized delivery plan.",
        ));
    }
    let mut cmd = command("ffmpeg");
    cmd.current_dir(dir).args([
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-progress",
        "progress.txt",
        "-stats_period",
        "1",
    ]);
    if let Some((_, backend)) = encoder {
        super::hardware::hardware_input(&mut cmd, backend);
    }
    if settings.throttle {
        cmd.args([
            "-readrate",
            if cfg!(unix) && plan.method != "transcode" {
                "8"
            } else {
                "4"
            },
        ]);
    }
    cmd.args([
        "-protocol_whitelist",
        "file,pipe",
        "-format_whitelist",
        VIDEO_DEMUXERS,
        "-ss",
    ])
    .arg(format!("{:.6}", input.position_seconds))
    .arg("-i")
    .arg(&source.path)
    .arg("-map")
    .arg(format!("0:{}", plan.video["index"].as_u64().unwrap_or(0)));
    if let Some(audio) = &plan.audio {
        cmd.arg("-map")
            .arg(format!("0:{}", audio["index"].as_u64().unwrap_or(0)));
    } else {
        cmd.arg("-an");
    }
    cmd.args(["-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1"]);
    if let Some((name, backend)) = encoder {
        let mut filters = Vec::new();
        if plan.hdr {
            filters.push("zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv".to_string());
        }
        filters.push(if plan.height > 0 {
            format!(
                "scale=w='trunc(oh*dar/2)*2':h='trunc(min(ih,{})/2)*2'",
                plan.height
            )
        } else {
            "scale=w='trunc(ih*dar/2)*2':h='trunc(ih/2)*2'".into()
        });
        filters.push("setsar=1".into());
        let mut filter = filters.join(",");
        filter.push_str(super::hardware::upload(backend));
        cmd.arg("-vf").arg(filter).args([
            "-c:v",
            name,
            "-force_key_frames",
            "expr:gte(t,n_forced*2)",
        ]);
        if backend == "software" {
            cmd.args([
                "-preset",
                if name == "libsvtav1" { "8" } else { "veryfast" },
            ]);
        }
        let bitrate = video_bitrate(plan);
        cmd.arg("-b:v")
            .arg(bitrate.to_string())
            .arg("-maxrate")
            .arg(bitrate.to_string())
            .arg("-bufsize")
            .arg((bitrate * 2).to_string());
        if plan.hdr {
            cmd.args([
                "-color_primaries",
                "bt709",
                "-color_trc",
                "bt709",
                "-colorspace",
                "bt709",
            ]);
        }
        if settings.threads > 0 {
            cmd.arg("-threads").arg(settings.threads.to_string());
        }
    } else {
        cmd.args(["-c:v", "copy"]);
    }
    if plan.output_codec == "hevc" {
        cmd.args(["-tag:v", "hvc1"]);
    }
    if plan.convert_audio {
        cmd.args(["-c:a", "aac", "-ac", "2", "-b:a", "192k"]);
        if settings.audio_boost > 1.0
            && plan
                .audio
                .as_ref()
                .and_then(|audio| audio["channels"].as_u64())
                .is_some_and(|channels| channels > 2)
        {
            cmd.arg("-af")
                .arg(format!("volume={}", settings.audio_boost));
        }
    } else {
        cmd.args(["-c:a", "copy"]);
    }
    cmd.args([
        "-avoid_negative_ts",
        "make_zero",
        "-max_muxing_queue_size",
        "4096",
        "-f",
        "hls",
        "-hls_time",
        if encoder.is_some() { "2" } else { "4" },
        "-hls_playlist_type",
        "event",
        "-hls_list_size",
        "0",
        "-hls_segment_type",
        "fmp4",
        "-hls_fmp4_init_filename",
        "init.mp4",
        "-hls_flags",
        "temp_file",
        "-hls_segment_filename",
    ])
    .arg(dir.join("segment-%06d.m4s"))
    .arg(dir.join("index.m3u8"));
    Ok(cmd)
}
pub(super) async fn start(
    store: &PlaybackStore,
    id: &str,
    generation: u64,
    delivery: &Delivery<'_>,
) -> Result<(Producer, Option<String>), HttpError> {
    let Delivery {
        source: _,
        probe: _,
        plan,
        input: _,
        settings,
        select_in_stream: _,
    } = *delivery;
    store.cache_budget.store(
        u64::from(settings.cache_gb) * 1024 * 1024 * 1024,
        Ordering::Release,
    );
    let counter = store.producers.clone();
    counter
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
            (count < settings.max_concurrent.max(1)).then_some(count + 1)
        })
        .map_err(|_| HttpError {
            status: axum::http::StatusCode::TOO_MANY_REQUESTS,
            detail: "The simultaneous playback producer limit has been reached.".into(),
        })?;
    let slot = Slot(counter);
    let dir = generation_dir(store, settings, id, generation)?;
    let selected = if plan.method == "transcode" {
        match super::hardware::encoder(store, plan, settings).await {
            Ok(encoder) => Some(encoder),
            Err(error) => {
                remove_owned(&dir);
                return Err(error);
            }
        }
    } else {
        None
    };
    let result = start_process(store, id, &dir, delivery, selected.as_ref()).await;
    let (child, encoder) = match result {
        Ok(child) => (child, selected.map(|v| v.0)),
        Err(_)
            if selected.as_ref().is_some_and(|v| v.1 != "software")
                && settings.software_fallback =>
        {
            for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
                if entry.file_name() != "owner.json" {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
            let software = (
                match plan.output_codec.as_str() {
                    "hevc" => "libx265",
                    "av1" => "libsvtav1",
                    _ => "libx264",
                }
                .into(),
                "software".into(),
            );
            match start_process(store, id, &dir, delivery, Some(&software)).await {
                Ok(child) => (child, Some(software.0)),
                Err(error) => {
                    remove_owned(&dir);
                    return Err(error);
                }
            }
        }
        Err(error) => {
            remove_owned(&dir);
            return Err(error);
        }
    };
    Ok((
        Producer {
            child,
            dir,
            suspended: false,
            buffer_seconds: f64::from(settings.buffer_seconds),
            cache_bytes: u64::from(settings.cache_gb) * 1024 * 1024 * 1024,
            throttle: settings.throttle,
            _slot: Some(slot),
        },
        encoder,
    ))
}
async fn start_process(
    store: &PlaybackStore,
    id: &str,
    dir: &Path,
    delivery: &Delivery<'_>,
    encoder: Option<&(String, String)>,
) -> Result<Child, HttpError> {
    let mut cmd = hls_command(delivery, encoder.map(|v| (v.0.as_str(), v.1.as_str())), dir)?;
    let log = std::fs::File::create(dir.join("ffmpeg.log"))
        .map_err(|_| failure("Unable to create playback diagnostics."))?;
    cmd.stderr(log);
    let mut child = cmd
        .spawn()
        .map_err(|_| failure("Playback requires an available FFmpeg installation."))?;
    if std::fs::write(
        dir.join("owner.json"),
        serde_json::to_vec(&Owner {
            id: id.into(),
            instance: store.instance.clone(),
            pid: child.id(),
        })
        .unwrap(),
    )
    .is_err()
    {
        let _ = child.kill().await;
        let _ = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
        return Err(failure("Unable to mark playback process ownership."));
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        if total_bytes(store) > store.cache_budget.load(Ordering::Acquire) {
            let _ = child.kill().await;
            let _ = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
            return Err(failure(
                "Playback preparation exceeded the temporary storage limit.",
            ));
        }
        if dir.join("init.mp4").is_file()
            && manifest::playlist_seconds(&dir.join("index.m3u8")) > 0.0
        {
            return Ok(child);
        }
        if child
            .try_wait()
            .map_err(|_| failure("Playback producer status is unavailable."))?
            .is_some()
        {
            let _ = child.wait().await;
            return Err(failure(
                "FFmpeg could not start this playback stream. Check codecs, hardware and HDR tone-mapping support.",
            ));
        }
        if tokio::time::Instant::now() >= deadline {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(failure(
                "Playback preparation timed out. Check encoder performance and the source video GOP.",
            ));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn orphan_pid_must_be_ffmpeg_with_the_exact_owned_playlist() {
        let index = Path::new("/cache/owned.g1/index.m3u8");
        assert!(orphan_ffmpeg(
            b"/usr/bin/ffmpeg\0-y\0/cache/owned.g1/index.m3u8\0",
            index
        ));
        assert!(orphan_ffmpeg(
            b"ffmpeg\0/cache/owned.g1/index.m3u8\0",
            index
        ));
        for command in [
            b"/usr/bin/editor\0/cache/owned.g1/index.m3u8\0".as_slice(),
            b"ffmpeg-helper\0/cache/owned.g1/index.m3u8\0",
            b"ffmpeg\0/cache/other.g1/index.m3u8\0",
            b"ffmpeg\0/cache/owned.g1/index.m3u8.backup\0",
            b"",
        ] {
            assert!(!orphan_ffmpeg(command, index));
        }
    }
    #[test]
    fn custom_cache_only_retires_owned_jobs_and_counts_preparing_generations() {
        let directory = tempfile::tempdir().unwrap();
        let custom = directory.path().join("custom");
        std::fs::create_dir(&custom).unwrap();
        std::fs::write(custom.join("user.txt"), b"preserve").unwrap();
        let settings = Settings {
            temporary_path: custom.to_string_lossy().into_owned(),
            ..Default::default()
        };
        let store = PlaybackStore::new(directory.path());
        let id = uuid::Uuid::new_v4().to_string();
        let first = generation_dir(&store, &settings, &id, 1).unwrap();
        std::fs::write(first.join("segment-000000.m4s"), [0u8; 2048]).unwrap();
        let second =
            generation_dir(&store, &settings, &uuid::Uuid::new_v4().to_string(), 1).unwrap();
        std::fs::write(second.join("init.mp4"), [0u8; 1024]).unwrap();
        assert_eq!(
            total_bytes(&store),
            directory_bytes(&first) + directory_bytes(&second)
        );
        let unrelated = custom
            .join("posterview-playback")
            .join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir(&unrelated).unwrap();
        std::fs::write(unrelated.join("user.txt"), b"preserve").unwrap();
        let next_store = PlaybackStore::new(directory.path());
        let current = generation_dir(&next_store, &settings, &id, 2).unwrap();
        assert!(!first.exists());
        assert!(!second.exists());
        assert!(current.exists());
        assert_eq!(std::fs::read(custom.join("user.txt")).unwrap(), b"preserve");
        assert_eq!(
            std::fs::read(unrelated.join("user.txt")).unwrap(),
            b"preserve"
        );
        std::fs::write(current.join("foreign.txt"), b"preserve").unwrap();
        remove_owned(&current);
        assert!(current.join("foreign.txt").is_file());
    }
}
