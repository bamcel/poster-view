//! Administrator-owned YouTube downloads and durable queue.
mod artwork;
mod cookies;
mod downloader;
mod naming;
mod nfo;
mod refresh;
mod subscriptions;
use crate::{AppState, HttpError};
use axum::{
    Json, Router,
    extract::{Path, State},
    routing::{get, post},
};
use posterview_infra_sqlite::ServerStore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::PathBuf;
static ACTIVE: std::sync::LazyLock<std::sync::Mutex<std::collections::HashSet<String>>> =
    std::sync::LazyLock::new(Default::default);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub(crate) struct Settings {
    #[serde(default)]
    pub skip_existing: bool,
    pub download_mode: String,
    pub enabled: bool,
    pub library_id: String,
    pub directory: String,
    pub video_codec: String,
    pub audio_codec: String,
    pub container: String,
    #[serde(default = "legacy_filename_convention")]
    pub filename_convention: String,
    #[serde(default)]
    pub quality: Option<u32>,
    pub max_height: u32,
    pub max_fps: u32,
    pub fallback: String,
    pub convert: bool,
    pub crf: u32,
    pub hardware_backend: String,
    pub subtitles: bool,
    pub subtitle_languages: Vec<String>,
    pub chapters: bool,
    pub thumbnail: bool,
}
fn legacy_filename_convention() -> String {
    "id".into()
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            skip_existing: true,
            download_mode: "custom".into(),
            enabled: false,
            library_id: String::new(),
            directory: String::new(),
            video_codec: "auto".into(),
            audio_codec: "auto".into(),
            container: "mp4".into(),
            filename_convention: "date_title_id".into(),
            quality: Some(1080),
            max_height: 1080,
            max_fps: 60,
            fallback: "best".into(),
            convert: false,
            crf: 23,
            hardware_backend: "cpu".into(),
            subtitles: false,
            subtitle_languages: vec!["en".into()],
            chapters: true,
            thumbnail: true,
        }
    }
}
impl Settings {
    /// Preserve custom preferences while direct downloads always copy source streams.
    fn effective(&self) -> Self {
        let mut settings = self.clone();
        if settings.download_mode == "direct" {
            settings.convert = false;
            settings.video_codec = "auto".into();
            settings.audio_codec = "auto".into();
            settings.container = "mkv".into();
            settings.hardware_backend = "cpu".into();
            settings.max_fps = 240;
        }
        settings
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Job {
    #[serde(default)]
    pub metadata_only: bool,
    pub id: String,
    pub url: String,
    pub title: String,
    pub status: String,
    pub progress: Option<f64>,
    #[serde(default)]
    pub encoding_progress: Option<f64>,
    #[serde(default)]
    pub total_videos: usize,
    #[serde(default)]
    pub completed_videos: usize,
    #[serde(default)]
    pub downloaded_videos: usize,
    #[serde(default)]
    pub existing_videos: usize,
    #[serde(default)]
    pub updated_videos: usize,
    #[serde(default)]
    pub skipped_videos: usize,
    #[serde(default)]
    pub failed_videos: usize,
    #[serde(default)]
    pub failed_entries: Vec<VideoFailure>,

    #[serde(default)]
    pub current_video_title: Option<String>,
    pub speed: Option<String>,
    pub eta: Option<String>,
    pub error: Option<String>,
    pub created_at: String,
    #[serde(default)]
    pub finished_at: Option<String>,
    pub settings: Settings,
    #[serde(default)]
    pub video_ids: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct VideoFailure {
    pub video_id: String,
    pub title: String,
    pub error: String,
}
#[derive(Clone, Copy)]
enum Outcome {
    Downloaded,
    Existing,
    Updated,
    Skipped,
}
async fn outcome(
    state: &AppState,
    id: &str,
    entry: &Value,
    result: Result<Outcome, HttpError>,
) -> Result<(), HttpError> {
    let _lock = state.ytdl_lock.lock().await;
    let mut jobs: Vec<Job> = load(state, "plugin-ytdl-jobs")?;
    if let Some(job) = jobs
        .iter_mut()
        .find(|job| job.id == id && job.status != "cancelled")
    {
        match result {
            Ok(Outcome::Downloaded) => job.downloaded_videos += 1,
            Ok(Outcome::Existing) => job.existing_videos += 1,
            Ok(Outcome::Updated) => job.updated_videos += 1,
            Ok(Outcome::Skipped) => job.skipped_videos += 1,
            Err(error) => {
                job.failed_videos += 1;
                job.failed_entries.push(VideoFailure {
                    video_id: downloader::text(entry, "id"),
                    title: downloader::text(entry, "title").chars().take(512).collect(),
                    error: error.detail.chars().take(2048).collect(),
                });
            }
        }
    }
    save(state, "plugin-ytdl-jobs", &jobs)
}
async fn finish(state: &AppState, id: &str) -> Result<(), HttpError> {
    let jobs: Vec<Job> = {
        let _lock = state.ytdl_lock.lock().await;
        load(state, "plugin-ytdl-jobs")?
    };
    let job = jobs
        .iter()
        .find(|job| job.id == id)
        .ok_or_else(|| err("Download not found."))?;
    let warnings = job.failed_videos + job.skipped_videos;
    let status = if job.failed_videos > 0 && job.failed_videos == job.completed_videos {
        "failed"
    } else if warnings > 0 {
        "completed_with_warnings"
    } else {
        "completed"
    };
    let message = (warnings > 0).then(|| {
        format!(
            "{} failed, {} skipped. Finished files are kept.",
            job.failed_videos, job.skipped_videos
        )
    });
    update(state, id, status, message, Some(100.0)).await
}
fn err(e: impl std::fmt::Display) -> HttpError {
    HttpError::bad_request(e.to_string())
}
fn load<T: serde::de::DeserializeOwned + Default>(
    state: &AppState,
    key: &str,
) -> Result<T, HttpError> {
    if key == "plugin-ytdl-jobs" {
        let path = state.runtime.data_dir().join("ytdl-jobs.json");
        match std::fs::read(&path) {
            Ok(raw) => return serde_json::from_slice(&raw).map_err(err),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(err(error)),
        }
        // Migrate once. Never fall back to SQLite after a file read/parse error:
        // doing so could resurrect jobs that were removed from the new queue.
        let raw = ServerStore::new(state.runtime.data_dir())
            .get_setting(key)
            .map_err(HttpError::from)?;
        let value = if raw.is_empty() {
            T::default()
        } else {
            serde_json::from_str(&raw).map_err(err)?
        };
        write_queue(
            state,
            if raw.is_empty() {
                b"[]"
            } else {
                raw.as_bytes()
            },
        )?;
        return Ok(value);
    }
    let raw = ServerStore::new(state.runtime.data_dir())
        .get_setting(key)
        .map_err(HttpError::from)?;
    if raw.is_empty() {
        Ok(T::default())
    } else {
        serde_json::from_str(&raw).map_err(err)
    }
}
fn save<T: Serialize>(state: &AppState, key: &str, value: &T) -> Result<(), HttpError> {
    if key == "plugin-ytdl-jobs" {
        return write_queue(state, &serde_json::to_vec(value).map_err(err)?);
    }
    ServerStore::new(state.runtime.data_dir())
        .set_setting(key, &serde_json::to_string(value).map_err(err)?)
        .map_err(HttpError::from)
}
fn write_queue(state: &AppState, bytes: &[u8]) -> Result<(), HttpError> {
    use std::io::Write;
    let directory = state.runtime.data_dir();
    let mut staged = tempfile::NamedTempFile::new_in(directory).map_err(err)?;
    staged.write_all(bytes).map_err(err)?;
    staged.as_file().sync_all().map_err(err)?;
    staged
        .persist(directory.join("ytdl-jobs.json"))
        .map_err(err)?;
    Ok(())
}
pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/plugins/ytdl", get(settings_get).put(settings_save))
        .merge(cookies::routes())
        .route("/api/plugins/ytdl/inspect", post(inspect))
        .route("/api/plugins/ytdl/jobs", get(jobs_get).post(jobs_create))
        .route("/api/plugins/ytdl/jobs/{id}", axum::routing::delete(remove))
        .route("/api/plugins/ytdl/jobs/{id}/cancel", post(cancel))
        .route("/api/plugins/ytdl/jobs/{id}/retry", post(retry))
        .route(
            "/api/plugins/ytdl/jobs/{id}/retry-failed",
            post(retry_failed),
        )
        .merge(subscriptions::routes())
}
async fn settings_get(State(state): State<AppState>) -> Result<Json<Value>, HttpError> {
    Ok(Json(
        json!({"settings":load::<Settings>(&state,"plugin-ytdl")?,"dependencies":downloader::dependencies().await}),
    ))
}
async fn settings_save(
    State(state): State<AppState>,
    Json(settings): Json<Settings>,
) -> Result<Json<Settings>, HttpError> {
    validate_settings(&state, &settings)?;
    let _lock = state.ytdl_lock.lock().await;
    save(&state, "plugin-ytdl", &settings)?;
    Ok(Json(settings))
}
fn validate_settings(state: &AppState, s: &Settings) -> Result<PathBuf, HttpError> {
    if !["direct", "custom"].contains(&s.download_mode.as_str()) {
        return Err(err("Invalid download mode."));
    }
    let effective = s.effective();
    let s = &effective;
    if !["auto", "h264", "hevc", "vp9", "av1"].contains(&s.video_codec.as_str())
        || !["auto", "aac", "opus"].contains(&s.audio_codec.as_str())
        || !["mp4", "mkv", "webm"].contains(&s.container.as_str())
        || !["id", "title", "date_title", "title_id", "date_title_id"]
            .contains(&s.filename_convention.as_str())
        || ![
            "best",
            "strict",
            "highest",
            "next_highest",
            "next_lowest",
            "skip",
        ]
        .contains(&s.fallback.as_str())
        || s.quality
            .is_some_and(|q| ![0, 480, 720, 1080, 1440, 2160].contains(&q))
        || !(144..=4320).contains(&s.max_height)
        || !(1..=240).contains(&s.max_fps)
        || s.crf > 51
        || !["cpu", "nvenc", "qsv", "vaapi"].contains(&s.hardware_backend.as_str())
        || s.subtitle_languages.len() > 20
        || s.subtitle_languages.iter().any(|v| {
            v.is_empty()
                || v.len() > 35
                || !v
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        })
    {
        return Err(err("Invalid codec, quality, or subtitle setting."));
    }
    if s.convert
        && s.hardware_backend != "cpu"
        && !["h264", "hevc", "av1"].contains(&s.video_codec.as_str())
    {
        return Err(err(
            "GPU encoding requires an explicit H.264, HEVC, or AV1 video codec. Choose CPU for Automatic or VP9.",
        ));
    }
    if s.container == "webm"
        && (["h264", "hevc"].contains(&s.video_codec.as_str()) || s.audio_codec == "aac")
    {
        return Err(err(
            "WebM requires VP9/AV1 video and Opus audio. Choose MKV/MP4 for H.264, HEVC, or AAC.",
        ));
    }
    let destination = state.metadata.directory(&s.directory, true)?;
    tempfile::NamedTempFile::new_in(&destination)
        .map_err(|_| err("Download directory is not writable."))?;
    Ok(destination)
}
fn validate_metadata_destination(state: &AppState, s: &Settings) -> Result<PathBuf, HttpError> {
    let destination = state.metadata.directory(&s.directory, false)?;
    tempfile::NamedTempFile::new_in(&destination)
        .map_err(|_| err("Metadata directory is not writable."))?;
    Ok(destination)
}
#[derive(Deserialize)]
struct InspectRequest {
    url: String,
}
async fn inspect(
    State(state): State<AppState>,
    Json(input): Json<InspectRequest>,
) -> Result<Json<Value>, HttpError> {
    downloader::inspect(&state, &input.url).await.map(Json)
}
async fn jobs_get(State(state): State<AppState>) -> Result<Json<Vec<Job>>, HttpError> {
    let _lock = state.ytdl_lock.lock().await;
    Ok(Json(load(&state, "plugin-ytdl-jobs")?))
}
#[derive(Deserialize)]
struct CreateRequest {
    #[serde(default)]
    metadata_only: bool,
    url: String,
    #[serde(default)]
    video_ids: Vec<String>,
    settings: Settings,
}
async fn jobs_create(
    State(state): State<AppState>,
    Json(input): Json<CreateRequest>,
) -> Result<Json<Value>, HttpError> {
    if !load::<Settings>(&state, "plugin-ytdl")?.enabled {
        return Err(err("Enable and save the YTDL plugin before downloading."));
    }
    downloader::validate_url(&input.url)?;
    if input.metadata_only {
        validate_metadata_destination(&state, &input.settings)?;
    } else {
        validate_settings(&state, &input.settings)?;
    }
    if !input.settings.enabled {
        return Err(err("Enable the YTDL plugin first."));
    }
    if !input.metadata_only && downloader::is_channel_url(&input.url) {
        return Err(err(
            "Choose a video or playlist from the channel before downloading.",
        ));
    }
    if input.video_ids.len() > 10000 || input.video_ids.iter().any(|v| !downloader::valid_id(v)) {
        return Err(err("Invalid selected video IDs."));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let job = Job {
        metadata_only: input.metadata_only,
        id: id.clone(),
        url: input.url,
        title: if input.metadata_only {
            "YouTube NFO update"
        } else {
            "YouTube download"
        }
        .into(),
        status: "queued".into(),
        progress: None,
        encoding_progress: None,
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
        created_at: chrono::Utc::now().to_rfc3339(),
        finished_at: None,
        settings: input.settings,
        video_ids: input.video_ids,
    };
    let _lock = state.ytdl_lock.lock().await;
    let mut jobs: Vec<Job> = load(&state, "plugin-ytdl-jobs")?;
    if jobs.len() >= 1000 {
        return Err(err("Download history has reached its limit."));
    }
    jobs.push(job);
    save(&state, "plugin-ytdl-jobs", &jobs)?;
    state.ytdl_notify.notify_one();
    Ok(Json(json!({"id":id})))
}
async fn change(
    state: &AppState,
    id: &str,
    retry: bool,
    failed_only: bool,
) -> Result<Job, HttpError> {
    let _lock = state.ytdl_lock.lock().await;
    let mut jobs: Vec<Job> = load(state, "plugin-ytdl-jobs")?;
    let job = jobs
        .iter_mut()
        .find(|j| j.id == id)
        .ok_or_else(|| err("Download not found."))?;
    if retry {
        if ACTIVE.lock().map_err(err)?.contains(id) {
            return Err(err(
                "Wait until the cancelled downloader has stopped before retrying.",
            ));
        }
        if ![
            "failed",
            "interrupted",
            "cancelled",
            "completed_with_warnings",
        ]
        .contains(&job.status.as_str())
        {
            return Err(err("Only stopped downloads can be retried."));
        }
        if job.metadata_only {
            validate_metadata_destination(state, &job.settings)?;
        } else {
            validate_settings(state, &job.settings)?;
        }
        if failed_only {
            if job.failed_entries.is_empty() {
                return Err(err("No failed videos to retry."));
            }
            job.video_ids = job
                .failed_entries
                .iter()
                .map(|entry| entry.video_id.clone())
                .collect();
        }
        job.downloaded_videos = 0;
        job.existing_videos = 0;
        job.updated_videos = 0;
        job.skipped_videos = 0;
        job.failed_videos = 0;
        job.failed_entries.clear();
        job.status = "queued".into();
        job.error = None;
        job.progress = None;
        job.encoding_progress = None;
        job.total_videos = 0;
        job.completed_videos = 0;
        job.current_video_title = None;
        job.finished_at = None;
    } else {
        if ["completed", "completed_with_warnings"].contains(&job.status.as_str()) {
            return Err(err("Completed downloads cannot be cancelled."));
        }
        job.status = "cancelled".into();
        job.finished_at = Some(chrono::Utc::now().to_rfc3339());
    }
    let result = job.clone();
    save(state, "plugin-ytdl-jobs", &jobs)?;
    state.ytdl_notify.notify_one();
    Ok(result)
}
async fn cancel(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Job>, HttpError> {
    change(&state, &id, false, false).await.map(Json)
}
async fn retry(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Job>, HttpError> {
    change(&state, &id, true, false).await.map(Json)
}
async fn retry_failed(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Job>, HttpError> {
    change(&state, &id, true, true).await.map(Json)
}
async fn remove(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<axum::http::StatusCode, HttpError> {
    let _lock = state.ytdl_lock.lock().await;
    let mut jobs: Vec<Job> = load(&state, "plugin-ytdl-jobs")?;
    jobs.retain(|job| job.id != id);
    save(&state, "plugin-ytdl-jobs", &jobs)?;
    // Missing jobs are treated as cancelled by the worker. Keep media files intact.
    state.ytdl_notify.notify_one();
    Ok(axum::http::StatusCode::NO_CONTENT)
}
fn clean_history(jobs: &mut Vec<Job>, now: chrono::DateTime<chrono::Utc>) {
    let cutoff = now - chrono::Duration::days(7);
    jobs.retain(|job| {
        ![
            "completed",
            "completed_with_warnings",
            "failed",
            "cancelled",
            "interrupted",
        ]
        .contains(&job.status.as_str())
            || chrono::DateTime::parse_from_rfc3339(
                job.finished_at.as_deref().unwrap_or(&job.created_at),
            )
            .map_or(true, |finished| finished > cutoff)
    });
}
async fn update(
    state: &AppState,
    id: &str,
    status: &str,
    error: Option<String>,
    progress: Option<f64>,
) -> Result<(), HttpError> {
    let _lock = state.ytdl_lock.lock().await;
    let mut jobs: Vec<Job> = load(state, "plugin-ytdl-jobs")?;
    if let Some(job) = jobs.iter_mut().find(|j| j.id == id)
        && job.status != "cancelled"
    {
        job.status = status.into();
        if [
            "completed",
            "completed_with_warnings",
            "failed",
            "interrupted",
        ]
        .contains(&status)
        {
            job.finished_at = Some(chrono::Utc::now().to_rfc3339());
        }
        job.error = error;
        if progress.is_some() {
            job.progress = progress;
        }
        if status != "downloading" {
            job.speed = None;
            job.eta = None;
        }
    }
    save(state, "plugin-ytdl-jobs", &jobs)
}
async fn cancelled(state: &AppState, id: &str) -> bool {
    let _lock = state.ytdl_lock.lock().await;
    load::<Vec<Job>>(state, "plugin-ytdl-jobs").map_or(true, |jobs| {
        jobs.iter()
            .find(|j| j.id == id)
            .is_none_or(|j| j.status == "cancelled")
    })
}
fn recover(jobs: &mut [Job]) {
    for job in jobs {
        if ["inspecting", "downloading", "processing", "importing"].contains(&job.status.as_str()) {
            job.status = "interrupted".into();
            job.finished_at = Some(chrono::Utc::now().to_rfc3339());
            job.error = Some("Server restarted. Retry to resume this download.".into());
        }
    }
}
pub(crate) fn start(state: AppState) {
    let cleanup_state = state.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(3600));
        loop {
            interval.tick().await;
            let _lock = cleanup_state.ytdl_lock.lock().await;
            if let Ok(mut jobs) = load::<Vec<Job>>(&cleanup_state, "plugin-ytdl-jobs") {
                let before = jobs.len();
                clean_history(&mut jobs, chrono::Utc::now());
                if jobs.len() != before {
                    if let Err(error) = save(&cleanup_state, "plugin-ytdl-jobs", &jobs) {
                        tracing::error!(?error, "Download history cleanup could not be persisted");
                    }
                }
            }
        }
    });
    tokio::spawn(async move {
        {
            let _lock = state.ytdl_lock.lock().await;
            if let Ok(mut jobs) = load::<Vec<Job>>(&state, "plugin-ytdl-jobs") {
                let interrupted = jobs.iter().any(|job| {
                    ["inspecting", "downloading", "processing", "importing"]
                        .contains(&job.status.as_str())
                });
                if interrupted {
                    recover(&mut jobs);
                    if let Err(error) = save(&state, "plugin-ytdl-jobs", &jobs) {
                        tracing::error!(
                            ?error,
                            "Interrupted download recovery could not be persisted"
                        );
                    }
                }
            }
        }
        subscriptions::start(state.clone());
        loop {
            let job = {
                let _lock = state.ytdl_lock.lock().await;
                load::<Vec<Job>>(&state, "plugin-ytdl-jobs")
                    .ok()
                    .and_then(|jobs| jobs.into_iter().find(|j| j.status == "queued"))
            };
            if let Some(job) = job {
                if let Ok(mut active) = ACTIVE.lock() {
                    active.insert(job.id.clone());
                }
                if let Err(e) = downloader::run(&state, &job).await {
                    if let Err(error) =
                        update(&state, &job.id, "failed", Some(e.detail), None).await
                    {
                        tracing::error!(job_id=%job.id, ?error, "Download failure could not be persisted");
                    }
                }
                if let Ok(mut active) = ACTIVE.lock() {
                    active.remove(&job.id);
                }
            } else {
                state.ytdl_notify.notified().await;
            }
        }
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    fn job(status: &str) -> Job {
        Job {
            metadata_only: false,
            id: "fixture".into(),
            url: "https://youtube.com/watch?v=fixture".into(),
            title: "Fixture".into(),
            status: status.into(),
            progress: None,
            encoding_progress: None,
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
            created_at: "2026-01-01".into(),
            finished_at: None,
            settings: Settings::default(),
            video_ids: vec![],
        }
    }
    #[test]
    fn new_defaults_skip_existing_but_legacy_configs_do_not_change() {
        assert!(Settings::default().skip_existing);
        assert!(
            !serde_json::from_str::<Settings>("{}")
                .unwrap()
                .skip_existing
        );
        let mut legacy = serde_json::to_value(job("completed")).unwrap();
        for field in [
            "downloaded_videos",
            "existing_videos",
            "updated_videos",
            "skipped_videos",
            "failed_videos",
            "failed_entries",
        ] {
            legacy.as_object_mut().unwrap().remove(field);
        }
        let restored: Job = serde_json::from_value(legacy).unwrap();
        assert_eq!(restored.failed_videos, 0);
        assert!(restored.failed_entries.is_empty());
    }
    #[tokio::test]
    async fn warnings_preserve_success_and_retry_only_failed_videos() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        let mut fixture = job("downloading");
        fixture.settings.enabled = true;
        fixture.completed_videos = 3;
        fixture.total_videos = 3;
        save(&state, "plugin-ytdl-jobs", &vec![fixture]).unwrap();
        outcome(
            &state,
            "fixture",
            &json!({"id":"good"}),
            Ok(Outcome::Downloaded),
        )
        .await
        .unwrap();
        outcome(
            &state,
            "fixture",
            &json!({"id":"old"}),
            Ok(Outcome::Existing),
        )
        .await
        .unwrap();
        outcome(
            &state,
            "fixture",
            &json!({"id":"restricted", "title":"Restricted"}),
            Err(err("Sign in to confirm your age")),
        )
        .await
        .unwrap();
        finish(&state, "fixture").await.unwrap();
        let saved: Vec<Job> = load(&state, "plugin-ytdl-jobs").unwrap();
        assert_eq!(saved[0].status, "completed_with_warnings");
        assert_eq!(
            (
                saved[0].downloaded_videos,
                saved[0].existing_videos,
                saved[0].failed_videos
            ),
            (1, 1, 1)
        );
        let retried = change(&state, "fixture", true, true).await.unwrap();
        assert_eq!(retried.video_ids, vec!["restricted"]);
        assert_eq!(retried.completed_videos, 0);
        assert_eq!(retried.failed_videos, 0);
        assert!(retried.failed_entries.is_empty());
        assert_eq!(retried.status, "queued");
        assert!(change(&state, "fixture", true, true).await.is_err());
    }
    #[test]
    fn queue_migrates_once_and_survives_catalog_write_locks() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        let mut original = job("downloading");
        original.video_ids = vec!["video-id".into()];
        ServerStore::new(state.runtime.data_dir())
            .set_setting(
                "plugin-ytdl-jobs",
                &serde_json::to_string(&vec![original]).unwrap(),
            )
            .unwrap();
        let migrated: Vec<Job> = load(&state, "plugin-ytdl-jobs").unwrap();
        assert_eq!(migrated[0].video_ids, vec!["video-id"]);
        let connection =
            rusqlite::Connection::open(state.runtime.data_dir().join("posterview.db")).unwrap();
        connection.execute_batch("BEGIN IMMEDIATE").unwrap();
        save(&state, "plugin-ytdl-jobs", &Vec::<Job>::new()).unwrap();
        assert!(
            load::<Vec<Job>>(&state, "plugin-ytdl-jobs")
                .unwrap()
                .is_empty()
        );
        connection.execute_batch("ROLLBACK").unwrap();
        // A corrupt file must not resurrect the old SQLite queue.
        std::fs::write(
            state.runtime.data_dir().join("ytdl-jobs.json"),
            b"broken json",
        )
        .unwrap();
        assert!(load::<Vec<Job>>(&state, "plugin-ytdl-jobs").is_err());
    }
    #[test]
    fn history_cleanup_uses_finish_time_and_preserves_active_jobs() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-10-15T00:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        let mut old = job("completed");
        old.finished_at = Some("2026-10-08T00:00:00Z".into());
        let mut recent = job("failed");
        recent.finished_at = Some("2026-10-14T00:00:00Z".into());
        let mut legacy = job("cancelled");
        legacy.created_at = "2026-10-01T00:00:00Z".into();
        let mut jobs = vec![old, recent, legacy, job("downloading"), job("queued")];
        clean_history(&mut jobs, now);
        assert_eq!(
            jobs.iter()
                .map(|job| job.status.as_str())
                .collect::<Vec<_>>(),
            ["failed", "downloading", "queued"]
        );
    }
    #[tokio::test]
    async fn removed_jobs_stop_workers_without_removing_media_or_reappearing() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        let media = temp.path().join("keep.mkv");
        std::fs::write(&media, "downloaded video").unwrap();
        save(&state, "plugin-ytdl-jobs", &vec![job("downloading")]).unwrap();
        assert_eq!(
            remove(State(state.clone()), Path("fixture".into()))
                .await
                .unwrap(),
            axum::http::StatusCode::NO_CONTENT
        );
        assert!(cancelled(&state, "fixture").await);
        update(&state, "fixture", "completed", None, Some(100.0))
            .await
            .unwrap();
        assert!(
            load::<Vec<Job>>(&state, "plugin-ytdl-jobs")
                .unwrap()
                .is_empty()
        );
        assert!(media.exists());
    }
    #[test]
    fn legacy_jobs_default_playlist_progress() {
        let mut value = serde_json::to_value(job("downloading")).unwrap();
        let object = value.as_object_mut().unwrap();
        for key in ["total_videos", "completed_videos", "current_video_title"] {
            object.remove(key);
        }
        object.remove("metadata_only");
        let restored: Job = serde_json::from_value(value).unwrap();
        assert_eq!(restored.total_videos, 0);
        assert_eq!(restored.completed_videos, 0);
        assert!(restored.current_video_title.is_none());
        assert!(!restored.metadata_only);
    }

    #[tokio::test]
    async fn playlist_progress_is_durable_and_preserved_between_phases() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        let mut fixture = job("downloading");
        fixture.total_videos = 4;
        fixture.completed_videos = 1;
        fixture.current_video_title = Some("Second video".into());
        fixture.progress = Some(25.0);
        downloader::record_stream_progress(&mut fixture, Some(100.0));
        let aggregate = fixture.progress;
        assert_eq!(aggregate, Some(48.75));
        downloader::record_stream_progress(&mut fixture, Some(5.0));
        assert_eq!(
            fixture.progress, aggregate,
            "audio stream must not reset progress"
        );
        save(&state, "plugin-ytdl-jobs", &vec![fixture]).unwrap();
        update(&state, "fixture", "processing", None, None)
            .await
            .unwrap();
        let Json(restored) = jobs_get(State(state.clone())).await.unwrap();
        assert_eq!(restored[0].progress, aggregate);
        assert_eq!(restored[0].completed_videos, 1);
        assert_eq!(
            restored[0].current_video_title.as_deref(),
            Some("Second video")
        );
        downloader::video_progress(&state, "fixture", 4, 2, None)
            .await
            .unwrap();
        update(&state, "fixture", "importing", None, None)
            .await
            .unwrap();
        let Json(restored) = jobs_get(State(state)).await.unwrap();
        assert_eq!(restored[0].progress, Some(50.0));
        assert_eq!(restored[0].completed_videos, 2);
    }

    #[test]
    fn older_saved_jobs_keep_id_filenames() {
        let settings: Settings = serde_json::from_value(json!({"enabled":false})).unwrap();
        assert_eq!(settings.filename_convention, "id");
        assert_eq!(settings.crf, 23);
        assert_eq!(settings.hardware_backend, "cpu");
        assert!(!settings.skip_existing);
        assert_eq!(Settings::default().filename_convention, "date_title_id");
    }

    #[tokio::test]
    async fn metadata_jobs_accept_channels_without_download_encoder_settings() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        std::fs::create_dir(temp.path().join("media/downloads")).unwrap();
        let settings = Settings {
            enabled: true,
            directory: "downloads".into(),
            convert: true,
            hardware_backend: "nvenc".into(),
            skip_existing: true,
            ..Default::default()
        };
        save(&state, "plugin-ytdl", &settings).unwrap();
        let request = |metadata_only| CreateRequest {
            metadata_only,
            url: "https://www.youtube.com/@OutdoorBoys".into(),
            video_ids: vec![],
            settings: settings.clone(),
        };
        assert!(
            jobs_create(State(state.clone()), Json(request(false)))
                .await
                .is_err()
        );
        let Json(created) = jobs_create(State(state.clone()), Json(request(true)))
            .await
            .unwrap();
        let jobs: Vec<Job> = load(&state, "plugin-ytdl-jobs").unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(created["id"], jobs[0].id);
        assert!(jobs[0].metadata_only);
        assert!(jobs[0].settings.skip_existing);
        change(&state, &jobs[0].id, false, false).await.unwrap();
        let retried = change(&state, &jobs[0].id, true, false).await.unwrap();
        assert!(retried.metadata_only);
        assert_eq!(retried.status, "queued");
    }

