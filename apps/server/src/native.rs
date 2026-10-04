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
    if input.options.server_sync.enabled {
        let sync = &input.options.server_sync;
        let server = state.runtime.list_servers().map_err(|e|HttpError::bad_request(e.to_string()))?.into_iter().find(|server|Some(server.id)==sync.server_id).ok_or_else(||HttpError::bad_request("Select a connected server."))?;
        if server.server_type == posterview_contracts::ServerType::Plex { return Err(HttpError::bad_request("Shared metadata sync currently supports Emby and Jellyfin.")); }
        let libraries=state.runtime.get_libraries(server.id).await.map_err(|e|HttpError::bad_request(e.to_string()))?.ok_or_else(HttpError::not_found)?.map_err(HttpError::bad_request)?;
        if sync.library_id!="*" && !libraries.iter().any(|library|library.id==sync.library_id){return Err(HttpError::bad_request("Select a library on the connected server."));}
    }
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
pub(crate) async fn previews(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, HttpError> {
    let Json(entries) = catalog(State(state), Path(id)).await?;
    Ok(Json(serde_json::Value::Array(entries.into_iter()
        .filter(|entry| entry.available && ["series", "movie", "book", "book_series"].contains(&entry.kind.as_str()) && entry.artwork.iter().any(|art| art.kind == "poster"))
        .map(|entry| serde_json::json!({"id":entry.id,"title":entry.title,"revision":entry.revision}))
        .collect())))
}
pub(crate) async fn start_scan(state: AppState, id: String) -> Result<(), HttpError> {
    start_scan_scoped(state, id, None).await
}
pub(crate) async fn start_scan_scoped(
    state: AppState,
    id: String,
    scopes: Option<Vec<String>>,
) -> Result<(), HttpError> {
    let library = library(&state, &id).await?;
    let db = store(&state);
    let scan_id = id.clone();
    tokio::task::spawn_blocking(move || db.begin_native_scan(&scan_id))
        .await
        .map_err(|_| HttpError::bad_request("Scan request interrupted."))?
        .map_err(error)?;
    tokio::spawn(async move {
        let result = run_scan_scoped(state.clone(), library, scopes).await;
        let status = match result {
            Ok(status) => status,
            Err(e) => posterview_contracts::native::NativeScanStatus {
                progress: None,
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
fn in_scope(path: &str, scopes: Option<&[String]>) -> bool {
    scopes.is_none_or(|scopes| {
        scopes.iter().any(|scope| {
            scope.is_empty() || path == scope || path.starts_with(&format!("{scope}/"))
        })
    })
}
#[cfg(test)]
pub(crate) async fn run_scan(
    state: AppState,
    library: NativeLibrary,
) -> Result<posterview_contracts::native::NativeScanStatus, HttpError> {
    run_scan_scoped(state, library, None).await
}
async fn run_scan_scoped(
    state: AppState,
    library: NativeLibrary,
    scopes: Option<Vec<String>>,
) -> Result<posterview_contracts::native::NativeScanStatus, HttpError> {
    let scan_state = state.clone();
    let scan_library = library.clone();
    let scan_scopes = scopes.clone();
    let (mut entries, mut warnings) = tokio::task::spawn_blocking(move || {
        crate::native_scan::collect_scoped(&scan_state, &scan_library, scan_scopes.as_deref())
    })
    .await
    .map_err(|_| HttpError::bad_request("File scan interrupted."))??;
    let db = store(&state);
    let id = library.id.clone();
    let existing_scopes = scopes.clone();
    let existing = tokio::task::spawn_blocking(move || {
        db.native_catalog_scoped(&id, existing_scopes.as_deref())
    })
    .await
    .map_err(|_| HttpError::bad_request("Catalog read interrupted."))?
    .map_err(error)?;
    let existing: std::collections::BTreeMap<_, _> = existing
        .into_iter()
        .map(|entry| (entry.path.clone(), entry))
        .collect();
    for entry in &mut entries {
        if let Some(previous) = existing.get(&entry.path) {
            crate::native_provider::merge_credit_portraits(
                &mut entry.metadata,
                &previous.metadata["credits"],
            );
            if previous.metadata["_title_locked"] == true {
                entry.metadata["title"] = previous.metadata["title"].clone();
                entry.metadata["_title_locked"] = serde_json::json!(true);
                entry.metadata["_sources"]["title"] = serde_json::json!("manual");
                entry.title = previous.title.clone();
            }
            // Server-authoritative shared fields survive local NFO rescans.
            if let Some(fields) = previous.metadata.as_object() {
                for (field, value) in fields {
                    if !field.starts_with('_') && previous.metadata["_sources"][field] == "server" {
                        entry.metadata[field] = value.clone();
                        entry.metadata["_sources"][field] = serde_json::json!("server");
                        if field == "title" { entry.title = previous.title.clone(); }
                    }
                }
            }
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
    let local_scopes = scopes.clone();
    tokio::task::spawn_blocking(move || {
        db.ingest_native_catalog_scoped(
            &local_library.id,
            local_library.revision,
            &local_entries,
            local_scopes.as_deref(),
        )?;
        db.finish_native_scan(
            &local_library.id,
            &posterview_contracts::native::NativeScanStatus {
                progress: None,
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
    let final_scopes = scopes.clone();
    tokio::task::spawn_blocking(move || {
        db.ingest_native_catalog_scoped(
            &scan_library.id,
            scan_library.revision,
            &entries,
            final_scopes.as_deref(),
        )
    })
    .await
    .map_err(|_| HttpError::bad_request("Catalog save interrupted."))?
    .map_err(error)?;
    let mut progress = crate::native_progress::Reporter::new(&state, &library.id);
    progress.report("saving", 0, None, count, "", true);
    if library.options.save_artwork {
        let write_state = state.clone();
        let id = library.id.clone();
        let write_scopes = scopes.clone();
        warnings.extend(
            tokio::task::spawn_blocking(move || {
                let entries = store(&write_state)
                    .native_catalog_scoped(&id, write_scopes.as_deref())
                    .map_err(error)?;
                let issues = crate::workers::parallel(
                    entries
                        .into_iter()
                        .filter(|e| e.available && in_scope(&e.path, write_scopes.as_deref()))
                        .collect(),
                    |entry| {
                        let mut issues = Vec::new();
                        for art in &entry.artwork {
                            if let Err(e) =
                                crate::native_artwork::write(&write_state, &entry, art, false)
                            {
                                issues.push(format!("{}: artwork write failed: {e}", entry.title));
                            }
                        }
                        issues
                    },
                )
                .into_iter()
                .flatten()
                .collect::<Vec<_>>();
                Ok::<_, HttpError>(issues)
            })
            .await
            .map_err(|_| HttpError::bad_request("Artwork write interrupted."))??,
        );
    }
    if library.options.save_nfo {
        let write_state = state.clone();
        let id = library.id.clone();
        let write_scopes = scopes.clone();
        let issues = tokio::task::spawn_blocking(move || {
            let entries = store(&write_state)
                .native_catalog_scoped(&id, write_scopes.as_deref())
                .map_err(error)?;
            let results = crate::workers::parallel(
                entries
                    .into_iter()
                    .filter(|e| {
                        e.available
                            && in_scope(&e.path, write_scopes.as_deref())
                            && (e.kind != "season" || e.nfo_path.is_some())
                    })
                    .collect(),
                |entry| {
                    let result = crate::native_scan::write_nfo(&write_state, &entry);
                    (entry, result)
                },
            );
            let mut issues = Vec::new();
            // File writes run concurrently; their database projections commit on this coordinator.
            for (entry, result) in results {
                match result {
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
    let count = if scopes.is_some() {
        let db = store(&state);
        let id = library.id.clone();
        tokio::task::spawn_blocking(move || db.native_available_count(&id))
            .await
            .map_err(|_| HttpError::bad_request("Catalog count interrupted."))?
            .map_err(error)?
    } else {
        count
    };
    Ok(posterview_contracts::native::NativeScanStatus {
        progress: None,
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
    let only_visual_fields=input.metadata.as_object().is_some_and(|fields| !fields.is_empty() && fields.keys().all(|key| ["posteredit", "poseredit", "backdropedit"].contains(&key.as_str())));
    let changed_fields=input.metadata.clone();
    let sync_state=state.clone();
    let sync_library=library_id.clone();
    let sync_item=item.clone();
    let result = tokio::task::spawn_blocking(move || {
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
        if library.options.save_nfo && !only_visual_fields && (entry.kind != "season" || entry.nfo_path.is_some()) {
            match crate::native_scan::write_nfo(&state, &entry) {
                Ok((path, xml)) => db
                    .record_native_nfo(&library_id, &entry.id, &path, &xml)
                    .map_err(error)?,
                Err(e) => warnings.push(format!(
                    "Metadata saved in the database. NFO write failed: {e}"
                )),
            }
        }
        Ok::<_,HttpError>(Json(serde_json::json!({"entry":entry,"warnings":warnings})))
    })
    .await
    .map_err(|_| HttpError::bad_request("Metadata save interrupted."))??;
    crate::native_sync::changed(&sync_state,&sync_library,&sync_item,changed_fields,None).await;
    Ok(result)
}
pub(crate) async fn apply_panel_artwork(state: AppState, target: String, kind: posterview_contracts::ImageTarget, bytes: Option<Vec<u8>>) -> Result<posterview_contracts::ApplyResult, HttpError> {
    let sync_library = posterview_runtime::native_artwork_target(&target).ok_or_else(HttpError::not_found)?.0.to_string();
    let remove_target = posterview_runtime::native_artwork_target(&target).ok_or_else(HttpError::not_found)?.1.to_string();
    let removed = bytes.is_none();
    let mut removed_kind = match kind { posterview_contracts::ImageTarget::Background=>"backdrop",posterview_contracts::ImageTarget::Logo=>"logo",_=>"poster" };
    let save_state = state.clone();
    let (mut result, saved) = tokio::task::spawn_blocking(move || {
        let state = save_state;
        let (library, item) = posterview_runtime::native_artwork_target(&target).ok_or_else(HttpError::not_found)?;
        let db = store(&state);
        // Replacements are stored as locked manual selections and survive scanner ingestion.
        // Keep deletions blocked until reconciliation completes.
        if bytes.is_none() && db.native_scan_status(library).map_err(error)?.status == "scanning" { return Err(HttpError::bad_request("Wait for the library scan to finish before removing artwork.")); }
        let entry = db.native_catalog(library).map_err(error)?.into_iter().find(|entry| entry.id == item && entry.available).ok_or_else(HttpError::not_found)?;
        let kind = match kind { posterview_contracts::ImageTarget::Background => "backdrop", posterview_contracts::ImageTarget::Logo => "logo", posterview_contracts::ImageTarget::Poster if entry.kind == "episode" => "thumb", _ => "poster" };
        let Some(bytes) = bytes else {
            crate::native_artwork::remove_static(&state,library,&entry,kind).map_err(HttpError::bad_request)?;
            db.remove_native_artwork(library, item, kind).map_err(error)?;
            return Ok((posterview_contracts::ApplyResult {ok:true,message:"Artwork removed from the database. Connected-server deletion will be queued when library sync is enabled.".into()}, None));
        };
        let path = crate::workers::blocking(|| crate::native_provider::store_image(&state, &bytes)).map_err(HttpError::bad_request)?;
        let animated=path.ends_with(".gif")||path.ends_with(".webm");
        let art = posterview_contracts::native::NativeArtwork {kind:if animated{format!("{kind}-animated")}else{kind.into()},path,source:"manual".into()};
        if let Some(previous)=entry.artwork.iter().find(|a|a.kind==kind){let mut previous=previous.clone();previous.kind=if previous.path.ends_with(".gif")||previous.path.ends_with(".webm"){format!("{kind}-animated")}else{format!("{kind}-previous")};db.save_native_artwork(library,item,&previous).map_err(error)?;}
        db.save_native_artwork(library,item,&art).map_err(error)?;
        let config = db.native_libraries().map_err(error)?.into_iter().find(|l|l.id == library).ok_or_else(HttpError::not_found)?;
        let message = if config.options.save_artwork && !animated {
            match crate::native_artwork::write(&state,&entry,&art,true) { Ok(()) => "Artwork saved in the database and media folder.".into(), Err(e) => format!("Artwork saved in the database, but media-folder write failed: {e}") }
        } else { "Artwork saved in the database.".into() };
        Ok((posterview_contracts::ApplyResult {ok:true,message}, Some((entry, art))))
    }).await.map_err(|_|HttpError::bad_request("Artwork save interrupted."))??;
    if let Some((entry, art)) = saved { result.message.push_str(&crate::native_artwork_sync::push(&state, &sync_library, &entry, &art).await); }
    if removed {if removed_kind=="poster" && store(&state).native_catalog(&sync_library).map_err(error)?.iter().any(|entry|entry.id==remove_target&&entry.kind=="episode"){removed_kind="thumb";}result.message.push_str(&crate::native_sync::changed(&state,&sync_library,&remove_target,serde_json::json!({}),Some(removed_kind)).await);}
    Ok(result)
}

pub(crate) async fn upload_artwork(
    State(state): State<AppState>,
    Path((library, item, kind)): Path<(String, String, String)>,
    mut multipart: axum::extract::Multipart,
) -> Result<StatusCode, HttpError> {
    if ![
        "poster",
        "poster-edit-original",
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
    let sync_library=library.clone();
    let save_state = state.clone();
    let (entry, art) = tokio::task::spawn_blocking(move || {
        let state = save_state;
        let db = store(&state);
        let entry = db
            .native_catalog(&library)
            .map_err(error)?
            .into_iter()
            .find(|e| e.id == item)
            .ok_or_else(HttpError::not_found)?;
        let config = db
            .native_libraries()
            .map_err(error)?
            .into_iter()
            .find(|e| e.id == library)
            .ok_or_else(HttpError::not_found)?;
        let path = crate::workers::blocking(|| crate::native_provider::store_image(&state, &bytes))
            .map_err(HttpError::bad_request)?;
        let animated=path.ends_with(".gif")||path.ends_with(".webm");
        let art = posterview_contracts::native::NativeArtwork {
            kind:if animated{format!("{kind}-animated")}else{kind},
            path,
            source: "manual".into(),
        };
        db.save_native_artwork(&library, &item, &art)
            .map_err(error)?;
        if config.options.save_artwork && !animated && art.kind != "poster-edit-original" {
            crate::workers::blocking(|| crate::native_artwork::write(&state, &entry, &art, true))
                .map_err(|e| {
                HttpError::bad_request(format!(
                    "Artwork saved in the database, but media-folder write failed: {e}"
                ))
            })?;
        }
        Ok::<_, HttpError>((entry, art))
    })
    .await
    .map_err(|_| HttpError::bad_request("Artwork save interrupted."))??;
    if art.kind == "poster-edit-original" { return Ok(StatusCode::NO_CONTENT); }
    let result = crate::native_artwork_sync::push(&state, &sync_library, &entry, &art).await;
    if !result.is_empty() { tracing::info!(message=%result, "Manual artwork server synchronization"); }
    Ok(StatusCode::NO_CONTENT)
}
pub(crate) async fn artwork(
    State(state): State<AppState>,
    Path((library, item, kind)): Path<(String, String, String)>,
    axum::extract::Query(options): axum::extract::Query<std::collections::HashMap<String,String>>,
    request_headers: axum::http::HeaderMap,
) -> Result<(StatusCode, axum::http::HeaderMap, Vec<u8>), HttpError> {
    tokio::task::spawn_blocking(move || {
        let art = store(&state)
            .native_artwork(&library, &item, &kind)
            .map_err(error)?
            .ok_or_else(HttpError::not_found)?;
        let path = if let Some(name) = art.path.strip_prefix("@managed/") {
            let (id, ext) = name.rsplit_once('.').ok_or_else(HttpError::not_found)?;
            if uuid::Uuid::parse_str(id).is_err() || !["jpg", "png", "webp", "gif", "webm"].contains(&ext) {
                return Err(HttpError::not_found());
            }
            state.runtime.data_dir().join("native-artwork").join(if options.get("still").is_some_and(|s|s=="1") && ["gif","webm"].contains(&ext) {format!("{id}.still.png")} else {name.to_string()})
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
        // Validate unchanged artwork before reading or processing its contents.
        let modified = metadata.modified().ok().and_then(|time|time.duration_since(std::time::UNIX_EPOCH).ok()).map(|time|time.as_nanos()).unwrap_or_default();
        let mut identity = std::hash::DefaultHasher::new();
        std::hash::Hash::hash(&art.path, &mut identity);
        let tag = format!("W/\"{}-{}-{}-{}\"", std::hash::Hasher::finish(&identity), metadata.len(), modified, options.get("still").is_some_and(|value|value=="1"));
        let etag = axum::http::HeaderValue::from_str(&tag).ok();
        if request_headers.get(axum::http::header::IF_NONE_MATCH).and_then(|value|value.to_str().ok()).is_some_and(|value|value.split(',').any(|candidate|candidate.trim()==tag || candidate.trim()=="*")) {
            if let Some(etag) = etag.clone() {
                let mut headers = axum::http::HeaderMap::new();
                headers.insert(axum::http::header::ETAG, etag);
                headers.insert(axum::http::header::CACHE_CONTROL, axum::http::HeaderValue::from_static("private, max-age=60"));
                return Ok((StatusCode::NOT_MODIFIED, headers, Vec::new()));
            }
        }
        let mut bytes = std::fs::read(&path).map_err(|_| HttpError::not_found())?;
        if !art.path.starts_with("@managed/") && crate::native_animation::is_animated(&bytes) {
            bytes = crate::native_animation::local(&state, &path, &bytes, options.get("still").is_some_and(|s|s=="1")).map_err(HttpError::bad_request)?;
        }
        let mime = if crate::native_animation::is_webm(&bytes) { "video/webm" } else {
        let format =
            image::guess_format(&bytes).map_err(|_| HttpError::bad_request("Invalid artwork."))?;
        match format {
            image::ImageFormat::Jpeg => "image/jpeg",
            image::ImageFormat::Png => "image/png",
            image::ImageFormat::WebP => "image/webp",
            image::ImageFormat::Gif => "image/gif",
            _ => return Err(HttpError::bad_request("Unsupported artwork.")),
        }
        };
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(
            axum::http::header::CONTENT_TYPE,
            axum::http::HeaderValue::from_static(mime),
        );
        headers.insert(
            axum::http::header::CACHE_CONTROL,
            axum::http::HeaderValue::from_static("private, max-age=60"),
        );
        if let Some(etag) = etag { headers.insert(axum::http::header::ETAG, etag); }
        let mut status=StatusCode::OK;
        if mime == "video/webm" {
            headers.insert(axum::http::header::ACCEPT_RANGES, axum::http::HeaderValue::from_static("bytes"));
            if let Some(range)=request_headers.get(axum::http::header::RANGE) {
                let total=bytes.len();
                match range.to_str().ok().and_then(|r|crate::native_animation::byte_range(r,total)) {
                    Some((start,end)) => {
                        status=StatusCode::PARTIAL_CONTENT;
                        headers.insert(axum::http::header::CONTENT_RANGE,format!("bytes {start}-{end}/{total}").parse().unwrap());
                        bytes=bytes[start..=end].to_vec();
                    }
                    None => {
                        status=StatusCode::RANGE_NOT_SATISFIABLE;
                        headers.insert(axum::http::header::CONTENT_RANGE,format!("bytes */{total}").parse().unwrap());
                        bytes.clear();
                    }
                }
            }
        }
        headers.insert(axum::http::header::CONTENT_LENGTH,bytes.len().to_string().parse().unwrap());
        Ok((status, headers, bytes))
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
pub(crate) mod scan_tests {
    use super::*;
    use posterview_contracts::native::{AnimeContent, NativeLibraryOptions, NativeLibraryType};
    use std::{fs, sync::Arc};
    pub(crate) fn state(dir: &std::path::Path) -> AppState {
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
    async fn overlay_only_edits_do_not_rewrite_nfo_or_artwork() {
        let temp = tempfile::tempdir().unwrap();
        let state = state(temp.path());
        let folder = temp.path().join("media/Shows/Example");
        fs::create_dir_all(&folder).unwrap();
        let xml = "<tvshow><title>Example</title><custom>preserve</custom></tvshow>";
        fs::write(folder.join("tvshow.nfo"), xml).unwrap();
        fs::write(folder.join("poster.jpg"), b"original poster").unwrap();
        let db = store(&state);
        let library = db.save_native_library(None, &NativeLibraryInput {
            name: "Shows".into(), library_type: NativeLibraryType::Shows,
            anime_content: AnimeContent::Both, paths: vec!["Shows".into()], revision: None,
            options: NativeLibraryOptions { save_nfo: true, ..Default::default() },
        }).unwrap();
        let entry = posterview_contracts::native::NativeCatalogEntry {
            id: String::new(), path: "Shows/Example".into(), kind: "series".into(), parent_path: None,
            title: "Example".into(), metadata: serde_json::json!({"title":"Example"}),
            artwork: vec![], files: vec![], nfo_path: Some("Shows/Example/tvshow.nfo".into()),
            nfo_xml: None, available: true, revision: 1,
        };
        db.ingest_native_catalog(&library.id, library.revision, &[entry]).unwrap();
        let entry = db.native_catalog(&library.id).unwrap().remove(0);
        let result = edit_item(State(state.clone()), Path((library.id.clone(), entry.id.clone())), Json(EditRequest {
            revision: entry.revision, metadata: serde_json::json!({"posteredit":{"mode":"overlay","x":15},"poseredit":null}),
        })).await.unwrap();
        assert_eq!(result.0["entry"]["metadata"]["posteredit"]["mode"], "overlay");
        let fresh=db.native_catalog(&library.id).unwrap().remove(0);
        let backdrop=edit_item(State(state),Path((library.id.clone(),fresh.id.clone())),Json(EditRequest {
            revision:fresh.revision,metadata:serde_json::json!({"backdropedit":{"x":25,"y":50,"zoom":150,"fit":"cover"}}),
        })).await.unwrap();
        assert_eq!(backdrop.0["entry"]["metadata"]["backdropedit"]["zoom"],150);

        assert_eq!(fs::read_to_string(folder.join("tvshow.nfo")).unwrap(), xml);
        assert_eq!(fs::read(folder.join("poster.jpg")).unwrap(), b"original poster");
        assert_eq!(db.native_catalog(&library.id).unwrap()[0].metadata["posteredit"]["mode"], "overlay");
    }

    #[tokio::test]
    async fn shared_artwork_panel_uses_native_identifiers_and_persists_manual_choices() {
        use posterview_contracts::ImageTarget;
        let temp = tempfile::tempdir().unwrap();
        let state = state(temp.path());
        let media = temp.path().join("media/Shows/Example/Season 01");
        fs::create_dir_all(&media).unwrap();
        fs::write(media.join("Example.S01E01.mkv"), b"fixture").unwrap();
        fs::write(media.parent().unwrap().join("tvshow.nfo"), b"<tvshow><title>Example</title><uniqueid type=\"anilist\">123</uniqueid></tvshow>").unwrap();
        let db = store(&state);
        let library = db.save_native_library(None, &NativeLibraryInput {name:"Shows".into(),library_type:NativeLibraryType::Anime,anime_content:AnimeContent::Both,paths:vec!["Shows".into()],revision:None,options:NativeLibraryOptions {fetch_missing:false,save_artwork:true,..Default::default()}}).unwrap();
        run_scan(state.clone(), library.clone()).await.unwrap();
        let entries = db.native_catalog(&library.id).unwrap();
        let series = entries.iter().find(|e| e.kind == "series").unwrap();
        let target = format!("native:{}:{}",library.id,series.id);
        let detail = state.runtime.get_item_detail(0,&target).await.unwrap().unwrap().unwrap();
        assert_eq!(detail.external_ids["anilist"],"123");
        assert!(detail.seasons[0].id.starts_with(&format!("native:{}:",library.id)));
        assert!(state.runtime.get_item_detail(0,&format!("native:other:{}",series.id)).await.unwrap().is_none());
        assert!(state.runtime.artwork_cache_settings(0).is_ok());
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgba8(2,2).write_to(&mut bytes,image::ImageFormat::Png).unwrap();
        assert!(apply_panel_artwork(state.clone(),target.clone(),ImageTarget::Poster,Some(bytes.get_ref().clone())).await.unwrap().ok);
        let art = db.native_artwork(&library.id,&series.id,"poster").unwrap().unwrap();
        assert_eq!(art.source,"manual");
        let image_path = (library.id.clone(), series.id.clone(), "poster".to_string());
        let (status, headers, image) = artwork(State(state.clone()), Path(image_path.clone()), axum::extract::Query(Default::default()), Default::default()).await.unwrap();
        assert_eq!(status, StatusCode::OK);
        assert!(!image.is_empty());
        let mut conditional = axum::http::HeaderMap::new();
        conditional.insert(axum::http::header::IF_NONE_MATCH, headers[axum::http::header::ETAG].clone());
        let (status, _, image) = artwork(State(state.clone()), Path(image_path.clone()), axum::extract::Query(Default::default()), conditional.clone()).await.unwrap();
        assert_eq!(status, StatusCode::NOT_MODIFIED);
        assert!(image.is_empty());
        apply_panel_artwork(state.clone(),target.clone(),ImageTarget::Poster,Some(bytes.get_ref().clone())).await.unwrap();
        let (status, _, _) = artwork(State(state.clone()), Path(image_path), axum::extract::Query(Default::default()), conditional).await.unwrap();
        assert_eq!(status, StatusCode::OK);
        let art = db.native_artwork(&library.id,&series.id,"poster").unwrap().unwrap();

        assert!(temp.path().join("media/Shows/Example/poster.jpg").exists());
        run_scan(state.clone(),library.clone()).await.unwrap();
        assert_eq!(db.native_artwork(&library.id,&series.id,"poster").unwrap().unwrap().path,art.path);
        assert!(apply_panel_artwork(state.clone(),detail.seasons[0].id.clone(),ImageTarget::Poster,Some(bytes.get_ref().clone())).await.unwrap().ok);
        assert!(temp.path().join("media/Shows/Example/season01-poster.jpg").exists());
        let episode = entries.iter().find(|e|e.kind=="episode").unwrap();
        assert!(apply_panel_artwork(state.clone(),format!("native:{}:{}",library.id,episode.id),ImageTarget::Poster,Some(bytes.into_inner())).await.unwrap().ok);
        assert!(db.native_artwork(&library.id,&episode.id,"thumb").unwrap().is_some());
        assert!(apply_panel_artwork(state.clone(),target.clone(),ImageTarget::Poster,Some(b"invalid".to_vec())).await.is_err());
        db.begin_native_scan(&library.id).unwrap();
        let mut replacement = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgba8(3,3).write_to(&mut replacement,image::ImageFormat::Png).unwrap();
        assert!(apply_panel_artwork(state.clone(),target.clone(),ImageTarget::Poster,Some(replacement.get_ref().clone())).await.unwrap().ok);
        assert!(apply_panel_artwork(state.clone(),detail.seasons[0].id.clone(),ImageTarget::Poster,Some(replacement.get_ref().clone())).await.unwrap().ok);
        let latest = db.native_artwork(&library.id,&series.id,"poster").unwrap().unwrap();
        let season_id = detail.seasons[0].id.split(':').next_back().unwrap();
        let latest_season = db.native_artwork(&library.id,season_id,"poster").unwrap().unwrap();
        assert_ne!(latest.path, art.path);
        // Reconcile a snapshot captured before those replacements.
        db.ingest_native_catalog(&library.id,library.revision,&entries).unwrap();
        assert_eq!(db.native_artwork(&library.id,&series.id,"poster").unwrap().unwrap().path,latest.path);
        assert_eq!(db.native_artwork(&library.id,season_id,"poster").unwrap().unwrap().path,latest_season.path);
        assert!(apply_panel_artwork(state.clone(),target.clone(),ImageTarget::Poster,None).await.is_err());
        db.finish_native_scan(&library.id,&posterview_contracts::native::NativeScanStatus {status:"complete".into(),count:0,warnings:vec![],progress:None}).unwrap();
        assert!(apply_panel_artwork(state,target,ImageTarget::Poster,None).await.unwrap().ok);
        assert!(db.native_artwork(&library.id,&series.id,"poster").unwrap().is_none());
        assert!(!temp.path().join("media/Shows/Example/poster.jpg").exists());
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
    #[test]
    fn scan_progress_updates_during_collection_and_cannot_replace_completed_status() {
        let temp = tempfile::tempdir().unwrap();
        let state = state(temp.path());
        let media = temp.path().join("media/Books/Example");
        fs::create_dir_all(&media).unwrap();
        fs::write(media.join("Volume 1.cbz"), b"fixture").unwrap();
        let db = store(&state);
        let library = db
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
                        ..Default::default()
                    },
                },
            )
            .unwrap();
        db.begin_native_scan(&library.id).unwrap();
        let (entries, _) = crate::native_scan::collect(&state, &library).unwrap();
        let status = db.native_scan_status(&library.id).unwrap();
        assert_eq!(status.status, "scanning");
        assert_eq!(status.count, entries.len());
        let progress = status.progress.as_ref().unwrap();
        assert_eq!(progress.phase, "reading");
        assert_eq!(progress.processed, 1);
        assert_eq!(progress.total, Some(1));
        db.finish_native_scan(
            &library.id,
            &posterview_contracts::native::NativeScanStatus {
                status: "complete".into(),
                count: entries.len(),
                ..Default::default()
            },
        )
        .unwrap();
        db.update_native_scan_progress(&library.id, &status)
            .unwrap();
        assert_eq!(
            db.native_scan_status(&library.id).unwrap().status,
            "complete"
        );
    }
    #[tokio::test]
    async fn saves_encoded_artwork_sidecars_and_reads_them_on_rescan() {
        let temp = tempfile::tempdir().unwrap();
        let state = state(temp.path());
        let media = temp.path().join("media");
        let series = media.join("Shows/Example");
        fs::create_dir_all(series.join("Season 01")).unwrap();
        fs::create_dir_all(series.join("Season 02")).unwrap();
        fs::write(series.join("Season 02/Example.S02E01.mkv"), b"fixture").unwrap();
        fs::write(series.join("Season 01/Example.S01E01.mkv"), b"fixture").unwrap();
        let db = store(&state);
        let library = db
            .save_native_library(
                None,
                &NativeLibraryInput {
                    name: "Shows".into(),
                    library_type: NativeLibraryType::Shows,
                    anime_content: AnimeContent::Both,
                    paths: vec!["Shows".into()],
                    revision: None,
                    options: NativeLibraryOptions {
                        fetch_missing: false,
                        save_artwork: true,
                        ..Default::default()
                    },
                },
            )
            .unwrap();
        run_scan(state.clone(), library.clone()).await.unwrap();
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgba8(2, 2)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        let managed = crate::native_provider::store_image(&state, bytes.get_ref()).unwrap();
        for entry in db.native_catalog(&library.id).unwrap() {
            let kinds: &[&str] = match entry.kind.as_str() {
                "series" => &["poster", "backdrop", "landscape", "logo"],
                "season" => &["poster"],
                "episode" => &["thumb"],
                _ => &[],
            };
            for kind in kinds {
                db.save_native_artwork(
                    &library.id,
                    &entry.id,
                    &posterview_contracts::native::NativeArtwork {
                        kind: (*kind).into(),
                        path: managed.clone(),
                        source: "manual".into(),
                    },
                )
                .unwrap();
            }
        }
        run_scan(state.clone(), library.clone()).await.unwrap();
        for path in [
            "poster.jpg",
            "fanart.jpg",
            "landscape.jpg",
            "season01-poster.jpg",
            "season02-poster.jpg",
            "Season 01/Example.S01E01.jpg",
        ] {
            assert_eq!(
                image::guess_format(&fs::read(series.join(path)).unwrap()).unwrap(),
                image::ImageFormat::Jpeg
            );
        }
        assert_eq!(
            image::guess_format(&fs::read(series.join("clearlogo.png")).unwrap()).unwrap(),
            image::ImageFormat::Png
        );
        let (entries, _) = crate::native_scan::collect(&state, &library).unwrap();
        let season = entries
            .iter()
            .find(|e| e.kind == "season" && e.metadata["season"] == 1)
            .unwrap();
        assert!(
            season
                .artwork
                .iter()
                .any(|a| a.path.ends_with("season01-poster.jpg"))
        );
        let episode = entries.iter().find(|e| e.kind == "episode").unwrap();
        assert!(
            episode
                .artwork
                .iter()
                .any(|a| a.kind == "thumb" && a.path.ends_with("Example.S01E01.jpg"))
        );
        fs::write(series.join("poster.jpg"), b"preserve existing sidecar").unwrap();
        run_scan(state.clone(), library.clone()).await.unwrap();
        assert_eq!(
            fs::read(series.join("poster.jpg")).unwrap(),
            b"preserve existing sidecar"
        );
        let show = db
            .native_catalog(&library.id)
            .unwrap()
            .into_iter()
            .find(|e| e.kind == "series")
            .unwrap();
        let art = show.artwork.iter().find(|a| a.kind == "poster").unwrap();
        crate::native_artwork::write(&state, &show, art, true).unwrap();
        assert_eq!(
            image::guess_format(&fs::read(series.join("poster.jpg")).unwrap()).unwrap(),
            image::ImageFormat::Jpeg
        );
        let modified = fs::metadata(series.join("poster.jpg"))
            .unwrap()
            .modified()
            .unwrap();
        crate::native_artwork::write(&state, &show, art, true).unwrap();
        assert_eq!(
            fs::metadata(series.join("poster.jpg"))
                .unwrap()
                .modified()
                .unwrap(),
            modified
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
        for folder in [
            "backdrops",
            "Backdrops",
            "backdrop",
            "Extras",
            "extra",
            "trailers",
            "featurettes",
            "behind the scenes",
            "deleted scenes",
            "interviews",
        ] {
            let extras = series.parent().unwrap().join(folder);
            fs::create_dir_all(extras.join("nested")).unwrap();
            fs::write(extras.join("NCOP.mp4"), b"fixture").unwrap();
            fs::write(extras.join("nested/NCED.S01E99.mkv"), b"fixture").unwrap();
        }
        for name in [
            "NCOP.mp4",
            "Show - NCED01.mkv",
            "[Group] Show NCOP2v2 [1080p].mkv",
        ] {
            fs::write(series.parent().unwrap().join(name), b"fixture").unwrap();
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
    async fn specials_and_named_season_folders_use_the_parent_series() {
        let temp = tempfile::tempdir().unwrap();
        let state = state(temp.path());
        let show = temp.path().join("media/Anime/Code Geass");
        for (folder, file) in [
            ("Season 1", "Show.S01E01.mkv"),
            ("Specials", "Show.S00E01.mkv"),
            ("Special", "Show - 02.mkv"),
            ("R2", "Show.S02E01.mkv"),
            ("Specials/Tanya Mini", "Show.S00E03.mkv"),
        ] {
            fs::create_dir_all(show.join(folder)).unwrap();
            fs::write(show.join(folder).join(file), b"fixture").unwrap();
        }
        fs::write(show.join("tvshow.nfo"), "<tvshow><title>Code Geass</title><tvdbid>79525</tvdbid><plot>Local plot</plot></tvshow>").unwrap();
        // A sidecar left by the old scanner must not create another Specials show.
        fs::write(
            show.join("Specials/tvshow.nfo"),
            "<tvshow><title>Specials</title><year>1991</year></tvshow>",
        )
        .unwrap();
        let db = store(&state);
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
                        ..Default::default()
                    },
                },
            )
            .unwrap();
        run_scan(state.clone(), library.clone()).await.unwrap();
        let entries = db.native_catalog(&library.id).unwrap();
        let shows = entries
            .iter()
            .filter(|e| e.available && e.kind == "series")
            .collect::<Vec<_>>();
        assert_eq!(shows.len(), 1);
        assert_eq!(shows[0].title, "Code Geass");
        let specials = entries
            .iter()
            .find(|e| e.kind == "season" && e.metadata["season"] == 0)
            .unwrap();
        assert_eq!(specials.title, "Specials");
        assert_eq!(
            specials.parent_path.as_deref(),
            Some(shows[0].path.as_str())
        );
        assert_eq!(
            entries
                .iter()
                .filter(|e| e.kind == "episode"
                    && e.parent_path.as_deref() == Some(specials.path.as_str()))
                .count(),
            3
        );
        assert_eq!(entries.iter().filter(|e| e.kind == "season").count(), 3);
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
    #[tokio::test]
    async fn incremental_mixed_scan_preserves_unrelated_items_and_reconciles_renames() {
        let temp = tempfile::tempdir().unwrap();
        let state = state(temp.path());
        let media = temp.path().join("media/Anime");
        for name in ["ShowA", "ShowB"] {
            let dir = media.join(name);
            fs::create_dir_all(dir.join("Season 1")).unwrap();
            fs::write(
                dir.join("tvshow.nfo"),
                format!("<tvshow><title>{name}</title><plot>Local plot</plot></tvshow>"),
            )
            .unwrap();
            fs::write(dir.join("Season 1/S01E01.mkv"), b"fixture").unwrap();
        }
        let library = store(&state)
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
                        ..Default::default()
                    },
                },
            )
            .unwrap();
        run_scan(state.clone(), library.clone()).await.unwrap();
        let before = store(&state).native_catalog(&library.id).unwrap();
        let untouched = before
            .iter()
            .filter(|e| e.path.starts_with("Anime/ShowB"))
            .cloned()
            .collect::<Vec<_>>();
        // A full scan would parse this changed NFO; a scoped scan must never visit it.
        fs::write(media.join("ShowB/tvshow.nfo"), "<broken>").unwrap();
        fs::write(media.join("ShowA/Season 1/S01E02.mkv"), b"fixture").unwrap();
        fs::create_dir_all(media.join("Movie")).unwrap();
        fs::write(media.join("Movie/Movie.mkv"), b"fixture").unwrap();
        fs::write(
            media.join("Movie/Movie.nfo"),
            "<movie><title>Anime Movie</title><plot>Local movie</plot></movie>",
        )
        .unwrap();
        let status = run_scan_scoped(
            state.clone(),
            library.clone(),
            Some(vec!["Anime/ShowA".into(), "Anime/Movie".into()]),
        )
        .await
        .unwrap();
        let after = store(&state).native_catalog(&library.id).unwrap();
        assert!(
            after
                .iter()
                .any(|e| e.available && e.kind == "episode" && e.path.ends_with("S01E02.mkv"))
        );
        assert!(
            after
                .iter()
                .any(|e| e.available && e.kind == "movie" && e.title == "Anime Movie")
        );
        assert_eq!(status.count, after.iter().filter(|e| e.available).count());
        for old in &untouched {
            let current = after.iter().find(|e| e.id == old.id).unwrap();
            assert!(current.available);
            assert_eq!(current.revision, old.revision);
            assert_eq!(current.metadata, old.metadata);
        }
        assert!(!status.warnings.iter().any(|w| w.contains("ShowB")));
        fs::remove_file(media.join("ShowA/Season 1/S01E01.mkv")).unwrap();
        fs::rename(media.join("ShowA"), media.join("Renamed")).unwrap();
        run_scan_scoped(
            state.clone(),
            library.clone(),
            Some(vec!["Anime/ShowA".into(), "Anime/Renamed".into()]),
        )
        .await
        .unwrap();
        let after = store(&state).native_catalog(&library.id).unwrap();
        assert!(
            after
                .iter()
                .filter(|e| e.path.starts_with("Anime/ShowA/") || e.path == "Anime/ShowA")
                .all(|e| !e.available)
        );
        assert!(
            after
                .iter()
                .any(|e| e.available && e.path == "Anime/Renamed")
        );
        assert!(!after.iter().any(|e| e.available
            && e.path.ends_with("S01E01.mkv")
            && e.path.starts_with("Anime/Renamed")));
        assert!(after.iter().any(|e| e.available && e.kind == "movie"));
        for old in &untouched {
            assert_eq!(
                after.iter().find(|e| e.id == old.id).unwrap().revision,
                old.revision
            );
        }
    }
    #[tokio::test]
    async fn manual_scan_nfo_writes_do_not_restart_monitor_scans() {
        let temp = tempfile::tempdir().unwrap();
        let state = state(temp.path());
        let dir = temp.path().join("media/Movies/Test");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("Test.mkv"), b"fixture").unwrap();
        fs::write(
            dir.join("Test.nfo"),
            "<movie><title>Test</title><plot>Local plot</plot></movie>",
        )
        .unwrap();
        let db = store(&state);
        let library = db
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
                        save_nfo: true,
                        real_time_monitor: true,
                        ..Default::default()
                    },
                },
            )
            .unwrap();
        crate::native_monitor::start(state.clone());
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        start_scan(state.clone(), library.id.clone()).await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while db.native_scan_status(&library.id).unwrap().status == "scanning" {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        })
        .await
        .unwrap();
        let before = db.native_catalog(&library.id).unwrap();
        assert!(!before.is_empty());
        // Covers a polling pass plus debounce after the manual scan's sidecar writes.
        tokio::time::sleep(std::time::Duration::from_secs(22)).await;
        assert_ne!(
            db.native_scan_status(&library.id).unwrap().status,
            "scanning"
        );
        let after = db.native_catalog(&library.id).unwrap();
        for entry in before {
            assert_eq!(
                after.iter().find(|e| e.id == entry.id).unwrap().revision,
                entry.revision
            );
        }
    }
    #[test]
    fn nfo_saves_preserve_actor_portraits_and_existing_actor_details() {
        let temp = tempfile::tempdir().unwrap();
        let state = state(temp.path());
        let dir = temp.path().join("media/Movies/Test");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("Test.mkv"), b"fixture").unwrap();
        fs::write(dir.join("Test.nfo"),"<movie><title>Test</title><actor><name>Actor</name><role>Lead</role><thumb>https://example.com/original.jpg</thumb><custom>keep</custom></actor></movie>").unwrap();
        let mut entry = posterview_contracts::native::NativeCatalogEntry {
            id: String::new(),
            path: "Movies/Test/Test.mkv".into(),
            kind: "movie".into(),
            parent_path: None,
            title: "Test".into(),
            metadata: serde_json::json!({"title":"Test","credits":[{"name":"Actor","role":"Lead","category":"cast"}]}),
            artwork: vec![],
            files: vec![],
            nfo_path: Some("Movies/Test/Test.nfo".into()),
            nfo_xml: None,
            available: true,
            revision: 1,
        };
        let (_, xml) = crate::native_scan::write_nfo(&state, &entry).unwrap();
        assert!(xml.contains("https://example.com/original.jpg"));
        assert!(xml.contains("<custom>keep</custom>"));
        entry.metadata["credits"][0]["image"] =
            serde_json::json!("https://example.com/updated.jpg");
        let (_, xml) = crate::native_scan::write_nfo(&state, &entry).unwrap();
        let (_, metadata) = crate::native_scan::parse_nfo(xml.as_bytes()).unwrap();
        assert_eq!(
            metadata["credits"][0]["image"],
            "https://example.com/updated.jpg"
        );
    }
    #[test]
    fn identification_nfo_replaces_old_ids_and_preserves_unknown_fields(){
        let temp=tempfile::tempdir().unwrap();let state=state(temp.path());let dir=temp.path().join("media/Movies/Test");fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("Test.nfo"),"<movie><uniqueid type='tvdb'>99</uniqueid><tvdbid>99</tvdbid><uniqueid type='custom'>keep</uniqueid><custom>value</custom></movie>").unwrap();
        let entry=posterview_contracts::native::NativeCatalogEntry{id:String::new(),path:"Movies/Test/Test.mkv".into(),kind:"movie".into(),parent_path:None,title:"Correct".into(),metadata:serde_json::json!({"title":"Correct","identifiers":{"tmdb":"12"}}),artwork:vec![],files:vec![],nfo_path:Some("Movies/Test/Test.nfo".into()),nfo_xml:None,available:true,revision:1};
        let (_,xml)=crate::native_scan::write_identification_nfo(&state,&entry).unwrap();let (_,metadata)=crate::native_scan::parse_nfo(xml.as_bytes()).unwrap();assert_eq!(metadata["identifiers"]["tmdb"],"12");assert!(metadata["identifiers"]["tvdb"].is_null());assert!(xml.contains("<custom>value</custom>"));assert!(xml.contains("keep"));
    }

}

pub(crate) async fn remove_variant(State(state):State<AppState>,Path((library,item,kind)):Path<(String,String,String)>)->Result<StatusCode,HttpError>{
 if !kind.ends_with("-animated"){return Err(HttpError::bad_request("Use the artwork panel to remove static artwork."));}
 let base=kind.trim_end_matches("-animated");
 if !["poster","backdrop","logo","banner","thumb","landscape","disc"].contains(&base){return Err(HttpError::bad_request("Unknown artwork type."));}
 store(&state).remove_native_artwork(&library,&item,&kind).map_err(error)?;
 Ok(StatusCode::NO_CONTENT)
}
