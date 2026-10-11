//! Authentication, health, status, and application appearance HTTP adapters.
use crate::{AppState, AuthState, HttpError, auth, login_backdrop, spawn_backdrop_refresh};
use axum::{
    Json, Router,
    extract::{ConnectInfo, Path, Request, State},
    http::{StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::get,
};
use posterview_contracts::AppearanceSettings;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Serialize)]
struct AuthStatus {
    username: String,
    authenticated: bool,
    password_required: bool,
    idle_timeout_minutes: Option<u32>,
}

#[derive(Deserialize)]
struct LoginRequest {
    username: String,
    password: String,
}

async fn auth_status(State(state): State<AppState>, request: Request) -> Json<AuthStatus> {
    let bypass = state.auth.local_bypass(peer(&request));
    Json(AuthStatus {
        username: state.auth.username().to_owned(),
        authenticated: bypass || state.auth.authenticated(request.headers()),
        password_required: state.auth.password_required(peer(&request)),
        idle_timeout_minutes: state.auth.security_settings().idle_timeout_minutes,
    })
}

async fn auth_login(
    State(state): State<AppState>,
    Json(input): Json<LoginRequest>,
) -> Result<impl IntoResponse, HttpError> {
    let (_, cookie) = state
        .auth
        .login(&input.username, &input.password)
        .ok_or_else(|| HttpError::unauthorized("Incorrect username or password."))?;
    let cache = state.login_backdrop.clone();
    let runtime = Arc::clone(&state.runtime);
    tokio::spawn(async move {
        cache.refresh(&runtime).await;
    });
    Ok((
        [(header::SET_COOKIE, cookie)],
        Json(AuthStatus {
            username: state.auth.username().to_owned(),
            authenticated: true,
            password_required: true,
            idle_timeout_minutes: state.auth.security_settings().idle_timeout_minutes,
        }),
    ))
}

async fn login_backdrop_manifest(State(state): State<AppState>) -> impl IntoResponse {
    let enabled = state.auth.security_settings().login_backdrop_enabled;
    let manifest = if enabled {
        state.login_backdrop.manifest()
    } else {
        login_backdrop::BackdropManifest::default()
    };
    if enabled && manifest.rows.is_empty() {
        spawn_backdrop_refresh(&state);
    }
    ([(header::CACHE_CONTROL, "no-store")], Json(manifest))
}

async fn login_backdrop_image(State(state): State<AppState>, Path(name): Path<String>) -> Response {
    if !state.auth.security_settings().login_backdrop_enabled {
        return StatusCode::NOT_FOUND.into_response();
    }
    match state.login_backdrop.image(&name) {
        Some(bytes) => (
            [
                (header::CONTENT_TYPE, "image/jpeg"),
                (header::CACHE_CONTROL, "public, max-age=3600"),
            ],
            bytes,
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn auth_logout(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
) -> impl IntoResponse {
    let cookie = state.auth.logout(&headers);
    (
        [(header::SET_COOKIE, cookie)],
        Json(AuthStatus {
            username: state.auth.username().to_owned(),
            authenticated: false,
            password_required: true,
            idle_timeout_minutes: state.auth.security_settings().idle_timeout_minutes,
        }),
    )
}

pub(crate) async fn require_auth(
    State(auth): State<AuthState>,
    request: Request,
    next: Next,
) -> Response {
    if auth.local_bypass(peer(&request)) || auth.authenticated(request.headers()) {
        next.run(request).await
    } else {
        auth::unauthorized()
    }
}

fn peer(request: &Request) -> Option<std::net::SocketAddr> {
    request
        .extensions()
        .get::<ConnectInfo<std::net::SocketAddr>>()
        .map(|info| info.0)
}

async fn security_settings(State(state): State<AppState>) -> Json<auth::SecuritySettings> {
    Json(state.auth.security_settings())
}

async fn update_security_settings(
    State(state): State<AppState>,
    Json(settings): Json<auth::SecuritySettings>,
) -> Result<Json<auth::SecuritySettings>, HttpError> {
    settings.validate().map_err(HttpError::bad_request)?;
    state
        .auth
        .set_security_settings(settings.clone())
        .map_err(|error| {
            tracing::error!(%error, "could not save security settings");
            HttpError {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                detail: "Could not save security settings.".to_owned(),
            }
        })?;
    if settings.login_backdrop_enabled {
        spawn_backdrop_refresh(&state);
    }
    Ok(Json(settings))
}

async fn auth_activity(State(state): State<AppState>, request: Request) -> Response {
    if !state.auth.password_required(peer(&request)) || state.auth.activity(request.headers()) {
        StatusCode::NO_CONTENT.into_response()
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

async fn get_appearance_settings(
    State(state): State<AppState>,
) -> Result<Json<AppearanceSettings>, HttpError> {
    Ok(Json(state.runtime.appearance_settings()?))
}

async fn set_appearance_settings(
    State(state): State<AppState>,
    Json(settings): Json<AppearanceSettings>,
) -> Result<Json<AppearanceSettings>, HttpError> {
    Ok(Json(state.runtime.set_appearance_settings(settings)?))
}

pub(super) fn protected() -> Router<AppState> {
    Router::new()
        .route(
            "/api/security/settings",
            get(security_settings).put(update_security_settings),
        )
        .route("/api/auth/activity", axum::routing::post(auth_activity))
        .route("/api/status", get(status))
        .route(
            "/api/appearance/settings",
            get(get_appearance_settings).put(set_appearance_settings),
        )
}

pub(crate) fn public() -> Router<AppState> {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/auth/status", get(auth_status))
        .route("/api/auth/login", axum::routing::post(auth_login))
        .route("/api/auth/logout", axum::routing::post(auth_logout))
        .route("/api/login-backdrop", get(login_backdrop_manifest))
        .route("/api/login-backdrop/{name}", get(login_backdrop_image))
}
