//! Native delivery and session lifecycle. Planning, hardware, models, and playlists have separate owners.
mod hardware;
mod manifest;
mod models;
mod planner;
#[cfg(test)]
mod test_support;
pub(crate) use hardware::capabilities;
use hardware::{encoder, hardware_input, upload, Encoder};
use manifest::{playlist_seconds, prune_consumed, rolling_manifest};
use models::{Chapter, Font, Info, NextItem, SessionInput, SessionResponse, Track};
use planner::{plan, selected_stream, Plan};

use crate::{transcoding::Settings, AppState, HttpError};
use axum::{
    extract::{Path, Request, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use posterview_contracts::native::NativeCatalogEntry;
use posterview_infra_sqlite::ServerStore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Component, Path as FsPath, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::{
    process::{Child, Command},
    sync::{Mutex, Semaphore},
};
use tower::ServiceExt;
use tower_http::services::ServeFile;

const MAX_PROBE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_SUBTITLE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_FONT_BYTES: u64 = 32 * 1024 * 1024;
const SESSION_IDLE: Duration = Duration::from_secs(90);
const MAX_SESSIONS: usize = 64;
const MAX_PLAYBACK_SECONDS: f64 = 7.0 * 86_400.0;
const VIDEO_DEMUXERS: &str = "mov,matroska,webm,avi,asf,mpeg,mpegts,ogg,mpegvideo";

fn bad(message: impl Into<String>) -> HttpError {
    HttpError::bad_request(message)
}
fn failure(message: impl Into<String>) -> HttpError {
    HttpError::bad_gateway(message)
}
fn number(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str()?.parse().ok())
        .filter(|n| n.is_finite())
}
fn stamp(path: &FsPath) -> Result<(u64, u128), HttpError> {
    let meta = std::fs::metadata(path).map_err(|_| bad("This video is no longer available."))?;
    if !meta.is_file() {
        return Err(bad("This video is no longer available."));
    }
    Ok((
        meta.len(),
        meta.modified()
            .ok()
            .and_then(|v| v.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |v| v.as_nanos()),
    ))
}

struct Source {
    library_id: String,
    item: NativeCatalogEntry,
    path: PathBuf,
    fingerprint: (u64, u128),
    series_title: Option<String>,
    next: Option<NextItem>,
}

fn safe_source_path(
    root: &FsPath,
    relative: &str,
    library_paths: &[String],
) -> Result<PathBuf, HttpError> {
    if relative.is_empty()
        || relative.contains(['\\', ':', '\0'])
        || FsPath::new(relative)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(bad("Invalid catalog video path."));
    }
    let path = root
        .join(relative)
        .canonicalize()
        .map_err(|_| bad("Video file is unavailable."))?;
    if !path.starts_with(root) || !path.is_file() {
        return Err(bad("Video must be inside the configured media folder."));
    }
    if ![
        "mkv", "mp4", "m4v", "mov", "webm", "avi", "wmv", "mpg", "mpeg", "ts", "m2ts", "mts",
        "vob", "ogv",
    ]
    .contains(&container(&path).as_str())
    {
        return Err(bad("This file is not a supported local video container."));
    }
    let roots = if library_paths.is_empty() {
        vec![root.to_path_buf()]
    } else {
        library_paths
            .iter()
            .filter_map(|p| root.join(p).canonicalize().ok())
            .collect::<Vec<_>>()
    };
    if !roots
        .iter()
        .any(|allowed| allowed.starts_with(root) && path.starts_with(allowed))
    {
        return Err(bad("Video must be inside this library."));
    }
    Ok(path)
}
async fn source(state: &AppState, library: String, item: String) -> Result<Source, HttpError> {
    let state = state.clone();
    tokio::task::spawn_blocking(move || {
        let db = ServerStore::new(state.runtime.data_dir());
        let lib = db
            .native_libraries()
            .map_err(|_| failure("Unable to load library."))?
            .into_iter()
            .find(|l| l.id == library)
            .ok_or_else(HttpError::not_found)?;
        let entry = db
            .native_catalog_item(&library, &item)
            .map_err(|_| failure("Unable to load video."))?
            .filter(|e| {
                e.available
                    && matches!(e.kind.as_str(), "episode" | "movie")
                    && e.metadata["missing"] != true
            })
            .ok_or_else(|| bad("Choose an available episode or movie."))?;
        let file = entry
            .files
            .iter()
            .find_map(|f| f["path"].as_str())
            .ok_or_else(|| bad("This title has no playable video file. Run Scan Library Files."))?;
        let root = state.metadata.directory("", true)?;
        let path = safe_source_path(&root, file, &lib.paths)?;
        let fingerprint = stamp(&path)?;
        let parent = if entry.kind == "episode" {
            entry
                .parent_path
                .as_deref()
                .map(|path| db.native_catalog_path(&library, path))
                .transpose()
                .map_err(|_| failure("Unable to load the episode parent."))?
                .flatten()
        } else {
            None
        };
        let series = if let Some(parent) = &parent {
            if parent.kind == "series" {
                Some(parent.clone())
            } else {
                parent
                    .parent_path
                    .as_deref()
                    .map(|path| db.native_catalog_path(&library, path))
                    .transpose()
                    .map_err(|_| failure("Unable to load the episode series."))?
                    .flatten()
            }
        } else {
            None
        };
        // Playback, subtitles and fonts must not deserialize unrelated series in the library.
        // The scoped subtree also retains next-episode navigation across seasons.
        let catalog = if let Some(series) = &series {
            db.native_catalog_scoped(&library, Some(std::slice::from_ref(&series.path)))
                .map_err(|_| failure("Unable to load episodes."))?
        } else if entry.kind == "episode" {
            entry
                .parent_path
                .as_deref()
                .map(|path| db.native_catalog_children(&library, path))
                .transpose()
                .map_err(|_| failure("Unable to load episodes."))?
                .unwrap_or_default()
        } else {
            vec![]
        };
        let series_parents = series.as_ref().map(|series| {
            std::iter::once(series.path.as_str())
                .chain(
                    catalog
                        .iter()
                        .filter(|candidate| {
                            candidate.parent_path.as_deref() == Some(series.path.as_str())
                        })
                        .map(|candidate| candidate.path.as_str()),
                )
                .collect::<std::collections::HashSet<_>>()
        });
        let mut episodes = catalog
            .iter()
            .filter(|e| {
                e.available && e.kind == "episode" && e.metadata["missing"] != true && {
                    if let Some(parents) = &series_parents {
                        e.parent_path
                            .as_deref()
                            .is_some_and(|path| parents.contains(path))
                    } else {
                        e.parent_path == entry.parent_path && entry.parent_path.is_some()
                    }
                }
            })
            .collect::<Vec<_>>();
        episodes.sort_by_key(|e| {
            (
                e.metadata["season"].as_i64().unwrap_or(0),
                e.metadata["episode"].as_i64().unwrap_or(0),
                e.path.clone(),
            )
        });
        let next = episodes
            .iter()
            .position(|e| e.id == item)
            .and_then(|i| episodes.get(i + 1))
            .map(|e| NextItem {
                library_id: library.clone(),
                item_id: e.id.clone(),
                title: e.title.clone(),
            });
        Ok(Source {
            library_id: library,
            item: entry.clone(),
            path,
            fingerprint,
            series_title: series.map(|s| s.title),
            next,
        })
    })
    .await
    .map_err(|_| failure("Video lookup was interrupted."))?
}

