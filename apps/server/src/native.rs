use crate::{AppState, HttpError};
use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use posterview_contracts::native::{NativeLibrary, NativeLibraryInput};
use posterview_infra_sqlite::{ServerStore, StoreError};

fn error(e: StoreError) -> HttpError {
    match e {
        StoreError::RevisionConflict => HttpError {
            status: StatusCode::CONFLICT,
            detail: e.to_string(),
        },
        StoreError::Validation(message) => HttpError::bad_request(message),
        _ => {
            tracing::error!(%e, "native catalog persistence failed");
            HttpError {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                detail: "Unable to save the library.".into(),
            }
        }
    }
}

pub(crate) async fn list(
    State(state): State<AppState>,
) -> Result<Json<Vec<NativeLibrary>>, HttpError> {
    let dir = state.runtime.data_dir().to_owned();
    let libraries = tokio::task::spawn_blocking(move || ServerStore::new(dir).native_libraries())
        .await
        .map_err(|_| HttpError::bad_request("Library request interrupted."))?
        .map_err(error)?;
    Ok(Json(libraries))
}

async fn save(
    state: AppState,
    id: Option<String>,
    input: NativeLibraryInput,
) -> Result<Json<NativeLibrary>, HttpError> {
    let result = tokio::task::spawn_blocking(move || {
        for path in &input.paths {
            state.metadata.directory(path, true)?;
        }
        let store = ServerStore::new(state.runtime.data_dir());
        if let Some(id) = &id {
            if !store
                .native_libraries()
                .map_err(error)?
                .iter()
                .any(|l| &l.id == id)
            {
                return Err(HttpError {
                    status: StatusCode::NOT_FOUND,
                    detail: "Library not found.".into(),
                });
            }
            if input.revision.is_none() {
                return Err(HttpError::bad_request(
                    "A revision is required when editing a library.",
                ));
            }
        } else if input.revision.is_some() {
            return Err(HttpError::bad_request(
                "New libraries cannot have a revision.",
            ));
        }
        store
            .save_native_library(id.as_deref(), &input)
            .map_err(error)
    })
    .await
    .map_err(|_| HttpError::bad_request("Library request interrupted."))??;
    Ok(Json(result))
}

pub(crate) async fn create(
    State(state): State<AppState>,
    Json(input): Json<NativeLibraryInput>,
) -> Result<(StatusCode, Json<NativeLibrary>), HttpError> {
    Ok((StatusCode::CREATED, save(state, None, input).await?))
}
pub(crate) async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<NativeLibraryInput>,
) -> Result<Json<NativeLibrary>, HttpError> {
    save(state, Some(id), input).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use posterview_contracts::native::{AnimeContent, NativeLibraryType};
    use std::sync::Arc;
    #[tokio::test]
    async fn paths_are_checked_and_stale_edits_leave_the_library_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let media = dir.path().join("media");
        std::fs::create_dir_all(media.join("Anime")).unwrap();
        let runtime = Arc::new(posterview_runtime::Runtime::new(dir.path().join("data")));
        runtime.initialize().unwrap();
        let state = AppState {
            runtime: runtime.clone(),
            auth: crate::AuthState::for_tests(""),
            login_backdrop: crate::login_backdrop::LoginBackdrop::new(runtime.data_dir()),
            metadata: Arc::new(crate::metadata::MetadataStore::new(media.clone())),
            reader: Arc::new(crate::reader::ReaderStore::new(
                media,
                dir.path().join("reader.sqlite"),
            )),
        };
        let mut input = NativeLibraryInput {
            name: "Anime".into(),
            library_type: NativeLibraryType::Anime,
            anime_content: AnimeContent::Both,
            paths: vec!["Anime".into()],
            revision: None,
        };
        let saved = save(state.clone(), None, input.clone()).await.unwrap().0;
        assert_eq!(saved.paths, vec!["Anime"]);
        input.revision = Some(999);
        input.name = "Changed".into();
        assert_eq!(
            save(state.clone(), Some(saved.id.clone()), input.clone())
                .await
                .unwrap_err()
                .status,
            StatusCode::CONFLICT
        );
        input.revision = None;
        input.paths = vec!["../outside".into()];
        assert!(save(state.clone(), None, input.clone()).await.is_err());
        input.paths = vec!["missing".into()];
        assert!(save(state.clone(), None, input).await.is_err());
        assert_eq!(list(State(state)).await.unwrap().0, vec![saved]);
    }
}
