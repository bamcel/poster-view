//! PosterView server composition: public facade, shared state, middleware, and workers.
use axum::{Router, routing::get};
use posterview_runtime::Runtime;
use std::{path::PathBuf, sync::Arc};
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};

mod auth;
mod config;
mod error;
mod google_books;
mod login_backdrop;
mod metadata;
mod native;
mod native_animation;
mod native_artwork;
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
mod playback;
mod plugins;
mod reader;
mod routes;
mod scheduled_tasks;
mod state;
#[cfg(test)]
mod test_support;
mod transcoding;
mod watch;
mod workers;
pub use auth::AuthState;
pub use config::ServerConfig;
use error::HttpError;
use state::{AppState, spawn_backdrop_refresh};

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
    native_monitor::start(state.clone());
    scheduled_tasks::start(state.clone());
    let index = ui_dir.join("index.html");
    let spa = ServeDir::new(ui_dir).fallback(ServeFile::new(index));

    let protected = routes::protected(auth);

    routes::system::public()
        .route(
            "/api/plugins/google-books/test",
            axum::routing::post(google_books::test),
        )
        .route(
            "/api/plugins/google-books",
            get(google_books::get).put(google_books::save),
        )
        .route(
            "/api/plugins/artwork",
            get(plugins::artwork_get).put(plugins::artwork_save),
        )
        .merge(protected)
        .fallback_service(spa)
        .layer(tower_http::compression::CompressionLayer::new())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

#[cfg(test)]
mod tests;