struct ProbeCache {
    stamp: (u64, u128),
    probe: Value,
    used: Instant,
}
type ResourceKey = (PathBuf, u64, u128, u32, String);
struct ResourceCache {
    path: PathBuf,
    bytes: u64,
    used: Instant,
}
#[derive(Serialize, Deserialize)]
struct SessionOwner {
    id: String,
    instance: String,
    pid: Option<u32>,
}
struct Session {
    library_id: String,
    item_id: String,
    source: PathBuf,
    stamp: (u64, u128),
    directory: Option<PathBuf>,
    response: SessionResponse,
    child: Option<Child>,
    touched: Instant,
    position: f64,
    buffer_seconds: u32,
    paused: bool,
    suspended: bool,
    cache_limit: u64,
    error: Option<String>,
}
fn throttle_actions(buffer_seconds: u32, paused: bool, lead: f64) -> (bool, bool) {
    let cap = f64::from(buffer_seconds);
    (
        lead > cap || (paused && lead > 12.0),
        !paused && lead < cap * 0.5,
    )
}
pub(crate) struct PlaybackStore {
    root: PathBuf,
    instance: String,
    sessions: Mutex<HashMap<String, Session>>,
    probes: Mutex<HashMap<PathBuf, ProbeCache>>,
    hardware: Mutex<HashMap<String, (Instant, Encoder)>>,
    resources: Mutex<HashMap<ResourceKey, ResourceCache>>,
    jobs: Arc<Semaphore>,
    started: AtomicBool,
}
impl PlaybackStore {
    pub(crate) fn new(data_dir: &FsPath) -> Self {
        let root = data_dir.join("playback");
        // Resource cache names are generated UUIDs; retire only our own files on startup.
        if let Ok(files) = std::fs::read_dir(root.join("resources")) {
            for entry in files.flatten() {
                if entry
                    .path()
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .is_some_and(|s| uuid::Uuid::parse_str(s).is_ok())
                    && entry.file_type().is_ok_and(|t| t.is_file())
                {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
        let instance = uuid::Uuid::new_v4().to_string();
        retire_orphans(&root.join("posterview-playback"), &instance);
        Self {
            root,
            instance,
            sessions: Mutex::new(HashMap::new()),
            probes: Mutex::new(HashMap::new()),
            hardware: Mutex::new(HashMap::new()),
            resources: Mutex::new(HashMap::new()),
            jobs: Arc::new(Semaphore::new(2)),
            started: AtomicBool::new(false),
        }
    }
    pub(crate) fn start_cleanup(self: &Arc<Self>) {
        if self.started.swap(true, Ordering::Relaxed) {
            return;
        }
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(1));
            loop {
                interval.tick().await;
                let Some(store) = weak.upgrade() else {
                    break;
                };
                store.maintain().await;
            }
        });
    }
    pub(crate) async fn session_details(&self, id: &str) -> Option<(String, String, f64)> {
        self.sessions.lock().await.get(id).map(|s| {
            (
                s.library_id.clone(),
                s.item_id.clone(),
                s.response.duration_seconds,
            )
        })
    }
    async fn stop_id(&self, id: &str) {
        let removed = self.sessions.lock().await.remove(id);
        if let Some(mut s) = removed {
            if let Some(child) = &mut s.child {
                let _ = child.kill().await;
                let _ = child.wait().await;
            }
            if let Some(dir) = &s.directory {
                let _ = tokio::fs::remove_dir_all(dir).await;
            }
        }
    }
    async fn maintain(&self) {
        let mut expired = vec![];
        let mut sessions = self.sessions.lock().await;
        for s in sessions.values() {
            if let Some(dir) = &s.directory {
                prune_consumed(dir, (s.position - s.response.offset_seconds).max(0.0));
            }
        }
        let roots = sessions
            .values()
            .filter_map(|s| {
                s.directory
                    .as_ref()
                    .and_then(|p| p.parent())
                    .map(FsPath::to_path_buf)
            })
            .collect::<std::collections::HashSet<_>>();
        let mut total: u64 = roots
            .iter()
            .map(|root| owned_cache_bytes(root))
            .sum::<u64>()
            + directory_bytes(&self.root.join("resources"));
        let limit = sessions
            .values()
            .filter(|s| s.directory.is_some())
            .map(|s| s.cache_limit)
            .min()
            .unwrap_or(u64::MAX);
        let mut large = sessions
            .iter()
            .filter_map(|(id, s)| {
                s.directory
                    .as_ref()
                    .map(|dir| (id.clone(), directory_bytes(dir)))
            })
            .collect::<Vec<_>>();
        large.sort_by_key(|(_, size)| std::cmp::Reverse(*size));
        for (id, size) in large {
            if total <= limit {
                break;
            }
            expired.push(id);
            total = total.saturating_sub(size);
        }
        for (id, s) in sessions.iter_mut() {
            if s.touched.elapsed() > SESSION_IDLE || expired.contains(id) {
                if !expired.contains(id) {
                    expired.push(id.clone());
                }
                continue;
            }
            if let Some(child) = &mut s.child {
                if let Some(status) = child.try_wait().ok().flatten() {
                    if !status.success() {
                        s.error=Some("The playback conversion process stopped unexpectedly. Reopen the player or choose a different quality.".into());
                    }
                    s.child = None;
                    s.suspended = false;
                    continue;
                }
                if s.buffer_seconds > 0 {
                    let generated = s
                        .directory
                        .as_ref()
                        .map_or(0.0, |d| playlist_seconds(&d.join("index.m3u8")))
                        + s.response.offset_seconds;
                    let lead = generated - s.position;
                    let (suspend, resume) = throttle_actions(s.buffer_seconds, s.paused, lead);
                    if let Some(pid) = child.id() {
                        if suspend && !s.suspended && signal(pid, false).await {
                            s.suspended = true;
                        } else if resume && s.suspended && signal(pid, true).await {
                            s.suspended = false;
                        }
                    }
                }
            }
        }
        drop(sessions);
        for id in expired {
            self.stop_id(&id).await;
        }
    }
    async fn probe(&self, source: &Source) -> Result<Value, HttpError> {
        {
            let mut cache = self.probes.lock().await;
            if let Some(cached) = cache
                .get_mut(&source.path)
                .filter(|c| c.stamp == source.fingerprint)
            {
                cached.used = Instant::now();
                return Ok(cached.probe.clone());
            }
        }
        let _permit = self
            .jobs
            .acquire()
            .await
            .map_err(|_| failure("Media inspection was interrupted."))?;
        let temp = tempfile::NamedTempFile::new()
            .map_err(|_| failure("Unable to create media inspection output."))?;
        let mut cmd = command("ffprobe");
        cmd.args([
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-format_whitelist",
            VIDEO_DEMUXERS,
            "-show_streams",
            "-show_format",
            "-show_chapters",
            "-of",
            "json",
        ])
        .arg(&source.path)
        .stdout(
            temp.reopen()
                .map_err(|_| failure("Unable to inspect media."))?,
        );
        run(&mut cmd, Duration::from_secs(30), "Media inspection").await?;
        if std::fs::metadata(temp.path()).map_or(true, |m| m.len() > MAX_PROBE_BYTES) {
            return Err(failure("Media inspection output is too large."));
        }
        let bytes = tokio::fs::read(temp.path())
            .await
            .map_err(|_| failure("Unable to read media inspection output."))?;
        let probe: Value = serde_json::from_slice(&bytes)
            .map_err(|_| failure("Invalid media inspection result."))?;
        let mut cache = self.probes.lock().await;
        if cache.len() >= 128 {
            if let Some(old) = cache
                .iter()
                .min_by_key(|(_, c)| c.used)
                .map(|(p, _)| p.clone())
            {
                cache.remove(&old);
            }
        }
        cache.insert(
            source.path.clone(),
            ProbeCache {
                stamp: source.fingerprint,
                probe: probe.clone(),
                used: Instant::now(),
            },
        );
        Ok(probe)
    }
}
fn directory_bytes(path: &FsPath) -> u64 {
    std::fs::read_dir(path)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.metadata().ok())
        .map(|m| m.len())
        .sum()
}
fn owned_directory(root: &FsPath, path: &FsPath) -> Option<SessionOwner> {
    let name = path.file_name()?.to_str()?;
    uuid::Uuid::parse_str(name).ok()?;
    if path.parent()? != root
        || std::fs::symlink_metadata(path)
            .ok()?
            .file_type()
            .is_symlink()
        || !path.is_dir()
    {
        return None;
    }
    let marker = path.join("owner.json");
    let meta = std::fs::symlink_metadata(&marker).ok()?;
    if !meta.is_file() || meta.len() > 1024 {
        return None;
    }
    let owner: SessionOwner = serde_json::from_slice(&std::fs::read(marker).ok()?).ok()?;
    if owner.id != name {
        return None;
    }
    // Never recursively remove a folder with unexpected files or nested directories.
    for entry in std::fs::read_dir(path).ok()?.flatten() {
        let kind = entry.file_type().ok()?;
        let name = entry.file_name();
        let name = name.to_str()?;
        let font = name
            .strip_prefix("font-")
            .and_then(|s| s.strip_suffix(".ttf"))
            .is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()));
        if !kind.is_file()
            || !(name == "owner.json"
                || matches!(name, "burn.ass" | "burn.vtt")
                || font
                || safe_segment(name)
                || name.strip_suffix(".tmp").is_some_and(safe_segment))
        {
            return None;
        }
    }
    Some(owner)
}
fn owned_cache_bytes(root: &FsPath) -> u64 {
    std::fs::read_dir(root)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|path| owned_directory(root, path).is_some())
        .map(|path| directory_bytes(&path))
        .sum()
}
fn retire_orphans(root: &FsPath, instance: &str) {
    let Ok(root) = root.canonicalize() else {
        return;
    };
    for entry in std::fs::read_dir(&root)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
    {
        let path = entry.path();
        let Some(owner) = owned_directory(&root, &path) else {
            continue;
        };
        if owner.instance == instance {
            continue;
        }
        #[cfg(target_os = "linux")]
        if let Some(pid) = owner.pid {
            // Protect against PID reuse: both FFmpeg and this exact generated output
            // path must be in the process argument vector before sending a signal.
            if let Ok(args) = std::fs::read(format!("/proc/{pid}/cmdline")) {
                let argv = args
                    .split(|b| *b == 0)
                    .filter_map(|b| std::str::from_utf8(b).ok())
                    .collect::<Vec<_>>();
                if argv
                    .first()
                    .is_some_and(|v| FsPath::new(v).file_stem().is_some_and(|v| v == "ffmpeg"))
                    && argv
                        .iter()
                        .any(|v| FsPath::new(v) == path.join("index.m3u8"))
                {
                    let _ = nix::sys::signal::kill(
                        nix::unistd::Pid::from_raw(pid as i32),
                        nix::sys::signal::Signal::SIGKILL,
                    );
                }
            }
        }
        // Resolved absolute target, UUID owner marker, expected flat files only.
        let _ = std::fs::remove_dir_all(&path);
    }
}
async fn signal(pid: u32, resume: bool) -> bool {
    // No unsafe platform calls: only signal the ID of an owned live FFmpeg child.
    #[cfg(unix)]
    {
        nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(pid as i32),
            if resume {
                nix::sys::signal::Signal::SIGCONT
            } else {
                nix::sys::signal::Signal::SIGSTOP
            },
        )
        .is_ok()
    }
    #[cfg(not(unix))]
    {
        let _ = (pid, resume);
        false
    }
}
fn command(binary: &str) -> Command {
    let mut cmd = Command::new(binary);
    cmd.kill_on_drop(true)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    cmd
}
async fn run(cmd: &mut Command, timeout: Duration, label: &str) -> Result<(), HttpError> {
    let mut child = cmd.spawn().map_err(|_| {
        failure(format!(
            "{label} requires an available FFmpeg installation."
        ))
    })?;
    match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) if status.success() => Ok(()),
        Ok(_) => Err(failure(format!(
            "{label} failed. Check the selected codec, file, and server FFmpeg support."
        ))),
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            Err(failure(format!("{label} timed out.")))
        }
    }
}

