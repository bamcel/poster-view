//! Original-file playback, media inspection, resource extraction, and direct session lifecycle.
mod hardware;
mod manifest;
mod models;
mod planner;
mod segmented;
#[cfg(test)]
mod test_support;
use models::{Chapter, Font, Info, NextItem, SeekInput, SessionInput, SessionResponse, Track};
use planner::{plan, plan_for_delivery, selected_stream, validate_request};

use crate::{AppState, HttpError};
use axum::{
    Json,
    extract::{Path, Request, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use posterview_contracts::native::NativeCatalogEntry;
use posterview_infra_sqlite::ServerStore;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::{Component, Path as FsPath, PathBuf},
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    process::Command,
    sync::{Mutex, Semaphore},
};
use tower::ServiceExt;
use tower_http::services::ServeFile;

const MAX_PROBE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_SUBTITLE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_FONT_BYTES: u64 = 32 * 1024 * 1024;
const MAX_BITMAP_BYTES: u64 = 128 * 1024 * 1024;
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

#[derive(Clone)]
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
fn generated_resource(entry: &std::fs::DirEntry) -> bool {
    let path = entry.path();
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .is_some_and(|stem| uuid::Uuid::parse_str(stem).is_ok())
        && path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| matches!(extension, "ass" | "vtt" | "font" | "sup" | "mks"))
        && entry
            .file_type()
            .is_ok_and(|kind| kind.is_file() && !kind.is_symlink())
}
#[cfg(test)]
#[derive(Default)]
struct PreparationGate {
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
}
struct PendingPreparation {
    generation: u64,
    cancel: tokio::sync::watch::Sender<()>,
}
struct Session {
    preparation: Option<PendingPreparation>,
    next_generation: u64,
    owner: String,
    source: Source,
    probe: Value,
    input: SessionInput,
    response: SessionResponse,
    touched: Instant,
    producer: Option<segmented::Producer>,
    position: f64,
    paused: bool,
    speed: f64,
    closed: bool,
}

