//! Bounded manual artwork undo snapshots, separate from the disposable image cache.
use crate::{AppState, HttpError};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::header,
    response::IntoResponse,
    routing::{get, post},
};
use chrono::{DateTime, Duration, Utc};
use posterview_contracts::{ApplyResult, ImageTarget, native::NativeArtwork};
use posterview_infra_sqlite::ServerStore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, OnceLock},
};
use tokio::sync::{Mutex, OwnedMutexGuard};
const KEY: &str = "artwork-history-v1";
const MAX_BYTES: usize = 128 * 1024 * 1024;
fn lock() -> Arc<Mutex<()>> {
    static LOCK: OnceLock<Arc<Mutex<()>>> = OnceLock::new();
    LOCK.get_or_init(|| Arc::new(Mutex::new(()))).clone()
}
tokio::task_local! { static RESTORING: bool; }
tokio::task_local! {static CHANGE_CONTEXT:(Option<String>,String);}
pub(crate) async fn context(
    axum::extract::State(auth): axum::extract::State<crate::AuthState>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let actor = auth.request_user(request.headers()).ok().map(|user| {
        if user.display_name.is_empty() {
            user.username
        } else {
            user.display_name
        }
    });
    let path = request.uri().path();
    let source = if path.ends_with("/restore") {
        "Restore"
    } else if path.contains("/posterdb/") {
        "ThePosterDB"
    } else if path.ends_with("/upload") {
        "Manual upload"
    } else if path.ends_with("/apply") {
        "Artwork provider"
    } else if path.ends_with("/remove") {
        "Removal"
    } else {
        "Manual artwork"
    };
    CHANGE_CONTEXT
        .scope((actor, source.into()), next.run(request))
        .await
}
#[derive(Clone, Serialize, Deserialize)]
struct Asset {
    kind: String,
    file: String,
    content_type: String,
}
#[derive(Clone, Serialize, Deserialize)]
struct Record {
    id: String,
    server_id: i64,
    item_id: String,
    group_id: String,
    title: String,
    item_title: String,
    kind: String,
    created_at: String,
    assets: Vec<Asset>,
    metadata: Option<Value>,
    #[serde(default)]
    actor: Option<String>,
    #[serde(default)]
    source: String,
}
#[derive(Default, Serialize, Deserialize)]
struct Document {
    records: Vec<Record>,
    #[serde(default)]
    groups: HashMap<String, (String, String)>,
    #[serde(default)]
    posters: HashMap<String, String>,
}
#[derive(Serialize)]
pub(crate) struct HistoryEntry {
    pub id: String,
    server_id: i64,
    item_id: String,
    group_id: String,
    title: String,
    item_title: String,
    kind: String,
    created_at: String,
    preview_url: Option<String>,
    has_image: bool,
    adjustments: bool,
    content_type: Option<String>,
    preview_settings: Option<Value>,
    preview_logo_url: Option<String>,
    actor: Option<String>,
    source: String,
}
#[derive(Serialize)]
struct Group {
    server_id: i64,
    group_id: String,
    title: String,
    poster_url: Option<String>,
    count: usize,
    latest_at: String,
}
fn db(state: &AppState) -> ServerStore {
    ServerStore::new(state.runtime.data_dir())
}
fn directory(state: &AppState) -> PathBuf {
    state.runtime.data_dir().join("artwork-history")
}
fn io(error: impl std::fmt::Display) -> HttpError {
    HttpError::bad_request(format!("Artwork history: {error}"))
}
fn load(state: &AppState) -> Result<Document, HttpError> {
    let raw = db(state).get_setting(KEY)?;
    if raw.is_empty() {
        Ok(Document::default())
    } else {
        serde_json::from_str(&raw).map_err(io)
    }
}
fn save(state: &AppState, doc: &Document) -> Result<(), HttpError> {
    db(state).set_setting(KEY, &serde_json::to_string(doc).map_err(io)?)?;
    Ok(())
}
fn live(record: &Record) -> bool {
    DateTime::parse_from_rfc3339(&record.created_at)
        .is_ok_and(|date| date.with_timezone(&Utc) > Utc::now() - Duration::days(7))
}
fn prune(doc: &mut Document) {
    doc.records.retain(live);
    doc.records.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| b.id.cmp(&a.id))
    });
    let mut counts = HashMap::new();
    doc.records.retain(|record| {
        let n = counts
            .entry((record.server_id, record.group_id.clone()))
            .or_insert(0);
        *n += 1;
        *n <= 20
    });
}
fn owned_file(name: &str) -> bool {
    let Some((id, index)) = name
        .strip_suffix(".bin")
        .and_then(|name| name.rsplit_once('-'))
    else {
        return false;
    };
    uuid::Uuid::parse_str(id).is_ok() && index.parse::<usize>().is_ok()
}
fn cleanup_files(state: &AppState, doc: &Document) -> Result<(), HttpError> {
    let root = directory(state);
    let needed: HashSet<_> = doc
        .records
        .iter()
        .flat_map(|r| r.assets.iter().map(|a| a.file.as_str()))
        .collect();
    let entries = match std::fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(io(e)),
    };
    for entry in entries {
        let entry = entry.map_err(io)?;
        let name = entry.file_name().to_string_lossy().to_string();
        if owned_file(&name)
            && !needed.contains(name.as_str())
            && entry.file_type().map_err(io)?.is_file()
        {
            std::fs::remove_file(entry.path()).map_err(io)?;
        }
    }
    Ok(())
}
async fn clean(state: &AppState) -> Result<(), HttpError> {
    let _guard = lock().lock_owned().await;
    let mut doc = load(state)?;
    prune(&mut doc);
    save(state, &doc)?;
    cleanup_files(state, &doc)
}
pub(crate) fn start(state: AppState) {
    tokio::spawn(async move {
        loop {
            if let Err(e) = clean(&state).await {
                tracing::warn!(error=%e.detail,"Artwork history cleanup failed");
            }
            tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
        }
    });
}
fn content_type(bytes: &[u8]) -> String {
    if bytes.starts_with(b"\x1aE\xdf\xa3") {
        "video/webm".into()
    } else {
        image::guess_format(bytes)
            .map(|format| format.to_mime_type().to_string())
            .unwrap_or_else(|_| "application/octet-stream".into())
    }
}
fn read_asset(path: &std::path::Path) -> Result<Vec<u8>, HttpError> {
    let file = std::fs::File::open(path).map_err(io)?;
    if file.metadata().map_err(io)?.len() > MAX_BYTES as u64 {
        return Err(io("Previous artwork exceeds the 128 MB history limit."));
    }
    use std::io::Read;
    let mut bytes = Vec::new();
    file.take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(io)?;
    if bytes.len() > MAX_BYTES {
        return Err(io("Previous artwork exceeds the history limit."));
    }
    Ok(bytes)
}
fn visual(metadata: &Value) -> Value {
    json!({"posteredit":metadata.get("posteredit").cloned().unwrap_or(Value::Null),"poseredit":metadata.get("poseredit").cloned().unwrap_or(Value::Null),"backdropedit":metadata.get("backdropedit").cloned().unwrap_or(Value::Null)})
}
pub(crate) struct Pending {
    record: Option<Record>,
    bytes: Vec<(String, Vec<u8>, String)>,
    _guard: Option<OwnedMutexGuard<()>>,
}
impl Pending {
    fn empty() -> Self {
        Self {
            record: None,
            bytes: vec![],
            _guard: None,
        }
    }
    pub(crate) async fn commit(mut self, state: &AppState) -> Result<(), HttpError> {
        let Some(mut record) = self.record.take() else {
            return Ok(());
        };
        let root = directory(state);
        std::fs::create_dir_all(&root).map_err(io)?;
        for (index, (kind, bytes, mime)) in self.bytes.into_iter().enumerate() {
            let file = format!("{}-{index}.bin", record.id);
            std::fs::write(root.join(&file), bytes).map_err(io)?;
            record.assets.push(Asset {
                kind,
                file,
                content_type: mime,
            });
        }
        let mut doc = load(state)?;
        doc.records.insert(0, record);
        prune(&mut doc);
        save(state, &doc)?;
        cleanup_files(state, &doc)?;
        Ok(())
    }
}
fn suppressed() -> bool {
    RESTORING.try_with(|value| *value).unwrap_or(false)
}
fn record(
    server_id: i64,
    item_id: String,
    group_id: String,
    title: String,
    item_title: String,
    kind: String,
    metadata: Option<Value>,
) -> Record {
    Record {
        id: uuid::Uuid::new_v4().to_string(),
        server_id,
        item_id,
        group_id,
        title,
        item_title,
        kind,
        created_at: Utc::now().to_rfc3339(),
        assets: vec![],
        metadata,
        actor: CHANGE_CONTEXT
            .try_with(|ctx| ctx.0.clone())
            .unwrap_or_default(),
        source: CHANGE_CONTEXT
            .try_with(|ctx| ctx.1.clone())
            .unwrap_or_else(|_| "Manual artwork".into()),
    }
}
pub(crate) async fn capture_native(
    state: &AppState,
    library: &str,
    item: &str,
    kind: &str,
) -> Result<Pending, HttpError> {
    if suppressed() {
        return Ok(Pending::empty());
    }
    let guard = lock().lock_owned().await;
    let store = db(state);
    let entry = store
        .native_catalog_item(library, item)?
        .ok_or_else(HttpError::not_found)?;
    let mut group = entry.clone();
    let mut seen = HashSet::new();
    while let Some(parent) = group.parent_path.clone() {
        if !seen.insert(parent.clone()) {
            break;
        }
        let Some(ancestor) = store.native_catalog_path(library, &parent)? else {
            break;
        };
        group = ancestor;
        if matches!(group.kind.as_str(), "series" | "book_series") {
            break;
        }
    }
    let mut bytes = vec![];
    for art in &entry.artwork {
        if art.kind == kind
            || art.kind == format!("{kind}-animated")
            || kind == "poster"
                && art.kind == "logo"
                && entry.metadata["posteredit"]["enabled"] == true
            || kind == "adjustments"
                && matches!(
                    art.kind.as_str(),
                    "poster" | "backdrop" | "logo" | "poster-edit-original"
                )
        {
            let data = read_asset(&crate::native::artwork_source(state, art, false)?)?;
            let mime = content_type(&data);
            bytes.push((art.kind.clone(), data, mime));
        }
    }
    if bytes.iter().map(|(_, b, _)| b.len()).sum::<usize>() > MAX_BYTES {
        return Err(io("Previous artwork exceeds the 128 MB history limit."));
    }
    Ok(Pending {
        record: Some(record(
            0,
            format!("native:{library}:{item}"),
            format!("native:{library}:{}", group.id),
            group.title,
            entry.title,
            kind.into(),
            Some(visual(&entry.metadata)),
        )),
        bytes,
        _guard: Some(guard),
    })
}
pub(crate) async fn capture_collection(
    state: &AppState,
    id: &str,
    kind: &str,
) -> Result<Pending, HttpError> {
    if suppressed() {
        return Ok(Pending::empty());
    }
    let guard = lock().lock_owned().await;
    let item = db(state).collection(id)?.ok_or_else(HttpError::not_found)?;
    let url = if kind == "poster" {
        item.metadata.poster_url
    } else {
        item.metadata.backdrop_url
    };
    let mut bytes = vec![];
    if !url.is_empty() {
        let file = url.rsplit('/').next().ok_or_else(HttpError::not_found)?;
        if uuid::Uuid::parse_str(file.trim_end_matches(".webp")).is_err() {
            return Err(io(
                "Existing collection artwork is not a local managed image.",
            ));
        }
        let data = read_asset(
            &state
                .runtime
                .data_dir()
                .join("collection-artwork")
                .join(file),
        )?;
        bytes.push((kind.into(), data, "image/webp".into()));
    }
    let target = format!("collection:{id}");
    Ok(Pending {
        record: Some(record(
            0,
            target.clone(),
            target,
            item.title.clone(),
            item.title,
            kind.into(),
            None,
        )),
        bytes,
        _guard: Some(guard),
    })
}
fn context_key(server: i64, item: &str) -> String {
    format!("{server}:{item}")
}
pub(crate) async fn capture_connected(
    state: &AppState,
    server: i64,
    item: &str,
    kind: &str,
) -> Result<Pending, HttpError> {
    if suppressed() {
        return Ok(Pending::empty());
    }
    let guard = lock().lock_owned().await;
    let detail = state
        .runtime
        .get_item_detail(server, item)
        .await?
        .ok_or_else(HttpError::not_found)?
        .map_err(io)?;
    let doc = load(state)?;
    let (group, title) = doc
        .groups
        .get(&context_key(server, item))
        .cloned()
        .unwrap_or_else(|| (item.into(), detail.title.clone()));
    let reference = match kind {
        "poster" => detail.poster,
        "backdrop" => detail.background,
        "logo" => detail.logo,
        "landscape" | "banner" => {
            let server_record = db(state)
                .get_server(server)?
                .ok_or_else(HttpError::not_found)?;
            if server_record.server_type == posterview_contracts::ServerType::Plex {
                return Ok(Pending::empty());
            }
            Some(format!(
                "Items/{item}/Images/{}",
                if kind == "banner" { "Banner" } else { "Thumb" }
            ))
        }
        _ => return Err(io("Unsupported artwork type.")),
    };
    let mut bytes = vec![];
    if let Some(reference) = reference.filter(|r| !r.is_empty()) {
        let fetched = state
            .runtime
            .fetch_image(server, &reference)
            .await?
            .ok_or_else(HttpError::not_found)?;
        let (data, mime) = match fetched {
            Ok(image) => image,
            Err(error) if matches!(kind, "landscape" | "banner") && error.contains("404") => {
                return Ok(Pending {
                    record: Some(record(
                        server,
                        item.into(),
                        group,
                        title,
                        detail.title,
                        kind.into(),
                        None,
                    )),
                    bytes: vec![],
                    _guard: Some(guard),
                });
            }
            Err(error) => return Err(io(error)),
        };
        if data.len() > MAX_BYTES {
            return Err(io("Previous artwork exceeds the 128 MB history limit."));
        }
        bytes.push((kind.into(), data, mime));
    }
    Ok(Pending {
        record: Some(record(
            server,
            item.into(),
            group,
            title,
            detail.title,
            kind.into(),
            None,
        )),
        bytes,
        _guard: Some(guard),
    })
}
fn preview_asset(r: &Record) -> Option<&Asset> {
    r.assets
        .iter()
        .find(|a| a.kind == r.kind || r.kind == "adjustments" && a.kind == "poster")
        .or_else(|| r.assets.first())
}
fn entry(r: &Record) -> HistoryEntry {
    HistoryEntry {
        id: r.id.clone(),
        server_id: r.server_id,
        item_id: r.item_id.clone(),
        group_id: r.group_id.clone(),
        title: r.title.clone(),
        item_title: r.item_title.clone(),
        kind: r.kind.clone(),
        created_at: r.created_at.clone(),
        preview_url: (!r.assets.is_empty()).then(|| format!("/api/artwork/history/{}/image", r.id)),
        has_image: !r.assets.is_empty(),
        adjustments: r.kind == "adjustments",
        actor: r.actor.clone(),
        source: if r.kind == "adjustments" {
            "Saved adjustments".into()
        } else {
            r.source.clone()
        },
        content_type: preview_asset(r).map(|a| a.content_type.clone()),
        preview_settings: r.metadata.as_ref().map(|metadata| {
            let mut value = metadata.clone();
            for key in ["posteredit", "poseredit"] {
                if let Some(obj) = value.get_mut(key).and_then(Value::as_object_mut) {
                    obj.remove("poster_path");
                }
            }
            if let Some(logo) = value
                .get_mut("backdropedit")
                .and_then(|v| v.get_mut("logo"))
                .and_then(Value::as_object_mut)
            {
                logo.remove("src");
            }
            if r.kind == "backdrop" {
                if let Some(obj) = value.as_object_mut() {
                    obj.remove("posteredit");
                    obj.remove("poseredit");
                }
            } else if let Some(obj) = value.as_object_mut() {
                obj.remove("backdropedit");
            }
            value
        }),
        preview_logo_url: r
            .assets
            .iter()
            .any(|a| a.kind == "logo")
            .then(|| format!("/api/artwork/history/{}/image?asset=logo", r.id)),
    }
}
pub(crate) async fn records_for(
    state: &AppState,
    server: i64,
    item: &str,
) -> Result<Vec<HistoryEntry>, HttpError> {
    let _guard = lock().lock_owned().await;
    let mut doc = load(state)?;
    let group = if server == 0 {
        if let Some((library, id)) = posterview_runtime::native_artwork_target(item) {
            let mut e = db(state)
                .native_catalog_item(library, id)?
                .ok_or_else(HttpError::not_found)?;
            let mut seen = HashSet::new();
            while let Some(parent) = e.parent_path.clone() {
                if !seen.insert(parent.clone()) {
                    break;
                }
                let Some(p) = db(state).native_catalog_path(library, &parent)? else {
                    break;
                };
                e = p;
                if matches!(e.kind.as_str(), "series" | "book_series") {
                    break;
                }
            }
            format!("native:{library}:{}", e.id)
        } else {
            item.into()
        }
    } else {
        let detail = state
            .runtime
            .get_item_detail(server, item)
            .await?
            .ok_or_else(HttpError::not_found)?
            .map_err(io)?;
        if let Some(poster) = &detail.poster {
            let mut url = reqwest::Url::parse(&format!("http://local/api/servers/{server}/image"))
                .map_err(io)?;
            url.query_pairs_mut().append_pair("ref", poster);
            doc.posters.insert(
                context_key(server, item),
                format!("{}?{}", url.path(), url.query().unwrap_or_default()),
            );
        }
        if !detail.seasons.is_empty() {
            for season in detail.seasons {
                doc.groups.insert(
                    context_key(server, &season.id),
                    (item.into(), detail.title.clone()),
                );
                for r in &mut doc.records {
                    if r.server_id == server && r.item_id == season.id {
                        r.group_id = item.into();
                        r.title = detail.title.clone();
                    }
                }
            }
        }
        doc.groups
            .get(&context_key(server, item))
            .map(|g| g.0.clone())
            .unwrap_or_else(|| item.into())
    };
    prune(&mut doc);
    save(state, &doc)?;
    cleanup_files(state, &doc)?;
    Ok(doc
        .records
        .iter()
        .filter(|r| r.server_id == server && r.group_id == group)
        .map(entry)
        .collect())
}
#[derive(Deserialize)]
struct Lookup {
    server_id: i64,
    item_id: String,
}
async fn list(
    State(state): State<AppState>,
    Query(q): Query<Lookup>,
) -> Result<Json<Vec<HistoryEntry>>, HttpError> {
    Ok(Json(records_for(&state, q.server_id, &q.item_id).await?))
}
async fn groups(State(state): State<AppState>) -> Result<Json<Vec<Group>>, HttpError> {
    let _guard = lock().lock_owned().await;
    let mut doc = load(&state)?;
    prune(&mut doc);
    save(&state, &doc)?;
    cleanup_files(&state, &doc)?;
    let mut groups: Vec<Group> = vec![];
    for r in &doc.records {
        if let Some(group) = groups
            .iter_mut()
            .find(|g| g.server_id == r.server_id && g.group_id == r.group_id)
        {
            group.count += 1;
        } else {
            groups.push(Group {
                server_id: r.server_id,
                group_id: r.group_id.clone(),
                title: r.title.clone(),
                poster_url: doc
                    .posters
                    .get(&context_key(r.server_id, &r.group_id))
                    .cloned(),
                count: 1,
                latest_at: r.created_at.clone(),
            });
        }
    }
    for group in &mut groups {
        if group.server_id == 0
            && let Some((library, id)) = posterview_runtime::native_artwork_target(&group.group_id)
            && let Some(item) = db(&state).native_catalog_item(library, id)?
            && item.artwork.iter().any(|a| a.kind == "poster")
        {
            group.poster_url = Some(format!(
                "/api/native/libraries/{library}/items/{id}/artwork/poster"
            ));
        }
        if group.poster_url.is_none() {
            group.poster_url = doc
                .records
                .iter()
                .find(|r| {
                    r.server_id == group.server_id
                        && r.group_id == group.group_id
                        && !r.assets.is_empty()
                })
                .map(|r| format!("/api/artwork/history/{}/image", r.id));
        }
    }
    Ok(Json(groups))
}
fn find(state: &AppState, id: &str) -> Result<Record, HttpError> {
    load(state)?
        .records
        .into_iter()
        .find(|r| r.id == id && live(r))
        .ok_or_else(HttpError::not_found)
}
#[derive(Default, Deserialize)]
struct ImageQuery {
    asset: Option<String>,
}
async fn image(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<ImageQuery>,
) -> Result<impl IntoResponse, HttpError> {
    let _guard = lock().lock_owned().await;
    let record = find(&state, &id)?;
    let asset = if let Some(kind) = query.asset {
        record.assets.iter().find(|a| a.kind == kind)
    } else {
        record.assets.first()
    }
    .ok_or_else(HttpError::not_found)?;
    if !owned_file(&asset.file) {
        return Err(HttpError::not_found());
    }
    let data = read_asset(&directory(&state).join(&asset.file))?;
    Ok((
        [
            (header::CONTENT_TYPE, asset.content_type.clone()),
            (header::CACHE_CONTROL, "private, no-store".into()),
        ],
        data,
    ))
}
fn target(kind: &str) -> Result<ImageTarget, HttpError> {
    match kind {
        "poster" | "thumb" => Ok(ImageTarget::Poster),
        "backdrop" => Ok(ImageTarget::Background),
        "logo" => Ok(ImageTarget::Logo),
        "landscape" => Ok(ImageTarget::Landscape),
        "banner" => Ok(ImageTarget::Banner),
        _ => Err(io("Unsupported artwork type.")),
    }
}
async fn restore(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<ApplyResult>, HttpError> {
    let record = {
        let _guard = lock().lock_owned().await;
        find(&state, &id)?
    };
    let pending = if record.server_id == 0 {
        if let Some((library, item)) = posterview_runtime::native_artwork_target(&record.item_id) {
            capture_native(&state, library, item, &record.kind).await?
        } else {
            capture_collection(
                &state,
                record
                    .item_id
                    .strip_prefix("collection:")
                    .ok_or_else(HttpError::not_found)?,
                &record.kind,
            )
            .await?
        }
    } else {
        capture_connected(&state, record.server_id, &record.item_id, &record.kind).await?
    };
    let mut assets = vec![];
    for asset in &record.assets {
        if !owned_file(&asset.file) {
            return Err(HttpError::not_found());
        }
        assets.push((
            asset.clone(),
            read_asset(&directory(&state).join(&asset.file))?,
        ));
    }
    RESTORING
        .scope(true, async {
            if record.server_id == 0 {
                if let Some((library, item)) =
                    posterview_runtime::native_artwork_target(&record.item_id)
                {
                    let store = db(&state);
                    let current = store
                        .native_catalog_item(library, item)?
                        .ok_or_else(HttpError::not_found)?;
                    // Validate and stage every immutable image before changing catalog pointers.
                    let staged = assets
                        .iter()
                        .map(|(asset, data)| {
                            Ok(NativeArtwork {
                                kind: asset.kind.clone(),
                                path: crate::native_provider::store_image(&state, data)
                                    .map_err(io)?,
                                source: "manual".into(),
                            })
                        })
                        .collect::<Result<Vec<_>, HttpError>>()?;
                    if record.kind != "adjustments"
                        && !record.kind.ends_with("-animated")
                        && !record.kind.ends_with("-edit-original")
                    {
                        crate::native_artwork::remove_static(
                            &state,
                            library,
                            &current,
                            &record.kind,
                        )
                        .map_err(io)?;
                    }
                    if record.kind != "adjustments" || !assets.is_empty() {
                        for art in &current.artwork {
                            if art.kind == record.kind
                                || art.kind == format!("{}-animated", record.kind)
                                || record.kind == "adjustments"
                                    && matches!(
                                        art.kind.as_str(),
                                        "poster" | "backdrop" | "logo" | "poster-edit-original"
                                    )
                            {
                                store.remove_native_artwork(library, item, &art.kind)?;
                            }
                        }
                        for artwork in staged {
                            store.save_native_artwork(library, item, &artwork)?;
                            if !artwork.kind.ends_with("-animated")
                                && artwork.kind != "poster-edit-original"
                                && store
                                    .native_libraries()?
                                    .iter()
                                    .any(|l| l.id == library && l.options.save_artwork)
                            {
                                crate::native_artwork::write(&state, &current, &artwork, true)
                                    .map_err(io)?;
                            }
                        }
                    }
                    if let Some(metadata) = &record.metadata {
                        let fresh = store
                            .native_catalog_item(library, item)?
                            .ok_or_else(HttpError::not_found)?;
                        let mut metadata = metadata.clone();
                        if let Some(poster) = fresh.artwork.iter().find(|a| a.kind == "poster") {
                            for key in ["posteredit", "poseredit"] {
                                if let Some(settings) =
                                    metadata.get_mut(key).and_then(Value::as_object_mut)
                                    && settings.contains_key("poster_path")
                                {
                                    settings.insert(
                                        "poster_path".into(),
                                        Value::String(poster.path.clone()),
                                    );
                                }
                            }
                        }
                        store.edit_native_entry(library, item, fresh.revision, &metadata)?;
                    }
                } else {
                    let bytes = assets.first().map(|(_, bytes)| bytes.clone());
                    crate::collections::apply_panel_artwork(
                        state.clone(),
                        record.item_id.clone(),
                        target(&record.kind)?,
                        bytes,
                    )
                    .await?;
                }
            } else {
                let result = if let Some((asset, bytes)) = assets.first() {
                    state
                        .runtime
                        .apply_image(
                            record.server_id,
                            &record.item_id,
                            &target(&record.kind)?,
                            bytes,
                            &asset.content_type,
                            "history",
                            &record.item_title,
                        )
                        .await?
                } else {
                    state
                        .runtime
                        .remove_image(record.server_id, &record.item_id, &target(&record.kind)?)
                        .await?
                };
                if !result.is_some_and(|r| r.ok) {
                    return Err(io("The media server did not restore this artwork."));
                }
            }
            Ok::<(), HttpError>(())
        })
        .await?;
    pending.commit(&state).await?;
    crate::spawn_backdrop_refresh(&state);
    crate::native_artwork_jobs::request(&state);
    Ok(Json(ApplyResult {
        ok: true,
        message: "Previous artwork restored. This change can also be restored from History.".into(),
    }))
}
#[cfg(test)]
pub(crate) async fn restore_for(state: &AppState, id: &str) -> Result<ApplyResult, HttpError> {
    Ok(restore(State(state.clone()), Path(id.into())).await?.0)
}
pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/artwork/history", get(list))
        .route("/api/artwork/history/groups", get(groups))
        .route("/api/artwork/history/{id}/image", get(image))
        .route("/api/artwork/history/{id}/restore", post(restore))
}

#[cfg(test)]
mod tests;
