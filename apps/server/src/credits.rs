use crate::{AppState, error::HttpError};
use axum::{
    Json,
    extract::{Path, Query, State},
};
use posterview_contracts::{CreditProviderSettings, CreditSearchResult, SeriesCredits};
use serde::Deserialize;

fn error(error: posterview_runtime::RuntimeError) -> HttpError {
    match error {
        posterview_runtime::RuntimeError::Watchdog(message) => HttpError::bad_gateway(message),
        other => other.into(),
    }
}
fn check(state: &AppState, server: i64, item: &str) -> Result<(), HttpError> {
    if state.runtime.get_server(server)?.is_none() {
        return Err(HttpError::not_found());
    }
    if item.is_empty() || item.len() > 512 {
        return Err(HttpError::bad_request("Invalid series ID."));
    }
    Ok(())
}
#[derive(Deserialize)]
pub(crate) struct Search {
    provider: String,
    query: String,
}
#[derive(Deserialize)]
pub(crate) struct Import {
    provider: String,
    external_id: String,
}
#[derive(Deserialize)]
pub(crate) struct Language {
    original_language: Option<String>,
}
#[derive(Deserialize)]
pub(crate) struct Source {
    provider: String,
    external_id: String,
}
#[derive(Deserialize)]
pub(crate) struct Settings {
    tmdb_access_token: String,
}

pub(crate) async fn get(
    State(state): State<AppState>,
    Path((server, item)): Path<(i64, String)>,
) -> Result<Json<SeriesCredits>, HttpError> {
    check(&state, server, &item)?;
    state
        .runtime
        .series_credits(server, &item)
        .map(Json)
        .map_err(error)
}
pub(crate) async fn import(
    State(state): State<AppState>,
    Path((server, item)): Path<(i64, String)>,
    Json(input): Json<Import>,
) -> Result<Json<SeriesCredits>, HttpError> {
    check(&state, server, &item)?;
    state
        .runtime
        .import_credits(server, &item, &input.provider, &input.external_id)
        .await
        .map(Json)
        .map_err(error)
}
pub(crate) async fn language(
    State(state): State<AppState>,
    Path((server, item)): Path<(i64, String)>,
    Json(input): Json<Language>,
) -> Result<Json<SeriesCredits>, HttpError> {
    check(&state, server, &item)?;
    if input.original_language.as_ref().is_some_and(|v| {
        v.is_empty()
            || v.len() > 64
            || !v
                .chars()
                .all(|c| c.is_alphabetic() || matches!(c, '-' | ' ' | '(' | ')'))
    }) {
        return Err(HttpError::bad_request("Invalid cast language."));
    }
    state
        .runtime
        .set_credit_language(server, &item, input.original_language.as_deref())
        .map(Json)
        .map_err(error)
}
pub(crate) async fn remove(
    State(state): State<AppState>,
    Path((server, item)): Path<(i64, String)>,
    Query(input): Query<Source>,
) -> Result<Json<SeriesCredits>, HttpError> {
    check(&state, server, &item)?;
    state
        .runtime
        .remove_credit_source(server, &item, &input.provider, &input.external_id)
        .await
        .map(Json)
        .map_err(error)
}
pub(crate) async fn search(
    State(state): State<AppState>,
    Query(input): Query<Search>,
) -> Result<Json<Vec<CreditSearchResult>>, HttpError> {
    state
        .runtime
        .search_credits(&input.provider, &input.query)
        .await
        .map(Json)
        .map_err(error)
}
pub(crate) async fn settings(
    State(state): State<AppState>,
) -> Result<Json<CreditProviderSettings>, HttpError> {
    state
        .runtime
        .credit_provider_settings()
        .map(Json)
        .map_err(error)
}
pub(crate) async fn save_settings(
    State(state): State<AppState>,
    Json(input): Json<Settings>,
) -> Result<Json<CreditProviderSettings>, HttpError> {
    state
        .runtime
        .set_credit_tmdb_token(&input.tmdb_access_token)
        .map(Json)
        .map_err(error)
}

#[cfg(test)]
mod tests {
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use http_body_util::BodyExt;
    use posterview_runtime::Runtime;
    use std::{path::PathBuf, sync::Arc};
    use tower::ServiceExt;

    #[tokio::test]
    async fn credits_routes_require_auth_and_keep_credentials_private() {
        let directory = tempfile::tempdir().unwrap();
        let runtime = Arc::new(Runtime::new(directory.path()));
        runtime.initialize().unwrap();
        let locked = crate::router(
            runtime.clone(),
            PathBuf::from("missing"),
            crate::AuthState::for_tests("password"),
        );
        for (method, path, body) in [
            ("GET", "/api/credits/settings", ""),
            (
                "PUT",
                "/api/credits/settings",
                r#"{"tmdb_access_token":"test-secret"}"#,
            ),
            (
                "GET",
                "/api/credits/search?provider=anilist&query=Series",
                "",
            ),
            ("GET", "/api/servers/1/items/series/credits", ""),
            (
                "POST",
                "/api/servers/1/items/series/credits",
                r#"{"provider":"anilist","external_id":"1"}"#,
            ),
            (
                "PUT",
                "/api/servers/1/items/series/credits",
                r#"{"original_language":"ja"}"#,
            ),
            (
                "DELETE",
                "/api/servers/1/items/series/credits?provider=anilist",
                "",
            ),
        ] {
            let reply = locked
                .clone()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(path)
                        .header("content-type", "application/json")
                        .body(Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(reply.status(), StatusCode::UNAUTHORIZED, "{method} {path}");
        }
        let app = crate::router(
            runtime,
            PathBuf::from("missing"),
            crate::AuthState::for_tests(""),
        );
        let reply = app
            .clone()
            .oneshot(
                Request::put("/api/credits/settings")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"tmdb_access_token":"test-secret"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(reply.status(), StatusCode::OK);
        let body = reply.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["tmdb_configured"], true);
        assert!(!String::from_utf8_lossy(&body).contains("test-secret"));
        let db = rusqlite::Connection::open(directory.path().join("posterview.db")).unwrap();
        let encrypted: String = db
            .query_row(
                "SELECT value_enc FROM settings WHERE key='tmdb_access_token'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!encrypted.contains("test-secret"));
        let reply = app
            .oneshot(
                Request::get("/api/servers/999/items/series/credits")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(reply.status(), StatusCode::NOT_FOUND);
    }
}
