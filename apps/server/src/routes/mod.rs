//! Central registration for legacy native/reader/provider adapters and feature routers.
//! Authentication is applied once after composing all protected routes.
mod artwork;
mod media_servers;
pub(crate) mod system;
use crate::{
    AppState, AuthState, artwork_preferences, metadata, native, native_identify,
    native_provider_extra, playback, reader, scheduled_tasks, transcoding, watch,
};
use axum::{
    Json, Router,
    http::{StatusCode, Uri},
    middleware,
    response::IntoResponse,
    routing::{any, get},
};
use posterview_contracts::ApiErrorResponse;

pub(crate) fn protected(auth: AuthState) -> Router<AppState> {
    Router::new()
        .merge(crate::users::routes())
        .merge(crate::collections::routes())
        .merge(crate::pairwise::routes())
        .merge(crate::jobs::routes())
        .merge(crate::ytdl::routes())
        .merge(crate::virtual_tv::routes())
        .merge(playback::routes())
        .merge(watch::routes())
        .route(
            "/api/transcoding/settings",
            get(transcoding::get).put(transcoding::save),
        )
        .merge(system::protected())
        .merge(media_servers::routes())
        .merge(artwork::routes())
        .route(
            "/api/artwork/preferences",
            get(artwork_preferences::artwork_get).put(artwork_preferences::artwork_save),
        )
        .route(
            "/api/plugins/artwork",
            get(artwork_preferences::artwork_get).put(artwork_preferences::artwork_save),
        )
        .route(
            "/api/native/libraries/{id}/scan",
            get(native::status).post(native::scan),
        )
        .route(
            "/api/native/providers/settings",
            get(native_provider_extra::settings).put(native_provider_extra::save_settings),
        )
        .route(
            "/api/native/providers/test/{provider}",
            axum::routing::post(native_provider_extra::test_provider),
        )
        .route(
            "/api/native/libraries",
            get(native::list).post(native::create),
        )
        .route(
            "/api/native/libraries/{id}/refresh",
            axum::routing::post(native::refresh_library),
        )
        .route("/api/native/libraries/{id}/items", get(native::catalog))
        .route(
            "/api/native/libraries/{id}/summaries",
            get(native::summaries),
        )
        .route("/api/native/libraries/{id}/previews", get(native::previews))
        .route(
            "/api/native/libraries/{library}/items/{item}/metadata/preview",
            axum::routing::post(native_identify::metadata_preview),
        )
        .route(
            "/api/native/libraries/{library}/items/{item}/identify/resolve",
            axum::routing::post(native_identify::resolve),
        )
        .route(
            "/api/native/libraries/{library}/items/{item}/identify/search",
            axum::routing::post(native_identify::search),
        )
        .route(
            "/api/native/libraries/{library}/items/{item}/identify",
            axum::routing::post(native_identify::apply),
        )
        .route(
            "/api/native/libraries/{library}/items/{item}/artwork/refresh",
            axum::routing::post(native::refresh_artwork),
        )
        .route(
            "/api/native/libraries/{library}/items/{item}/scan",
            axum::routing::post(native::scan_folder),
        )
        .route(
            "/api/native/libraries/{library}/items/{item}",
            get(native::catalog_item).put(native::edit_item),
        )
        .route(
            "/api/native/libraries/{library}/items/{item}/artwork/{kind}",
            get(native::artwork)
                .post(native::upload_artwork)
                .delete(native::remove_variant),
        )
        .route(
            "/api/native/libraries/{id}",
            axum::routing::put(native::update).delete(native::delete),
        )
        .route("/api/reader/open/{server}/{item}", get(reader::open))
        .route(
            "/api/reader/native/{library}/{item}",
            get(reader::open_native),
        )
        .route("/api/reader/books/{id}", get(reader::manifest))
        .route("/api/reader/info/{server}/{item}", get(reader::info))
        .route(
            "/api/library-display",
            get(reader::load_display_preferences).put(reader::save_display_preferences),
        )
        .route("/api/reader/books/{id}/file", get(reader::file))
        .route("/api/reader/books/{id}/entry", get(reader::entry))
        .route(
            "/api/reader/books/{id}/state",
            get(reader::load_state).put(reader::save_state),
        )
        .route("/api/metadata/folders", get(metadata::folders))
        .route(
            "/api/metadata/document",
            get(metadata::document).put(metadata::save),
        )
        .route(
            "/api/metadata/preview",
            axum::routing::post(metadata::preview),
        )
        .route("/api/metadata/search", get(metadata::search))
        .route(
            "/api/metadata/item",
            get(metadata::item).put(metadata::update_item),
        )
        .route(
            "/api/metadata/edition",
            axum::routing::put(metadata::update_edition),
        )
        .route(
            "/api/metadata/comicvine",
            axum::routing::post(metadata::use_comicvine),
        )
        .route(
            "/api/metadata/comicvine/preview",
            axum::routing::post(metadata::preview_comicvine),
        )
        .route(
            "/api/metadata/anilist-manga",
            axum::routing::post(metadata::use_anilist_manga),
        )
        .route(
            "/api/metadata/anilist-manga/preview",
            axum::routing::post(metadata::preview_anilist_manga),
        )
        .route(
            "/api/native/identify/anidb/{id}/poster",
            get(native_identify::anidb_preview),
        )
        .route("/api/tasks", get(scheduled_tasks::list))
        .route("/api/tasks/cleanup/preview", get(scheduled_tasks::preview))
        .route(
            "/api/tasks/provider-cache",
            axum::routing::delete(scheduled_tasks::clear_provider_cache),
        )
        .route(
            "/api/tasks/{id}",
            axum::routing::put(scheduled_tasks::configure),
        )
        .route(
            "/api/tasks/{id}/run",
            axum::routing::post(scheduled_tasks::run),
        )
        .route("/api", any(api_not_found))
        .route("/api/{*path}", any(api_not_found))
        .route_layer(middleware::from_fn_with_state(auth, system::require_auth))
}

async fn api_not_found(uri: Uri) -> impl IntoResponse {
    (
        StatusCode::NOT_FOUND,
        Json(ApiErrorResponse {
            detail: format!("API route not found: {uri}"),
        }),
    )
}
