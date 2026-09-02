use std::{net::SocketAddr, path::PathBuf, sync::Arc};

use axum::{
    Json, Router,
    extract::{Multipart, Path, Query, State},
    http::{HeaderValue, StatusCode, Uri, header},
    response::IntoResponse,
    routing::{any, get},
};
use posterview_contracts::{
    ApiErrorResponse, ApplyRequest, ArtworkCacheSettings, ArtworkProviderTestRequest,
    ArtworkRefreshRequest, ArtworkRefreshResult, ArtworkSettingsUpdate, HistoryPurgeResult,
    HistorySettings, ImageTarget, PosterDbCredentials, ServerCreate, ServerUpdate,
    VerifyTitlesRequest,
};
use posterview_runtime::{Runtime, RuntimeError};
use serde::Deserialize;
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};

#[derive(Debug, Clone)]
pub struct ServerConfig {
    pub bind: SocketAddr,
    pub data_dir: PathBuf,
    pub ui_dir: PathBuf,
}

impl ServerConfig {
    pub fn from_env() -> anyhow::Result<Self> {
        let bind = std::env::var("POSTERVIEW_BIND")
            .unwrap_or_else(|_| "0.0.0.0:7979".to_owned())
            .parse()?;
        let data_dir = std::env::var_os("POSTERVIEW_DATA_DIR")
            .map_or_else(|| PathBuf::from("data"), PathBuf::from);
        let ui_dir = std::env::var_os("POSTERVIEW_UI_DIR")
            .map_or_else(|| PathBuf::from("frontend/dist"), PathBuf::from);
        Ok(Self {
            bind,
            data_dir,
            ui_dir,
        })
    }
}

#[derive(Clone)]
struct AppState {
    runtime: Arc<Runtime>,
}

