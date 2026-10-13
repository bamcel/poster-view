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
use posterview_contracts::{
    AppearanceSettings, UserAccount, UserCreate, UserPermissions, UserRole,
};
use posterview_infra_sqlite::{ServerStore, StoreError};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Serialize)]
struct AuthStatus {
    username: String,
    user: Option<UserAccount>,
    accounts_enabled: bool,
    setup_required: bool,
    authenticated: bool,
    password_required: bool,
    idle_timeout_minutes: Option<u32>,
}

#[derive(Deserialize)]
struct LoginRequest {
    username: String,
    password: String,
}

async fn auth_status(State(state): State<AppState>, request: Request) -> impl IntoResponse {
    let user = state.auth.principal(request.headers(), peer(&request));
    (
        [
            (header::CACHE_CONTROL, "private, no-store"),
            (header::VARY, "Cookie"),
        ],
        Json(AuthStatus {
            username: user
                .as_ref()
                .map(|u| u.username.clone())
                .unwrap_or_else(|| state.auth.username().to_owned()),
            authenticated: user.is_some(),
            user,
            accounts_enabled: true,
            setup_required: state.auth.setup_required(),
            password_required: state.auth.password_required(peer(&request)),
            idle_timeout_minutes: state.auth.security_settings().idle_timeout_minutes,
        }),
    )
}