    #[test]
    fn metadata_destination_must_exist_and_stay_inside_media_root() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        let mut settings = Settings {
            directory: "missing".into(),
            ..Default::default()
        };
        assert!(validate_metadata_destination(&state, &settings).is_err());
        assert!(!temp.path().join("media/missing").exists());
        settings.directory = "../outside".into();
        assert!(validate_metadata_destination(&state, &settings).is_err());
    }

    #[test]
    fn restart_requires_explicit_retry() {
        let mut jobs = vec![job("downloading"), job("queued"), job("completed")];
        recover(&mut jobs);
        assert_eq!(jobs[0].status, "interrupted");
        assert_eq!(jobs[1].status, "queued");
        assert_eq!(jobs[2].status, "completed");
    }
    #[tokio::test]
    async fn cancellation_is_persisted_and_worker_cannot_overwrite_it() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        save(&state, "plugin-ytdl-jobs", &vec![job("downloading")]).unwrap();
        change(&state, "fixture", false, false).await.unwrap();
        update(&state, "fixture", "completed", None, Some(100.0))
            .await
            .unwrap();
        assert!(cancelled(&state, "fixture").await);
        assert_eq!(
            load::<Vec<Job>>(&state, "plugin-ytdl-jobs").unwrap()[0].status,
            "cancelled"
        );
    }
    #[test]
    fn downloads_require_a_writable_media_directory_not_a_library() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        std::fs::create_dir(temp.path().join("media/downloads")).unwrap();
        let mut settings = Settings {
            enabled: true,
            directory: "downloads".into(),
            ..Default::default()
        };
        assert_eq!(
            validate_settings(&state, &settings).unwrap(),
            temp.path().join("media/downloads").canonicalize().unwrap()
        );
        settings.library_id = "deleted-library".into();
        assert!(validate_settings(&state, &settings).is_ok());
        settings.quality = Some(1440);
        assert!(validate_settings(&state, &settings).is_ok());
        settings.crf = 52;
        assert!(validate_settings(&state, &settings).is_err());
        settings.crf = 23;
        settings.convert = true;
        settings.hardware_backend = "nvenc".into();
        assert!(validate_settings(&state, &settings).is_err());
        settings.video_codec = "hevc".into();
        assert!(validate_settings(&state, &settings).is_ok());
        settings.hardware_backend = "unsupported".into();
        assert!(validate_settings(&state, &settings).is_err());
        settings.hardware_backend = "cpu".into();
        settings.directory = "../outside".into();
        assert!(validate_settings(&state, &settings).is_err());
        settings.directory = "missing".into();
        assert!(validate_settings(&state, &settings).is_err());
    }
    #[test]
    fn invalid_settings_cannot_disable_validation() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        let settings = Settings {
            video_codec: "--exec".into(),
            ..Default::default()
        };
        assert!(validate_settings(&state, &settings).is_err());
        let settings = Settings {
            subtitle_languages: vec!["en,--exec=x".into()],
            ..Default::default()
        };
        assert!(validate_settings(&state, &settings).is_err());
    }
}