pub fn router(runtime: Arc<Runtime>, ui_dir: PathBuf) -> Router {
    let state = AppState { runtime };
    let index = ui_dir.join("index.html");
    let spa = ServeDir::new(ui_dir).fallback(ServeFile::new(index));

    Router::new()
        .route("/api/health", get(health))
        .route("/api/status", get(status))
        .route("/api/servers/test", axum::routing::post(test_adhoc_server))
        .route("/api/servers", get(list_servers).post(create_server))
        .route(
            "/api/servers/{id}",
            get(get_server).patch(update_server).delete(delete_server),
        )
        .route(
            "/api/servers/{id}/test",
            axum::routing::post(test_saved_server),
        )
        .route("/api/servers/{id}/libraries", get(get_libraries))
        .route("/api/servers/{id}/image", get(proxy_image))
        .route(
            "/api/servers/{id}/libraries/{library_id}/items",
            get(get_items),
        )
        .route("/api/servers/{id}/items/{item_id}", get(get_item_detail))
        .route("/api/artwork/upload", axum::routing::post(upload_image))
        .route("/api/artwork/providers", get(artwork_providers))
        .route(
            "/api/artwork/test",
            axum::routing::post(test_artwork_provider),
        )
        .route(
            "/api/artwork/settings",
            get(get_artwork_settings).put(set_artwork_settings),
        )
        .route(
            "/api/artwork/cache",
            get(get_artwork_cache)
                .put(set_artwork_cache)
                .delete(clear_artwork_cache),
        )
        .route(
            "/api/artwork/cache/refresh",
            axum::routing::post(refresh_artwork_item),
        )
        .route(
            "/api/artwork/cache/watchdog/run",
            axum::routing::post(run_artwork_watchdog),
        )
        .route("/api/artwork/search", get(search_artwork))
        .route("/api/artwork/mediux/image", get(mediux_image))
        .route("/api/artwork", get(get_artwork))
        .route("/api/posterdb/status", get(posterdb_status))
        .route(
            "/api/posterdb/credentials",
            axum::routing::put(set_posterdb_credentials),
        )
        .route("/api/posterdb/login", axum::routing::post(posterdb_login))
        .route("/api/posterdb/search/preview", get(posterdb_search_preview))
        .route("/api/posterdb/search", get(posterdb_search))
        .route("/api/posterdb/set", get(posterdb_set))
        .route("/api/posterdb/verify", axum::routing::post(posterdb_verify))
        .route("/api/posterdb/image", get(posterdb_image))
        .route("/api/posterdb/apply", axum::routing::post(apply_download))
        .route("/api/history", get(list_history))
        .route(
            "/api/history/settings",
            get(get_history_settings).put(set_history_settings),
        )
        .route("/api/history/purge", axum::routing::post(purge_history))
        .route("/api/history/{id}/image", get(history_image))
        .route(
            "/api/history/{id}/revert",
            axum::routing::post(revert_history),
        )
        .route("/api", any(api_not_found))
        .route("/api/{*path}", any(api_not_found))
        .fallback_service(spa)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn health(State(state): State<AppState>) -> impl IntoResponse {
    Json(state.runtime.health())
}

async fn status(State(state): State<AppState>) -> impl IntoResponse {
    Json(state.runtime.status())
}

async fn list_servers(State(state): State<AppState>) -> Result<impl IntoResponse, HttpError> {
    Ok(Json(state.runtime.list_servers()?))
}

async fn create_server(
    State(state): State<AppState>,
    Json(input): Json<ServerCreate>,
) -> Result<impl IntoResponse, HttpError> {
    Ok((
        StatusCode::CREATED,
        Json(state.runtime.create_server(&input)?),
    ))
}

async fn get_server(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, HttpError> {
    state
        .runtime
        .get_server(id)?
        .map(Json)
        .ok_or_else(HttpError::not_found)
}

async fn update_server(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(input): Json<ServerUpdate>,
) -> Result<impl IntoResponse, HttpError> {
    state
        .runtime
        .update_server(id, &input)?
        .map(Json)
        .ok_or_else(HttpError::not_found)
}

async fn delete_server(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<StatusCode, HttpError> {
    if state.runtime.delete_server(id)? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(HttpError::not_found())
    }
}

async fn test_adhoc_server(
    State(state): State<AppState>,
    Json(input): Json<ServerCreate>,
) -> impl IntoResponse {
    Json(state.runtime.test_adhoc_server(&input).await)
}

async fn test_saved_server(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, HttpError> {
    state
        .runtime
        .test_saved_server(id)
        .await?
        .map(Json)
        .ok_or_else(HttpError::not_found)
}

async fn get_libraries(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, HttpError> {
    match state.runtime.get_libraries(id).await? {
        None => Err(HttpError::not_found()),
        Some(Ok(libraries)) => Ok(Json(libraries)),
        Some(Err(detail)) => Err(HttpError {
            status: StatusCode::BAD_GATEWAY,
            detail,
        }),
    }
}

#[derive(Debug, Deserialize)]
struct ItemsQuery {
    #[serde(default = "default_true")]
    group_collections: bool,
}

#[derive(Debug, Deserialize)]
struct ImageQuery {
    r#ref: String,
}

async fn proxy_image(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(query): Query<ImageQuery>,
) -> Result<axum::response::Response, HttpError> {
    match state.runtime.fetch_image(id, &query.r#ref).await? {
        None => Err(HttpError::not_found()),
        Some(Err(detail)) => Err(HttpError {
            status: StatusCode::BAD_GATEWAY,
            detail,
        }),
        Some(Ok((bytes, content_type))) => {
            let mut response = bytes.into_response();
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_str(&content_type)
                    .unwrap_or_else(|_| HeaderValue::from_static("image/jpeg")),
            );
            response.headers_mut().insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("public, max-age=3600"),
            );
            Ok(response)
        }
    }
}

const fn default_true() -> bool {
    true
}

async fn get_items(
    State(state): State<AppState>,
    Path((id, library_id)): Path<(i64, String)>,
    Query(query): Query<ItemsQuery>,
) -> Result<impl IntoResponse, HttpError> {
    match state
        .runtime
        .get_items(id, &library_id, query.group_collections)
        .await?
    {
        None => Err(HttpError::not_found()),
        Some(Ok(items)) => Ok(Json(items)),
        Some(Err(detail)) => Err(HttpError {
            status: StatusCode::BAD_GATEWAY,
            detail,
        }),
    }
}

async fn get_item_detail(
    State(state): State<AppState>,
    Path((id, item_id)): Path<(i64, String)>,
) -> Result<impl IntoResponse, HttpError> {
    match state.runtime.get_item_detail(id, &item_id).await? {
        None => Err(HttpError::not_found()),
        Some(Ok(item)) => Ok(Json(item)),
        Some(Err(detail)) => Err(HttpError {
            status: StatusCode::BAD_GATEWAY,
            detail,
        }),
    }
}

async fn upload_image(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<impl IntoResponse, HttpError> {
    let mut server_id = None;
    let mut item_id = None;
    let mut target = ImageTarget::Poster;
    let mut item_title = String::new();
    let mut image = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|error| HttpError::bad_request(error.to_string()))?
    {
        let name = field.name().unwrap_or_default().to_owned();
        if name == "file" {
            let content_type = field.content_type().unwrap_or("image/jpeg").to_owned();
            let bytes = field
                .bytes()
                .await
                .map_err(|error| HttpError::bad_request(error.to_string()))?;
            image = Some((bytes.to_vec(), content_type));
            continue;
        }
        let value = field
            .text()
            .await
            .map_err(|error| HttpError::bad_request(error.to_string()))?;
        match name.as_str() {
            "server_id" => server_id = value.parse().ok(),
            "item_id" => item_id = Some(value),
            "target" => {
                target = match value.as_str() {
                    "background" => ImageTarget::Background,
                    "logo" => ImageTarget::Logo,
                    _ => ImageTarget::Poster,
                };
            }
            "item_title" => item_title = value,
            _ => {}
        }
    }
    let server_id = server_id.ok_or_else(|| HttpError::bad_request("server_id is required"))?;
    let item_id = item_id.ok_or_else(|| HttpError::bad_request("item_id is required"))?;
    let (bytes, content_type) = image.ok_or_else(|| HttpError::bad_request("file is required"))?;
    if bytes.is_empty() {
        return Err(HttpError::bad_request("The uploaded file is empty."));
    }
    if !content_type.starts_with("image/") {
        return Err(HttpError::bad_request("That file isn't an image."));
    }
    state
        .runtime
        .apply_image(
            server_id,
            &item_id,
            &target,
            &bytes,
            &content_type,
            "manual",
            &item_title,
        )
        .await?
        .map(Json)
        .ok_or_else(HttpError::not_found)
}

async fn artwork_providers(State(state): State<AppState>) -> Result<impl IntoResponse, HttpError> {
    Ok(Json(state.runtime.artwork_providers()?))
}

async fn get_artwork_settings(
    State(state): State<AppState>,
) -> Result<impl IntoResponse, HttpError> {
    Ok(Json(state.runtime.artwork_settings()?))
}

async fn set_artwork_settings(
    State(state): State<AppState>,
    Json(input): Json<ArtworkSettingsUpdate>,
) -> Result<impl IntoResponse, HttpError> {
    Ok(Json(state.runtime.set_artwork_settings(&input).await?))
}

async fn get_artwork_cache(State(state): State<AppState>) -> Result<impl IntoResponse, HttpError> {
    Ok(Json(state.runtime.artwork_cache_status()?))
}

async fn set_artwork_cache(
    State(state): State<AppState>,
    Json(input): Json<ArtworkCacheSettings>,
) -> Result<impl IntoResponse, HttpError> {
    Ok(Json(state.runtime.set_artwork_cache_settings(&input)?))
}

async fn clear_artwork_cache(
    State(state): State<AppState>,
) -> Result<impl IntoResponse, HttpError> {
    Ok(Json(state.runtime.clear_artwork_cache()?))
}

async fn refresh_artwork_item(
    State(state): State<AppState>,
    Json(input): Json<ArtworkRefreshRequest>,
) -> Result<impl IntoResponse, HttpError> {
    state
        .runtime
        .refresh_artwork_item(input.server_id, &input.item_id)
        .await?
        .map(Json)
        .ok_or_else(HttpError::not_found)
}

async fn run_artwork_watchdog(
    State(state): State<AppState>,
) -> Result<impl IntoResponse, HttpError> {
    let runtime = Arc::clone(&state.runtime);
    tokio::spawn(async move {
        let _ = runtime.run_watchdog().await;
    });
    Ok(Json(ArtworkRefreshResult {
        ok: true,
        message: "Watchdog started in the background.".to_owned(),
        providers_warmed: 0,
    }))
}

async fn test_artwork_provider(
    State(state): State<AppState>,
    Json(input): Json<ArtworkProviderTestRequest>,
) -> Result<impl IntoResponse, HttpError> {
    Ok(Json(state.runtime.test_artwork_provider(&input).await?))
}

#[derive(Debug, Deserialize)]
struct ArtworkQuery {
    provider: String,
    server_id: i64,
    item_id: String,
    id_override: Option<String>,
}

async fn get_artwork(
    State(state): State<AppState>,
    Query(query): Query<ArtworkQuery>,
) -> Result<impl IntoResponse, HttpError> {
    if !matches!(
        query.provider.as_str(),
        "fanart" | "tvdb" | "anilist" | "mediux"
    ) {
        return Err(HttpError {
            status: StatusCode::NOT_FOUND,
            detail: format!("Unknown provider: {}", query.provider),
        });
    }
    match state
        .runtime
        .get_artwork(
            &query.provider,
            query.server_id,
            &query.item_id,
            query.id_override.as_deref(),
        )
        .await?
    {
        None => Err(HttpError::not_found()),
        Some(Ok(result)) => Ok(Json(result)),
        Some(Err(detail)) => Err(HttpError::bad_gateway(detail)),
    }
}

#[derive(Debug, Deserialize)]
struct ArtworkSearchQuery {
    provider: String,
    server_id: i64,
    item_id: String,
    query: String,
}

async fn search_artwork(
    State(state): State<AppState>,
    Query(query): Query<ArtworkSearchQuery>,
) -> Result<impl IntoResponse, HttpError> {
    if query.query.is_empty() {
        return Err(HttpError::bad_request("query must not be empty"));
    }
    if !matches!(query.provider.as_str(), "tvdb" | "fanart" | "mediux") {
        return Err(HttpError::bad_request(format!(
            "Title search isn't available for {}.",
            query.provider
        )));
    }
    match state
        .runtime
        .search_artwork(
            &query.provider,
            query.server_id,
            &query.item_id,
            &query.query,
        )
        .await?
    {
        None => Err(HttpError::not_found()),
        Some(Ok(result)) => Ok(Json(result)),
        Some(Err(detail)) => Err(HttpError::bad_gateway(detail)),
    }
}

#[derive(Debug, Deserialize)]
struct UrlQuery {
    url: String,
}

async fn mediux_image(
    State(state): State<AppState>,
    Query(query): Query<UrlQuery>,
) -> Result<axum::response::Response, HttpError> {
    let (bytes, content_type) = state
        .runtime
        .mediux_image(&query.url)
        .await
        .map_err(HttpError::bad_gateway)?;
    Ok(cached_image_response(bytes, &content_type))
}

async fn posterdb_status(State(state): State<AppState>) -> Result<impl IntoResponse, HttpError> {
    Ok(Json(state.runtime.posterdb_status("").await?))
}

async fn set_posterdb_credentials(
    State(state): State<AppState>,
    Json(input): Json<PosterDbCredentials>,
) -> Result<impl IntoResponse, HttpError> {
    Ok(Json(state.runtime.set_posterdb_credentials(&input).await?))
}

async fn posterdb_login(State(state): State<AppState>) -> Result<impl IntoResponse, HttpError> {
    Ok(Json(state.runtime.posterdb_login().await?))
}

#[derive(Debug, Deserialize)]
struct SearchQuery {
    term: String,
}

async fn posterdb_search(
    State(state): State<AppState>,
    Query(query): Query<SearchQuery>,
) -> Result<impl IntoResponse, HttpError> {
    if query.term.is_empty() {
        return Err(HttpError::bad_request("term must not be empty"));
    }
    Ok(Json(
        state
            .runtime
            .posterdb_search(&query.term)
            .await
            .map_err(HttpError::bad_gateway)?,
    ))
}

async fn posterdb_search_preview(
    State(state): State<AppState>,
    Query(query): Query<SearchQuery>,
) -> Result<impl IntoResponse, HttpError> {
    if query.term.is_empty() {
        return Err(HttpError::bad_request("term must not be empty"));
    }
    Ok(Json(
        state
            .runtime
            .posterdb_search_preview(&query.term)
            .map_err(HttpError::bad_gateway)?,
    ))
}

async fn posterdb_set(
    State(state): State<AppState>,
    Query(query): Query<UrlQuery>,
) -> Result<impl IntoResponse, HttpError> {
    Ok(Json(
        state
            .runtime
            .posterdb_set(&query.url)
            .await
            .map_err(HttpError::bad_gateway)?,
    ))
}

async fn posterdb_verify(
    State(state): State<AppState>,
    Json(input): Json<VerifyTitlesRequest>,
) -> Result<impl IntoResponse, HttpError> {
    Ok(Json(
        state
            .runtime
            .posterdb_verify(&input.ids)
            .await
            .map_err(HttpError::bad_gateway)?,
    ))
}

async fn posterdb_image(
    State(state): State<AppState>,
    Query(query): Query<UrlQuery>,
) -> Result<axum::response::Response, HttpError> {
    let (bytes, content_type) = state
        .runtime
        .posterdb_image(&query.url)
        .await
        .map_err(HttpError::bad_gateway)?;
    Ok(cached_image_response(bytes, &content_type))
}

async fn apply_download(
    State(state): State<AppState>,
    Json(input): Json<ApplyRequest>,
) -> Result<impl IntoResponse, HttpError> {
    state
        .runtime
        .apply_download(&input)
        .await?
        .map(Json)
        .ok_or_else(HttpError::not_found)
}

fn cached_image_response(bytes: Vec<u8>, content_type: &str) -> axum::response::Response {
    let mut response = bytes.into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(content_type)
            .unwrap_or_else(|_| HeaderValue::from_static("image/jpeg")),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=86400"),
    );
    response
}

#[derive(Debug, Deserialize)]
struct HistoryQuery {
    server_id: Option<i64>,
    item_id: Option<String>,
    target: Option<ImageTarget>,
    limit: Option<i64>,
}

async fn list_history(
    State(state): State<AppState>,
    Query(query): Query<HistoryQuery>,
) -> Result<impl IntoResponse, HttpError> {
    Ok(Json(state.runtime.list_history(
        query.server_id,
        query.item_id.as_deref(),
        query.target.as_ref(),
        query.limit,
    )?))
}

async fn get_history_settings(
    State(state): State<AppState>,
) -> Result<impl IntoResponse, HttpError> {
    Ok(Json(state.runtime.history_settings()?))
}

async fn set_history_settings(
    State(state): State<AppState>,
    Json(settings): Json<HistorySettings>,
) -> Result<impl IntoResponse, HttpError> {
    Ok(Json(state.runtime.set_history_settings(&settings)?))
}

#[derive(Debug, Deserialize)]
struct PurgeQuery {
    days: Option<i64>,
}

async fn purge_history(
    State(state): State<AppState>,
    Query(query): Query<PurgeQuery>,
) -> Result<impl IntoResponse, HttpError> {
    Ok(Json(HistoryPurgeResult {
        purged: state.runtime.purge_history(query.days)?,
    }))
}

async fn history_image(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<axum::response::Response, HttpError> {
    let (bytes, content_type) = state
        .runtime
        .history_image(id)?
        .ok_or_else(HttpError::history_not_found)?;
    let mut response = bytes.into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&content_type)
            .unwrap_or_else(|_| HeaderValue::from_static("image/jpeg")),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=86400"),
    );
    Ok(response)
}

