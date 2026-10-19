//! Collection-owned artwork; member library files are never modified.
use super::{error, project_one};
use crate::{AppState, HttpError};
use axum::{
    Router,
    extract::{Path, State},
    http::{HeaderMap, header},
    routing::get,
};
use posterview_contracts::{ApplyResult, ImageTarget};
use posterview_infra_sqlite::ServerStore;
use std::io::Cursor;

pub(super) fn routes() -> Router<AppState> {
    Router::new().route("/api/collections/{id}/artwork/{file}", get(image))
}

pub(crate) async fn apply_panel_artwork(
    state: AppState,
    target: String,
    kind: ImageTarget,
    bytes: Option<Vec<u8>>,
) -> Result<ApplyResult, HttpError> {
    let field = match kind {
        ImageTarget::Poster => "poster",
        ImageTarget::Background => "backdrop",
        _ => {
            return Err(HttpError::bad_request(
                "Collections support posters and backdrops.",
            ));
        }
    };
    let id = target
        .strip_prefix("collection:")
        .ok_or_else(HttpError::not_found)?
        .to_string();
    let history = crate::artwork_history::capture_collection(&state, &id, field).await?;
    let history_state = state.clone();
    let result = super::blocking(move || {
        let store = ServerStore::new(state.runtime.data_dir());
        store
            .collection(&id)
            .map_err(error)?
            .ok_or_else(HttpError::not_found)?;
        let mut saved = None;
        let url = if let Some(bytes) = bytes {
            if bytes.len() > 50 * 1024 * 1024 || crate::native_animation::is_animated(&bytes) {
                return Err(HttpError::bad_request(
                    "Choose a static collection image under 50 MB.",
                ));
            }
            let reader = image::ImageReader::new(Cursor::new(&bytes))
                .with_guessed_format()
                .map_err(|error| HttpError::bad_request(error.to_string()))?;
            let (width, height) = reader
                .into_dimensions()
                .map_err(|error| HttpError::bad_request(error.to_string()))?;
            if u64::from(width) * u64::from(height) > 64_000_000 {
                return Err(HttpError::bad_request("Artwork exceeds 64 megapixels."));
            }
            let image = image::load_from_memory(&bytes)
                .map_err(|error| HttpError::bad_request(error.to_string()))?
                .thumbnail(1920, 1920);
            let mut encoded = Cursor::new(Vec::new());
            image
                .write_to(&mut encoded, image::ImageFormat::WebP)
                .map_err(|error| HttpError::bad_request(error.to_string()))?;
            let directory = state.runtime.data_dir().join("collection-artwork");
            std::fs::create_dir_all(&directory)
                .map_err(|error| HttpError::bad_request(error.to_string()))?;
            let file = format!("{}.webp", uuid::Uuid::new_v4());
            let path = directory.join(&file);
            std::fs::write(&path, encoded.into_inner())
                .map_err(|error| HttpError::bad_request(error.to_string()))?;
            saved = Some(path);
            format!("/api/collections/{id}/artwork/{file}")
        } else {
            String::new()
        };
        let result = store
            .save_collection_artwork(&id, field, &url)
            .map_err(error);
        if !matches!(result, Ok(Some(_)))
            && let Some(path) = saved
        {
            let _ = std::fs::remove_file(path);
        }
        result?.ok_or_else(HttpError::not_found)?;
        Ok(ApplyResult {
            ok: true,
            message: "Collection artwork updated.".into(),
        })
    })
    .await?;
    history.commit(&history_state).await?;
    Ok(result)
}

async fn image(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, file)): Path<(String, String)>,
) -> Result<impl axum::response::IntoResponse, HttpError> {
    let user = state.auth.request_user(&headers)?;
    if !file.ends_with(".webp") || uuid::Uuid::parse_str(file.trim_end_matches(".webp")).is_err() {
        return Err(HttpError::not_found());
    }
    let dir = state.runtime.data_dir().to_path_buf();
    super::blocking(move || {
        let store = ServerStore::new(&dir);
        let record = store
            .collection(&id)
            .map_err(error)?
            .ok_or_else(HttpError::not_found)?;
        let url = format!("/api/collections/{id}/artwork/{file}");
        let visible = project_one(&store, &user, record)?;
        if visible.metadata.poster_url != url && visible.metadata.backdrop_url != url {
            return Err(HttpError::not_found());
        }
        let bytes = std::fs::read(dir.join("collection-artwork").join(file))
            .map_err(|_| HttpError::not_found())?;
        Ok((
            [
                (header::CONTENT_TYPE, "image/webp"),
                (header::CACHE_CONTROL, "private, max-age=86400"),
            ],
            bytes,
        ))
    })
    .await
}
