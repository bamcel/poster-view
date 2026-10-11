//! Connected media-server administration, catalog browsing, and image proxy routes.
use crate::{AppState, HttpError, spawn_backdrop_refresh};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{HeaderValue, StatusCode, header},
    response::IntoResponse,
    routing::get,
};
use posterview_contracts::{LibraryVisibilityUpdate, ServerCreate, ServerUpdate};
use posterview_url_security::media_server_base;
use serde::Deserialize;
use std::sync::Arc;

async fn list_servers(State(state): State<AppState>) -> Result<impl IntoResponse, HttpError> {
    Ok(Json(state.runtime.list_servers()?))
}

async fn create_server(
    State(state): State<AppState>,
    Json(input): Json<ServerCreate>,
) -> Result<impl IntoResponse, HttpError> {
    media_server_base(&input.base_url).map_err(HttpError::bad_request)?;
    let server = state.runtime.create_server(&input)?;
    let cache = state.login_backdrop.clone();
    let runtime = Arc::clone(&state.runtime);
    tokio::spawn(async move {
        cache.refresh(&runtime).await;
    });
    Ok((StatusCode::CREATED, Json(server)))
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
    let server = state
        .runtime
        .update_server(id, &input)?
        .ok_or_else(HttpError::not_found)?;
    spawn_backdrop_refresh(&state);
    Ok(Json(server))
}

async fn delete_server(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<StatusCode, HttpError> {
    if state.runtime.delete_server(id)? {
        spawn_backdrop_refresh(&state);
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
    body: axum::body::Bytes,
) -> Result<impl IntoResponse, HttpError> {
    let input: ServerUpdate = if body.is_empty() {
        ServerUpdate::default()
    } else {
        serde_json::from_slice(&body)
            .map_err(|_| HttpError::bad_request("Invalid connection test settings."))?
    };
    if let Some(url) = &input.base_url {
        media_server_base(url.trim()).map_err(HttpError::bad_request)?;
    }
    state
        .runtime
        .test_server_changes(id, &input)
        .await?
        .map(Json)
        .ok_or_else(HttpError::not_found)
}

async fn get_libraries(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, HttpError> {
    match state.runtime.get_visible_libraries(id).await? {
        None => Err(HttpError::not_found()),
        Some(Ok(libraries)) => Ok(Json(libraries)),
        Some(Err(detail)) => Err(HttpError {
            status: StatusCode::BAD_GATEWAY,
            detail,
        }),
    }
}

async fn get_library_visibility(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, HttpError> {
    match state.runtime.library_visibility(id).await? {
        None => Err(HttpError::not_found()),
        Some(Ok(visibility)) => Ok(Json(visibility)),
        Some(Err(detail)) => Err(HttpError {
            status: StatusCode::BAD_GATEWAY,
            detail,
        }),
    }
}

async fn set_library_visibility(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(input): Json<LibraryVisibilityUpdate>,
) -> Result<StatusCode, HttpError> {
    if state
        .runtime
        .set_hidden_library_ids(id, &input.hidden_library_ids)?
    {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(HttpError::not_found())
    }
}

#[derive(Debug, Deserialize)]
struct ItemsQuery {
    parent_id: Option<String>,
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
    let result = if let Some(parent_id) = query.parent_id.as_deref() {
        state.runtime.get_folder_items(id, parent_id).await?
    } else {
        state
            .runtime
            .get_items(id, &library_id, query.group_collections)
            .await?
    };
    match result {
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

async fn get_season_detail(
    State(state): State<AppState>,
    Path((id, series_id, season_id)): Path<(i64, String, String)>,
) -> Result<impl IntoResponse, HttpError> {
    match state
        .runtime
        .get_season_detail(id, &series_id, &season_id)
        .await?
    {
        None => Err(HttpError::not_found()),
        Some(Ok(season)) => Ok(Json(season)),
        Some(Err(detail)) => Err(HttpError::bad_gateway(detail)),
    }
}

pub(super) fn routes() -> Router<AppState> {
    Router::new()
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
        .route(
            "/api/servers/{id}/library-visibility",
            get(get_library_visibility).put(set_library_visibility),
        )
        .route("/api/servers/{id}/image", get(proxy_image))
        .route(
            "/api/servers/{id}/libraries/{library_id}/items",
            get(get_items),
        )
        .route("/api/servers/{id}/items/{item_id}", get(get_item_detail))
        .route(
            "/api/servers/{id}/shows/{series_id}/seasons/{season_id}",
            get(get_season_detail),
        )
}
