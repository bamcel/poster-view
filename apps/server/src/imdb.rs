use crate::{AppState, error::HttpError};
use axum::{
    Json,
    extract::{Query, State},
};
use posterview_runtime::{ImdbStatus, ImdbTitle};
use serde::Deserialize;

#[derive(Deserialize)]
pub(crate) struct Settings {
    enabled: bool,
}
#[derive(Deserialize)]
pub(crate) struct Search {
    q: String,
}
pub(crate) async fn status(State(state): State<AppState>) -> Result<Json<ImdbStatus>, HttpError> {
    Ok(Json(state.runtime.imdb_status()?))
}
pub(crate) async fn save(
    State(state): State<AppState>,
    Json(input): Json<Settings>,
) -> Result<Json<ImdbStatus>, HttpError> {
    Ok(Json(state.runtime.set_imdb_enabled(input.enabled)?))
}
pub(crate) async fn search(
    State(state): State<AppState>,
    Query(input): Query<Search>,
) -> Result<Json<Vec<ImdbTitle>>, HttpError> {
    tokio::task::spawn_blocking(move || state.runtime.imdb_lookup(&input.q))
        .await
        .map_err(|e| HttpError::bad_request(e.to_string()))?
        .map(Json)
        .map_err(|e| HttpError::bad_request(e.to_string()))
}

#[cfg(test)]
mod tests {
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;
    #[tokio::test]
    async fn imdb_requires_auth_and_enable_does_not_start_download() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = std::sync::Arc::new(posterview_runtime::Runtime::new(dir.path()));
        runtime.initialize().unwrap();
        let locked = crate::router(
            runtime.clone(),
            "missing".into(),
            crate::AuthState::for_tests("password"),
        );
        for (method, path) in [
            ("GET", "/api/imdb/settings"),
            ("PUT", "/api/imdb/settings"),
            ("GET", "/api/imdb/search?q=test"),
        ] {
            let response = locked
                .clone()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(path)
                        .header("content-type", "application/json")
                        .body(Body::from(r#"{"enabled":true}"#))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }
        let open = crate::router(
            runtime.clone(),
            "missing".into(),
            crate::AuthState::for_tests(""),
        );
        let response = open
            .oneshot(
                Request::put("/api/imdb/settings")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"enabled":true}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(runtime.imdb_status().unwrap().enabled);
        assert!(!runtime.imdb_status().unwrap().ready);
        assert_eq!(
            runtime
                .scheduled_tasks()
                .unwrap()
                .iter()
                .find(|t| t.id == "imdb_refresh")
                .unwrap()
                .status,
            "idle"
        );
    }
}
