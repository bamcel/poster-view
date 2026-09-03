use std::{path::PathBuf, sync::Arc};

use axum::{
    Json, Router,
    extract::{Multipart, Path, Query, Request, State},
    http::{HeaderValue, StatusCode, Uri, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{any, get},
};
use posterview_contracts::{
    ApiErrorResponse, ApplyRequest, ArtworkCacheSettings, ArtworkProviderTestRequest,
    ArtworkRefreshRequest, ArtworkRefreshResult, ArtworkSettingsUpdate, HistoryPurgeResult,
    HistorySettings, ImageTarget, PosterDbCredentials, ServerCreate, ServerUpdate,
    VerifyTitlesRequest,
};
use posterview_runtime::Runtime;
use posterview_url_security::media_server_base;
use serde::{Deserialize, Serialize};
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};

mod auth;
mod config;
mod error;
pub use auth::AuthState;
pub use config::ServerConfig;
use error::HttpError;

#[derive(Clone)]
struct AppState {
    runtime: Arc<Runtime>,
    auth: AuthState,
}

pub fn router(runtime: Arc<Runtime>, ui_dir: PathBuf, auth: AuthState) -> Router {
    let state = AppState {
        runtime,
        auth: auth.clone(),
    };
    let index = ui_dir.join("index.html");
    let spa = ServeDir::new(ui_dir).fallback(ServeFile::new(index));

    let protected = Router::new()
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
        .route_layer(middleware::from_fn_with_state(auth, require_auth));

    Router::new()
        .route("/api/health", get(health))
        .route("/api/auth/status", get(auth_status))
        .route("/api/auth/login", axum::routing::post(auth_login))
        .route("/api/auth/logout", axum::routing::post(auth_logout))
        .merge(protected)
        .fallback_service(spa)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

#[derive(Serialize)]
struct AuthStatus {
    authenticated: bool,
}

#[derive(Deserialize)]
struct LoginRequest {
    password: String,
}

async fn auth_status(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
) -> Json<AuthStatus> {
    Json(AuthStatus {
        authenticated: state.auth.authenticated(&headers),
    })
}

async fn auth_login(
    State(state): State<AppState>,
    Json(input): Json<LoginRequest>,
) -> Result<impl IntoResponse, HttpError> {
    let (_, cookie) = state
        .auth
        .login(&input.password)
        .ok_or_else(|| HttpError::unauthorized("Incorrect administrator password."))?;
    Ok((
        [(header::SET_COOKIE, cookie)],
        Json(AuthStatus {
            authenticated: true,
        }),
    ))
}

async fn auth_logout(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
) -> impl IntoResponse {
    let cookie = state.auth.logout(&headers);
    (
        [(header::SET_COOKIE, cookie)],
        Json(AuthStatus {
            authenticated: false,
        }),
    )
}

async fn require_auth(State(auth): State<AuthState>, request: Request, next: Next) -> Response {
    if auth.authenticated(request.headers()) {
        next.run(request).await
    } else {
        auth::unauthorized()
    }
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
    media_server_base(&input.base_url).map_err(HttpError::bad_request)?;
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
    if let Some(base_url) = input.base_url.as_deref() {
        media_server_base(base_url).map_err(HttpError::bad_request)?;
    }
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
) -> Result<impl IntoResponse, HttpError> {
    media_server_base(&input.base_url).map_err(HttpError::bad_request)?;
    Ok(Json(state.runtime.test_adhoc_server(&input).await))
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

async fn api_not_found(uri: Uri) -> impl IntoResponse {
    (
        StatusCode::NOT_FOUND,
        Json(ApiErrorResponse {
            detail: format!("API route not found: {uri}"),
        }),
    )
}

#[cfg(test)]
mod tests;