fn tracks(probe: &Value, source: &Source) -> Vec<Track> {
    probe["streams"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| {
            let kind = s["codec_type"].as_str()?;
            if !["video", "audio", "subtitle"].contains(&kind)
                || s["disposition"]["attached_pic"] == 1
            {
                return None;
            }
            let index = s["index"].as_u64()? as u32;
            let codec = s["codec_name"].as_str().unwrap_or("unknown").to_string();
            let subtitle_format = (kind == "subtitle").then(|| {
                if ["ass", "ssa"].contains(&codec.as_str()) {
                    "ass"
                } else if ["subrip", "webvtt", "mov_text", "text", "srt"].contains(&codec.as_str())
                {
                    "vtt"
                } else {
                    "image"
                }
                .to_string()
            });
            let url = subtitle_format
                .as_ref()
                .filter(|v| v.as_str() != "image")
                .map(|_| {
                    format!(
                        "/api/playback/native/{}/{}/subtitles/{index}",
                        source.library_id, source.item.id
                    )
                });
            Some(Track {
                index,
                kind: kind.into(),
                codec,
                language: s["tags"]["language"].as_str().map(String::from),
                title: s["tags"]["title"].as_str().map(String::from),
                profile: s["profile"].as_str().map(String::from),
                is_default: s["disposition"]["default"] == 1,
                forced: s["disposition"]["forced"] == 1,
                hearing_impaired: s["disposition"]["hearing_impaired"] == 1,
                channels: s["channels"].as_u64().map(|n| n as u32),
                width: s["width"].as_u64().map(|n| n as u32),
                height: s["height"].as_u64().map(|n| n as u32),
                bit_depth: number(&s["bits_per_raw_sample"])
                    .filter(|n| *n > 0.0)
                    .map(|n| n as u32)
                    .or_else(|| {
                        s["pix_fmt"].as_str().map(|p| {
                            if p.contains("p10") || p.contains("p010") {
                                10
                            } else if p.contains("p12") || p.contains("p012") {
                                12
                            } else if p.contains("p16") || p.contains("p016") {
                                16
                            } else {
                                8
                            }
                        })
                    }),
                pixel_format: s["pix_fmt"].as_str().map(String::from),
                bitrate: number(&s["bit_rate"])
                    .or_else(|| number(&probe["format"]["bit_rate"]))
                    .filter(|n| *n > 0.0)
                    .map(|n| n as u64),
                frame_rate: s["avg_frame_rate"].as_str().and_then(|rate| {
                    let (a, b) = rate.split_once('/')?;
                    let a = a.parse::<f64>().ok()?;
                    let b = b.parse::<f64>().ok()?;
                    let rate = a / b;
                    (rate.is_finite() && rate > 0.0).then_some(rate)
                }),
                subtitle_format,
                url,
            })
        })
        .collect()
}
fn duration(probe: &Value) -> f64 {
    number(&probe["format"]["duration"])
        .filter(|n| *n > 0.0)
        .or_else(|| {
            probe["streams"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|stream| matches!(stream["codec_type"].as_str(), Some("video" | "audio")))
                .filter_map(|stream| number(&stream["duration"]).filter(|seconds| *seconds > 0.0))
                .max_by(f64::total_cmp)
        })
        .unwrap_or(0.0)
}
fn source_bitrate(probe: &Value) -> Option<u64> {
    let bitrate = |value: &Value| {
        number(value)
            .filter(|rate| *rate >= 1.0 && *rate < u64::MAX as f64)
            .map(|rate| rate as u64)
    };
    bitrate(&probe["format"]["bit_rate"])
        .or_else(|| {
            let bytes = number(&probe["format"]["size"])?;
            let seconds = duration(probe);
            let rate = bytes * 8.0 / seconds;
            (bytes > 0.0
                && seconds > 0.0
                && rate.is_finite()
                && rate >= 1.0
                && rate < u64::MAX as f64)
                .then_some(rate as u64)
        })
        .or_else(|| {
            let mut streams = probe["streams"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|stream| {
                    matches!(stream["codec_type"].as_str(), Some("video" | "audio"))
                        && stream["disposition"]["attached_pic"] != 1
                });
            let first = bitrate(&streams.next()?["bit_rate"])?;
            streams.try_fold(first, |total, stream| {
                total.checked_add(bitrate(&stream["bit_rate"])?)
            })
        })
}
fn container(path: &FsPath) -> String {
    path.extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}
