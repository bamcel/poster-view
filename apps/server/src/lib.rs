//! PosterView server composition: public facade, shared state, middleware, and workers.
use axum::Router;
use posterview_runtime::Runtime;
use std::{path::PathBuf, sync::Arc};
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};

mod access;
mod auth;
mod collections;
mod config;
mod episode_order;
mod error;
mod jobs;
mod login_backdrop;
mod metadata;
mod native;
mod native_animation;
mod native_artwork;
mod native_artwork_jobs;
mod native_artwork_variants;
mod native_capture;
mod native_identify;
mod native_jikan;
mod native_missing;
mod native_monitor;
mod native_operations;
mod native_progress;
mod native_provider;
mod native_provider_extra;
mod native_scan;
mod pairwise;
mod playback;
mod plugins;
mod reader;
mod routes;
mod scheduled_tasks;
mod state;
#[cfg(test)]
mod test_support;
mod transcoding;
mod users;
mod virtual_tv;
mod watch;
mod workers;
mod ytdl;
pub use auth::AuthState;
pub use config::ServerConfig;
use error::HttpError;
use state::{AppState, spawn_backdrop_refresh};

pub(crate) fn media_compression_layer()
-> tower_http::compression::CompressionLayer<impl tower_http::compression::predicate::Predicate> {
    use tower_http::compression::predicate::{DefaultPredicate, NotForContentType, Predicate};
    // Original media keeps its byte offsets, length, and range headers even
    // when a browser requests the entire file and advertises gzip support.
    tower_http::compression::CompressionLayer::new().compress_when(
        DefaultPredicate::new()
            .and(NotForContentType::const_new("video/"))
            .and(NotForContentType::const_new("audio/")),
    )
}

#[cfg(test)]
use routes::system::require_auth;

pub fn router(runtime: Arc<Runtime>, ui_dir: PathBuf, auth: AuthState) -> Router {
    if let Err(e) =
        posterview_infra_sqlite::ServerStore::new(runtime.data_dir()).recover_native_scans()
    {
        tracing::warn!(%e,"Could not recover interrupted native scans");
    }
    let media_dir = std::env::var_os("POSTERVIEW_MEDIA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/media"));
    let state = AppState::new(runtime, auth.clone(), media_dir);
    let refresh_cache = state.login_backdrop.clone();
    let refresh_runtime = Arc::clone(&state.runtime);
    tokio::spawn(async move {
        refresh_cache.refresh(&refresh_runtime).await;
    });
    if let Err(error) = scheduled_tasks::retire_artwork_history(&state) {
        tracing::warn!(error=%error.detail,"Unable to remove legacy artwork history");
    }
    state.playback.start_cleanup();
    jobs::start(state.clone());
    native_monitor::start(state.clone());
    ytdl::start(state.clone());
    scheduled_tasks::start(state.clone());
    native_artwork_jobs::start(state.clone());
    let index = ui_dir.join("index.html");
    let spa = ServeDir::new(ui_dir).fallback(ServeFile::new(index));

    let protected = routes::protected(auth);

    routes::system::public()
        .merge(protected)
        .fallback_service(spa)
        .layer(media_compression_layer())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

#[cfg(test)]
mod tests;
