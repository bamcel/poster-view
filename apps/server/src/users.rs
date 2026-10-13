//! Administrator account management. Credentials are hashed in blocking workers.
use crate::{AppState, HttpError};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::get,
};
use posterview_contracts::{UserAccount, UserCreate, UserPermissions, UserRole, UserUpdate};
use posterview_infra_sqlite::{ServerStore, StoreError};

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/users", get(list).post(create))
        .route("/api/users/{id}", axum::routing::put(update).delete(delete))
}
fn admin(state: &AppState, headers: &HeaderMap) -> Result<(), HttpError> {
    if state.auth.request_user(headers)?.role != UserRole::Admin {
        return Err(HttpError {
            status: StatusCode::FORBIDDEN,
            detail: "Administrator access required.".into(),
        });
    }
    Ok(())
}
fn error(error: StoreError) -> HttpError {
    match error {
        StoreError::Validation(detail) => HttpError::bad_request(detail),
        StoreError::RevisionConflict => HttpError {
            status: StatusCode::CONFLICT,
            detail: "Account changed. Reload before saving.".into(),
        },
        error => {
            tracing::error!(%error,"account storage failed");
            HttpError {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                detail: "Could not save account.".into(),
            }
        }
    }
}
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, StoreError> + Send + 'static,
) -> Result<T, HttpError> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|_| HttpError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            detail: "Account operation failed.".into(),
        })?
        .map_err(error)
}
fn libraries(store: &ServerStore, permissions: &UserPermissions) -> Result<(), StoreError> {
    let valid: std::collections::HashSet<_> = store
        .native_libraries()?
        .into_iter()
        .map(|l| l.id)
        .collect();
    if permissions.library_ids.iter().any(|id| !valid.contains(id)) {
        return Err(StoreError::Validation(
            "One or more selected libraries no longer exist.".into(),
        ));
    }
    Ok(())
}
async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<UserAccount>>, HttpError> {
    admin(&state, &headers)?;
    let dir = state.runtime.data_dir().to_owned();
    Ok(Json(blocking(move || ServerStore::new(dir).users()).await?))
}
async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<UserCreate>,
) -> Result<(StatusCode, Json<UserAccount>), HttpError> {
    admin(&state, &headers)?;
    let dir = state.runtime.data_dir().to_owned();
    let user = blocking(move || {
        let store = ServerStore::new(dir);
        libraries(&store, &input.permissions)?;
        store.create_user(&input)
    })
    .await?;
    Ok((StatusCode::CREATED, Json(user)))
}
async fn update(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<UserUpdate>,
) -> Result<Json<UserAccount>, HttpError> {
    admin(&state, &headers)?;
    let dir = state.runtime.data_dir().to_owned();
    let user = blocking(move || {
        let store = ServerStore::new(dir);
        libraries(&store, &input.permissions)?;
        store.update_user(&id, &input)
    })
    .await?
    .ok_or_else(|| HttpError {
        status: StatusCode::NOT_FOUND,
        detail: "Account not found.".into(),
    })?;
    Ok(Json(user))
}
async fn delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<StatusCode, HttpError> {
    admin(&state, &headers)?;
    let dir = state.runtime.data_dir().to_owned();
    if !blocking(move || ServerStore::new(dir).delete_user(&id)).await? {
        return Err(HttpError {
            status: StatusCode::NOT_FOUND,
            detail: "Account not found.".into(),
        });
    }
    Ok(StatusCode::NO_CONTENT)
}
