use crate::{AppState, error::HttpError};
use axum::{
    Json,
    extract::{Path, State},
};
use posterview_runtime::{MetadataFetchResult, VideoMetadataDocument};
use std::collections::BTreeMap;
fn check(state: &AppState, server: i64, item: &str) -> Result<(), HttpError> {
    if item.is_empty() || item.len() > 512 || state.runtime.get_server(server)?.is_none() {
        return Err(HttpError::bad_request("Invalid server or item"));
    }
    Ok(())
}
pub(crate) async fn get(
    State(state): State<AppState>,
    Path((server, item)): Path<(i64, String)>,
) -> Result<Json<VideoMetadataDocument>, HttpError> {
    check(&state, server, &item)?;
    Ok(Json(state.runtime.video_metadata_document(server, &item)?))
}
pub(crate) async fn matches(
    State(state): State<AppState>,
    Path((server, item)): Path<(i64, String)>,
    Json(matches): Json<BTreeMap<String, String>>,
) -> Result<Json<VideoMetadataDocument>, HttpError> {
    check(&state, server, &item)?;
    state
        .runtime
        .save_video_matches(server, &item, matches)
        .await
        .map(Json)
        .map_err(|e| HttpError::bad_request(e.to_string()))
}
pub(crate) async fn find(
    State(state): State<AppState>,
    Path((server, item)): Path<(i64, String)>,
) -> Result<Json<MetadataFetchResult>, HttpError> {
    check(&state, server, &item)?;
    state
        .runtime
        .find_missing_metadata(server, &item, None)
        .await
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
    async fn metadata_find_and_matches_require_authentication() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = std::sync::Arc::new(posterview_runtime::Runtime::new(dir.path()));
        runtime.initialize().unwrap();
        let app = crate::router(
            runtime,
            "missing".into(),
            crate::AuthState::for_tests("password"),
        );
        for method in ["GET", "POST", "PUT"] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri("/api/servers/1/items/movie/metadata")
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
