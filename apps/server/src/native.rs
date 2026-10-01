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
    let saved = save(state.clone(), None, input).await?;
    start_scan(state, saved.0.id.clone()).await?;
    Ok((StatusCode::CREATED, saved))
}
pub(crate) async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<NativeLibraryInput>,
) -> Result<Json<NativeLibrary>, HttpError> {
    save(state, Some(id), input).await
}

fn store(state: &AppState) -> ServerStore {
    ServerStore::new(state.runtime.data_dir())
}
async fn library(state: &AppState, id: &str) -> Result<NativeLibrary, HttpError> {
    let store = store(state);
    let id = id.to_owned();
    tokio::task::spawn_blocking(move || store.native_libraries())
        .await
        .map_err(|_| HttpError::bad_request("Library request interrupted."))?
        .map_err(error)?
        .into_iter()
        .find(|l| l.id == id)
        .ok_or_else(HttpError::not_found)
}
pub(crate) async fn status(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<posterview_contracts::native::NativeScanStatus>, HttpError> {
    library(&state, &id).await?;
    let store = store(&state);
    tokio::task::spawn_blocking(move || store.native_scan_status(&id))
        .await
        .map_err(|_| HttpError::bad_request("Scan status interrupted."))?
        .map(Json)
        .map_err(error)
}
pub(crate) async fn catalog(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Vec<posterview_contracts::native::NativeCatalogEntry>>, HttpError> {
    library(&state, &id).await?;
    let store = store(&state);
    tokio::task::spawn_blocking(move || store.native_catalog(&id))
        .await
        .map_err(|_| HttpError::bad_request("Catalog request interrupted."))?
        .map(Json)
        .map_err(error)
}
pub(crate) async fn start_scan(state: AppState, id: String) -> Result<(), HttpError> {
    let library = library(&state, &id).await?;
    let db = store(&state);
    let scan_id = id.clone();
    tokio::task::spawn_blocking(move || db.begin_native_scan(&scan_id))
        .await
        .map_err(|_| HttpError::bad_request("Scan request interrupted."))?
        .map_err(error)?;
    tokio::spawn(async move {
        let result = run_scan(state.clone(), library).await;
        let status = match result {
            Ok(status) => status,
            Err(e) => posterview_contracts::native::NativeScanStatus {
                status: "failed".into(),
                count: 0,
                warnings: vec![e.detail],
            },
        };
        let db = store(&state);
        let _ = tokio::task::spawn_blocking(move || db.finish_native_scan(&id, &status)).await;
    });
    Ok(())
}
async fn run_scan(
    state: AppState,
    library: NativeLibrary,
) -> Result<posterview_contracts::native::NativeScanStatus, HttpError> {
    let scan_state = state.clone();
    let scan_library = library.clone();
    let (mut entries, mut warnings) = tokio::task::spawn_blocking(move || {
        crate::native_scan::collect(&scan_state, &scan_library)
    })
    .await
    .map_err(|_| HttpError::bad_request("File scan interrupted."))??;
    let db = store(&state);
    let id = library.id.clone();
    let existing = tokio::task::spawn_blocking(move || db.native_catalog(&id))
        .await
        .map_err(|_| HttpError::bad_request("Catalog read interrupted."))?
        .map_err(error)?;
    let existing: std::collections::BTreeMap<_, _> = existing
        .into_iter()
        .map(|entry| (entry.path.clone(), entry))
        .collect();
    for entry in &mut entries {
        if let Some(previous) = existing.get(&entry.path) {
            // Carry forward known values so rescans do not discard manual edits or redownload artwork.
            if let Some(fields) = previous.metadata.as_object() {
                for (field, value) in fields {
                    if entry.metadata.get(field).is_none() {
                        entry.metadata[field] = value.clone();
                        entry.metadata["_sources"][field] = serde_json::json!("database");
                    }
                }
            }
            for art in &previous.artwork {
                let path = if let Some(name) = art.path.strip_prefix("@managed/") {
                    state.runtime.data_dir().join("native-artwork").join(name)
                } else {
                    state.metadata.directory("", true)?.join(&art.path)
                };
                if art.source != "manual" && !path.is_file() {
                    continue;
                }
                if !entry.artwork.iter().any(|v| v.kind == art.kind) {
                    entry.artwork.push(art.clone());
                }
            }
        }
    }
    // Publish the local catalog before network enrichment so large libraries are usable immediately.
    let local_entries = entries.clone();
    let db = store(&state);
    let local_library = library.clone();
    tokio::task::spawn_blocking(move || {
        db.ingest_native_catalog(&local_library.id, local_library.revision, &local_entries)?;
        db.finish_native_scan(
            &local_library.id,
            &posterview_contracts::native::NativeScanStatus {
                status: "scanning".into(),
                count: local_entries.len(),
                warnings: Vec::new(),
            },
        )
    })
    .await
    .map_err(|_| HttpError::bad_request("Local catalog save interrupted."))?
    .map_err(error)?;
    crate::native_provider::enrich(&state, &library, &mut entries, &mut warnings).await;
    let count = entries.len();
    let db = store(&state);
    let scan_library = library.clone();
    tokio::task::spawn_blocking(move || {
        db.ingest_native_catalog(&scan_library.id, scan_library.revision, &entries)
    })
    .await
    .map_err(|_| HttpError::bad_request("Catalog save interrupted."))?
    .map_err(error)?;
    if library.options.save_nfo {
        let write_state = state.clone();
        let id = library.id.clone();
        let issues = tokio::task::spawn_blocking(move || {
            let entries = store(&write_state).native_catalog(&id).map_err(error)?;
            let mut issues = Vec::new();
            for entry in entries
                .into_iter()
                .filter(|e| e.available && (e.kind != "season" || e.nfo_path.is_some()))
            {
                match crate::native_scan::write_nfo(&write_state, &entry) {
                    Ok((path, xml)) => store(&write_state)
                        .record_native_nfo(&id, &entry.id, &path, &xml)
                        .map_err(error)?,
                    Err(e) => issues.push(format!("{}: NFO write failed: {e}", entry.title)),
                }
            }
            Ok::<_, HttpError>(issues)
        })
        .await
        .map_err(|_| HttpError::bad_request("NFO write interrupted."))??;
        warnings.extend(issues);
    }
    if warnings.len() > 500 {
        warnings.truncate(500);
        warnings.push(
            "Additional warnings omitted; narrow the library roots to inspect remaining items."
                .into(),
        );
    }
    Ok(posterview_contracts::native::NativeScanStatus {
        status: if warnings.is_empty() {
            "complete"
        } else {
            "needs_review"
        }
        .into(),
        count,
        warnings,
    })
}
pub(crate) async fn scan(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<(StatusCode, Json<serde_json::Value>), HttpError> {
    start_scan(state, id).await?;
    Ok((
        StatusCode::ACCEPTED,
        Json(serde_json::json!({"status":"scanning"})),
    ))
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DeleteRequest {
    revision: i64,
}
pub(crate) async fn delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<DeleteRequest>,
) -> Result<StatusCode, HttpError> {
    library(&state, &id).await?;
    let db = store(&state);
    tokio::task::spawn_blocking(move || db.delete_native_library(&id, input.revision))
        .await
        .map_err(|_| HttpError::bad_request("Library delete interrupted."))?
        .map_err(error)?;
    Ok(StatusCode::NO_CONTENT)
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct EditRequest {
    revision: i64,
    metadata: serde_json::Value,
}
pub(crate) async fn edit_item(
    State(state): State<AppState>,
    Path((library_id, item)): Path<(String, String)>,
    Json(input): Json<EditRequest>,
) -> Result<Json<serde_json::Value>, HttpError> {
    let library = library(&state, &library_id).await?;
    tokio::task::spawn_blocking(move || {
        let db = store(&state);
        db.edit_native_entry(&library_id, &item, input.revision, &input.metadata)
            .map_err(error)?;
        let entry = db
            .native_catalog(&library_id)
            .map_err(error)?
            .into_iter()
            .find(|e| e.id == item)
            .ok_or_else(HttpError::not_found)?;
        let mut warnings = Vec::<String>::new();
        if library.options.save_nfo && (entry.kind != "season" || entry.nfo_path.is_some()) {
            match crate::native_scan::write_nfo(&state, &entry) {
                Ok((path, xml)) => db
                    .record_native_nfo(&library_id, &entry.id, &path, &xml)
                    .map_err(error)?,
                Err(e) => warnings.push(format!(
                    "Metadata saved in the database. NFO write failed: {e}"
                )),
            }
        }
        Ok(Json(serde_json::json!({"entry":entry,"warnings":warnings})))
    })
    .await
    .map_err(|_| HttpError::bad_request("Metadata save interrupted."))?
}
pub(crate) async fn upload_artwork(
    State(state): State<AppState>,
    Path((library, item, kind)): Path<(String, String, String)>,
    mut multipart: axum::extract::Multipart,
) -> Result<StatusCode, HttpError> {
    if ![
        "poster",
        "backdrop",
        "banner",
        "logo",
        "thumb",
        "landscape",
        "disc",
    ]
    .contains(&kind.as_str())
    {
        return Err(HttpError::bad_request("Unknown artwork type."));
    }
    let field = multipart
        .next_field()
        .await
        .map_err(|_| HttpError::bad_request("Invalid upload."))?
        .ok_or_else(|| HttpError::bad_request("Choose an artwork image."))?;
    let bytes = field
        .bytes()
        .await
        .map_err(|_| HttpError::bad_request("Unable to read artwork upload."))?;
    tokio::task::spawn_blocking(move || {
        let db = store(&state);
        if !db
            .native_catalog(&library)
            .map_err(error)?
            .iter()
            .any(|e| e.id == item)
        {
            return Err(HttpError::not_found());
        }
        let path =
            crate::native_provider::store_image(&state, &bytes).map_err(HttpError::bad_request)?;
        db.save_native_artwork(
            &library,
            &item,
            &posterview_contracts::native::NativeArtwork {
                kind,
                path,
                source: "manual".into(),
            },
        )
        .map_err(error)?;
        Ok(())
    })
    .await
    .map_err(|_| HttpError::bad_request("Artwork save interrupted."))??;
    Ok(StatusCode::NO_CONTENT)
}
pub(crate) async fn artwork(
    State(state): State<AppState>,
    Path((library, item, kind)): Path<(String, String, String)>,
) -> Result<(axum::http::HeaderMap, Vec<u8>), HttpError> {
    tokio::task::spawn_blocking(move || {
        let entry = store(&state)
            .native_catalog(&library)
            .map_err(error)?
            .into_iter()
            .find(|e| e.id == item)
            .ok_or_else(HttpError::not_found)?;
        let art = entry
            .artwork
            .iter()
            .find(|a| a.kind == kind)
            .ok_or_else(HttpError::not_found)?;
        let path = if let Some(name) = art.path.strip_prefix("@managed/") {
            let (id, ext) = name.rsplit_once('.').ok_or_else(HttpError::not_found)?;
            if uuid::Uuid::parse_str(id).is_err() || !["jpg", "png", "webp"].contains(&ext) {
                return Err(HttpError::not_found());
            }
            state.runtime.data_dir().join("native-artwork").join(name)
        } else {
            let root = state.metadata.directory("", true)?;
            let path = root.join(&art.path);
            let parent = path.parent().ok_or_else(HttpError::not_found)?;
            let rel = parent
                .strip_prefix(&root)
                .map_err(|_| HttpError::not_found())?
                .to_string_lossy()
                .replace('\\', "/");
            state.metadata.directory(&rel, true)?;
            if std::fs::symlink_metadata(&path)
                .map_err(|_| HttpError::not_found())?
                .is_symlink()
                || !path
                    .canonicalize()
                    .map_err(|_| HttpError::not_found())?
                    .starts_with(root)
            {
                return Err(HttpError::not_found());
            }
            path
        };
        let metadata = std::fs::metadata(&path).map_err(|_| HttpError::not_found())?;
        if metadata.len() > 20 * 1024 * 1024 {
            return Err(HttpError::bad_request("Artwork exceeds 20 MB."));
        }
        let bytes = std::fs::read(&path).map_err(|_| HttpError::not_found())?;
        let format =
            image::guess_format(&bytes).map_err(|_| HttpError::bad_request("Invalid artwork."))?;
        let mime = match format {
            image::ImageFormat::Jpeg => "image/jpeg",
            image::ImageFormat::Png => "image/png",
            image::ImageFormat::WebP => "image/webp",
            _ => return Err(HttpError::bad_request("Unsupported artwork.")),
        };
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(
            axum::http::header::CONTENT_TYPE,
            axum::http::HeaderValue::from_static(mime),
        );
        headers.insert(
            axum::http::header::CACHE_CONTROL,
            axum::http::HeaderValue::from_static("private, no-cache"),
        );
        Ok((headers, bytes))
    })
    .await
    .map_err(|_| HttpError::bad_request("Artwork request interrupted."))?
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
            options: Default::default(),
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

#[cfg(test)]
mod scan_tests {
    use super::*;
    use posterview_contracts::native::{AnimeContent, NativeLibraryOptions, NativeLibraryType};
    use std::{fs, sync::Arc};
    fn state(dir: &std::path::Path) -> AppState {
        let media = dir.join("media");
        fs::create_dir_all(&media).unwrap();
        let runtime = Arc::new(posterview_runtime::Runtime::new(dir.join("config")));
        runtime.initialize().unwrap();
        AppState {
            runtime: runtime.clone(),
            auth: crate::AuthState::for_tests(""),
            login_backdrop: crate::login_backdrop::LoginBackdrop::new(runtime.data_dir()),
            metadata: Arc::new(crate::metadata::MetadataStore::new(media.clone())),
            reader: Arc::new(crate::reader::ReaderStore::new(
                media,
                dir.join("config/reader.sqlite"),
            )),
        }
    }
    #[tokio::test]
    async fn monitoring_scans_new_files_and_can_be_disabled() {
        let temp = tempfile::tempdir().unwrap();
        let state = state(temp.path());
        let media = temp.path().join("media/Movies");
        fs::create_dir_all(&media).unwrap();
        let db = store(&state);
        let mut library = db
            .save_native_library(
                None,
                &NativeLibraryInput {
                    name: "Movies".into(),
                    library_type: NativeLibraryType::Movies,
                    anime_content: AnimeContent::Both,
                    paths: vec!["Movies".into()],
                    revision: None,
                    options: NativeLibraryOptions {
                        fetch_missing: false,
                        real_time_monitor: true,
                        ..Default::default()
                    },
                },
            )
            .unwrap();
        crate::native_monitor::start(state.clone());
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        fs::write(media.join("New.mp4"), b"fixture").unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(25), async {
            loop {
                if db
                    .native_catalog(&library.id)
                    .unwrap()
                    .iter()
                    .any(|e| e.title == "New")
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
        })
        .await
        .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while db.native_scan_status(&library.id).unwrap().status == "scanning" {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        })
        .await
        .unwrap();
        let mut options = library.options.clone();
        options.real_time_monitor = false;
        library = db
            .save_native_library(
                Some(&library.id),
                &NativeLibraryInput {
                    name: library.name.clone(),
                    library_type: library.library_type,
                    anime_content: library.anime_content,
                    paths: library.paths.clone(),
                    revision: Some(library.revision),
                    options,
                },
            )
            .unwrap();
        fs::write(media.join("Ignored.mp4"), b"fixture").unwrap();
        tokio::time::sleep(std::time::Duration::from_secs(7)).await;
        assert!(
            !db.native_catalog(&library.id)
                .unwrap()
                .iter()
                .any(|e| e.title == "Ignored")
        );
    }
    #[test]
    fn sample_size_setting_controls_inclusion() {
        let temp = tempfile::tempdir().unwrap();
        let state = state(temp.path());
        let media = temp.path().join("media/Movies");
        fs::create_dir_all(&media).unwrap();
        fs::write(media.join("Film.sample.mp4"), b"fixture").unwrap();
        let db = store(&state);
        let mut library = db
            .save_native_library(
                None,
                &NativeLibraryInput {
                    name: "Movies".into(),
                    library_type: NativeLibraryType::Movies,
                    anime_content: AnimeContent::Both,
                    paths: vec!["Movies".into()],
                    revision: None,
                    options: NativeLibraryOptions {
                        fetch_missing: false,
                        ..Default::default()
                    },
                },
            )
            .unwrap();
        assert!(
            crate::native_scan::collect(&state, &library)
                .unwrap()
                .0
                .is_empty()
        );
        library.options.sample_ignore_mb = 0;
        assert_eq!(
            crate::native_scan::collect(&state, &library)
                .unwrap()
                .0
                .len(),
            1
        );
    }
    #[tokio::test]
    async fn scans_mixed_anime_preserves_manual_edits_and_deletes_only_catalog() {
        let temp = tempfile::tempdir().unwrap();
        let state = state(temp.path());
        let media = temp.path().join("media");
        let series = media.join("Anime/Example/Season 01");
        fs::create_dir_all(&series).unwrap();
        fs::write(series.join("Example.S01E01.mkv"), b"fixture").unwrap();
        fs::write(series.join("Example.S01E01.nfo"),"<episodedetails><title>Episode One</title><season>1</season><episode>1</episode></episodedetails>").unwrap();
        let series_nfo = series.parent().unwrap().join("tvshow.nfo");
        fs::write(&series_nfo,"<tvshow><title>Example</title><genre>Action</genre><actor><name>Actor</name><role>Lead</role></actor><custom>keep</custom></tvshow>").unwrap();
        image::save_buffer(
            series.parent().unwrap().join("poster.png"),
            &[20, 30, 40],
            1,
            1,
            image::ColorType::Rgb8,
        )
        .unwrap();
        fs::create_dir_all(media.join("Anime/Film")).unwrap();
        fs::write(media.join("Anime/Film/Film.mp4"), b"fixture").unwrap();
        fs::write(
            media.join("Anime/Film/Film.nfo"),
            "<movie><title>Film</title><year>2020</year><tag>Favorite</tag></movie>",
        )
        .unwrap();
        for folder in ["backdrops", "Backdrops", "backdrop"] {
            let extras = series.parent().unwrap().join(folder);
            fs::create_dir_all(extras.join("nested")).unwrap();
            fs::write(extras.join("NCOP.mp4"), b"fixture").unwrap();
            fs::write(extras.join("nested/NCED.S01E99.mkv"), b"fixture").unwrap();
        }
        let db = store(&state);
        db.set_setting("existing", "untouched").unwrap();
        let library = db
            .save_native_library(
                None,
                &NativeLibraryInput {
                    name: "Anime".into(),
                    library_type: NativeLibraryType::Anime,
                    anime_content: AnimeContent::Both,
                    paths: vec!["Anime".into()],
                    revision: None,
                    options: NativeLibraryOptions {
                        fetch_missing: false,
                        save_nfo: true,
                        ..Default::default()
                    },
                },
            )
            .unwrap();
        let report = run_scan(state.clone(), library.clone()).await.unwrap();
        assert_eq!(report.count, 4);
        let items = db.native_catalog(&library.id).unwrap();
        assert!(items.iter().any(|e| e.kind == "movie"));
        assert!(items.iter().any(|e| e.kind == "season"));
        let show = items.iter().find(|e| e.kind == "series").unwrap();
        assert_eq!(show.metadata["genres"], serde_json::json!(["Action"]));
        assert_eq!(show.artwork[0].source, "local");
        assert!(show.nfo_path.is_some());
        db.edit_native_entry(
            &library.id,
            &show.id,
            show.revision,
            &serde_json::json!({"title":"Manual Title","genres":["Manual Genre"]}),
        )
        .unwrap();
        let uploaded = crate::native_provider::store_image(
            &state,
            &fs::read(series.parent().unwrap().join("poster.png")).unwrap(),
        )
        .unwrap();
        db.save_native_artwork(
            &library.id,
            &show.id,
            &posterview_contracts::native::NativeArtwork {
                kind: "poster".into(),
                path: uploaded.clone(),
                source: "manual".into(),
            },
        )
        .unwrap();
        run_scan(state.clone(), library.clone()).await.unwrap();
        let items = db.native_catalog(&library.id).unwrap();
        let rescanned = items.iter().find(|e| e.kind == "series").unwrap();
        assert_eq!(rescanned.id, show.id);
        assert_eq!(rescanned.artwork[0].source, "manual");
        assert_eq!(rescanned.artwork[0].path, uploaded);
        assert_eq!(rescanned.title, "Manual Title");
        assert_eq!(
            rescanned.metadata["genres"],
            serde_json::json!(["Manual Genre"])
        );
        let xml = fs::read_to_string(&series_nfo).unwrap();
        assert!(xml.contains("<custom>keep</custom>"));
        assert!(xml.contains("Manual Title"));
        let external = xml.replace("</tvshow>", "<external>edit</external></tvshow>");
        fs::write(&series_nfo, &external).unwrap();
        assert!(crate::native_scan::write_nfo(&state, rescanned).is_err());
        assert_eq!(fs::read_to_string(&series_nfo).unwrap(), external);
        fs::write(&series_nfo, &xml).unwrap();

        let episode = items.iter().find(|e| e.kind == "episode").unwrap();
        fs::remove_file(media.join(&episode.path)).unwrap();
        run_scan(state.clone(), library.clone()).await.unwrap();
        assert!(
            !db.native_catalog(&library.id)
                .unwrap()
                .iter()
                .find(|e| e.id == episode.id)
                .unwrap()
                .available
        );
        db.begin_native_scan(&library.id).unwrap();
        assert!(db.begin_native_scan(&library.id).is_err());
        assert!(
            db.delete_native_library(&library.id, library.revision)
                .is_err()
        );
        db.finish_native_scan(&library.id, &report).unwrap();
        db.delete_native_library(&library.id, library.revision)
            .unwrap();
        assert!(db.native_libraries().unwrap().is_empty());
        assert!(db.native_catalog(&library.id).unwrap().is_empty());
        assert!(series_nfo.is_file());
        assert!(media.join("Anime/Film/Film.mp4").is_file());
        assert_eq!(db.get_setting("existing").unwrap(), "untouched");
    }
    #[tokio::test]
    async fn invalid_nfo_is_not_replaced_and_book_profile_is_preserved() {
        let temp = tempfile::tempdir().unwrap();
        let state = state(temp.path());
        let dir = temp.path().join("media/Books/Colored");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("Vol01.cbz"), b"fixture").unwrap();
        fs::write(dir.join("Colored.nfo"),"<series><title>Book Title</title><edition>Colored</edition><custom>keep</custom></series>").unwrap();
        fs::write(dir.join("Vol01.nfo"), "<broken>").unwrap();
        let library = store(&state)
            .save_native_library(
                None,
                &NativeLibraryInput {
                    name: "Books".into(),
                    library_type: NativeLibraryType::Books,
                    anime_content: AnimeContent::Both,
                    paths: vec!["Books".into()],
                    revision: None,
                    options: NativeLibraryOptions {
                        fetch_missing: false,
                        save_nfo: true,
                        ..Default::default()
                    },
                },
            )
            .unwrap();
        let status = run_scan(state.clone(), library.clone()).await.unwrap();
        assert!(status.warnings.iter().any(|w| w.contains("Invalid NFO")));
        assert_eq!(
            fs::read_to_string(dir.join("Vol01.nfo")).unwrap(),
            "<broken>"
        );
        let entries = store(&state).native_catalog(&library.id).unwrap();
        let book = entries.iter().find(|e| e.kind == "book_series").unwrap();
        assert_eq!(book.metadata["edition"], "Colored");
        assert!(
            fs::read_to_string(dir.join("Colored.nfo"))
                .unwrap()
                .contains("<custom>keep</custom>")
        );
        assert!(crate::native_scan::parse_nfo(b"<!DOCTYPE movie><movie/>").is_err());
    }
}
