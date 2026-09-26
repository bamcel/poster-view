use crate::{AppState, error::HttpError};
use axum::{
    Json,
    extract::{Path, State},
};
use posterview_runtime::{ScheduledTask, TaskConfig};

#[cfg(test)]
mod tests {
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;
    #[tokio::test]
    async fn scheduled_task_routes_require_authentication() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = std::sync::Arc::new(posterview_runtime::Runtime::new(dir.path()));
        runtime.initialize().unwrap();
        let app = crate::router(
            runtime,
            std::path::PathBuf::from("missing"),
            crate::AuthState::for_tests("password"),
        );
        for (method, uri) in [
            ("GET", "/api/tasks"),
            ("POST", "/api/tasks"),
            ("PUT", "/api/tasks/id"),
            ("POST", "/api/tasks/id/run"),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(uri)
                        .header("content-type", "application/json")
                        .body(Body::from("{}"))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }
    }
}

pub(crate) async fn list(
    State(state): State<AppState>,
) -> Result<Json<Vec<ScheduledTask>>, HttpError> {
    Ok(Json(state.runtime.scheduled_tasks()?))
}
pub(crate) async fn create(
    State(state): State<AppState>,
    Json(config): Json<TaskConfig>,
) -> Result<Json<ScheduledTask>, HttpError> {
    state
        .runtime
        .save_scheduled_task(None, config)
        .map(Json)
        .map_err(|e| HttpError::bad_request(e.to_string()))
}
pub(crate) async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(config): Json<TaskConfig>,
) -> Result<Json<ScheduledTask>, HttpError> {
    state
        .runtime
        .save_scheduled_task(Some(&id), config)
        .map(Json)
        .map_err(|e| HttpError::bad_request(e.to_string()))
}
pub(crate) async fn action(
    State(state): State<AppState>,
    Path((id, action)): Path<(String, String)>,
) -> Result<Json<Vec<ScheduledTask>>, HttpError> {
    state
        .runtime
        .task_action(&id, &action)
        .map_err(|e| HttpError::bad_request(e.to_string()))?;
    Ok(Json(state.runtime.scheduled_tasks()?))
}