async fn revert_history(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, HttpError> {
    state
        .runtime
        .revert_history(id)
        .await?
        .map(Json)
        .ok_or_else(HttpError::history_not_found)
}

struct HttpError {
    status: StatusCode,
    detail: String,
}

impl HttpError {
    fn not_found() -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            detail: "Server not found".to_owned(),
        }
    }

    fn history_not_found() -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            detail: "History entry not found".to_owned(),
        }
    }

    fn bad_request(detail: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            detail: detail.into(),
        }
    }

    fn bad_gateway(detail: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            detail: detail.into(),
        }
    }
}

impl From<RuntimeError> for HttpError {
    fn from(error: RuntimeError) -> Self {
        tracing::error!(%error, "request failed");
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            detail: "Internal server error".to_owned(),
        }
    }
}

impl IntoResponse for HttpError {
    fn into_response(self) -> axum::response::Response {
        (
            self.status,
            Json(ApiErrorResponse {
                detail: self.detail,
            }),
        )
            .into_response()
    }
}

async fn api_not_found(uri: Uri) -> impl IntoResponse {
    (
        StatusCode::NOT_FOUND,
        Json(ApiErrorResponse {
            detail: format!("API route not found: {uri}"),
        }),
    )
}

#[cfg(test)]
mod tests {
    use std::{path::PathBuf, sync::Arc};

    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use http_body_util::BodyExt;
    use posterview_runtime::Runtime;
    use tempfile::tempdir;
    use tower::ServiceExt;