pub(crate) struct PlaybackStore {
    root: PathBuf,
    #[cfg(test)]
    preparation_gate: Mutex<Option<Arc<PreparationGate>>>,
    sessions: Mutex<HashMap<String, Arc<Mutex<Session>>>>,
    probes: Mutex<HashMap<PathBuf, ProbeCache>>,
    resources: Mutex<HashMap<ResourceKey, ResourceCache>>,
    // Only media inspection and subtitle/font extraction use subprocess permits.
    jobs: Arc<Semaphore>,
    started: AtomicBool,
    hardware: Mutex<HashMap<String, (Instant, hardware::Encoder)>>,
    hardware_probes: hardware::ProbeGates,
    copy_seeks: segmented::CopySeekCache,
    producers: Arc<AtomicU32>,
    instance: String,
    cache_roots: StdMutex<HashSet<PathBuf>>,
    cache_budget: AtomicU64,
}
impl PlaybackStore {
    pub(crate) fn new(data_dir: &FsPath) -> Self {
        let root = data_dir.join("playback");
        // Retire only generated resource files, never media files or unrelated folders.
        if let Ok(files) = std::fs::read_dir(root.join("resources")) {
            for entry in files.flatten() {
                if generated_resource(&entry) {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
        Self {
            root,
            #[cfg(test)]
            preparation_gate: Mutex::new(None),
            sessions: Mutex::new(HashMap::new()),
            probes: Mutex::new(HashMap::new()),
            resources: Mutex::new(HashMap::new()),
            jobs: Arc::new(Semaphore::new(2)),
            started: AtomicBool::new(false),
            hardware: Mutex::new(HashMap::new()),
            hardware_probes: Default::default(),
            copy_seeks: Default::default(),
            producers: Arc::new(AtomicU32::new(0)),
            instance: uuid::Uuid::new_v4().to_string(),
            cache_roots: StdMutex::new(HashSet::new()),
            cache_budget: AtomicU64::new(10 * 1024 * 1024 * 1024),
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
    #[cfg(test)]
    pub(crate) async fn session_details(&self, id: &str) -> Option<(String, String, f64)> {
        let handle = self.sessions.lock().await.get(id)?.clone();
        let session = handle.lock().await;
        if session.closed
            || !self.sessions.lock().await.contains_key(id)
            || session.touched.elapsed() > SESSION_IDLE
            || stamp(&session.source.path).ok()? != session.source.fingerprint
        {
            return None;
        }
        Some((
            session.source.library_id.clone(),
            session.source.item.id.clone(),
            session.response.duration_seconds,
        ))
    }
    pub(crate) async fn session_details_for(
        &self,
        id: &str,
        user: &str,
    ) -> Result<Option<(String, String, f64)>, HttpError> {
        let Some(session) = self.sessions.lock().await.get(id).cloned() else {
            return Ok(None);
        };
        let session = session.lock().await;
        if session.owner != user {
            return Err(HttpError::not_found());
        }
        if validate_session(&session).is_err() {
            return Ok(None);
        }
        Ok(Some((
            session.source.library_id.clone(),
            session.source.item.id.clone(),
            session.response.duration_seconds,
        )))
    }
    async fn stop_id(&self, id: &str) {
        let handle = self.sessions.lock().await.remove(id);
        if let Some(handle) = handle {
            let producer = {
                let mut session = handle.lock().await;
                session.closed = true;
                cancel_preparation(&mut session);
                session.producer.take()
            };
            if let Some(producer) = producer {
                producer.stop().await;
            }
        }
    }
    async fn maintain(&self) {
        let handles = self
            .sessions
            .lock()
            .await
            .iter()
            .map(|(id, handle)| (id.clone(), handle.clone()))
            .collect::<Vec<_>>();
        let mut expired = Vec::new();
        let mut total = segmented::total_bytes(self);
        let mut sizes = Vec::new();
        for (id, handle) in handles {
            let Ok(mut session) = handle.try_lock() else {
                continue;
            };
            let position = (session.position - session.response.offset_seconds).max(0.0);
            let paused = session.paused;
            let speed = session.speed;
            let valid = session
                .producer
                .as_mut()
                .is_none_or(|producer| producer.maintain(position, paused, speed));
            if session.touched.elapsed() > SESSION_IDLE || !valid {
                expired.push(id);
            } else if let Some(producer) = &session.producer {
                let size = segmented::directory_bytes(&producer.dir);
                sizes.push((id, size, producer.cache_bytes));
            }
        }
        let limit = self.cache_budget.load(Ordering::Acquire);
        sizes.sort_by_key(|entry| std::cmp::Reverse(entry.1));
        for (id, size, _) in sizes {
            if total <= limit {
                break;
            }
            total = total.saturating_sub(size);
            expired.push(id);
        }
        for id in expired {
            self.stop_id(&id).await;
        }
        let active = self.sessions.lock().await.keys().cloned().collect();
        segmented::sweep_abandoned(self, &active).await;
        self.sweep_resources();
    }
    fn sweep_resources(&self) {
        // A fill owns this mutex from before file creation through insertion.
        // try_lock prevents cleanup from blocking or deleting a live extraction.
        let Ok(cache) = self.resources.try_lock() else {
            return;
        };
        let cached = cache
            .values()
            .map(|entry| entry.path.as_path())
            .collect::<HashSet<_>>();
        let mut attempts = 0usize;
        for entry in std::fs::read_dir(self.root.join("resources"))
            .into_iter()
            .flatten()
            .flatten()
            .take(4096)
        {
            let path = entry.path();
            if !generated_resource(&entry) || cached.contains(path.as_path()) {
                continue;
            }
            if attempts >= 32 {
                break;
            }
            attempts += 1;
            let _ = std::fs::remove_file(path);
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
        // A concurrent inspection may have filled the cache while this request waited.
        {
            let mut cache = self.probes.lock().await;
            if let Some(cached) = cache
                .get_mut(&source.path)
                .filter(|cached| cached.stamp == source.fingerprint)
            {
                cached.used = Instant::now();
                return Ok(cached.probe.clone());
            }
        }
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

fn tracks(probe: &Value, source: &Source, subtitle_extraction: bool) -> Vec<Track> {
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
                } else if codec == "hdmv_pgs_subtitle" {
                    "pgs"
                } else if codec == "dvd_subtitle" {
                    "vobsub"
                } else {
                    "image"
                }
                .to_string()
            });
            let url = subtitle_format
                .as_ref()
                .filter(|v| v.as_str() != "image" && subtitle_extraction)
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
    headers: HeaderMap,
    Path((library, item)): Path<(String, String)>,
) -> Result<Json<Info>, HttpError> {
    let user = state.auth.request_user(&headers)?;
    let settings = crate::transcoding::load(&state)?;
    crate::access::require_item(&state, &user, &library, &item)?;
    let mut source = source(&state, library, item).await?;
    if source.next.as_ref().is_some_and(|next| {
        !crate::access::allows_item(&state, &user, &source.library_id, &next.item_id)
    }) {
        source.next = None;
    }
    let probe = state.playback.probe(&source).await?;
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
    let fonts = probe["streams"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|s| settings.font_extraction && font_stream(s))
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
        .collect();
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
        remux_allowed: settings.allow_remux,
        container: container(&source.path),
        tracks: tracks(&probe, &source, settings.subtitle_extraction),
        chapters,
        fonts,
        next: source.next.clone(),
    }))
}

fn original_mime(path: &FsPath) -> &'static str {
    match container(path).as_str() {
        "mkv" => "video/x-matroska",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        _ => "video/mp4",
    }
}
fn response(
    id: &str,
    source: &Source,
    probe: &Value,
    plan: &planner::Plan,
    generation: u64,
    offset: f64,
    encoder: Option<String>,
) -> SessionResponse {
    let source_height = plan.video["height"].as_u64().map(|height| height as u32);
    let height = if plan.method == "transcode" {
        source_height.map(|height| {
            let height = if plan.height > 0 {
                height.min(plan.height)
            } else {
                height
            };
            height / 2 * 2
        })
    } else {
        source_height
    };
    let width = plan.video["width"].as_u64().map(|width| {
        if plan.method == "transcode" {
            let source_height = source_height.unwrap_or(1).max(1);
            let ratio = |value: &Value| {
                value
                    .as_str()
                    .and_then(|value| value.split_once(':'))
                    .and_then(|(a, b)| Some(a.parse::<f64>().ok()? / b.parse::<f64>().ok()?))
                    .filter(|value| value.is_finite() && *value > 0.0)
            };
            let dar = ratio(&plan.video["display_aspect_ratio"]).unwrap_or_else(|| {
                width as f64 / source_height as f64
                    * ratio(&plan.video["sample_aspect_ratio"]).unwrap_or(1.0)
            });
            ((dar * f64::from(height.unwrap_or(source_height)) / 2.0).floor() * 2.0) as u32
        } else {
            width as u32
        }
    });
    SessionResponse {
        id: id.into(),
        method: plan.method.into(),
        reason: plan.reason.into(),
        url: if generation == 0 {
            format!("/api/playback/sessions/{id}/stream")
        } else {
            format!("/api/playback/sessions/{id}/hls/{generation}/index.m3u8")
        },
        mime: if generation == 0 {
            original_mime(&source.path)
        } else {
            "application/vnd.apple.mpegurl"
        }
        .into(),
        offset_seconds: offset,
        duration_seconds: duration(probe),
        encoder,
        audio_index: plan
            .audio
            .as_ref()
            .and_then(|audio| audio["index"].as_u64())
            .map(|index| index as u32),
        generation,
        video_codec: Some(plan.output_codec.clone()),
        audio_codec: plan.audio.as_ref().map(|audio| {
            if plan.convert_audio {
                "aac".into()
            } else {
                audio["codec_name"].as_str().unwrap_or("unknown").into()
            }
        }),
        width,
        height,
        bitrate: if plan.method == "transcode" {
            Some(segmented::video_bitrate(plan).saturating_add(segmented::audio_budget(plan)))
        } else {
            source_bitrate(probe)
        },
    }
}
struct GenerationOptions {
    number: u64,
    select_in_stream: bool,
}
async fn prepare(
    store: &PlaybackStore,
    id: &str,
    source: &Source,
    probe: &Value,
    mut input: SessionInput,
    settings: &crate::transcoding::Settings,
    options: GenerationOptions,
) -> Result<(SessionResponse, Option<segmented::Producer>), HttpError> {
    #[cfg(test)]
    let gate = store.preparation_gate.lock().await.take();
    #[cfg(test)]
    if let Some(gate) = gate {
        gate.entered.notify_one();
        gate.release.notified().await;
        return Err(bad("Controlled preparation failure."));
    }
    let GenerationOptions {
        number: generation,
        select_in_stream,
    } = options;
    let mut planned = plan_for_delivery(
        probe,
        &container(&source.path),
        &input,
        settings,
        select_in_stream,
    )?;
    if planned.method == "direct" {
        return Ok((response(id, source, probe, &planned, 0, 0.0, None), None));
    }
    if planned.method != "transcode" {
        match segmented::copy_seek_start(store, source, input.position_seconds).await {
            Ok(position) => input.position_seconds = position,
            Err(error) if !settings.allow_conversion || input.force_remux => return Err(error),
            Err(_) => {
                input.force_transcode = true;
                planned = plan_for_delivery(
                    probe,
                    &container(&source.path),
                    &input,
                    settings,
                    select_in_stream,
                )?;
            }
        }
    }
    let (producer, encoder) = segmented::start(
        store,
        id,
        generation,
        &segmented::Delivery {
            source,
            probe,
            plan: &planned,
            input: &input,
            settings,
            select_in_stream,
        },
    )
    .await?;
    let result = response(
        id,
        source,
        probe,
        &planned,
        generation,
        input.position_seconds,
        encoder,
    );
    Ok((result, Some(producer)))
}
fn cancel_preparation(session: &mut Session) {
    if let Some(pending) = session.preparation.take() {
        pending.cancel.send_replace(());
    }
}
fn reserve_preparation(
    session: &mut Session,
) -> Result<(u64, tokio::sync::watch::Receiver<()>), HttpError> {
    cancel_preparation(session);
    let generation = session.next_generation;
    session.next_generation = generation
        .checked_add(1)
        .ok_or_else(|| bad("Playback generation limit reached."))?;
    let (cancel, receiver) = tokio::sync::watch::channel(());
    session.preparation = Some(PendingPreparation { generation, cancel });
    Ok((generation, receiver))
}
fn revalidate_owner(state: &AppState, owner: &str, source: &Source) -> Result<(), HttpError> {
    let user = ServerStore::new(state.runtime.data_dir())
        .user(owner)
        .map_err(|_| failure("Unable to verify playback account."))?
        .or_else(|| {
            state
                .auth
                .request_user(&HeaderMap::new())
                .ok()
                .filter(|user| user.id == owner)
        })
        .filter(|user| user.enabled)
        .ok_or_else(HttpError::not_found)?;
    crate::access::require_item(state, &user, &source.library_id, &source.item.id)
}
async fn retire_idle(store: &Arc<PlaybackStore>) {
    let handles = store
        .sessions
        .lock()
        .await
        .iter()
        .map(|(id, handle)| (id.clone(), handle.clone()))
        .collect::<Vec<_>>();
    for (id, handle) in handles {
        let Ok(mut session) = handle.try_lock() else {
            continue;
        };
        if session.touched.elapsed() <= SESSION_IDLE {
            continue;
        }
        session.closed = true;
        cancel_preparation(&mut session);
        let producer = session.producer.take();
        store.sessions.lock().await.remove(&id);
        drop(session);
        if let Some(producer) = producer {
            tokio::spawn(async move {
                producer.stop().await;
            });
        }
    }
}
pub(crate) async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((library, item)): Path<(String, String)>,
    Json(input): Json<SessionInput>,
) -> Result<Json<SessionResponse>, HttpError> {
    let user = state.auth.request_user(&headers)?;
    validate_request(&input)?;
    retire_idle(&state.playback).await;
    crate::access::require_item(&state, &user, &library, &item)?;
    let mut source = source(&state, library, item).await?;
    if source.next.as_ref().is_some_and(|next| {
        !crate::access::allows_item(&state, &user, &source.library_id, &next.item_id)
    }) {
        source.next = None;
    }
    let probe = state.playback.probe(&source).await?;
    let settings = crate::transcoding::load(&state)?;
    let planned = plan(&probe, &container(&source.path), &input, &settings)?;
    let id = uuid::Uuid::new_v4().to_string();
    let initial = response(&id, &source, &probe, &planned, 0, 0.0, None);
    let session = Arc::new(Mutex::new(Session {
        preparation: None,
        next_generation: 1,
        owner: user.id.clone(),
        source,
        probe,
        input: input.clone(),
        response: initial,
        touched: Instant::now(),
        producer: None,
        position: input.position_seconds,
        paused: false,
        speed: 1.0,
        closed: false,
    }));
    let mut guard = session.lock().await;
    {
        let mut sessions = state.playback.sessions.lock().await;
        if sessions.len() >= MAX_SESSIONS {
            return Err(HttpError {
                status: StatusCode::TOO_MANY_REQUESTS,
                detail: "The playback session limit has been reached.".into(),
            });
        }
        sessions.insert(id.clone(), session.clone());
    }
    let (generation, mut canceled) = reserve_preparation(&mut guard)?;
    let source = guard.source.clone();
    let probe = guard.probe.clone();
    drop(guard);
    let result = tokio::select! {
        biased;
        _ = canceled.changed() => Err(conflict()),
        result = prepare(
        &state.playback,
        &id,
        &source,
        &probe,
        input,
        &settings,
        GenerationOptions {
            number: generation,
            select_in_stream: false,
        },
    ) => result,
    };
    let mut guard = session.lock().await;
    if guard.closed
        || !state.playback.sessions.lock().await.contains_key(&id)
        || guard
            .preparation
            .as_ref()
            .is_none_or(|pending| pending.generation != generation)
    {
        drop(guard);
        if let Ok((_, Some(producer))) = result {
            producer.stop().await;
        }
        return Err(conflict());
    }
    if let Err(error) = validate_session(&guard) {
        drop(guard);
        if let Ok((_, Some(producer))) = result {
            producer.stop().await;
        }
        state.playback.stop_id(&id).await;
        return Err(error);
    }
    if let Err(error) = revalidate_owner(&state, &guard.owner, &source) {
        drop(guard);
        if let Ok((_, Some(producer))) = result {
            producer.stop().await;
        }
        state.playback.stop_id(&id).await;
        return Err(error);
    }
    guard.preparation = None;
    match result {
        Ok((response, producer)) => {
            guard.next_generation = response
                .generation
                .checked_add(1)
                .ok_or_else(|| bad("Playback generation limit reached."))?;
            guard.response = response.clone();
            guard.producer = producer;
            guard.touched = Instant::now();
            Ok(Json(response))
        }
        Err(error) => {
            drop(guard);
            state.playback.stop_id(&id).await;
            Err(error)
        }
    }
}
async fn authorize_session(
    state: &AppState,
    id: &str,
    user: &posterview_contracts::users::UserAccount,
) -> Result<(), HttpError> {
    let session = handle(&state.playback, id).await?;
    let session = session.lock().await;
    if session.owner != user.id {
        return Err(HttpError::not_found());
    }
    crate::access::require_item(
        state,
        user,
        &session.source.library_id,
        &session.source.item.id,
    )
}
async fn handle(store: &PlaybackStore, id: &str) -> Result<Arc<Mutex<Session>>, HttpError> {
    store
        .sessions
        .lock()
        .await
        .get(id)
        .cloned()
        .ok_or_else(|| bad("Playback session expired. Reopen the player."))
}
fn validate_session(session: &Session) -> Result<(), HttpError> {
    if session.closed || session.touched.elapsed() > SESSION_IDLE {
        return Err(bad("Playback session expired. Reopen the player."));
    }
    if stamp(&session.source.path)? != session.source.fingerprint {
        return Err(bad("The video file changed. Reopen the player."));
    }
    Ok(())
}
async fn validate_active(
    store: &PlaybackStore,
    id: &str,
    session: &Session,
) -> Result<(), HttpError> {
    if !store.sessions.lock().await.contains_key(id) {
        return Err(bad("Playback session expired. Reopen the player."));
    }
    validate_session(session)
}
fn conflict() -> HttpError {
    HttpError {
        status: StatusCode::CONFLICT,
        detail: "The playback generation changed. Use the current session generation.".into(),
    }
}
pub(crate) async fn seek(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(request): Json<SeekInput>,
) -> Result<Json<SessionResponse>, HttpError> {
    let user = state.auth.request_user(&headers)?;
    authorize_session(&state, &id, &user).await?;
    let handle = handle(&state.playback, &id).await?;
    seek_session(state, id, handle, request).await
}
async fn seek_session(
    state: AppState,
    id: String,
    handle: Arc<Mutex<Session>>,
    request: SeekInput,
) -> Result<Json<SessionResponse>, HttpError> {
    let mut session = handle.lock().await;
    validate_active(&state.playback, &id, &session).await?;
    if request.generation != session.response.generation {
        return Err(conflict());
    }
    if !request.position_seconds.is_finite()
        || request.position_seconds < 0.0
        || request.position_seconds > MAX_PLAYBACK_SECONDS
        || (session.response.duration_seconds > 0.0
            && request.position_seconds > session.response.duration_seconds)
    {
        return Err(bad("Playback position is out of range."));
    }
    let changed_audio = request
        .audio_index
        .is_some_and(|index| Some(index) != session.response.audio_index);
    if let Some(index) = request.audio_index {
        selected_stream(&session.probe, "audio", Some(index))?;
    }
    cancel_preparation(&mut session);
    if session.response.generation == 0 && request.audio_index.is_none() {
        session.position = request.position_seconds;
        session.touched = Instant::now();
        return Ok(Json(session.response.clone()));
    }
    if !changed_audio && session.response.generation > 0 {
        let target = request.position_seconds - session.response.offset_seconds;
        if let Some(producer) = session.producer.as_mut() {
            let raw = std::fs::read_to_string(producer.dir.join("index.m3u8")).unwrap_or_default();
            if manifest::retained_range(&raw, &producer.dir)
                .is_some_and(|(start, end)| target >= start && target < end - 0.1)
            {
                session.touched = Instant::now();
                // A requested seek is speculative until the client reports its actual
                // media clock. Do not prune the attached generation using the target.
                let position = (session.position - session.response.offset_seconds).max(0.0);
                let paused = session.paused;
                let speed = session.speed;
                if let Some(producer) = session.producer.as_mut() {
                    producer.maintain(position, paused, speed);
                }
                return Ok(Json(session.response.clone()));
            }
        }
    }
    let mut input = session.input.clone();
    input.position_seconds = request.position_seconds;
    if let Some(index) = request.audio_index {
        input.audio_index = Some(index);
    }
    let settings = crate::transcoding::load(&state)?;
    // Validate before retiring the current producer. Audio promotion explicitly bypasses
    // the original-file preference because native track selection has already failed.
    plan_for_delivery(
        &session.probe,
        &container(&session.source.path),
        &input,
        &settings,
        true,
    )?;
    let (generation, mut canceled) = reserve_preparation(&mut session)?;
    let owner = session.owner.clone();
    let source = session.source.clone();
    let probe = session.probe.clone();
    // Preserve the active generation while warming a replacement if capacity permits.
    let retire =
        if state.playback.producers.load(Ordering::Acquire) >= settings.max_concurrent.max(1) {
            session.producer.take()
        } else {
            None
        };
    drop(session);
    if let Some(producer) = retire {
        producer.stop().await;
    }
    let result = tokio::select! {
        biased;
        _=canceled.changed()=>Err(conflict()),
        result=prepare(&state.playback,&id,&source,&probe,input.clone(),&settings,GenerationOptions{number:generation,select_in_stream:true})=>result,
    };
    let mut session = handle.lock().await;
    if session.closed
        || session.owner != owner
        || !state.playback.sessions.lock().await.contains_key(&id)
        || session
            .preparation
            .as_ref()
            .is_none_or(|pending| pending.generation != generation)
    {
        drop(session);
        if let Ok((_, Some(producer))) = result {
            producer.stop().await;
        }
        return Err(conflict());
    }
    if let Err(error) = validate_session(&session) {
        drop(session);
        if let Ok((_, Some(producer))) = result {
            producer.stop().await;
        }
        state.playback.stop_id(&id).await;
        return Err(error);
    }
    if let Err(error) = revalidate_owner(&state, &owner, &source) {
        drop(session);
        if let Ok((_, Some(producer))) = result {
            producer.stop().await;
        }
        state.playback.stop_id(&id).await;
        return Err(error);
    }
    session.preparation = None;
    match result {
        Ok((response, producer)) => {
            let retired = std::mem::replace(&mut session.producer, producer);
            session.input = input;
            session.response = response.clone();
            session.position = request.position_seconds;
            session.touched = Instant::now();
            drop(session);
            if let Some(producer) = retired {
                tokio::spawn(async move {
                    producer.stop().await;
                });
            }
            Ok(Json(response))
        }
        Err(error) => {
            // A preserved generation stays playable; otherwise clearly retire the failed session.
            let has_delivery = session.producer.is_some() || session.response.generation == 0;
            drop(session);
            if !has_delivery {
                state.playback.stop_id(&id).await;
            }
            Err(error)
        }
    }
}
async fn session_path(state: &AppState, id: &str) -> Result<(PathBuf, String), HttpError> {
    let handle = handle(&state.playback, id).await?;
    let mut session = handle.lock().await;
    validate_active(&state.playback, id, &session).await?;
    if session.response.generation != 0 {
        return Err(bad("This session uses segmented playback."));
    }
    session.touched = Instant::now();
    Ok((session.source.path.clone(), session.response.mime.clone()))
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
    let user = state.auth.request_user(request.headers())?;
    authorize_session(&state, &id, &user).await?;
    let (path, mime) = session_path(&state, &id).await?;
    serve(path, &mime, request).await
}
pub(crate) async fn segment(
    State(state): State<AppState>,
    Path((id, generation, name)): Path<(String, u64, String)>,
    request: Request,
) -> Result<Response, HttpError> {
    let user = state.auth.request_user(request.headers())?;
    authorize_session(&state, &id, &user).await?;
    if !manifest::safe_segment(&name) {
        return Err(bad("Invalid playback resource name."));
    }
    let handle = handle(&state.playback, &id).await?;
    let mut session = handle.lock().await;
    validate_active(&state.playback, &id, &session).await?;
    if session.response.generation != generation {
        return Err(conflict());
    }
    let producer = session
        .producer
        .as_ref()
        .ok_or_else(|| bad("This session has no segmented producer."))?;
    let path = producer.dir.join(&name);
    if !path.is_file() {
        return Err(HttpError::not_found());
    }
    let playlist = if name == "index.m3u8" {
        Some(manifest::rolling_manifest(
            &std::fs::read_to_string(&path)
                .map_err(|_| failure("Unable to read playback playlist."))?,
            &producer.dir,
        )?)
    } else {
        None
    };
    session.touched = Instant::now();
    drop(session);
    if let Some(playlist) = playlist {
        Ok((
            [
                (header::CONTENT_TYPE, "application/vnd.apple.mpegurl"),
                (header::CACHE_CONTROL, "private, no-store"),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            ],
            playlist,
        )
            .into_response())
    } else {
        serve(path, "video/mp4", request).await
    }
}
#[derive(Default, Deserialize)]
pub(crate) struct Heartbeat {
    pub(crate) position_seconds: f64,
    #[serde(default)]
    paused: bool,
    generation: Option<u64>,
    fps: Option<f64>,
    speed: Option<f64>,
    buffered_seconds: Option<f64>,
}
pub(crate) async fn heartbeat(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<Heartbeat>,
) -> Result<Json<Value>, HttpError> {
    let user = state.auth.request_user(&headers)?;
    authorize_session(&state, &id, &user).await?;
    let handle = handle(&state.playback, &id).await?;
    let mut session = handle.lock().await;
    validate_active(&state.playback, &id, &session).await?;
    if input
        .generation
        .is_some_and(|generation| generation != session.response.generation)
    {
        return Err(conflict());
    }
    if !input.position_seconds.is_finite()
        || input.position_seconds < 0.0
        || input.position_seconds > MAX_PLAYBACK_SECONDS
        || (session.response.duration_seconds > 0.0
            && input.position_seconds > session.response.duration_seconds + 5.0)
        || input
            .speed
            .is_some_and(|speed| !speed.is_finite() || !(0.25..=4.0).contains(&speed))
        || input
            .fps
            .is_some_and(|fps| !fps.is_finite() || !(0.0..=240.0).contains(&fps))
        || input
            .buffered_seconds
            .is_some_and(|seconds| !seconds.is_finite() || !(0.0..=3600.0).contains(&seconds))
    {
        return Err(bad("Playback position or diagnostics are out of range."));
    }
    session.position = input.position_seconds;
    session.paused = input.paused;
    session.speed = input.speed.unwrap_or(session.speed);
    session.touched = Instant::now();
    let position = (session.position - session.response.offset_seconds).max(0.0);
    let speed = session.speed;
    if let Some(producer) = session.producer.as_mut() {
        if !producer.maintain(position, input.paused, speed) {
            drop(session);
            state.playback.stop_id(&id).await;
            return Err(failure("Playback temporary storage limit was reached."));
        }
    }
    if !input.paused {
        state.auth.activity(&headers);
    }
    let (fps, encoding_speed) = session
        .producer
        .as_ref()
        .map_or((None, None), |producer| producer.progress());
    Ok(Json(
        json!({"ok":true,"method":session.response.method,"encoder":session.response.encoder,"generation":session.response.generation,"transcoding":session.response.method=="transcode"||session.response.method=="audio_transcode","throttled":session.producer.as_ref().is_some_and(|producer|producer.suspended),"fps":fps,"speed":encoding_speed}),
    ))
}
pub(crate) async fn stop(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<StatusCode, HttpError> {
    let user = state.auth.request_user(&headers)?;
    authorize_session(&state, &id, &user).await?;
    state.playback.stop_id(&id).await;
    Ok(StatusCode::NO_CONTENT)
}

async fn extracted_resource(
    store: &PlaybackStore,
    source: &Source,
    index: u32,
    format: &str,
) -> Result<PathBuf, HttpError> {
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
        if value.path.is_file() {
            return Ok(value.path.clone());
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
    let extension = match format {
        "pgs" => "sup",
        "vobsub" => "mks",
        format => format,
    };
    let path = root.join(format!("{name}.{extension}"));
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
            .args(["-c", "copy", "-t", "0", "-f", "null", "-"]);
        MAX_FONT_BYTES
    } else {
        cmd.args([
            "-protocol_whitelist",
            "file,pipe",
            "-format_whitelist",
            VIDEO_DEMUXERS,
        ]);
        let bitmap = matches!(format, "pgs" | "vobsub");
        if bitmap {
            cmd.args(["-copyts", "-avoid_negative_ts", "disabled"]);
        }
        cmd.arg("-i")
            .arg(&source.path)
            .arg("-map")
            .arg(format!("0:{index}"))
            .args([
                "-vn",
                "-an",
                "-dn",
                "-c:s",
                if bitmap {
                    "copy"
                } else if format == "ass" {
                    "ass"
                } else {
                    "webvtt"
                },
            ]);
        let limit = if bitmap {
            MAX_BITMAP_BYTES
        } else {
            MAX_SUBTITLE_BYTES
        };
        if bitmap {
            cmd.args(["-f", if format == "pgs" { "sup" } else { "matroska" }]);
        }
        cmd.arg("-fs").arg(limit.to_string()).arg(&path);
        limit
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
    if stamp(&source.path)? != source.fingerprint {
        let _ = tokio::fs::remove_file(&path).await;
        return Err(bad(
            "The video file changed during resource extraction. Reopen the player.",
        ));
    }
    if size >= limit {
        let _ = tokio::fs::remove_file(&path).await;
        return Err(failure(
            "Extracted media resource is too large or was truncated.",
        ));
    }
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
            path: path.clone(),
            bytes: size,
            used: Instant::now(),
        },
    );
    Ok(path)
}