fn font_stream(s: &Value) -> bool {
    s["codec_type"] == "attachment"
        && (matches!(s["codec_name"].as_str(), Some("ttf" | "otf"))
            || s["tags"]["mimetype"].as_str().is_some_and(|v| {
                [
                    "application/x-truetype-font",
                    "application/x-font-ttf",
                    "application/vnd.ms-opentype",
                    "application/x-font-opentype",
                    "font/ttf",
                    "font/otf",
                    "application/font-sfnt",
                ]
                .contains(&v)
            }))
}
pub(crate) async fn info(
    State(state): State<AppState>,
    Path((library, item)): Path<(String, String)>,
) -> Result<Json<Info>, HttpError> {
    let source = source(&state, library, item).await?;
    let probe = state.playback.probe(&source).await?;
    let settings = crate::transcoding::load(&state)?;
    let chapters = probe["chapters"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| {
            Some(Chapter {
                title: c["tags"]["title"].as_str().unwrap_or("Chapter").to_string(),
                start_seconds: number(&c["start_time"])?,
            })
        })
        .filter(|c| c.start_seconds >= 0.0)
        .take(2048)
        .collect();
    let fonts = if settings.font_extraction {
        probe["streams"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|s| font_stream(s))
            .filter_map(|s| {
                let index = s["index"].as_u64()? as u32;
                Some(Font {
                    index,
                    name: s["tags"]["filename"]
                        .as_str()
                        .unwrap_or("Embedded font")
                        .to_string(),
                    url: format!(
                        "/api/playback/native/{}/{}/fonts/{index}",
                        source.library_id, source.item.id
                    ),
                })
            })
            .take(128)
            .collect()
    } else {
        vec![]
    };
    Ok(Json(Info {
        library_id: source.library_id.clone(),
        item_id: source.item.id.clone(),
        title: source.item.title.clone(),
        series_title: source.series_title.clone(),
        overview: source.item.metadata["plot"]
            .as_str()
            .or_else(|| source.item.metadata["overview"].as_str())
            .map(String::from),
        season: source.item.metadata["season"].as_i64(),
        episode: source.item.metadata["episode"].as_i64(),
        poster_url: source
            .item
            .artwork
            .iter()
            .find(|a| matches!(a.kind.as_str(), "thumb" | "landscape" | "poster"))
            .map(|a| {
                format!(
                    "/api/native/libraries/{}/items/{}/artwork/{}",
                    source.library_id, source.item.id, a.kind
                )
            }),
        duration_seconds: duration(&probe),
        conversion_allowed: settings.allow_conversion,
        audio_conversion_allowed: settings.allow_conversion || settings.allow_audio_transcoding,
        bandwidth_adaptation_allowed: settings.auto_bandwidth_transcoding,
        source_bitrate: source_bitrate(&probe),
        remux_allowed: settings.allow_remux || settings.allow_conversion,
        container: container(&source.path),
        tracks: tracks(&probe, &source),
        chapters,
        fonts,
        next: source.next.clone(),
    }))
}

