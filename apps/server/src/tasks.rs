use crate::{AppState, error::HttpError};
use axum::{
    Json,
    extract::{Path, State},
};
use posterview_runtime::{ScheduledTask, TaskConfig};

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;
    #[tokio::test]
    async fn builtin_tasks_discover_all_tv_libraries_on_every_server() {
        use axum::{Json, Router, extract::Path, routing::get};
        let upstream = Router::new()
            .route("/library/sections", get(|| async { Json(serde_json::json!({"MediaContainer": {"Directory": [
                {"key": "a", "title": "TV", "type": "show"},
                {"key": "b", "title": "Anime", "type": "show"},
                {"key": "c", "title": "Movies", "type": "movie"}
            ]}})) }))
            .route("/library/sections/{id}/all", get(|Path(id): Path<String>| async move {
                Json(serde_json::json!({"MediaContainer": {"totalSize": 1, "Metadata": [{"ratingKey": id, "title": "Title", "type": if id=="c" {"movie"} else {"show"}}]}}))
            }))
            .route("/library/metadata/{id}", get(|Path(id):Path<String>| async move {Json(serde_json::json!({"MediaContainer":{"Metadata":[{"ratingKey":id,"title":"Title","type":if id=="c" {"movie"} else {"show"}}]}}))}))
            .route("/library/metadata/{id}/children", get(||async {Json(serde_json::json!({"MediaContainer":{"Metadata":[]}}))}));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let handle = tokio::spawn(async move {
            axum::serve(listener, upstream).await.unwrap();
        });
        let dir = tempfile::tempdir().unwrap();
        let runtime = posterview_runtime::Runtime::new(dir.path());
        runtime.initialize().unwrap();
        // Read the built-ins before connecting servers: scope must be discovered at run time.
        assert_eq!(runtime.scheduled_tasks().unwrap().len(), 5);
        for name in ["One", "Two"] {
            runtime
                .create_server(&posterview_contracts::ServerCreate {
                    name: name.into(),
                    server_type: posterview_contracts::ServerType::Plex,
                    base_url: url.clone(),
                    token: "test".into(),
                    is_default: false,
                    nfo_metadata_enabled: false,
                })
                .unwrap();
        }
        runtime.task_action("missing_credits", "run").unwrap();
        runtime.scheduled_task_tick().await.unwrap();
        let task = &runtime.scheduled_tasks().unwrap()[0];
        assert_eq!(task.status, "running", "{}", task.message);
        assert_eq!(
            task.total, 6,
            "IDs shared by different servers must remain distinct"
        );
        runtime.task_action("missing_credits", "cancel").unwrap();
        runtime.task_action("missing_metadata", "run").unwrap();
        runtime.scheduled_task_tick().await.unwrap();
        assert_eq!(runtime.scheduled_tasks().unwrap().iter().find(|t|t.id=="missing_metadata").unwrap().total,6);
        for _ in 0..7 {runtime.scheduled_task_tick().await.unwrap();}
        let tasks=runtime.scheduled_tasks().unwrap();let metadata=tasks.iter().find(|t|t.id=="missing_metadata").unwrap();
        assert_eq!(metadata.status,"completed_with_issues");assert_eq!(metadata.needs_matching,6);assert_eq!(metadata.failed,0);
        handle.abort();
    }
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
