//! Administrator-owned YouTube downloads and durable queue.
mod downloader;
mod naming;
mod nfo;
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
    pub enabled: bool,
    pub library_id: String,
    pub directory: String,
    pub video_codec: String,
    pub audio_codec: String,
    pub container: String,
    #[serde(default = "legacy_filename_convention")]
    pub filename_convention: String,
    pub max_height: u32,
    pub max_fps: u32,
    pub fallback: String,
    pub convert: bool,
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
            enabled: false,
            library_id: String::new(),
            directory: String::new(),
            video_codec: "auto".into(),
            audio_codec: "auto".into(),
            container: "mp4".into(),
            filename_convention: "date_title_id".into(),
            max_height: 1080,
            max_fps: 60,
            fallback: "best".into(),
            convert: false,
            subtitles: false,
            subtitle_languages: vec!["en".into()],
            chapters: true,
            thumbnail: true,
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Job {
    pub id: String,
    pub url: String,
    pub title: String,
    pub status: String,
    pub progress: Option<f64>,
    pub speed: Option<String>,
    pub eta: Option<String>,
    pub error: Option<String>,
    pub created_at: String,
    pub settings: Settings,
    #[serde(default)]
    pub video_ids: Vec<String>,
}
fn err(e: impl std::fmt::Display) -> HttpError {
    HttpError::bad_request(e.to_string())
}
fn load<T: serde::de::DeserializeOwned + Default>(
    state: &AppState,
    key: &str,
) -> Result<T, HttpError> {
    let raw = ServerStore::new(state.runtime.data_dir())
        .get_setting(key)
        .map_err(err)?;
    if raw.is_empty() {
        Ok(T::default())
    } else {
        serde_json::from_str(&raw).map_err(err)
    }
}
fn save<T: Serialize>(state: &AppState, key: &str, value: &T) -> Result<(), HttpError> {
    ServerStore::new(state.runtime.data_dir())
        .set_setting(key, &serde_json::to_string(value).map_err(err)?)
        .map_err(err)
}
pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/plugins/ytdl", get(settings_get).put(settings_save))
        .route("/api/plugins/ytdl/inspect", post(inspect))
        .route("/api/plugins/ytdl/jobs", get(jobs_get).post(jobs_create))
        .route("/api/plugins/ytdl/jobs/{id}/cancel", post(cancel))
        .route("/api/plugins/ytdl/jobs/{id}/retry", post(retry))
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
    if !["auto", "h264", "vp9", "av1"].contains(&s.video_codec.as_str())
        || !["auto", "aac", "opus"].contains(&s.audio_codec.as_str())
        || !["mp4", "mkv", "webm"].contains(&s.container.as_str())
        || !["id", "title", "date_title", "title_id", "date_title_id"]
            .contains(&s.filename_convention.as_str())
        || !["best", "strict"].contains(&s.fallback.as_str())
        || !(144..=4320).contains(&s.max_height)
        || !(1..=240).contains(&s.max_fps)
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
    if s.container == "webm" && (s.video_codec == "h264" || s.audio_codec == "aac") {
        return Err(err(
            "WebM requires VP9/AV1 video and Opus audio. Choose MKV/MP4 for H.264 or AAC.",
        ));
    }
    if !s.enabled && s.library_id.is_empty() {
        return Ok(PathBuf::new());
    }
    let library = ServerStore::new(state.runtime.data_dir())
        .native_libraries()
        .map_err(err)?
        .into_iter()
        .find(|l| l.id == s.library_id && l.library_type.as_str() == "youtube")
        .ok_or_else(|| err("Select a YouTube library."))?;
    let destination = state.metadata.directory(&s.directory, true)?;
    let roots = if library.paths.is_empty() {
        vec![String::new()]
    } else {
        library.paths
    };
    if !roots.iter().any(|root| {
        state
            .metadata
            .directory(root, true)
            .is_ok_and(|p| destination.starts_with(p))
    }) {
        return Err(err(
            "Download directory must be inside the selected library.",
        ));
    }
    tempfile::NamedTempFile::new_in(&destination)
        .map_err(|_| err("Download directory is not writable."))?;
    Ok(destination)
}
#[derive(Deserialize)]
struct InspectRequest {
    url: String,
}
async fn inspect(
    State(_state): State<AppState>,
    Json(input): Json<InspectRequest>,
) -> Result<Json<Value>, HttpError> {
    downloader::inspect(&input.url).await.map(Json)
}
async fn jobs_get(State(state): State<AppState>) -> Result<Json<Vec<Job>>, HttpError> {
    let _lock = state.ytdl_lock.lock().await;
    Ok(Json(load(&state, "plugin-ytdl-jobs")?))
}
#[derive(Deserialize)]
struct CreateRequest {
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
    validate_settings(&state, &input.settings)?;
    if !input.settings.enabled {
        return Err(err("Enable the YTDL plugin first."));
    }
    if downloader::is_channel_url(&input.url) {
        return Err(err(
            "Choose a video or playlist from the channel before downloading.",
        ));
    }
    if input.video_ids.len() > 10000 || input.video_ids.iter().any(|v| !downloader::valid_id(v)) {
        return Err(err("Invalid selected video IDs."));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let job = Job {
        id: id.clone(),
        url: input.url,
        title: "YouTube download".into(),
        status: "queued".into(),
        progress: None,
        speed: None,
        eta: None,
        error: None,
        created_at: chrono::Utc::now().to_rfc3339(),
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
async fn change(state: &AppState, id: &str, retry: bool) -> Result<Job, HttpError> {
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
        if !["failed", "interrupted", "cancelled"].contains(&job.status.as_str()) {
            return Err(err("Only stopped downloads can be retried."));
        }
        validate_settings(state, &job.settings)?;
        job.status = "queued".into();
        job.error = None;
        job.progress = None;
    } else {
        if job.status == "completed" {
            return Err(err("Completed downloads cannot be cancelled."));
        }
        job.status = "cancelled".into();
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
    change(&state, &id, false).await.map(Json)
}
async fn retry(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Job>, HttpError> {
    change(&state, &id, true).await.map(Json)
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
    if let Some(job) = jobs.iter_mut().find(|j| j.id == id) {
        if job.status != "cancelled" {
            job.status = status.into();
            job.error = error;
            job.progress = progress;
            if status != "downloading" {
                job.speed = None;
                job.eta = None;
            }
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
            job.error = Some("Server restarted. Retry to resume this download.".into());
        }
    }
}
pub(crate) fn start(state: AppState) {
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
                    let _ = save(&state, "plugin-ytdl-jobs", &jobs);
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
                    let _ = update(&state, &job.id, "failed", Some(e.detail), None).await;
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
            id: "fixture".into(),
            url: "https://youtube.com/watch?v=fixture".into(),
            title: "Fixture".into(),
            status: status.into(),
            progress: None,
            speed: None,
            eta: None,
            error: None,
            created_at: "2026-01-01".into(),
            settings: Settings::default(),
            video_ids: vec![],
        }
    }
    #[test]
    fn older_saved_jobs_keep_id_filenames() {
        let settings: Settings = serde_json::from_value(json!({"enabled":false})).unwrap();
        assert_eq!(settings.filename_convention, "id");
        assert_eq!(Settings::default().filename_convention, "date_title_id");
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
        change(&state, "fixture", false).await.unwrap();
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
