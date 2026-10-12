//! Original-file playback, media inspection, resource extraction, and direct session lifecycle.
mod models;
mod planner;
#[cfg(test)]
mod test_support;
use models::{Chapter, Font, Info, NextItem, SessionInput, SessionResponse, Track};
use planner::{plan, selected_stream, validate_request};

use crate::{AppState, HttpError};
use axum::{
    extract::{Path, Request, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use posterview_contracts::native::NativeCatalogEntry;
use posterview_infra_sqlite::ServerStore;
use serde::Deserialize;
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
    process::Command,
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
struct Session {
    library_id: String,
    item_id: String,
    source: PathBuf,
    stamp: (u64, u128),
    response: SessionResponse,
    touched: Instant,
}

pub(crate) struct PlaybackStore {
    root: PathBuf,
    sessions: Mutex<HashMap<String, Session>>,
    probes: Mutex<HashMap<PathBuf, ProbeCache>>,
    resources: Mutex<HashMap<ResourceKey, ResourceCache>>,
    // Only media inspection and subtitle/font extraction use subprocess permits.
    jobs: Arc<Semaphore>,
    started: AtomicBool,
}
impl PlaybackStore {
    pub(crate) fn new(data_dir: &FsPath) -> Self {
        let root = data_dir.join("playback");
        // Retire only generated resource files, never media files or unrelated folders.
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
        Self {
            root,
            sessions: Mutex::new(HashMap::new()),
            probes: Mutex::new(HashMap::new()),
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
        let sessions = self.sessions.lock().await;
        let session = sessions.get(id)?;
        if session.touched.elapsed() > SESSION_IDLE || stamp(&session.source).ok()? != session.stamp
        {
            return None;
        }
        Some((
            session.library_id.clone(),
            session.item_id.clone(),
            session.response.duration_seconds,
        ))
    }
    async fn stop_id(&self, id: &str) {
        self.sessions.lock().await.remove(id);
    }
    async fn maintain(&self) {
        self.sessions
            .lock()
            .await
            .retain(|_, session| session.touched.elapsed() <= SESSION_IDLE);
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
        conversion_allowed: false,
        audio_conversion_allowed: false,
        bandwidth_adaptation_allowed: false,
        source_bitrate: source_bitrate(&probe),
        remux_allowed: false,
        container: container(&source.path),
        tracks: tracks(&probe, &source),
        chapters,
        fonts,
        next: source.next.clone(),
    }))
}

pub(crate) async fn create(
    State(state): State<AppState>,
    Path((library, item)): Path<(String, String)>,
    Json(input): Json<SessionInput>,
) -> Result<Json<SessionResponse>, HttpError> {
    // Reject retired conversion controls before source inspection or session allocation.
    validate_request(&input)?;
    let source = source(&state, library, item).await?;
    let probe = state.playback.probe(&source).await?;
    let plan = plan(&probe, &container(&source.path), &input)?;
    let id = uuid::Uuid::new_v4().to_string();
    let response = SessionResponse {
        id: id.clone(),
        method: plan.method.into(),
        reason: plan.reason.into(),
        url: format!("/api/playback/sessions/{id}/stream"),
        mime: match container(&source.path).as_str() {
            "mkv" => "video/x-matroska",
            "webm" => "video/webm",
            _ => "video/mp4",
        }
        .into(),
        offset_seconds: 0.0,
        duration_seconds: duration(&probe),
        encoder: None,
        audio_index: plan
            .audio
            .as_ref()
            .and_then(|audio| audio["index"].as_u64())
            .map(|index| index as u32),
    };
    let mut sessions = state.playback.sessions.lock().await;
    sessions.retain(|_, session| session.touched.elapsed() <= SESSION_IDLE);
    if sessions.len() >= MAX_SESSIONS {
        return Err(HttpError {
            status: StatusCode::TOO_MANY_REQUESTS,
            detail: "The direct playback session limit has been reached.".into(),
        });
    }
    sessions.insert(
        id,
        Session {
            library_id: source.library_id,
            item_id: source.item.id,
            source: source.path,
            stamp: source.fingerprint,
            response: response.clone(),
            touched: Instant::now(),
        },
    );
    Ok(Json(response))
}

async fn session_path(state: &AppState, id: &str) -> Result<(PathBuf, String), HttpError> {
    let mut sessions = state.playback.sessions.lock().await;
    let session = sessions
        .get_mut(id)
        .filter(|session| session.touched.elapsed() <= SESSION_IDLE)
        .ok_or_else(|| bad("Playback session expired. Reopen the player."))?;
    if stamp(&session.source)? != session.stamp {
        return Err(bad("The video file changed. Reopen the player."));
    }
    session.touched = Instant::now();
    Ok((session.source.clone(), session.response.mime.clone()))
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
    let (path, mime) = session_path(&state, &id).await?;
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
        .filter(|session| session.touched.elapsed() <= SESSION_IDLE)
        .ok_or_else(|| bad("Playback session expired."))?;
    if stamp(&s.source)? != s.stamp {
        return Err(bad("The video file changed. Reopen the player."));
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
    if !input.paused {
        state.auth.activity(&headers);
    }
    Ok(Json(
        json!({"ok":true,"method":"direct","encoder":null,"transcoding":false,"throttled":false}),
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
            .args(["-c", "copy", "-t", "0", "-f", "null", "-"]);
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
        .args(["-vn", "-an", "-dn"])
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
        return Err(bad("This subtitle track is not supported in direct playback. Choose ASS/SSA or a text subtitle track."));
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