pub(crate) async fn subtitle(
    State(state): State<AppState>,
    Path((library, item, index)): Path<(String, String, u32)>,
    request: Request,
) -> Result<Response, HttpError> {
    let user = state.auth.request_user(request.headers())?;
    if !crate::transcoding::load(&state)?.subtitle_extraction {
        return Err(bad(
            "Subtitle extraction is disabled in Transcoding settings.",
        ));
    }
    crate::access::require_item(&state, &user, &library, &item)?;
    let mut source = source(&state, library, item).await?;
    if source.next.as_ref().is_some_and(|next| {
        !crate::access::allows_item(&state, &user, &source.library_id, &next.item_id)
    }) {
        source.next = None;
    }
    let probe = state.playback.probe(&source).await?;
    let track = selected_stream(&probe, "subtitle", Some(index))?
        .ok_or_else(|| bad("Subtitle track not found."))?;
    let (format, mime, name) = match track["codec_name"].as_str() {
        Some("ass" | "ssa") => ("ass", "text/plain; charset=utf-8", "track.ass"),
        Some("subrip" | "webvtt" | "mov_text" | "text" | "srt") => {
            ("vtt", "text/vtt; charset=utf-8", "track.vtt")
        }
        Some("hdmv_pgs_subtitle") => ("pgs", "application/octet-stream", "track.sup"),
        Some("dvd_subtitle") => ("vobsub", "application/octet-stream", "track.mks"),
        _ => {
            return Err(bad(
                "This subtitle format has no supported client renderer.",
            ));
        }
    };
    let path = extracted_resource(&state.playback, &source, index, format).await?;
    let mut response = serve(path, mime, request).await?;
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        format!("inline; filename=\"{name}\"").parse().unwrap(),
    );
    Ok(response)
}
pub(crate) async fn font(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((library, item, index)): Path<(String, String, u32)>,
) -> Result<Response, HttpError> {
    let user = state.auth.request_user(&headers)?;
    if !crate::transcoding::load(&state)?.font_extraction {
        return Err(bad(
            "Embedded font extraction is disabled in Transcoding settings.",
        ));
    }
    crate::access::require_item(&state, &user, &library, &item)?;
    let mut source = source(&state, library, item).await?;
    if source.next.as_ref().is_some_and(|next| {
        !crate::access::allows_item(&state, &user, &source.library_id, &next.item_id)
    }) {
        source.next = None;
    }
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
    let path = extracted_resource(&state.playback, &source, index, "font").await?;
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|_| failure("Unable to read extracted font."))?;
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
            axum::routing::get(hardware::capabilities),
        )
        .route(
            "/api/playback/sessions/{id}/seek",
            axum::routing::post(seek),
        )
        .route(
            "/api/playback/sessions/{id}/hls/{generation}/{name}",
            axum::routing::get(segment),
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
            "/api/playback/sessions/{id}/heartbeat",
            axum::routing::post(heartbeat),
        )
        .route("/api/playback/sessions/{id}", axum::routing::delete(stop))
}

#[cfg(test)]
mod tests;
