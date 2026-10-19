//! Artwork browsing, provider configuration, and application HTTP adapters.
use crate::{AppState, HttpError, native, native_animation};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Multipart, Query, State},
    http::{HeaderValue, StatusCode, header},
    response::IntoResponse,
    routing::get,
};
use posterview_contracts::{
    ApplyRequest, ArtworkProviderTestRequest, ArtworkRefreshRequest, ArtworkSettingsUpdate,
    ImageTarget, PosterDbCredentials, RemoveImageRequest, VerifyTitlesRequest,
};
use serde::Deserialize;
const MAX_MANUAL_IMAGE_BYTES: usize = 50 * 1024 * 1024;

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
                    "landscape" => ImageTarget::Landscape,
                    "banner" => ImageTarget::Banner,
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
    if !(content_type.starts_with("image/") || server_id == 0 && content_type == "video/webm") {
        return Err(HttpError::bad_request("That file isn't an image."));
    }
    if server_id != 0 && native_animation::is_animated(&bytes) {
        return Err(HttpError::bad_request(
            "Animated artwork belongs to manual libraries. Select static artwork for the connected server.",
        ));
    }
    if server_id == 0 && item_id.starts_with("collection:") {
        return crate::collections::apply_panel_artwork(state, item_id, target, Some(bytes))
            .await
            .map(Json);
    }
    if server_id == 0 {
        return native::apply_panel_artwork(state, item_id, target, Some(bytes.to_vec()))
            .await
            .map(Json);
    }
    let history = crate::artwork_history::capture_connected(
        &state,
        server_id,
        &item_id,
        history_kind(&target),
    )
    .await?;
    let result = state
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
        .ok_or_else(HttpError::not_found)?;
    if result.ok {
        history.commit(&state).await?;
    }
    Ok(Json(result))
}

async fn remove_artwork(
    State(state): State<AppState>,
    Json(input): Json<RemoveImageRequest>,
) -> Result<impl IntoResponse, HttpError> {
    if input.server_id == 0 && input.item_id.starts_with("collection:") {
        return crate::collections::apply_panel_artwork(state, input.item_id, input.target, None)
            .await
            .map(Json);
    }
    if input.server_id == 0 {
        return native::apply_panel_artwork(state, input.item_id, input.target, None)
            .await
            .map(Json);
    }
    let history = crate::artwork_history::capture_connected(
        &state,
        input.server_id,
        &input.item_id,
        history_kind(&input.target),
    )
    .await?;
    let result = state
        .runtime
        .remove_image(input.server_id, &input.item_id, &input.target)
        .await?
        .ok_or_else(HttpError::not_found)?;
    if result.ok {
        history.commit(&state).await?;
    }
    Ok(Json(result))
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
    #[serde(default)]
    refresh: bool,
}