    use super::router;

    #[tokio::test]
    async fn health_contract_matches_fastapi() {
        let app = router(Arc::new(Runtime::new("data")), PathBuf::from("missing-ui"));
        let response = app
            .oneshot(Request::get("/api/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"status": "ok", "version": "0.1.0"})
        );
    }

    #[tokio::test]
    async fn unknown_api_routes_return_json() {
        let app = router(Arc::new(Runtime::new("data")), PathBuf::from("missing-ui"));
        let response = app
            .oneshot(
                Request::get("/api/not-migrated")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let content_type = response
            .headers()
            .get("content-type")
            .unwrap()
            .to_str()
            .unwrap();
        assert!(content_type.starts_with("application/json"));
    }

    #[tokio::test]
    async fn media_server_crud_matches_the_frontend_contract() {
        let directory = tempdir().unwrap();
        let runtime = Arc::new(Runtime::new(directory.path()));
        runtime.initialize().unwrap();
        let app = router(runtime, PathBuf::from("missing-ui"));

        let create = app
            .clone()
            .oneshot(
                Request::post("/api/servers")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"name":"Living Room","type":"jellyfin","base_url":"http://media:8096/","token":"secret","is_default":false}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(create.status(), StatusCode::CREATED);
        let created: serde_json::Value =
            serde_json::from_slice(&create.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(created["name"], "Living Room");
        assert_eq!(created["type"], "jellyfin");
        assert_eq!(created["base_url"], "http://media:8096");
        assert_eq!(created["is_default"], true);
        assert_eq!(created["has_token"], true);
        assert!(created.get("token").is_none());
        let id = created["id"].as_i64().unwrap();

        let list = app
            .clone()
            .oneshot(Request::get("/api/servers").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(list.status(), StatusCode::OK);
        let listed: serde_json::Value =
            serde_json::from_slice(&list.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(listed.as_array().unwrap().len(), 1);

        let patch = app
            .clone()
            .oneshot(
                Request::patch(format!("/api/servers/{id}"))
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"name":"Updated","token":""}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(patch.status(), StatusCode::OK);
        let updated: serde_json::Value =
            serde_json::from_slice(&patch.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(updated["name"], "Updated");
        assert_eq!(updated["has_token"], true);

        let delete = app
            .clone()
            .oneshot(
                Request::delete(format!("/api/servers/{id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(delete.status(), StatusCode::NO_CONTENT);

        let missing = app
            .oneshot(
                Request::get(format!("/api/servers/{id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
        let body: serde_json::Value =
            serde_json::from_slice(&missing.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(body, serde_json::json!({"detail": "Server not found"}));
    }

    #[tokio::test]
    async fn adhoc_jellyfin_connection_test_matches_fastapi_shape() {
        let media_app = axum::Router::new().route(
            "/System/Info",
            axum::routing::get(|| async {
                axum::Json(serde_json::json!({
                    "ServerName": "Fixture Jellyfin",
                    "Version": "10.10.7"
                }))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let media_server = tokio::spawn(async move {
            axum::serve(listener, media_app).await.unwrap();
        });

        let directory = tempdir().unwrap();
        let runtime = Arc::new(Runtime::new(directory.path()));
        runtime.initialize().unwrap();
        let app = router(runtime, PathBuf::from("missing-ui"));
        let response = app
            .oneshot(
                Request::post("/api/servers/test")
                    .header("content-type", "application/json")
                    .body(Body::from(format!(
                        r#"{{"name":"Fixture","type":"jellyfin","base_url":"http://{address}","token":"api-key","is_default":false}}"#
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: serde_json::Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(
            body,
            serde_json::json!({
                "ok": true,
                "message": "Connected successfully.",
                "server_name": "Fixture Jellyfin",
                "version": "10.10.7"
            })
        );
        media_server.abort();
    }

    #[tokio::test]
    async fn jellyfin_library_discovery_is_normalized() {
        let media_app = axum::Router::new()
            .route(
                "/Library/MediaFolders",
                axum::routing::get(|| async {
                    axum::Json(serde_json::json!({"Items": [
                        {"Id": "movies", "Name": "Movies", "CollectionType": "movies"},
                        {"Id": "shows", "Name": "TV Shows", "CollectionType": "tvshows"}
                    ]}))
                }),
            )
            .route(
                "/Users",
                axum::routing::get(|| async { axum::Json(serde_json::json!([{"Id": "user-1"}])) }),
            )
            .route(
                "/Items",
                axum::routing::get(|| async {
                    axum::Json(serde_json::json!({"Items": [], "TotalRecordCount": 1}))
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let media_server = tokio::spawn(async move {
            axum::serve(listener, media_app).await.unwrap();
        });

        let directory = tempdir().unwrap();
        let runtime = Arc::new(Runtime::new(directory.path()));
        runtime.initialize().unwrap();
        let app = router(runtime, PathBuf::from("missing-ui"));
        let create = app.clone().oneshot(
            Request::post("/api/servers")
                .header("content-type", "application/json")
                .body(Body::from(format!(r#"{{"name":"Fixture","type":"jellyfin","base_url":"http://{address}","token":"key","is_default":true}}"#)))
                .unwrap(),
        ).await.unwrap();
        let created: serde_json::Value =
            serde_json::from_slice(&create.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        let id = created["id"].as_i64().unwrap();
        let response = app
            .oneshot(
                Request::get(format!("/api/servers/{id}/libraries"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: serde_json::Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(
            body,
            serde_json::json!([
                {"id":"movies","title":"Movies","type":"movie"},
                {"id":"shows","title":"TV Shows","type":"show"},
                {"id":"collections","title":"Collections","type":"collection"}
            ])
        );
        media_server.abort();
    }

    #[tokio::test]
    async fn jellyfin_item_detail_is_normalized() {
        let media_app = axum::Router::new()
            .route(
                "/Users",
                axum::routing::get(|| async { axum::Json(serde_json::json!([{"Id": "u1"}])) }),
            )
            .route(
                "/Items",
                axum::routing::get(|| async {
                    axum::Json(serde_json::json!({"Items": [{
                        "Id":"show-1","Name":"Example Show","Type":"Series",
                        "ProductionYear":2024,"Overview":"Summary","ChildCount":2,
                        "ProviderIds":{"Tmdb":"123","Tvdb":"456"},
                        "ImageTags":{"Primary":"p","Logo":"l"},
                        "BackdropImageTags":["b"]
                    }]}))
                }),
            )
            .route(
                "/Shows/show-1/Seasons",
                axum::routing::get(|| async {
                    axum::Json(serde_json::json!({"Items":[{
                        "Id":"season-1","Name":"Season 1","IndexNumber":1,
                        "ChildCount":10,"ImageTags":{"Primary":"sp"}
                    }]}))
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let media_server = tokio::spawn(async move {
            axum::serve(listener, media_app).await.unwrap();
        });
        let directory = tempdir().unwrap();
        let runtime = Arc::new(Runtime::new(directory.path()));
        runtime.initialize().unwrap();
        let app = router(runtime, PathBuf::from("missing-ui"));
        let created = app.clone().oneshot(
            Request::post("/api/servers").header("content-type", "application/json")
                .body(Body::from(format!(r#"{{"name":"Fixture","type":"jellyfin","base_url":"http://{address}","token":"key","is_default":true}}"#))).unwrap(),
        ).await.unwrap();
        let server: serde_json::Value =
            serde_json::from_slice(&created.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        let response = app
            .oneshot(
                Request::get(format!("/api/servers/{}/items/show-1", server["id"]))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let detail: serde_json::Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(detail["type"], "show");
        assert_eq!(
            detail["external_ids"],
            serde_json::json!({"tmdb":"123","tvdb":"456"})
        );
        assert_eq!(detail["seasons"][0]["episode_count"], 10);
        assert_eq!(detail["background"], "Items/show-1/Images/Backdrop?tag=b");
        media_server.abort();
    }

    #[tokio::test]
    async fn manual_upload_is_applied_and_recorded_in_history() {
        let media_app = axum::Router::new().route(
            "/Items/movie-1/Images/Primary",
            axum::routing::post(|| async { StatusCode::NO_CONTENT }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let media_server = tokio::spawn(async move {
            axum::serve(listener, media_app).await.unwrap();
        });
        let directory = tempdir().unwrap();
        let runtime = Arc::new(Runtime::new(directory.path()));
        runtime.initialize().unwrap();
        let app = router(runtime, PathBuf::from("missing-ui"));
        let created = app.clone().oneshot(
            Request::post("/api/servers").header("content-type", "application/json")
                .body(Body::from(format!(r#"{{"name":"Fixture","type":"jellyfin","base_url":"http://{address}","token":"key","is_default":true}}"#))).unwrap(),
        ).await.unwrap();
        let server: serde_json::Value =
            serde_json::from_slice(&created.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        let boundary = "posterview-test";
        let body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"server_id\"\r\n\r\n{}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"item_id\"\r\n\r\nmovie-1\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"target\"\r\n\r\nposter\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"item_title\"\r\n\r\nExample Movie\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"poster.jpg\"\r\nContent-Type: image/jpeg\r\n\r\nimage-bytes\r\n--{boundary}--\r\n",
            server["id"]
        );
        let applied = app
            .clone()
            .oneshot(
                Request::post("/api/artwork/upload")
                    .header(
                        "content-type",
                        format!("multipart/form-data; boundary={boundary}"),
                    )
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(applied.status(), StatusCode::OK);
        let history = app
            .oneshot(Request::get("/api/history").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let entries: serde_json::Value =
            serde_json::from_slice(&history.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(entries[0]["item_title"], "Example Movie");
        assert_eq!(entries[0]["provider"], "manual");
        assert!(
            directory
                .path()
                .join("history")
                .read_dir()
                .unwrap()
                .next()
                .is_some()
        );
        media_server.abort();
    }

    #[tokio::test]
    async fn provider_settings_and_posterdb_credentials_match_frontend_contracts() {
        let directory = tempdir().unwrap();
        let runtime = Arc::new(Runtime::new(directory.path()));
        runtime.initialize().unwrap();
        let app = router(runtime, PathBuf::from("missing-ui"));

        let providers = app
            .clone()
            .oneshot(
                Request::get("/api/artwork/providers")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let providers: serde_json::Value =
            serde_json::from_slice(&providers.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(providers.as_array().unwrap().len(), 4);

        for provider in ["fanart", "tvdb"] {
            let tested = app
                .clone()
                .oneshot(
                    Request::post("/api/artwork/test")
                        .header("content-type", "application/json")
                        .body(Body::from(format!(r#"{{"provider":"{provider}"}}"#)))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(tested.status(), StatusCode::OK);
            let tested: serde_json::Value =
                serde_json::from_slice(&tested.into_body().collect().await.unwrap().to_bytes())
                    .unwrap();
            assert_eq!(tested["ok"], false);
            assert!(
                tested["message"]
                    .as_str()
                    .unwrap()
                    .contains("not configured")
            );
        }

        let settings = app
            .clone()
            .oneshot(
                Request::put("/api/artwork/settings")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"fanart_api_key":"fanart-secret","tvdb_api_key":"tvdb-secret","tvdb_pin":"1234"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let settings: serde_json::Value =
            serde_json::from_slice(&settings.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(
            settings,
            serde_json::json!({
                "fanart_configured": true,
                "tvdb_configured": true,
                "default_provider": "posterdb",
                "enabled_providers": ["posterdb", "fanart", "tvdb", "anilist", "mediux"]
            })
        );

        let preferences = app
            .clone()
            .oneshot(
                Request::put("/api/artwork/settings")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"default_provider":"tvdb","enabled_providers":["tvdb","mediux"]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let preferences: serde_json::Value =
            serde_json::from_slice(&preferences.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(preferences["default_provider"], "tvdb");
        assert_eq!(
            preferences["enabled_providers"],
            serde_json::json!(["tvdb", "mediux"])
        );

        let credentials = app
            .oneshot(
                Request::put("/api/posterdb/credentials")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"email":"viewer@example.com","password":"private"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let credentials: serde_json::Value =
            serde_json::from_slice(&credentials.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(credentials["configured"], true);
        assert_eq!(credentials["email"], "viewer@example.com");
        assert!(credentials.get("password").is_none());
    }

    #[tokio::test]
    async fn artwork_cache_defaults_to_250_mb_and_can_be_configured_and_cleared() {
        let directory = tempdir().unwrap();
        let runtime = Arc::new(Runtime::new(directory.path()));
        runtime.initialize().unwrap();
        let app = router(runtime, PathBuf::from("missing-ui"));

        let status = app
            .clone()
            .oneshot(
                Request::get("/api/artwork/cache")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status: serde_json::Value =
            serde_json::from_slice(&status.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(status["max_mb"], 250);
        assert_eq!(status["ttl_days"], 30);

        let updated = app
            .clone()
            .oneshot(
                Request::put("/api/artwork/cache")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"max_mb":500,"ttl_days":60}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        let updated: serde_json::Value =
            serde_json::from_slice(&updated.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(updated["max_mb"], 500);
        assert_eq!(updated["ttl_days"], 60);

        let cleared = app
            .oneshot(
                Request::delete("/api/artwork/cache")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(cleared.status(), StatusCode::OK);
    }
}
