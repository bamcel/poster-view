//! Durable background execution. Storage owns claims; workers never retain request lifetimes.
use crate::{AppState, HttpError};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use posterview_contracts::{
    UserRole,
    jobs::{BackgroundJobRecord, BackgroundJobSpec, JobCheckpoint, JobOutcome},
    native::NativeScanProgress,
};
use posterview_infra_sqlite::{ServerStore, StoreError};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[derive(Default)]
pub(crate) struct Manager {
    notify: tokio::sync::Notify,
    started: AtomicBool,
    active: Mutex<HashMap<String, JobContext>>,
}
#[derive(Clone)]
pub(crate) struct JobContext {
    pub(crate) record: BackgroundJobRecord,
    pub(crate) cancelled: Arc<AtomicBool>,
}
impl JobContext {
    pub(crate) fn check(&self) -> Result<(), HttpError> {
        if self.cancelled.load(Ordering::Acquire) {
            Err(cancelled())
        } else {
            Ok(())
        }
    }
    pub(crate) async fn checkpoint(
        &self,
        state: &AppState,
        checkpoint: JobCheckpoint,
    ) -> Result<(), HttpError> {
        self.check()?;
        let store = store(state);
        let id = self.record.id.clone();
        let lease = self.record.lease.clone().ok_or_else(internal)?;
        if db(move || store.save_job_checkpoint(&id, &lease, &checkpoint, now())).await? {
            Ok(())
        } else {
            Err(cancelled())
        }
    }
    pub(crate) async fn checkpoints(
        &self,
        state: &AppState,
    ) -> Result<Vec<JobCheckpoint>, HttpError> {
        self.check()?;
        let store = store(state);
        let id = self.record.id.clone();
        db(move || store.job_checkpoints(&id)).await
    }
}
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
fn store(state: &AppState) -> ServerStore {
    ServerStore::new(state.runtime.data_dir())
}
fn internal() -> HttpError {
    HttpError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        detail: "Background task operation failed.".into(),
    }
}
fn cancelled() -> HttpError {
    HttpError {
        status: StatusCode::CONFLICT,
        detail: "Background task cancelled.".into(),
    }
}
fn storage_error(error: StoreError) -> HttpError {
    HttpError::from(error)
}
async fn db<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, StoreError> + Send + 'static,
) -> Result<T, HttpError> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|_| internal())?
        .map_err(storage_error)
}
pub(crate) async fn enqueue(
    state: &AppState,
    spec: BackgroundJobSpec,
) -> Result<BackgroundJobRecord, HttpError> {
    let store = store(state);
    let record = db(move || store.enqueue_background_job(&spec, now())).await?;
    start(state.clone());
    state.background_jobs.notify.notify_waiters();
    Ok(record)
}
pub(crate) async fn wait(state: &AppState, id: &str) -> Result<Value, HttpError> {
    loop {
        let store = store(state);
        let id = id.to_owned();
        let record = db(move || store.background_job(&id))
            .await?
            .ok_or_else(HttpError::not_found)?;
        match record.status.as_str() {
            "completed" => return Ok(record.result.unwrap_or(Value::Null)),
            "cancelled" => return Err(cancelled()),
            "failed" => {
                return Err(HttpError {
                    status: record
                        .result
                        .as_ref()
                        .and_then(|value| value["http_status"].as_u64())
                        .and_then(|status| u16::try_from(status).ok())
                        .and_then(|status| StatusCode::from_u16(status).ok())
                        .filter(|status| status.is_client_error() || status.is_server_error())
                        .unwrap_or(StatusCode::BAD_GATEWAY),
                    detail: "Background task failed. See Status to retry.".into(),
                });
            }
            _ => tokio::time::sleep(Duration::from_millis(200)).await,
        }
    }
}
pub(crate) fn native_context(state: &AppState, library: &str) -> Option<JobContext> {
    state
        .background_jobs
        .active
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .find(|ctx| {
            ctx.record.kind == "native_scan"
                && payload_id(&ctx.record, "library_id") == Some(library)
        })
        .cloned()
}
fn payload_id<'a>(record: &'a BackgroundJobRecord, key: &str) -> Option<&'a str> {
    record.payload.get(key).and_then(Value::as_str)
}
fn admin(state: &AppState, headers: &HeaderMap) -> Result<(), HttpError> {
    if state.auth.request_user(headers)?.role == UserRole::Admin {
        Ok(())
    } else {
        Err(HttpError {
            status: StatusCode::FORBIDDEN,
            detail: "Administrator access required.".into(),
        })
    }
}
#[derive(Serialize)]
struct Activity {
    id: String,
    kind: String,
    title: String,
    status: String,
    attempt: u32,
    max_attempts: u32,
    available_at: i64,
    created_at: i64,
    updated_at: i64,
    error: Option<String>,
    checkpoint_count: u64,
    href: String,
    library_id: Option<String>,
    task_id: Option<String>,
    progress: Option<NativeScanProgress>,
}
fn activity(state: &AppState, record: BackgroundJobRecord) -> Activity {
    let library_id = (record.kind == "native_scan")
        .then(|| payload_id(&record, "library_id").map(str::to_owned))
        .flatten();
    let task_id = (record.kind == "maintenance")
        .then(|| payload_id(&record, "task_id").map(str::to_owned))
        .flatten();
    let href = match record.kind.as_str() {
        "native_scan" => "/settings/libraries".to_owned(),
        "maintenance" | "artwork_backfill" => "/settings/tasks".to_owned(),
        "collection_metadata" => payload_id(&record, "collection_id")
            .filter(|id| uuid::Uuid::parse_str(id).is_ok())
            .map_or_else(|| "/collections".into(), |id| format!("/collections/{id}")),
        _ => String::new(),
    };
    let progress = library_id
        .as_deref()
        .filter(|_| matches!(record.status.as_str(), "running" | "cancelling"))
        .and_then(|id| crate::native_progress::current(state, id))
        .and_then(|scan| scan.progress);
    Activity {
        id: record.id,
        kind: record.kind,
        title: record.title,
        status: record.status,
        attempt: record.attempt,
        max_attempts: record.max_attempts,
        available_at: record.available_at,
        created_at: record.created_at,
        updated_at: record.updated_at,
        error: record
            .error
            .map(|_| "Task could not complete. Retry or check server logs.".into()),
        checkpoint_count: record.checkpoint_count,
        href,
        library_id,
        task_id,
        progress,
    }
}
pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/jobs", get(list))
        .route("/api/jobs/{id}/cancel", post(cancel))
        .route("/api/jobs/{id}/retry", post(retry))
}
async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<Activity>>, HttpError> {
    admin(&state, &headers)?;
    let store = store(&state);
    Ok(Json(
        db(move || store.background_jobs())
            .await?
            .into_iter()
            .map(|record| activity(&state, record))
            .collect(),
    ))
}
async fn cancel(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Activity>, HttpError> {
    admin(&state, &headers)?;
    let store = store(&state);
    let key = id.clone();
    let record = db(move || store.request_background_job_cancel(&key, now()))
        .await?
        .ok_or_else(HttpError::not_found)?;
    if let Some(ctx) = state
        .background_jobs
        .active
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&id)
    {
        ctx.cancelled.store(true, Ordering::Release);
    }
    state.background_jobs.notify.notify_waiters();
    Ok(Json(activity(&state, record)))
}
async fn retry(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Activity>, HttpError> {
    admin(&state, &headers)?;
    let store = store(&state);
    let record = db(move || store.retry_background_job(&id, now()))
        .await?
        .ok_or_else(HttpError::not_found)?;
    state.background_jobs.notify.notify_waiters();
    Ok(Json(activity(&state, record)))
}
/// Startup recovery happens before either worker may claim new work.
pub(crate) fn start(state: AppState) {
    if state
        .background_jobs
        .started
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    tokio::spawn(async move {
        loop {
            let store = store(&state);
            match db(move || store.recover_background_jobs(now())).await {
                Ok(count) => {
                    if count > 0 {
                        tracing::info!(count, "recovered interrupted background tasks");
                    }
                    break;
                }
                Err(_) => tokio::time::sleep(Duration::from_secs(2)).await,
            }
        }
        for _ in 0..2 {
            let state = state.clone();
            tokio::spawn(worker(state));
        }
    });
}
async fn worker(state: AppState) {
    loop {
        let store = store(&state);
        match db(move || store.claim_background_job(now())).await {
            Ok(Some(record)) => execute(&state, record).await,
            Ok(None) | Err(_) => {
                tokio::select! {_=state.background_jobs.notify.notified()=>{},_=tokio::time::sleep(Duration::from_secs(1))=>{}}
            }
        }
    }
}
fn outcome(
    record: &BackgroundJobRecord,
    cancelled: bool,
    result: Result<Value, HttpError>,
) -> JobOutcome {
    if cancelled {
        return JobOutcome {
            status: "cancelled".into(),
            error: None,
            result: None,
            retry_at: None,
        };
    }
    match result {
        Ok(value) => JobOutcome {
            status: "completed".into(),
            error: None,
            result: Some(value),
            retry_at: None,
        },
        Err(error) => {
            tracing::warn!(job_id=%record.id, kind=%record.kind, status=%error.status, "Background task execution failed");
            let retry = (error.status.is_server_error()
                || error.status == StatusCode::TOO_MANY_REQUESTS)
                && record.attempt < record.max_attempts;
            JobOutcome {
                status: if retry { "queued" } else { "failed" }.into(),
                error: Some("Background task could not complete.".into()),
                result: Some(serde_json::json!({"http_status":error.status.as_u16()})),
                retry_at: retry.then(|| now() + 2_i64.pow(record.attempt.min(4)).min(30)),
            }
        }
    }
}
async fn dispatch(state: AppState, context: JobContext) -> Result<Value, HttpError> {
    context.check()?;
    match context.record.kind.as_str() {
        "native_scan" => crate::native::execute_background_job(state, context).await,
        "maintenance" => crate::scheduled_tasks::execute_background_job(state, context).await,
        "artwork_backfill" => {
            crate::native_artwork_jobs::execute_background_job(state, context).await
        }
        "collection_metadata" => crate::collections::execute_background_job(state, context).await,
        _ => Err(HttpError::bad_request("Unsupported background task type.")),
    }
}
async fn execute(state: &AppState, record: BackgroundJobRecord) {
    let context = JobContext {
        record: record.clone(),
        cancelled: Arc::new(AtomicBool::new(false)),
    };
    state
        .background_jobs
        .active
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(record.id.clone(), context.clone());
    // Recheck persistent cancellation after registration, closing the claim/cancel race.
    let persistent = store(state);
    let id = record.id.clone();
    if let Ok(Some(current)) = db(move || persistent.background_job(&id)).await {
        if current.status == "cancelling" {
            context.cancelled.store(true, Ordering::Release);
        }
    }
    let execution_state = state.clone();
    let execution_context = context.clone();
    let result = tokio::spawn(async move { dispatch(execution_state, execution_context).await })
        .await
        .unwrap_or_else(|_| Err(internal()));
    let result = outcome(&record, context.cancelled.load(Ordering::Acquire), result);
    // Never abandon a running lease merely because SQLite was temporarily busy.
    loop {
        let store = store(state);
        let id = record.id.clone();
        let lease = record.lease.clone().unwrap_or_default();
        let result = result.clone();
        match db(move || store.finish_background_job(&id, &lease, &result, now())).await {
            Ok(_) => break,
            Err(_) => tokio::time::sleep(Duration::from_secs(1)).await,
        }
    }
    state
        .background_jobs
        .active
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&record.id);
    state.background_jobs.notify.notify_waiters();
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn spec() -> BackgroundJobSpec {
        BackgroundJobSpec {
            kind: "unknown_test_job".into(),
            title: "Task".into(),
            resource_key: "test:resource".into(),
            dedupe_key: "test".into(),
            payload: json!({"secret":"credential","path":"private-path"}),
            max_attempts: 3,
        }
    }
    #[test]
    fn projections_exclude_payload_lease_resources_and_internal_errors() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        let store = store(&state);
        let mut record = store.enqueue_background_job(&spec(), now()).unwrap();
        record.error = Some("token=secret-token /private/path".into());
        record.lease = Some("secret-lease".into());
        let value = serde_json::to_value(activity(&state, record)).unwrap();
        for name in ["payload", "lease", "resource_key", "dedupe_key", "result"] {
            assert!(value.get(name).is_none());
        }
        let encoded = value.to_string();
        for secret in ["credential", "private-path", "secret-token", "secret-lease"] {
            assert!(!encoded.contains(secret));
        }
        assert_eq!(value["href"], "");
    }
    #[test]
    fn retry_only_transient_failures_and_respects_attempt_budget() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        let mut record = store(&state)
            .enqueue_background_job(&spec(), now())
            .unwrap();
        record.attempt = 1;
        let failure = |status| {
            Err(HttpError {
                status,
                detail: "sensitive upstream information".into(),
            })
        };
        for status in [
            StatusCode::BAD_REQUEST,
            StatusCode::UNAUTHORIZED,
            StatusCode::FORBIDDEN,
            StatusCode::NOT_FOUND,
            StatusCode::CONFLICT,
        ] {
            assert_eq!(outcome(&record, false, failure(status)).status, "failed");
        }
        for status in [StatusCode::BAD_GATEWAY, StatusCode::TOO_MANY_REQUESTS] {
            let result = outcome(&record, false, failure(status));
            assert_eq!(result.status, "queued");
            assert!(result.retry_at.unwrap() > now());
            assert!(!result.error.unwrap().contains("sensitive"));
        }
        record.attempt = 3;
        assert_eq!(
            outcome(&record, false, failure(StatusCode::BAD_GATEWAY)).status,
            "failed"
        );
        assert_eq!(
            outcome(&record, true, Ok(json!({"done":true}))).status,
            "cancelled"
        );
    }
    #[tokio::test]
    async fn waiting_preserves_safe_failure_status_without_exposing_details() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        let store = store(&state);
        let queued = store.enqueue_background_job(&spec(), now()).unwrap();
        let record = store.claim_background_job(now()).unwrap().unwrap();
        let result = outcome(
            &record,
            false,
            Err(HttpError {
                status: StatusCode::CONFLICT,
                detail: "private provider token and path".into(),
            }),
        );
        store
            .finish_background_job(&record.id, record.lease.as_deref().unwrap(), &result, now())
            .unwrap();
        let error = wait(&state, &queued.id).await.unwrap_err();
        assert_eq!(error.status, StatusCode::CONFLICT);
        assert!(!error.detail.contains("private"));
    }

    #[tokio::test]
    async fn cancellation_updates_persistent_and_live_context_and_stops_checkpoints() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        let store = store(&state);
        let queued = store.enqueue_background_job(&spec(), now()).unwrap();
        let Json(queued) = cancel(State(state.clone()), HeaderMap::new(), Path(queued.id))
            .await
            .unwrap();
        assert_eq!(queued.status, "cancelled");
        store.retry_background_job(&queued.id, now()).unwrap();
        let record = store.claim_background_job(now()).unwrap().unwrap();
        let context = JobContext {
            record: record.clone(),
            cancelled: Arc::new(AtomicBool::new(false)),
        };
        state
            .background_jobs
            .active
            .lock()
            .unwrap()
            .insert(record.id.clone(), context.clone());
        let Json(result) = cancel(
            State(state.clone()),
            HeaderMap::new(),
            Path(record.id.clone()),
        )
        .await
        .unwrap();
        assert_eq!(result.status, "cancelling");
        assert!(context.check().is_err());
        assert!(
            context
                .checkpoint(
                    &state,
                    JobCheckpoint {
                        key: "entry".into(),
                        signature: "v1".into(),
                        value: json!({})
                    }
                )
                .await
                .is_err()
        );
        assert!(store.job_checkpoints(&record.id).unwrap().is_empty());
    }
    #[tokio::test]
    async fn viewer_cannot_list_cancel_or_retry_global_jobs() {
        use axum::http::header;
        use posterview_contracts::UserCreate;
        let temp = tempfile::tempdir().unwrap();
        let mut state = crate::test_support::state(temp.path());
        let store = store(&state);
        store.bootstrap_user("admin", "admin-password").unwrap();
        store
            .create_user(&UserCreate {
                username: "viewer".into(),
                display_name: "Viewer".into(),
                password: "viewer-password".into(),
                role: UserRole::User,
                enabled: true,
                permissions: Default::default(),
            })
            .unwrap();
        state.auth =
            crate::AuthState::load(state.runtime.data_dir(), None, "admin", false).unwrap();
        let (_, cookie) = state.auth.login("viewer", "viewer-password").unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, cookie);
        assert_eq!(
            list(State(state.clone()), headers.clone())
                .await
                .err()
                .unwrap()
                .status,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            cancel(State(state.clone()), headers.clone(), Path("id".into()))
                .await
                .err()
                .unwrap()
                .status,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            retry(State(state), headers, Path("id".into()))
                .await
                .err()
                .unwrap()
                .status,
            StatusCode::FORBIDDEN
        );
    }
    #[tokio::test]
    async fn restart_recovers_interrupted_lease_and_worker_finishes_unsupported_job() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        let store = store(&state);
        let record = store.enqueue_background_job(&spec(), now()).unwrap();
        store.claim_background_job(now()).unwrap().unwrap();
        start(state.clone());
        start(state.clone());
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let current = store.background_job(&record.id).unwrap().unwrap();
                if current.status == "failed"
                    && state.background_jobs.active.lock().unwrap().is_empty()
                {
                    assert_eq!(current.attempt, 2);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        assert!(state.background_jobs.active.lock().unwrap().is_empty());
    }
}