async fn copy_seek_start(source: &Source, position: f64) -> Result<f64, HttpError> {
    if position < 0.01 {
        return Ok(0.0);
    }
    let temp = tempfile::NamedTempFile::new()
        .map_err(|_| failure("Unable to inspect the video seek point."))?;
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
            .map_err(|_| failure("Unable to inspect video seek point."))?,
    );
    run(&mut cmd, Duration::from_secs(15), "Video seek inspection").await?;
    if std::fs::metadata(temp.path()).map_or(true, |m| m.len() > 65536) {
        return Err(failure("Unexpected seek inspection output."));
    }
    let result: Value = serde_json::from_slice(
        &tokio::fs::read(temp.path())
            .await
            .map_err(|_| failure("Unable to read seek point."))?,
    )
    .map_err(|_| failure("Invalid seek inspection result."))?;
    let packet = result["packets"]
        .as_array()
        .and_then(|p| p.first())
        .ok_or_else(|| failure("This video did not provide a seekable keyframe."))?;
    let start = number(&packet["pts_time"])
        .filter(|s| *s >= 0.0 && *s <= position)
        .ok_or_else(|| failure("This video did not provide a valid seek point."))?;
    if !packet["flags"].as_str().is_some_and(|f| f.contains('K')) {
        return Err(failure(
            "This video cannot be remuxed from the requested position. Select a transcoding quality to seek accurately.",
        ));
    }
    Ok(start)
}
fn session_dir(store: &PlaybackStore, settings: &Settings, id: &str) -> Result<PathBuf, HttpError> {
    let base = if settings.temporary_path.is_empty() {
        store.root.clone()
    } else {
        PathBuf::from(&settings.temporary_path)
    };
    let root = base.join("posterview-playback");
    std::fs::create_dir_all(&root)
        .map_err(|_| failure("The transcoding temporary folder is not writable."))?;
    let root = root
        .canonicalize()
        .map_err(|_| failure("The transcoding temporary folder is unavailable."))?;
    retire_orphans(&root, &store.instance);
    let dir = root.join(id);
    std::fs::create_dir(&dir)
        .map_err(|_| failure("Unable to create the playback session folder."))?;
    std::fs::write(
        dir.join("owner.json"),
        serde_json::to_vec(&SessionOwner {
            id: id.into(),
            instance: store.instance.clone(),
            pid: None,
        })
        .map_err(|_| failure("Unable to mark playback folder ownership."))?,
    )
    .map_err(|_| failure("Unable to mark playback folder ownership."))?;
    Ok(dir)
}
fn write_owner(
    store: &PlaybackStore,
    id: &str,
    dir: &FsPath,
    pid: Option<u32>,
) -> Result<(), HttpError> {
    std::fs::write(
        dir.join("owner.json"),
        serde_json::to_vec(&SessionOwner {
            id: id.into(),
            instance: store.instance.clone(),
            pid,
        })
        .map_err(|_| failure("Unable to update playback folder ownership."))?,
    )
    .map_err(|_| failure("Unable to update playback folder ownership."))
}
fn burn_filter(probe: &Value, index: u32) -> Result<String, HttpError> {
    let track = selected_stream(probe, "subtitle", Some(index))?
        .ok_or_else(|| bad("Selected subtitle track is unavailable."))?;
    // Cached subtitles and fonts are copied into the session under fixed ASCII
    // names. Neither a source path nor user text enters FFmpeg's filter grammar.
    Ok(format!(
        "subtitles=filename={}:fontsdir=.",
        if matches!(track["codec_name"].as_str(), Some("ass" | "ssa")) {
            "burn.ass"
        } else {
            "burn.vtt"
        }
    ))
}
async fn prepare_burn(
    store: &PlaybackStore,
    source: &Source,
    probe: &Value,
    input: &SessionInput,
    settings: &Settings,
) -> Result<Vec<(String, Vec<u8>)>, HttpError> {
    let Some(index) = input.subtitle_burn_index else {
        return Ok(vec![]);
    };
    let track = selected_stream(probe, "subtitle", Some(index))?
        .ok_or_else(|| bad("Selected subtitle track is unavailable."))?;
    if matches!(
        track["codec_name"].as_str(),
        Some("hdmv_pgs_subtitle" | "dvd_subtitle" | "dvb_subtitle" | "xsub")
    ) {
        return Ok(vec![]);
    }
    let format = if matches!(track["codec_name"].as_str(), Some("ass" | "ssa")) {
        "ass"
    } else if matches!(
        track["codec_name"].as_str(),
        Some("subrip" | "webvtt" | "mov_text" | "text" | "srt")
    ) {
        "vtt"
    } else {
        return Err(bad(
            "This subtitle codec cannot be rendered. Select another subtitle track.",
        ));
    };
    let bytes = extracted_resource(store, source, index, format).await?;
    let mut total = bytes.len();
    let mut resources = vec![(format!("burn.{format}"), bytes)];
    if format == "ass" && settings.font_extraction {
        for stream in probe["streams"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|s| font_stream(s))
            .take(128)
        {
            if stream["extradata_size"]
                .as_u64()
                .is_some_and(|n| n >= MAX_FONT_BYTES)
            {
                return Err(bad("An embedded subtitle font exceeds the 32 MB limit."));
            }
            let Some(index) = stream["index"].as_u64() else {
                continue;
            };
            let font = extracted_resource(store, source, index as u32, "font").await?;
            total += font.len();
            if total > 64 * 1024 * 1024 {
                return Err(bad(
                    "Subtitle fonts and text exceed the 64 MB rendering limit.",
                ));
            }
            resources.push((format!("font-{index}.ttf"), font));
        }
    }
    Ok(resources)
}
async fn write_burn(dir: &FsPath, resources: &[(String, Vec<u8>)]) -> Result<(), HttpError> {
    for (name, bytes) in resources {
        tokio::fs::write(dir.join(name), bytes)
            .await
            .map_err(|_| failure("Unable to prepare rendered subtitles."))?;
    }
    Ok(())
}
fn throttled_readrate(method: &str, unix: bool) -> &'static str {
    if !unix {
        "1"
    } else if matches!(method, "remux" | "audio_transcode") {
        "8"
    } else {
        "4"
    }
}
fn hls_command(
    source: &Source,
    probe: &Value,
    plan: &Plan,
    input: &SessionInput,
    settings: &Settings,
    encoder: Option<(&str, &str)>,
    dir: &FsPath,
) -> Result<Command, HttpError> {
    // Revalidate policy before every initial/fallback process command. Internal
    // retries cannot turn an audio-only or bandwidth grant into broad encoding.
    let authorized = self::plan(probe, &container(&source.path), input, settings)?;
    if !matches!(plan.method, "remux" | "audio_transcode" | "transcode")
        || authorized.method != plan.method
        || authorized.convert_audio != plan.convert_audio
        || authorized.output_codec != plan.output_codec
        || authorized.height != plan.height
        || authorized.hdr != plan.hdr
        || authorized.video != plan.video
        || authorized.audio != plan.audio
        || authorized.bitrate_limit != plan.bitrate_limit
        || authorized.bandwidth_adaptation != plan.bandwidth_adaptation
        || (plan.method == "transcode") != encoder.is_some()
    {
        return Err(bad(
            "The playback command does not match its authorized source, codec, or bandwidth plan.",
        ));
    }
    let mut cmd = command("ffmpeg");
    cmd.current_dir(dir)
        .args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y"]);
    if let Some((_, backend)) = encoder {
        hardware_input(&mut cmd, backend);
    }
    // -readrate is supported by the Debian FFmpeg shipped in the runtime image.
    // Initial-burst options require newer FFmpeg and must not be assumed available.
    if settings.throttle {
        // Copied video can fill its first source-GOP segment sooner without a
        // video encode. Unix suspension still enforces the configured lead cap.
        cmd.args(["-readrate", throttled_readrate(plan.method, cfg!(unix))]);
    }
    let image_subtitle = input
        .subtitle_burn_index
        .and_then(|index| {
            selected_stream(probe, "subtitle", Some(index))
                .ok()
                .flatten()
        })
        .is_some_and(|s| {
            matches!(
                s["codec_name"].as_str(),
                Some("hdmv_pgs_subtitle" | "dvd_subtitle" | "dvb_subtitle" | "xsub")
            )
        });
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
    .arg(if image_subtitle {
        "[pvout]".to_string()
    } else {
        format!("0:{}", plan.video["index"].as_u64().unwrap_or(0))
    });
    if let Some(audio) = &plan.audio {
        cmd.arg("-map")
            .arg(format!("0:{}", audio["index"].as_u64().unwrap_or(0)));
    } else {
        cmd.arg("-an");
    }
    cmd.args(["-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1"]);
    if let Some((name, backend)) = encoder {
        let mut filters = vec![];
        if plan.hdr {
            filters.push("zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv".to_string());
        }
        if let Some(index) = input.subtitle_burn_index.filter(|_| !image_subtitle) {
            // libass reads the complete source subtitle timeline, while the seeked
            // decoded video starts at zero. Render at source time and restore zero.
            filters.push(format!("setpts=PTS+{:.6}/TB", input.position_seconds));
            filters.push(burn_filter(probe, index)?);
            filters.push(format!("setpts=PTS-{:.6}/TB", input.position_seconds));
        }
        if plan.height > 0 {
            filters.push(format!(
                "scale=w='trunc(oh*dar/2)*2':h='trunc(min(ih,{})/2)*2'",
                plan.height
            ));
        } else {
            filters.push("scale=w='trunc(ih*dar/2)*2':h='trunc(ih/2)*2'".into());
        }
        filters.push("setsar=1".into());
        let tone = if image_subtitle && plan.hdr {
            Some(filters.remove(0))
        } else {
            None
        };
        let mut filter = filters.join(",");
        filter.push_str(upload(backend));
        if image_subtitle {
            let index = input.subtitle_burn_index.unwrap();
            let video = plan.video["index"].as_u64().unwrap_or(0);
            // FFmpeg's sub2video bridge decodes PGS/DVD bitmap events and feeds overlay.
            let graph = if let Some(tone) = tone {
                format!(
                    "[0:{video}]{tone}[toned];[toned][0:{index}]overlay=eof_action=pass:shortest=0,{filter}[pvout]"
                )
            } else {
                format!("[0:{video}][0:{index}]overlay=eof_action=pass:shortest=0,{filter}[pvout]")
            };
            cmd.arg("-filter_complex").arg(graph);
        } else {
            cmd.arg("-vf").arg(filter);
        }
        cmd.args(["-c:v", name, "-force_key_frames", "expr:gte(t,n_forced*2)"]);
        if backend == "software" {
            cmd.args([
                "-preset",
                if name == "libsvtav1" { "8" } else { "veryfast" },
            ]);
        }
        let bitrate = if plan.bitrate_limit > 0 {
            let audio_budget = if plan.audio.is_some() { 192_000 } else { 0 };
            plan.bitrate_limit.saturating_sub(audio_budget).max(300_000)
        } else {
            match plan.height {
                0 | 2160.. => 16_000_000,
                1080.. => 8_000_000,
                720.. => 4_000_000,
                _ => 2_000_000,
            }
        };
        cmd.arg("-b:v")
            .arg(bitrate.to_string())
            .arg("-maxrate")
            .arg(bitrate.to_string())
            .arg("-bufsize")
            .arg((bitrate * 2).to_string());
        if plan.output_codec == "hevc" {
            cmd.args(["-tag:v", "hvc1"]);
        }
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
        if plan.video["codec_name"] == "hevc" {
            cmd.args(["-tag:v", "hvc1"]);
        }
    }
    if plan.convert_audio {
        cmd.args(["-c:a", "aac", "-ac", "2", "-b:a", "192k"]);
        if settings.audio_boost > 1.0
            && plan
                .audio
                .as_ref()
                .and_then(|stream| stream["channels"].as_u64())
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
pub(crate) async fn create(
    State(state): State<AppState>,
    Path((library, item)): Path<(String, String)>,
    Json(mut input): Json<SessionInput>,
) -> Result<Json<SessionResponse>, HttpError> {
    let source = source(&state, library, item).await?;
    let probe = state.playback.probe(&source).await?;
    let settings = crate::transcoding::load(&state)?;
    let mut plan = plan(&probe, &container(&source.path), &input, &settings)?;
    if matches!(plan.method, "remux" | "audio_transcode") {
        match copy_seek_start(&source, input.position_seconds).await {
            Ok(start) => input.position_seconds = start,
            Err(_) if !settings.allow_conversion || input.force_remux => {
                return Err(failure("Playback with copied video could not find a valid video keyframe for this seek. Retry from the beginning or choose a different file; video encoding is not allowed for this request."));
            }
            Err(_) => {
                input.force_transcode = true;
                plan = self::plan(&probe, &container(&source.path), &input, &settings)?;
                plan.reason = "This file requires video conversion to seek accurately.";
            }
        }
    }
    if input.subtitle_burn_index.is_some() && !settings.subtitle_extraction {
        return Err(bad(
            "Subtitle processing is disabled in Transcoding settings.",
        ));
    }
    let burn = prepare_burn(&state.playback, &source, &probe, &input, &settings).await?;
    let enc = if plan.method == "transcode" {
        Some(encoder(&state.playback, &plan, &settings).await?)
    } else {
        None
    };
    let id = uuid::Uuid::new_v4().to_string();
    let direct = plan.method == "direct";
    let mut response = SessionResponse {
        id: id.clone(),
        method: plan.method.into(),
        reason: plan.reason.into(),
        url: if direct {
            format!("/api/playback/sessions/{id}/stream")
        } else {
            format!("/api/playback/sessions/{id}/hls/index.m3u8")
        },
        mime: if direct {
            match container(&source.path).as_str() {
                "webm" => "video/webm",
                "mkv" => "video/x-matroska",
                _ => "video/mp4",
            }
        } else {
            "application/vnd.apple.mpegurl"
        }
        .into(),
        offset_seconds: if direct { 0.0 } else { input.position_seconds },
        duration_seconds: duration(&probe),
        encoder: enc.as_ref().map(|(e, _)| e.clone()),
        audio_index: plan
            .audio
            .as_ref()
            .and_then(|a| a["index"].as_u64())
            .map(|i| i as u32),
    };
    // Reserve a slot before starting FFmpeg; concurrent create requests cannot exceed limits.
    let mut sessions = state.playback.sessions.lock().await;
    if sessions.len() >= MAX_SESSIONS
        || (!direct
            && sessions
                .values()
                .filter(|s| s.directory.is_some() && s.child.is_some())
                .count()
                >= settings.max_concurrent as usize)
    {
        return Err(HttpError {
            status: StatusCode::TOO_MANY_REQUESTS,
            detail: "The playback/transcoding session limit has been reached.".into(),
        });
    }
    let directory = if direct {
        None
    } else {
        Some(session_dir(&state.playback, &settings, &id)?)
    };
    if let Some(dir) = &directory {
        if let Err(error) = write_burn(dir, &burn).await {
            let _ = tokio::fs::remove_dir_all(dir).await;
            return Err(error);
        }
    }
    let child = if let Some(dir) = &directory {
        let mut cmd = match hls_command(
            &source,
            &probe,
            &plan,
            &input,
            &settings,
            enc.as_ref()
                .map(|(name, backend)| (name.as_str(), backend.as_str())),
            dir,
        ) {
            Ok(cmd) => cmd,
            Err(error) => {
                let _ = tokio::fs::remove_dir_all(dir).await;
                return Err(error);
            }
        };
        match cmd.spawn() {
            Ok(child) => Some(child),
            Err(_) => {
                let _ = tokio::fs::remove_dir_all(dir).await;
                return Err(failure("Unable to start FFmpeg for playback."));
            }
        }
    } else {
        None
    };
    if let (Some(dir), Some(child)) = (&directory, &child) {
        write_owner(&state.playback, &id, dir, child.id())?;
    }
    sessions.insert(
        id.clone(),
        Session {
            library_id: source.library_id.clone(),
            item_id: source.item.id.clone(),
            source: source.path.clone(),
            stamp: source.fingerprint,
            directory: directory.clone(),
            response: response.clone(),
            child,
            touched: Instant::now(),
            position: input.position_seconds,
            buffer_seconds: if settings.throttle {
                settings.buffer_seconds
            } else {
                0
            },
            paused: false,
            suspended: false,
            cache_limit: u64::from(settings.cache_gb) * 1024 * 1024 * 1024,
            error: None,
        },
    );
    drop(sessions);
    if let Some(dir) = directory {
        if !wait_manifest(&state.playback, &id, &dir).await {
            let fallback = enc
                .as_ref()
                .is_some_and(|(_, backend)| backend != "software")
                && settings.software_fallback
                && (settings.allow_conversion
                    || plan.bandwidth_adaptation && settings.auto_bandwidth_transcoding);
            if fallback {
                let mut sessions = state.playback.sessions.lock().await;
                let s = sessions
                    .get_mut(&id)
                    .ok_or_else(|| failure("Playback session was interrupted."))?;
                if let Some(child) = &mut s.child {
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                }
                s.child = None;
                s.suspended = false;
                s.error = None;
                let _ = tokio::fs::remove_dir_all(&dir).await;
                tokio::fs::create_dir(&dir)
                    .await
                    .map_err(|_| failure("Unable to restart the playback session."))?;
                write_burn(&dir, &burn).await?;
                let name = match plan.output_codec.as_str() {
                    "hevc" => "libx265",
                    "av1" => "libsvtav1",
                    _ => "libx264",
                };
                let mut cmd = hls_command(
                    &source,
                    &probe,
                    &plan,
                    &input,
                    &settings,
                    Some((name, "software")),
                    &dir,
                )?;
                s.child = Some(
                    cmd.spawn()
                        .map_err(|_| failure("Unable to start software transcoding."))?,
                );
                write_owner(
                    &state.playback,
                    &id,
                    &dir,
                    s.child.as_ref().and_then(Child::id),
                )?;
                response.encoder = Some(name.into());
                response.reason =
                    "The hardware encode failed; software fallback is converting this video."
                        .into();
                s.response = response.clone();
                drop(sessions);
                if !wait_manifest(&state.playback, &id, &dir).await {
                    state.playback.stop_id(&id).await;
                    return Err(failure(
                        "Hardware and software playback conversion both failed. Check the file, codec, and Transcoding settings.",
                    ));
                }
            } else {
                state.playback.stop_id(&id).await;
                return Err(failure(if plan.hdr {
                    "HDR playback conversion failed. This FFmpeg build must support zscale and tone mapping."
                } else {
                    "Playback could not produce its first segment. Check the file, codec, and Transcoding settings."
                }));
            }
        }
    }
    Ok(Json(response))
}
async fn wait_manifest(store: &PlaybackStore, id: &str, dir: &FsPath) -> bool {
    let started = Instant::now();
    loop {
        if tokio::fs::metadata(dir.join("index.m3u8")).await.is_ok() {
            return true;
        }
        let failed = {
            let mut sessions = store.sessions.lock().await;
            sessions.get_mut(id).is_none_or(|s| {
                s.child
                    .as_mut()
                    .is_none_or(|c| c.try_wait().ok().flatten().is_some())
            })
        };
        if failed || started.elapsed() > Duration::from_secs(30) {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn session_path(
    state: &AppState,
    id: &str,
    name: Option<&str>,
) -> Result<(PathBuf, String), HttpError> {
    let mut sessions = state.playback.sessions.lock().await;
    let s = sessions
        .get_mut(id)
        .ok_or_else(|| bad("Playback session expired. Reopen the player."))?;
    if let Some(error) = &s.error {
        return Err(failure(error.clone()));
    }
    if stamp(&s.source)? != s.stamp {
        return Err(bad("The video file changed. Reopen the player."));
    }
    s.touched = Instant::now();
    if let Some(name) = name {
        if !safe_segment(name) {
            return Err(bad("Invalid playback segment."));
        }
        Ok((
            s.directory
                .as_ref()
                .ok_or_else(|| bad("This is a direct playback session."))?
                .join(name),
            if name.ends_with("m3u8") {
                "application/vnd.apple.mpegurl"
            } else {
                "video/mp4"
            }
            .into(),
        ))
    } else {
        if s.directory.is_some() {
            return Err(bad("This session uses segmented playback."));
        }
        Ok((s.source.clone(), s.response.mime.clone()))
    }
}
fn safe_segment(name: &str) -> bool {
    name == "index.m3u8"
        || name == "init.mp4"
        || (name.starts_with("segment-")
            && name.ends_with(".m4s")
            && name.len() == 18
            && name[8..14].bytes().all(|b| b.is_ascii_digit()))
}
async fn serve(path: PathBuf, mime: &str, request: Request) -> Result<Response, HttpError> {
    let mut response = ServeFile::new(path)
        .oneshot(request)
        .await
        .map_err(|_| failure("Unable to stream media."))?
        .into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        mime.parse().map_err(|_| failure("Invalid media type."))?,
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "private, no-store".parse().unwrap());
    response
        .headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    Ok(response)
}
pub(crate) async fn stream(
    State(state): State<AppState>,
    Path(id): Path<String>,
    request: Request,
) -> Result<Response, HttpError> {
    let (path, mime) = session_path(&state, &id, None).await?;
    serve(path, &mime, request).await
}
pub(crate) async fn segment(
    State(state): State<AppState>,
    Path((id, name)): Path<(String, String)>,
    request: Request,
) -> Result<Response, HttpError> {
    let (path, mime) = session_path(&state, &id, Some(&name)).await?;
    if name == "index.m3u8" {
        if tokio::fs::metadata(&path)
            .await
            .map_or(true, |m| m.len() > MAX_PROBE_BYTES)
        {
            return Err(failure("Playback playlist is unavailable or too large."));
        }
        let raw = tokio::fs::read_to_string(&path)
            .await
            .map_err(|_| failure("Unable to read playback playlist."))?;
        let manifest = rolling_manifest(
            &raw,
            path.parent()
                .ok_or_else(|| failure("Playback folder unavailable."))?,
        )?;
        return Ok((
            [
                (header::CONTENT_TYPE, "application/vnd.apple.mpegurl"),
                (header::CACHE_CONTROL, "private, no-store"),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            ],
            manifest,
        )
            .into_response());
    }
    serve(path, &mime, request).await
}
#[derive(Deserialize)]
pub(crate) struct Heartbeat {
    pub(crate) position_seconds: f64,
    #[serde(default)]
    paused: bool,
}
pub(crate) async fn heartbeat(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<Heartbeat>,
) -> Result<Json<Value>, HttpError> {
    let mut sessions = state.playback.sessions.lock().await;
    let s = sessions
        .get_mut(&id)
        .ok_or_else(|| bad("Playback session expired."))?;
    if let Some(error) = &s.error {
        return Err(failure(error.clone()));
    }
    if !input.position_seconds.is_finite()
        || input.position_seconds < 0.0
        || input.position_seconds > MAX_PLAYBACK_SECONDS
        || (s.response.duration_seconds > 0.0
            && input.position_seconds > s.response.duration_seconds + 5.0)
    {
        return Err(bad("Playback position is out of range."));
    }
    s.touched = Instant::now();
    s.position = input.position_seconds;
    s.paused = input.paused;
    if !input.paused {
        state.auth.activity(&headers);
    }
    Ok(Json(
        json!({"ok":true,"method":s.response.method,"encoder":s.response.encoder,"transcoding":s.child.is_some(),"throttled":s.suspended}),
    ))
}
pub(crate) async fn stop(State(state): State<AppState>, Path(id): Path<String>) -> StatusCode {
    state.playback.stop_id(&id).await;
    StatusCode::NO_CONTENT
}

async fn extracted_resource(
    store: &PlaybackStore,
    source: &Source,
    index: u32,
    format: &str,
) -> Result<Vec<u8>, HttpError> {
    let key = (
        source.path.clone(),
        source.fingerprint.0,
        source.fingerprint.1,
        index,
        format.to_string(),
    );
    // Serialize cache fills so simultaneous subtitle/font fetches reuse completed output.
    let mut cache = store.resources.lock().await;
    if let Some(value) = cache.get_mut(&key) {
        value.used = Instant::now();
        if let Ok(bytes) = tokio::fs::read(&value.path).await {
            return Ok(bytes);
        }
    }
    let _permit = store
        .jobs
        .acquire()
        .await
        .map_err(|_| failure("Media resource extraction interrupted."))?;
    let root = store.root.join("resources");
    tokio::fs::create_dir_all(&root)
        .await
        .map_err(|_| failure("Media resource cache is not writable."))?;
    let name = uuid::Uuid::new_v4().to_string();
    let path = root.join(format!("{name}.{format}"));
    let mut cmd = command("ffmpeg");
    cmd.args(["-nostdin", "-v", "error", "-y"]);
    let limit = if format == "font" {
        cmd.arg(format!("-dump_attachment:{index}"))
            .arg(&path)
            .args([
                "-protocol_whitelist",
                "file,pipe",
                "-format_whitelist",
                VIDEO_DEMUXERS,
                "-i",
            ])
            .arg(&source.path)
            .args(["-t", "0", "-f", "null", "-"]);
        MAX_FONT_BYTES
    } else {
        cmd.args([
            "-protocol_whitelist",
            "file,pipe",
            "-format_whitelist",
            VIDEO_DEMUXERS,
            "-i",
        ])
        .arg(&source.path)
        .arg("-map")
        .arg(format!("0:{index}"))
        .args([
            "-c:s",
            if format == "ass" { "ass" } else { "webvtt" },
            "-fs",
        ])
        .arg(MAX_SUBTITLE_BYTES.to_string())
        .arg(&path);
        MAX_SUBTITLE_BYTES
    };
    if let Err(error) = run(
        &mut cmd,
        Duration::from_secs(45),
        "Media resource extraction",
    )
    .await
    {
        let _ = tokio::fs::remove_file(&path).await;
        return Err(error);
    }
    let size = std::fs::metadata(&path).map_or(u64::MAX, |m| m.len());
    if size >= limit {
        let _ = tokio::fs::remove_file(&path).await;
        return Err(failure(
            "Extracted media resource is too large or was truncated.",
        ));
    }
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|_| failure("Unable to read extracted media resource."))?;
    while cache.len() >= 128
        || cache.values().map(|v| v.bytes).sum::<u64>() + size > 256 * 1024 * 1024
    {
        let Some(old) = cache
            .iter()
            .min_by_key(|(_, v)| v.used)
            .map(|(key, _)| key.clone())
        else {
            break;
        };
        if let Some(record) = cache.remove(&old) {
            let _ = tokio::fs::remove_file(record.path).await;
        }
    }
    cache.insert(
        key,
        ResourceCache {
            path,
            bytes: size,
            used: Instant::now(),
        },
    );
    Ok(bytes)
}

pub(crate) async fn subtitle(
    State(state): State<AppState>,
    Path((library, item, index)): Path<(String, String, u32)>,
) -> Result<Response, HttpError> {
    if !crate::transcoding::load(&state)?.subtitle_extraction {
        return Err(bad(
            "Subtitle extraction is disabled in Transcoding settings.",
        ));
    }
    let source = source(&state, library, item).await?;
    let probe = state.playback.probe(&source).await?;
    let track = selected_stream(&probe, "subtitle", Some(index))?
        .ok_or_else(|| bad("Subtitle track not found."))?;
    let ass = matches!(track["codec_name"].as_str(), Some("ass" | "ssa"));
    if !ass
        && !matches!(
            track["codec_name"].as_str(),
            Some("subrip" | "webvtt" | "mov_text" | "text" | "srt")
        )
    {
        return Err(bad("This graphical subtitle track needs burn-in playback."));
    }
    let bytes = extracted_resource(
        &state.playback,
        &source,
        index,
        if ass { "ass" } else { "vtt" },
    )
    .await?;
    Ok((
        [
            (
                header::CONTENT_TYPE,
                if ass {
                    "text/plain; charset=utf-8"
                } else {
                    "text/vtt; charset=utf-8"
                },
            ),
            (header::CACHE_CONTROL, "private, no-store"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        bytes,
    )
        .into_response())
}
pub(crate) async fn font(
    State(state): State<AppState>,
    Path((library, item, index)): Path<(String, String, u32)>,
) -> Result<Response, HttpError> {
    if !crate::transcoding::load(&state)?.font_extraction {
        return Err(bad(
            "Embedded font extraction is disabled in Transcoding settings.",
        ));
    }
    let source = source(&state, library, item).await?;
    let probe = state.playback.probe(&source).await?;
    if !probe["streams"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|s| s["index"].as_u64() == Some(u64::from(index)) && font_stream(s))
    {
        return Err(bad("This attachment is not a supported font."));
    }
    if probe["streams"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|s| s["index"].as_u64() == Some(u64::from(index)))
        .and_then(|s| s["extradata_size"].as_u64())
        .is_some_and(|size| size >= MAX_FONT_BYTES)
    {
        return Err(bad("Embedded font is too large."));
    }
    let bytes = extracted_resource(&state.playback, &source, index, "font").await?;
    let mime = if bytes.starts_with(b"OTTO") {
        "font/otf"
    } else if bytes.starts_with(&[0, 1, 0, 0]) || bytes.starts_with(b"true") {
        "font/ttf"
    } else if bytes.starts_with(b"ttcf") {
        "font/collection"
    } else {
        return Err(bad("Attachment has an invalid font signature."));
    };
    Ok((
        [
            (header::CONTENT_TYPE, mime),
            (header::CACHE_CONTROL, "private, no-store"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        bytes,
    )
        .into_response())
}

pub(crate) fn routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route(
            "/api/playback/capabilities",
            axum::routing::get(capabilities),
        )
        .route(
            "/api/playback/native/{library}/{item}",
            axum::routing::get(info),
        )
        .route(
            "/api/playback/native/{library}/{item}/sessions",
            axum::routing::post(create),
        )
        .route(
            "/api/playback/native/{library}/{item}/subtitles/{index}",
            axum::routing::get(subtitle),
        )
        .route(
            "/api/playback/native/{library}/{item}/fonts/{index}",
            axum::routing::get(font),
        )
        .route(
            "/api/playback/sessions/{id}/stream",
            axum::routing::get(stream),
        )
        .route(
            "/api/playback/sessions/{id}/hls/{name}",
            axum::routing::get(segment),
        )
        .route(
            "/api/playback/sessions/{id}/heartbeat",
            axum::routing::post(heartbeat),
        )
        .route("/api/playback/sessions/{id}", axum::routing::delete(stop))
}

#[cfg(test)]
mod tests;