async fn auth_login(
    State(state): State<AppState>,
    Json(input): Json<LoginRequest>,
) -> Result<impl IntoResponse, HttpError> {
    let permit = state.auth.login_permit().ok_or_else(|| HttpError {
        status: StatusCode::TOO_MANY_REQUESTS,
        detail: "Too many sign-in attempts. Try again shortly.".into(),
    })?;
    let auth = state.auth.clone();
    let login = tokio::task::spawn_blocking(move || {
        // Keep the slot until verification finishes, even if the HTTP request is cancelled.
        let _permit = permit;
        auth.login(&input.username, &input.password)
    })
    .await
    .map_err(|_| HttpError::bad_request("Could not sign in."))?;
    let (_, cookie) =
        login.ok_or_else(|| HttpError::unauthorized("Incorrect username or password."))?;
    let mut headers = axum::http::HeaderMap::new();
    headers.insert(header::COOKIE, cookie.clone());
    let user = state.auth.principal(&headers, None);
    if user.is_none() {
        return Err(HttpError::unauthorized("Account changed. Sign in again."));
    }
    let cache = state.login_backdrop.clone();
    let runtime = Arc::clone(&state.runtime);
    tokio::spawn(async move {
        cache.refresh(&runtime).await;
    });
    Ok((
        [(header::SET_COOKIE, cookie)],
        Json(AuthStatus {
            username: user
                .as_ref()
                .map(|u| u.username.clone())
                .unwrap_or_default(),
            user,
            accounts_enabled: true,
            setup_required: state.auth.setup_required(),
            authenticated: true,
            password_required: true,
            idle_timeout_minutes: state.auth.security_settings().idle_timeout_minutes,
        }),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SetupRequest {
    username: String,
    display_name: String,
    password: String,
}

async fn auth_setup(
    State(state): State<AppState>,
    Json(input): Json<SetupRequest>,
) -> Result<impl IntoResponse, HttpError> {
    let permit = state.auth.login_permit().ok_or_else(|| HttpError {
        status: StatusCode::TOO_MANY_REQUESTS,
        detail: "Too many sign-in attempts. Try again shortly.".into(),
    })?;
    let auth = state.auth.clone();
    let dir = auth
        .data_dir()
        .ok_or_else(|| HttpError::bad_request("Account setup is unavailable."))?
        .to_owned();
    let legacy_id = auth.username().to_owned();
    let cookie = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let store = ServerStore::new(dir);
        store
            .create_first_admin(
                &legacy_id,
                &UserCreate {
                    username: input.username.clone(),
                    display_name: input.display_name,
                    password: input.password.clone(),
                    role: UserRole::Admin,
                    enabled: true,
                    permissions: UserPermissions {
                        all_libraries: true,
                        allow_unrated: true,
                        ..Default::default()
                    },
                },
            )
            .map_err(|error| match error {
                StoreError::RevisionConflict => HttpError {
                    status: StatusCode::CONFLICT,
                    detail: "Administrator setup has already been completed. Sign in instead."
                        .into(),
                },
                StoreError::Validation(detail) => HttpError::bad_request(detail),
                error => {
                    tracing::error!(%error,"administrator setup failed");
                    HttpError {
                        status: StatusCode::INTERNAL_SERVER_ERROR,
                        detail: "Could not create administrator.".into(),
                    }
                }
            })?;
        auth.login(&input.username, &input.password)
            .map(|(_, cookie)| cookie)
            .ok_or_else(|| {
                HttpError::unauthorized("Administrator was created. Sign in to continue.")
            })
    })
    .await
    .map_err(|_| HttpError::bad_request("Could not complete administrator setup."))??;
    let mut headers = axum::http::HeaderMap::new();
    headers.insert(header::COOKIE, cookie.clone());
    let user = state
        .auth
        .principal(&headers, None)
        .ok_or_else(|| HttpError::unauthorized("Sign in to continue."))?;
    Ok((
        StatusCode::CREATED,
        [(header::SET_COOKIE, cookie)],
        Json(AuthStatus {
            username: user.username.clone(),
            user: Some(user),
            accounts_enabled: true,
            setup_required: false,
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
            user: None,
            accounts_enabled: true,
            setup_required: state.auth.setup_required(),
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
    let Some(user) = auth.principal(request.headers(), peer(&request)) else {
        return auth::unauthorized();
    };
    if let Err(error) = crate::access::authorize_request(&auth, &user, &request) {
        return error.into_response();
    }
    let uri_path = request.uri().path().to_owned();
    let mut request = request;
    request.extensions_mut().insert(user.clone());
    let response = next.run(request).await;
    crate::access::filter_response(&auth, &user, &uri_path, response).await
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
    if state
        .auth
        .principal(request.headers(), peer(&request))
        .is_some()
        && (!state.auth.password_required(peer(&request)) || state.auth.activity(request.headers()))
    {
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
        .route("/api/auth/setup", axum::routing::post(auth_setup))
        .route("/api/auth/logout", axum::routing::post(auth_logout))
        .route("/api/login-backdrop", get(login_backdrop_manifest))
        .route("/api/login-backdrop/{name}", get(login_backdrop_image))
}

#[cfg(test)]
mod account_setup_tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use tower::ServiceExt;

    #[tokio::test]
    async fn first_visitor_creates_the_only_initial_admin_and_receives_a_session() {
        let dir = tempfile::tempdir().unwrap();
        let mut state = crate::test_support::state(dir.path());
        state.auth = AuthState::load(
            state.runtime.data_dir(),
            Some("old-env-password"),
            "legacy-admin",
            false,
        )
        .unwrap();
        let router = public().with_state(state.clone());
        let status = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/auth/status")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status: serde_json::Value =
            serde_json::from_slice(&to_bytes(status.into_body(), 1024 * 1024).await.unwrap())
                .unwrap();
        assert_eq!(status["setup_required"], true);
        assert_eq!(status["authenticated"], false);
        let payload = r#"{"username":"owner","display_name":"Owner","password":"new-password"}"#;
        let setup = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/setup")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(payload))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(setup.status(), StatusCode::CREATED);
        let cookie = setup.headers()[header::SET_COOKIE].clone();
        let result: serde_json::Value =
            serde_json::from_slice(&to_bytes(setup.into_body(), 1024 * 1024).await.unwrap())
                .unwrap();
        assert_eq!(result["setup_required"], false);
        assert_eq!(result["user"]["username"], "owner");
        assert_eq!(result["user"]["id"], "legacy-admin");
        assert_eq!(result["user"]["role"], "admin");
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(header::COOKIE, cookie);
        assert_eq!(
            state.auth.principal(&headers, None).unwrap().username,
            "owner"
        );
        assert!(
            state
                .auth
                .login("legacy-admin", "old-env-password")
                .is_none()
        );
        let second = router
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/setup")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(payload))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(second.status(), StatusCode::CONFLICT);
        let reloaded = AuthState::load(
            state.runtime.data_dir(),
            Some("different-env-password"),
            "different-configured-name",
            false,
        )
        .unwrap();
        assert!(!reloaded.setup_required());
        assert!(reloaded.login("owner", "new-password").is_some());
    }
}