async fn get_artwork(
    State(state): State<AppState>,
    Query(query): Query<ArtworkQuery>,
) -> Result<impl IntoResponse, HttpError> {
    if query.refresh && query.provider == "mangadex" {
        state
            .runtime
            .refresh_mangadex_cache(query.server_id, &query.item_id);
    } else if query.refresh && query.provider == "viz" {
        state.runtime.refresh_artwork_provider_cache(
            &query.provider,
            query.server_id,
            &query.item_id,
        );
    }
    if !matches!(
        query.provider.as_str(),
        "fanart"
            | "tvdb"
            | "anilist"
            | "anilist-manga"
            | "myanimelist"
            | "myanimelist-manga"
            | "mediux"
            | "mangadex"
            | "viz"
            | "comicvine"
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
    #[serde(default)]
    refresh: bool,
}

async fn search_artwork(
    State(state): State<AppState>,
    Query(query): Query<ArtworkSearchQuery>,
) -> Result<impl IntoResponse, HttpError> {
    if query.refresh && query.provider == "mangadex" {
        state
            .runtime
            .refresh_mangadex_cache(query.server_id, &query.item_id);
    }
    if query.query.is_empty() {
        return Err(HttpError::bad_request("query must not be empty"));
    }
    if !matches!(
        query.provider.as_str(),
        "tvdb" | "fanart" | "mediux" | "anilist-manga" | "mangadex" | "viz" | "comicvine"
    ) {
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
    server_id: i64,
    url: String,
}

#[derive(Debug, Deserialize)]
struct MangaItemQuery {
    server_id: i64,
    item_id: String,
}

async fn manga_selection(
    State(state): State<AppState>,
    Query(query): Query<MangaItemQuery>,
) -> Result<impl IntoResponse, HttpError> {
    if query.server_id == 0 {
        state
            .runtime
            .get_item_detail(0, &query.item_id)
            .await?
            .ok_or_else(HttpError::not_found)?
            .map_err(HttpError::bad_request)?;
    } else {
        state
            .runtime
            .get_server(query.server_id)?
            .ok_or_else(HttpError::not_found)?;
    }
    Ok(Json(
        state
            .runtime
            .manga_selection(query.server_id, &query.item_id)?,
    ))
}

async fn save_manga_selection(
    State(state): State<AppState>,
    Query(query): Query<MangaItemQuery>,
    Json(selection): Json<posterview_contracts::MangaSelection>,
) -> Result<impl IntoResponse, HttpError> {
    if query.server_id == 0 {
        state
            .runtime
            .get_item_detail(0, &query.item_id)
            .await?
            .ok_or_else(HttpError::not_found)?
            .map_err(HttpError::bad_request)?;
    } else {
        state
            .runtime
            .get_server(query.server_id)?
            .ok_or_else(HttpError::not_found)?;
    }
    if (!selection.mangadex_id.is_empty()
        && !posterview_runtime::valid_manga_id(&selection.mangadex_id))
        || selection.title.len() > 1000
        || selection.volume.as_ref().is_some_and(|v| v.len() > 100)
    {
        return Err(HttpError::bad_request("Invalid MangaDex series or volume."));
    }
    state
        .runtime
        .save_manga_selection(query.server_id, &query.item_id, &selection)?;
    Ok(Json(selection))
}

async fn mangadex_image(
    State(state): State<AppState>,
    Query(query): Query<UrlQuery>,
) -> Result<axum::response::Response, HttpError> {
    let (bytes, content_type) = state
        .runtime
        .mangadex_image(query.server_id, &query.url)
        .await
        .map_err(HttpError::bad_gateway)?;
    Ok(cached_image_response(bytes, &content_type))
}

async fn mediux_image(
    State(state): State<AppState>,
    Query(query): Query<UrlQuery>,
) -> Result<axum::response::Response, HttpError> {
    let (bytes, content_type) = state
        .runtime
        .mediux_image(query.server_id, &query.url)
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
struct ServerQuery {
    server_id: i64,
}

#[derive(Debug, Deserialize)]
struct SearchQuery {
    server_id: i64,
    term: String,
    #[serde(default)]
    refresh: bool,
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
            .posterdb_search_with_refresh(query.server_id, &query.term, query.refresh)
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
            .posterdb_search_preview(query.server_id, &query.term)
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
            .posterdb_set(query.server_id, &query.url)
            .await
            .map_err(HttpError::bad_gateway)?,
    ))
}

async fn posterdb_verify(
    State(state): State<AppState>,
    Query(query): Query<ServerQuery>,
    Json(input): Json<VerifyTitlesRequest>,
) -> Result<impl IntoResponse, HttpError> {
    Ok(Json(
        state
            .runtime
            .posterdb_verify(query.server_id, &input.ids)
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
        .posterdb_image(query.server_id, &query.url)
        .await
        .map_err(HttpError::bad_gateway)?;
    Ok(cached_image_response(bytes, &content_type))
}

async fn apply_download(
    State(state): State<AppState>,
    Json(input): Json<ApplyRequest>,
) -> Result<impl IntoResponse, HttpError> {
    if input.server_id == 0 {
        if state
            .runtime
            .get_item_detail(0, &input.item_id)
            .await?
            .is_none()
        {
            return Err(HttpError::not_found());
        }
        let (bytes, _) = state
            .runtime
            .download_artwork_image(&input)
            .await
            .map_err(|e| HttpError::bad_gateway(e.to_string()))?;
        if input.item_id.starts_with("collection:") {
            return crate::collections::apply_panel_artwork(
                state,
                input.item_id,
                input.target,
                Some(bytes),
            )
            .await
            .map(Json);
        }
        return native::apply_panel_artwork(state, input.item_id, input.target, Some(bytes))
            .await
            .map(Json);
    }
    let history = crate::artwork_history::capture_connected(
        &state,
        input.server_id,
        &input.item_id,
        history_kind(&input.target),
    )
    .await?;
    let result = state
        .runtime
        .apply_download(&input)
        .await?
        .ok_or_else(HttpError::not_found)?;
    if result.ok {
        history.commit(&state).await?;
    }
    Ok(Json(result))
}

fn history_kind(target: &ImageTarget) -> &'static str {
    match target {
        ImageTarget::Poster => "poster",
        ImageTarget::Background => "backdrop",
        ImageTarget::Logo => "logo",
        ImageTarget::Landscape => "landscape",
        ImageTarget::Banner => "banner",
    }
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

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/posterdb/status", get(posterdb_status))
        .route(
            "/api/artwork/upload",
            axum::routing::post(upload_image).layer(DefaultBodyLimit::max(MAX_MANUAL_IMAGE_BYTES)),
        )
        .route("/api/artwork/remove", axum::routing::post(remove_artwork))
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
            "/api/artwork/cache/refresh",
            axum::routing::post(refresh_artwork_item),
        )
        .route("/api/artwork/search", get(search_artwork))
        .route("/api/artwork/mediux/image", get(mediux_image))
        .route("/api/artwork", get(get_artwork))
        .route("/api/artwork/mangadex/image", get(mangadex_image))
        .route(
            "/api/artwork/mangadex/selection",
            get(manga_selection).put(save_manga_selection),
        )
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
}
