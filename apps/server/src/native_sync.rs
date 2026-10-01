use crate::{AppState, HttpError};
use axum::{
    Json,
    extract::{Path, State},
};
use posterview_contracts::native::{NativeArtwork, NativeCatalogEntry, NativeLibrary};
use posterview_infra_media_servers::{
    ConnectionConfig, remove_image, select_artwork_item, set_image, sync_image, sync_item,
    sync_library_items, sync_update_item,
};
use posterview_infra_sqlite::ServerStore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub const FIELDS: &[(&str, &str)] = &[
    ("title", "Name"),
    ("originaltitle", "OriginalTitle"),
    ("sorttitle", "SortName"),
    ("year", "ProductionYear"),
    ("plot", "Overview"),
    ("tagline", "Taglines"),
    ("rating", "CommunityRating"),
    ("mpaa", "OfficialRating"),
    ("premiered", "PremiereDate"),
    ("status", "Status"),
    ("genres", "Genres"),
    ("tags", "Tags"),
    ("studios", "Studios"),
    ("identifiers", "ProviderIds"),
    ("credits", "People"),
    ("season", "ParentIndexNumber"),
    ("episode", "IndexNumber"),
    ("runtime", "RunTimeTicks"),
];
const ART: &[(&str, &str)] = &[
    ("poster", "Primary"),
    ("backdrop", "Backdrop"),
    ("logo", "Logo"),
    ("banner", "Banner"),
    ("landscape", "Thumb"),
    ("disc", "Disc"),
];
static RUN_LOCK: std::sync::LazyLock<tokio::sync::Mutex<()>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(()));
static QUEUE_LOCK: std::sync::LazyLock<tokio::sync::Mutex<()>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(()));
#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(default)]
struct ItemState {
    remote: String,
    metadata: Value,
    tags: Value,
    history: Vec<Value>,
}
#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(default)]
struct SyncState {
    partner: String,
    items: BTreeMap<String, ItemState>,
    pending: BTreeMap<String, Value>,
    mirrors: BTreeMap<String, BTreeMap<String, Value>>,
    mirror_links: BTreeMap<String, String>,
    status: String,
    last_success: Option<String>,
    matched: usize,
    unmatched: usize,
    failed: usize,
    notices: Vec<String>,
    activity: Vec<String>,
}
#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Request {
    fields: Option<Vec<String>>,
    override_locked: Option<bool>,
    write_nfo: Option<bool>,
    recover: bool,
}
fn db(state: &AppState) -> ServerStore {
    ServerStore::new(state.runtime.data_dir())
}
fn key(library: &str) -> String {
    format!("native-server-sync:{library}")
}
fn load(state: &AppState, library: &str) -> Result<SyncState, String> {
    let data = db(state)
        .get_setting(&key(library))
        .map_err(|e| e.to_string())?;
    let mut value: SyncState = if data.is_empty() {
        SyncState::default()
    } else {
        serde_json::from_str(&data).map_err(|_| "Invalid saved sync state.")?
    };
    let queue = db(state)
        .get_setting(&format!("native-sync-queue:{library}"))
        .map_err(|e| e.to_string())?;
    if !queue.is_empty() {
        let queue: Value =
            serde_json::from_str(&queue).map_err(|_| "Invalid pending sync queue.")?;
        value.pending = serde_json::from_value(queue["pending"].clone())
            .map_err(|_| "Invalid pending edits.")?;
        value.mirrors = serde_json::from_value(queue["mirrors"].clone())
            .map_err(|_| "Invalid pending destinations.")?;
    }
    Ok(value)
}
fn save_queue(state: &AppState, library: &str, value: &SyncState) -> Result<(), String> {
    db(state)
        .set_setting(
            &format!("native-sync-queue:{library}"),
            &json!({"pending":value.pending,"mirrors":value.mirrors}).to_string(),
        )
        .map_err(|e| e.to_string())
}
async fn acknowledge(
    state: &AppState,
    library: &str,
    item: &str,
    expected: &Value,
    destination: Option<&str>,
) -> Result<(), String> {
    let _guard = QUEUE_LOCK.lock().await;
    let mut value = load(state, library)?;
    let pending = if let Some(server) = destination {
        value.mirrors.entry(server.into()).or_default()
    } else {
        &mut value.pending
    };
    if pending.get(item) == Some(expected) {
        pending.remove(item);
    }
    save_queue(state, library, &value)
}
/// Propagate accepted source values without replacing a newer local edit queued concurrently.
async fn mirror_accepted(
    state: &AppState,
    lib: &NativeLibrary,
    item: &str,
    fields: &Value,
    art: &Value,
    expected: Option<&Value>,
) -> Result<(), String> {
    let _guard = QUEUE_LOCK.lock().await;
    let mut queue = load(state, &lib.id)?;
    if queue
        .pending
        .get(item)
        .is_some_and(|current| Some(current) != expected)
    {
        return Ok(());
    }
    for server in state
        .runtime
        .list_servers()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|s| {
            Some(s.id) != lib.options.server_sync.server_id
                && (lib.options.server_sync.push_to_all
                    || lib.options.server_sync.push_server_ids.contains(&s.id))
        })
    {
        let change = queue
            .mirrors
            .entry(server.id.to_string())
            .or_default()
            .entry(item.into())
            .or_insert_with(|| json!({"fields":{},"art":{}}));
        for (field, value) in fields.as_object().into_iter().flatten() {
            change["fields"][field] = value.clone();
        }
        for (kind, _) in art.as_object().into_iter().flatten() {
            change["art"][kind] = json!(true);
        }
    }
    save_queue(state, &lib.id, &queue)
}
fn save(state: &AppState, library: &str, value: &SyncState) -> Result<(), String> {
    db(state)
        .set_setting(
            &key(library),
            &serde_json::to_string(value).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())
}
fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}
fn active(state: &AppState, library: &str) -> Option<NativeLibrary> {
    db(state)
        .native_libraries()
        .ok()?
        .into_iter()
        .find(|l| l.id == library && l.options.server_sync.enabled)
}
fn source_library(lib: &NativeLibrary) -> &str {
    if lib.options.server_sync.library_id == "*" {
        ""
    } else {
        &lib.options.server_sync.library_id
    }
}
fn partner(lib: &NativeLibrary) -> String {
    format!(
        "{}:{}",
        lib.options.server_sync.server_id.unwrap_or_default(),
        lib.options.server_sync.library_id
    )
}
fn note(value: &mut SyncState, message: String) {
    value.activity.insert(0, format!("{} {message}", now()));
    value.activity.truncate(50);
}

pub(crate) async fn status(
    State(state): State<AppState>,
    Path(library): Path<String>,
) -> Result<Json<Value>, HttpError> {
    let libraries = db(&state)
        .native_libraries()
        .map_err(|e| HttpError::bad_request(e.to_string()))?;
    let lib = libraries
        .iter()
        .find(|l| l.id == library)
        .ok_or_else(HttpError::not_found)?;
    let value = load(&state, &library).map_err(HttpError::bad_request)?;
    Ok(Json(
        json!({"enabled":lib.options.server_sync.enabled,"status":value.status,"last_success":value.last_success,"pending":value.pending.len()+value.mirrors.values().map(|v|v.len()).sum::<usize>(),"linked_items":value.items.iter().map(|(item,value)|json!({"item":item,"server_item":value.remote})).collect::<Vec<_>>(),"matched":value.matched,"unmatched":value.unmatched,"failed":value.failed,"notices":value.notices,"activity":value.activity}),
    ))
}
pub(crate) async fn run(
    State(state): State<AppState>,
    Path(library): Path<String>,
    Json(request): Json<Request>,
) -> Result<Json<Value>, HttpError> {
    if request.fields.as_ref().is_some_and(|fields| {
        fields
            .iter()
            .any(|field| !FIELDS.iter().any(|(key, _)| key == field))
    }) {
        return Err(HttpError::bad_request("Unknown import field."));
    }
    if active(&state, &library).is_none() {
        return Err(HttpError::bad_request(
            "Enable a connected server and library in library settings first.",
        ));
    }
    // Persist an import request; work runs off the HTTP request and survives restarts.
    let _guard = QUEUE_LOCK.lock().await;
    db(&state).set_setting(&format!("native-server-import:{library}"),&serde_json::to_string(&json!({"fields":request.fields,"override_locked":request.override_locked,"write_nfo":request.write_nfo,"recover":request.recover})).unwrap()).map_err(|e|HttpError::bad_request(e.to_string()))?;
    let mut value = load(&state, &library).map_err(HttpError::bad_request)?;
    value.status = "queued".into();
    save(&state, &library, &value).map_err(HttpError::bad_request)?;
    drop(_guard);
    let copy = state.clone();
    tokio::spawn(async move {
        if let Err(e) = reconcile(&copy, &library).await {
            tracing::warn!(%e,"Requested server sync failed");
        }
    });
    Ok(Json(json!({"status":"queued"})))
}

/// Queue exact local field/artwork changes durably. Scans never create outgoing edits.
pub(crate) async fn changed(
    state: &AppState,
    library: &str,
    item: &str,
    fields: Value,
    art: Option<&str>,
) -> String {
    let Some(lib) = active(state, library) else {
        return String::new();
    };
    if art.is_some_and(|kind| kind.ends_with("-animated"))
        || (art.is_none()
            && !fields.as_object().is_some_and(|values| {
                values
                    .keys()
                    .any(|field| FIELDS.iter().any(|(name, _)| name == field))
            }))
    {
        return String::new();
    }
    let _guard = QUEUE_LOCK.lock().await;
    let mut value = match load(state, library) {
        Ok(value) => value,
        Err(e) => return format!(" Sync queue failed: {e}"),
    };
    if value.partner != partner(&lib) {
        value = SyncState {
            partner: partner(&lib),
            ..Default::default()
        };
    }
    let pending = value
        .pending
        .entry(item.into())
        .or_insert_with(|| json!({"fields":{},"art":{},"created":now()}));
    for (field, v) in fields.as_object().into_iter().flatten() {
        if FIELDS.iter().any(|(name, _)| name == field) {
            pending["fields"][field] = v.clone();
        }
    }
    if let Some(kind) = art {
        if kind.ends_with("-animated") {
            return String::new();
        }
        pending["art"][kind] = json!(true);
    }
    pending["updated"] = json!(now());
    let mirror = pending.clone();
    for server in state
        .runtime
        .list_servers()
        .unwrap_or_default()
        .into_iter()
        .filter(|s| {
            Some(s.id) != lib.options.server_sync.server_id
                && (lib.options.server_sync.push_to_all
                    || lib.options.server_sync.push_server_ids.contains(&s.id))
        })
    {
        let previous = value
            .mirrors
            .entry(server.id.to_string())
            .or_default()
            .entry(item.into())
            .or_insert_with(|| json!({"fields":{},"art":{}}));
        for section in ["fields", "art"] {
            for (key, v) in mirror[section].as_object().into_iter().flatten() {
                previous[section][key] = v.clone();
            }
        }
    }

    value.status = "pending".into();
    if let Err(e) = save_queue(state, library, &value).and_then(|_| save(state, library, &value)) {
        return format!(" Sync queue failed: {e}");
    }
    drop(_guard);
    let copy = state.clone();
    let library = library.to_string();
    tokio::spawn(async move {
        if let Err(e) = reconcile(&copy, &library).await {
            tracing::warn!(%e,"Outgoing server sync pending retry");
        }
    });
    " Connected-server update queued; status is shown in library settings.".into()
}

pub(crate) fn start(state: AppState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
        loop {
            interval.tick().await;
            let libraries = db(&state).native_libraries().unwrap_or_default();
            for lib in libraries
                .into_iter()
                .filter(|l| l.options.server_sync.enabled)
            {
                if let Err(error) = reconcile(&state, &lib.id).await {
                    if let Ok(mut value) = load(&state, &lib.id) {
                        value.status = "unavailable".into();
                        value.notices = vec![error];
                        let _ = save(&state, &lib.id, &value);
                    }
                }
            }
        }
    });
}

fn shared(remote: &Value, kind: &str) -> Value {
    let mut result = json!({});
    for (field, key) in FIELDS {
        if *field == "episode" && kind != "episode" {
            continue;
        }
        let key = if *field == "season" && kind == "season" {
            "IndexNumber"
        } else {
            *key
        };
        let Some(v) = remote.get(key) else {
            continue;
        };
        let v=match *field{
   "identifiers"=>Value::Object(v.as_object().into_iter().flatten().map(|(k,v)|(k.to_ascii_lowercase(),v.clone())).collect()),
   "studios"=>json!(v.as_array().into_iter().flatten().filter_map(|v|v["Name"].as_str()).collect::<Vec<_>>()),
   "credits"=>json!(v.as_array().into_iter().flatten().filter_map(|p|Some(json!({"name":p["Name"].as_str()?,"role":p["Role"],"category":if p["Type"]=="Actor"{"cast"}else{"crew"},"type":p["Type"],"provider":"server","server_person_id":p["Id"]}))).collect::<Vec<_>>()),
   "runtime"=>v.as_i64().map(|ticks|json!(ticks/600_000_000)).unwrap_or(Value::Null),
   "tagline"=>v.as_array().and_then(|v|v.first()).cloned().unwrap_or(json!("")),
   "season" if kind=="season"=>remote["IndexNumber"].clone(),
   "season"|"episode" if !["season","episode"].contains(&kind)=>continue,
   _=>v.clone()
  };
        result[*field] = v;
    }
    result
}
fn same_field(field: &str, left: Option<&Value>, right: Option<&Value>) -> bool {
    if field != "credits" {
        return left == right;
    }
    let canonical = |value: Option<&Value>| {
        value.and_then(Value::as_array).map(|people|people.iter().map(|p|json!({"name":p["name"],"role":p["role"],"category":p["category"],"type":p["type"]})).collect::<Vec<_>>())
    };
    canonical(left) == canonical(right)
}
fn to_remote(remote: &mut Value, field: &str, value: &Value, kind: &str) {
    let Some((_, key)) = FIELDS.iter().find(|(name, _)| *name == field) else {
        return;
    };
    let value=match field{
  "identifiers"=>{let previous=remote["ProviderIds"].as_object().cloned().unwrap_or_default();let mut ids=serde_json::Map::new();for (key,value) in value.as_object().into_iter().flatten(){let existing=previous.keys().find(|k|k.eq_ignore_ascii_case(key)).cloned().unwrap_or_else(||key.clone());ids.insert(existing,value.clone());}Value::Object(ids)},
  "studios"=>json!(value.as_array().into_iter().flatten().filter_map(|v|v.as_str()).map(|name|json!({"Name":name})).collect::<Vec<_>>()),
  "credits"=>json!(value.as_array().into_iter().flatten().filter(|p|!["voice","character"].contains(&p["category"].as_str().unwrap_or(""))).map(|p|json!({"Name":p["name"],"Role":p["role"],"Type":p["type"].as_str().unwrap_or(if p["category"]=="crew"{p["role"].as_str().unwrap_or("Crew")}else{"Actor"})})).collect::<Vec<_>>()),
  "tagline"=>json!([value.as_str().unwrap_or("")]),
  "runtime"=>value.as_i64().map(|minutes|json!(minutes.saturating_mul(600_000_000))).unwrap_or(Value::Null),
  _=>value.clone()
 };
    remote[if field == "season" && kind == "season" {
        "IndexNumber"
    } else {
        key
    }] = value;
}
fn tags(remote: &Value, kind: &str) -> Value {
    let mut result = json!({});
    for (key, typ) in ART {
        let key = if kind == "episode" && *key == "poster" {
            "thumb"
        } else {
            key
        };
        let tag = if *typ == "Backdrop" {
            remote["BackdropImageTags"]
                .as_array()
                .and_then(|v| v.first())
                .cloned()
                .unwrap_or(Value::Null)
        } else {
            remote["ImageTags"][typ].clone()
        };
        result[key] = tag;
    }
    result
}
fn match_entry(
    entry: &NativeCatalogEntry,
    rows: &[Value],
    links: &BTreeMap<String, String>,
    entries: &[NativeCatalogEntry],
    root: &std::path::Path,
) -> Result<String, String> {
    let absolute = root.join(&entry.path).to_string_lossy().replace('\\', "/");
    if let Ok(id) = select_artwork_item(
        rows,
        &absolute,
        &entry.kind,
        &entry.metadata["identifiers"],
        false,
    ) {
        return Ok(id);
    }
    if let Ok(id) = select_artwork_item(
        rows,
        &entry.path,
        &entry.kind,
        &entry.metadata["identifiers"],
        false,
    ) {
        return Ok(id);
    }
    if ["season", "episode"].contains(&entry.kind.as_str()) {
        let parent = entry
            .parent_path
            .as_ref()
            .and_then(|p| entries.iter().find(|e| &e.path == p))
            .and_then(|e| links.get(&e.id));
        if let Some(parent) = parent {
            let number = entry.metadata[if entry.kind == "season" {
                "season"
            } else {
                "episode"
            }]
            .as_i64();
            let found: Vec<_> = rows
                .iter()
                .filter(|r| {
                    r["ParentId"] == *parent
                        && r["Type"]
                            == if entry.kind == "season" {
                                "Season"
                            } else {
                                "Episode"
                            }
                        && number.is_some()
                        && r["IndexNumber"].as_i64() == number
                })
                .filter_map(|r| r["Id"].as_str())
                .collect();
            if found.len() == 1 {
                return Ok(found[0].into());
            }
        }
    }
    Err("No unique matching media path, provider IDs, or parent/episode number.".into())
}

async fn reconcile(state: &AppState, library: &str) -> Result<(), String> {
    let Ok(_guard) = RUN_LOCK.try_lock() else {
        return Ok(());
    };
    let Some(lib) = active(state, library) else {
        return Ok(());
    };
    if db(state)
        .native_scan_status(library)
        .map_err(|e| e.to_string())?
        .status
        == "scanning"
    {
        return Ok(());
    }
    let server = state
        .runtime
        .list_servers()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|s| Some(s.id) == lib.options.server_sync.server_id)
        .ok_or("Linked server was removed.")?;
    let token = db(state)
        .decrypted_token(server.id)
        .map_err(|e| e.to_string())?
        .ok_or("Server credentials unavailable.")?;
    let config = ConnectionConfig {
        server_type: server.server_type,
        base_url: &server.base_url,
        token: &token,
    };
    let mut saved = load(state, library)?;
    if saved.partner != partner(&lib) {
        saved = SyncState {
            partner: partner(&lib),
            ..Default::default()
        };
        let _queue_guard = QUEUE_LOCK.lock().await;
        save_queue(state, library, &saved)?;
        save(state, library, &saved)?;
    }
    saved.notices.clear();
    let import_key = format!("native-server-import:{library}");
    let request_raw = db(state)
        .get_setting(&import_key)
        .map_err(|e| e.to_string())?;
    let request: Option<Request> = if request_raw.is_empty() {
        None
    } else {
        Some(serde_json::from_str(&request_raw).map_err(|_| "Invalid import request.")?)
    };
    let override_locked = request
        .as_ref()
        .and_then(|r| r.override_locked)
        .unwrap_or(lib.options.server_sync.override_locked);
    let write_nfo = request
        .as_ref()
        .and_then(|r| r.write_nfo)
        .unwrap_or(lib.options.server_sync.write_nfo);
    if request.as_ref().is_some_and(|r| r.recover) {
        let _guard = QUEUE_LOCK.lock().await;
        saved.pending.clear();
        saved.mirrors.clear();
        save_queue(state, library, &saved)?;
    }
    // Additional destinations can still receive edits while the source is offline.
    push_destinations(state, &lib, &mut saved).await;
    save(state, library, &saved)?;
    let rows = sync_library_items(config.clone(), source_library(&lib)).await?;
    let root = state.metadata.directory("", true).map_err(|e| e.detail)?;
    let mut entries = db(state)
        .native_catalog(library)
        .map_err(|e| e.to_string())?;
    entries.retain(|e| e.available);
    entries.sort_by_key(|e| match e.kind.as_str() {
        "series" | "movie" => 0,
        "season" => 1,
        _ => 2,
    });
    let mut links = BTreeMap::new();
    let mut used = std::collections::BTreeSet::new();
    saved.status = "syncing".into();
    saved.matched = 0;
    saved.unmatched = 0;
    saved.failed = 0;
    save(state, library, &saved)?;
    for (position, entry) in entries.iter().enumerate() {
        let linked = saved
            .items
            .get(&entry.id)
            .map(|s| &s.remote)
            .filter(|id| rows.iter().any(|row| row["Id"] == **id));
        let id = match linked
            .cloned()
            .map(Ok)
            .unwrap_or_else(|| match_entry(entry, &rows, &links, &entries, &root))
        {
            Ok(id) => id,
            Err(error) => {
                saved.unmatched += 1;
                if saved.notices.len() < 30 {
                    saved.notices.push(format!("{}: {error}", entry.title));
                }
                continue;
            }
        };
        if !used.insert(id.clone()) {
            saved.unmatched += 1;
            continue;
        }
        links.insert(entry.id.clone(), id.clone());
        saved.matched += 1;
        let remote = rows
            .iter()
            .find(|r| r["Id"] == id)
            .ok_or("Linked server item missing.")?;
        let previous = saved.items.get(&entry.id).cloned();
        let mut snapshot = previous.clone().unwrap_or_default();
        let pending = saved.pending.get(&entry.id).cloned();
        let first = previous
            .as_ref()
            .is_none_or(|p| p.remote != id || p.metadata.is_null());
        let force = request.is_some() || first;
        let force_images = first || request.as_ref().is_some_and(|r| r.recover);
        if !force
            && pending.is_none()
            && shared(remote, &entry.kind) == snapshot.metadata
            && tags(remote, &entry.kind) == snapshot.tags
        {
            continue;
        }
        let recover = request.as_ref().is_some_and(|r| r.recover);
        let work=async {
   let mut remote=remote.clone();
   if let Some(pending)=&pending{
    // A missing initial baseline or an offline conflict falls back to server values.
    if !first && !recover {
     let current=shared(&remote,&entry.kind);
     let mut dto:Option<Value>=None;let mut sent=serde_json::Map::new();
     for (field,value) in pending["fields"].as_object().into_iter().flatten(){
      if current.get(field)==snapshot.metadata.get(field){
       if dto.is_none(){dto=Some(sync_item(config.clone(),&id).await?);}
       let full=dto.as_mut().unwrap();
       // Recheck against a fresh complete DTO before writing any field.
       if shared(full,&entry.kind).get(field)==snapshot.metadata.get(field){to_remote(full,field,value,&entry.kind);sent.insert(field.clone(),shared(full,&entry.kind)[field].clone());}
      }
     }
     if let Some(dto)=dto {sync_update_item(config.clone(),&dto).await?;remote=sync_item(config.clone(),&id).await?;let confirmed=shared(&remote,&entry.kind);if sent.iter().any(|(field,value)|!same_field(field,confirmed.get(field),Some(value))){return Err("Server did not confirm the metadata update; it remains pending.".into());}state.runtime.invalidate_media_item_images(server.id,&id).map_err(|e|e.to_string())?;}
     for (kind,_) in pending["art"].as_object().into_iter().flatten(){
      if kind.ends_with("-animated"){continue;}
      if tags(&remote,&entry.kind).get(kind)!=snapshot.tags.get(kind){continue;}
      let art=entry.artwork.iter().find(|a|&a.kind==kind);
      let target=if kind=="backdrop"{"background"}else{kind};
      if let Some(art)=art {
       let name=art.path.strip_prefix("@managed/").ok_or("Outgoing artwork must be managed.")?;
       if name.ends_with(".gif")||name.ends_with(".webm"){continue;}
       let bytes=tokio::fs::read(state.runtime.data_dir().join("native-artwork").join(name)).await.map_err(|_|"Artwork file unavailable.")?;
       set_image(config.clone(),&id,target,&bytes,if name.ends_with(".png"){"image/png"}else if name.ends_with(".webp"){"image/webp"}else{"image/jpeg"}).await?;
      }else{if tags(&remote,&entry.kind)[kind].is_null(){continue;}remove_image(config.clone(),&id,target).await?;}
      state.runtime.invalidate_media_item_images(server.id,&id).map_err(|e|e.to_string())?;
     }
     if pending["art"].as_object().is_some_and(|a|!a.is_empty()){remote=sync_item(config.clone(),&id).await?;}
    }
   }
   let metadata=shared(&remote,&entry.kind);
   let mut fields=json!({});
   for (field,v) in metadata.as_object().into_iter().flatten(){
    let selected=request.as_ref().and_then(|r|r.fields.as_ref()).is_none_or(|fields|fields.iter().any(|f|f==field));
    if selected&&(force||metadata.get(field)!=snapshot.metadata.get(field)||pending.as_ref().is_some_and(|p|p["fields"].get(field).is_some())){fields[field]=v.clone();}
   }
   if let Some(credits)=fields["credits"].as_array_mut(){
    for credit in credits {if let Some(person)=credit["server_person_id"].as_str().filter(|id|!id.is_empty()&&id.chars().all(|c|c.is_ascii_alphanumeric()||c=='-')){credit["image"]=json!(format!("/api/servers/{}/image?ref=%2FItems%2F{}%2FImages%2FPrimary",server.id,person));}}
   }
   let current=db(state).native_catalog_scoped(library,Some(&[entry.path.clone()])).map_err(|e|e.to_string())?.into_iter().find(|e|e.id==entry.id).ok_or("Manual item was removed.")?;
   if current.revision!=entry.revision {fields=json!({});}
   if !fields.as_object().unwrap().is_empty(){
    snapshot.history.insert(0,json!({"time":now(),"metadata":FIELDS.iter().filter_map(|(key,_)|current.metadata.get(*key).map(|v|((*key).to_string(),v.clone()))).collect::<serde_json::Map<String,Value>>(),"artwork":current.artwork}));snapshot.history.truncate(10);
    db(state).sync_native_metadata(library,&entry.id,current.revision,&fields,override_locked).map_err(|e|e.to_string())?;
    if write_nfo {let mut updated=db(state).native_catalog_scoped(library,Some(&[entry.path.clone()])).map_err(|e|e.to_string())?.into_iter().find(|e|e.id==entry.id).ok_or("Item unavailable.")?;
     updated.metadata.as_object_mut().unwrap().retain(|field,_|fields.get(field).is_some());
     // PosterView's authenticated portrait proxy is not a portable NFO image URL.
     if let Some(credits)=updated.metadata["credits"].as_array_mut(){for person in credits {if person["image"].as_str().is_some_and(|url|url.starts_with("/api/servers/")){person.as_object_mut().unwrap().remove("image");}}}
     match if fields.get("identifiers").is_some(){crate::native_scan::write_identification_nfo(state,&updated)}else{crate::native_scan::write_nfo(state,&updated)}{
      Ok((path,xml))=>db(state).record_native_nfo(library,&entry.id,&path,&xml).map_err(|e|e.to_string())?,
      Err(e)=>saved.notices.push(format!("{}: database updated; NFO write skipped: {e}",entry.title))
     }
    }
   }
   let image_tags=tags(&remote,&entry.kind);
   for (kind,tag) in image_tags.as_object().into_iter().flatten(){
    if !force_images && snapshot.tags.get(kind)==Some(tag){continue;}
    let existing=current.artwork.iter().find(|a|&a.kind==kind);
    if tag.is_null(){
     // Only explicit absence in a successful complete image response counts as deletion.
     if ((kind=="backdrop"&&remote.get("BackdropImageTags").is_some())||(kind!="backdrop"&&remote.get("ImageTags").is_some()))&&existing.is_some(){crate::native_artwork::remove_static(state,library,&current,kind)?;db(state).remove_native_artwork(library,&entry.id,kind).map_err(|e|e.to_string())?;}
    }else{
     let typ=if kind=="thumb"{"Primary"}else{ART.iter().find(|(name,_)|*name==kind).map(|(_,typ)|*typ).unwrap_or("Thumb")};
     let bytes=sync_image(config.clone(),&id,typ).await?;
     let managed=crate::native_provider::store_image(state,&bytes)?;
     if let Some(existing)=existing{let mut backup=existing.clone();backup.kind=if existing.path.ends_with(".gif")||existing.path.ends_with(".webm"){format!("{kind}-animated")}else{format!("{kind}-previous")};db(state).save_native_artwork(library,&entry.id,&backup).map_err(|e|e.to_string())?;}
     let art=NativeArtwork{kind:kind.clone(),path:managed,source:"server".into()};
     db(state).save_native_artwork(library,&entry.id,&art).map_err(|e|e.to_string())?;
     if lib.options.save_artwork{crate::native_artwork::write(state,&current,&art,true)?;}
    }
   }
   let updated=db(state).native_catalog_scoped(library,Some(&[entry.path.clone()])).map_err(|e|e.to_string())?.into_iter().find(|e|e.id==entry.id).ok_or("Item unavailable.")?;
   let accepted=Value::Object(fields.as_object().into_iter().flatten().filter_map(|(field,_)|updated.metadata.get(field).map(|value|(field.clone(),value.clone()))).collect());
   let changed_art=Value::Object(image_tags.as_object().into_iter().flatten().filter(|(kind,tag)|force_images||snapshot.tags.get(*kind)!=Some(*tag)||pending.as_ref().is_some_and(|p|p["art"].get(*kind).is_some())).map(|(kind,_)|(kind.clone(),json!(true))).collect());
   if accepted.as_object().is_some_and(|v|!v.is_empty())||changed_art.as_object().is_some_and(|v|!v.is_empty()){mirror_accepted(state,&lib,&entry.id,&accepted,&changed_art,pending.as_ref()).await?;}
   snapshot.remote=id.clone();snapshot.metadata=metadata;snapshot.tags=image_tags;
   Ok::<(),String>(())
  }.await;
        match work {
            Ok(()) => {
                saved.items.insert(entry.id.clone(), snapshot);
                if let Some(expected) = &pending {
                    acknowledge(state, library, &entry.id, expected, None).await?;
                }
                saved.pending.remove(&entry.id);
            }
            Err(error) => {
                saved.failed += 1;
                if saved.notices.len() < 30 {
                    saved.notices.push(format!("{}: {error}", entry.title));
                }
            }
        }
        if position % 25 == 0 {
            save(state, library, &saved)?;
        }
    }
    let latest = load(state, library)?;
    saved.pending = latest.pending;
    saved.mirrors = latest.mirrors;
    push_destinations(state, &lib, &mut saved).await;
    let latest = load(state, library)?;
    saved.pending = latest.pending;
    saved.mirrors = latest.mirrors;
    saved.notices.truncate(50);
    saved.status = if saved.failed > 0 {
        "partial"
    } else if saved.pending.is_empty() && saved.mirrors.values().all(|v| v.is_empty()) {
        "synced"
    } else {
        "pending"
    }
    .into();
    if saved.failed == 0 && saved.pending.is_empty() && saved.mirrors.values().all(|v| v.is_empty())
    {
        saved.last_success = Some(now());
    }
    if force_activity(&request) {
        let summary = format!(
            "Matched {}, unmatched {}, failed {}.",
            saved.matched, saved.unmatched, saved.failed
        );
        note(&mut saved, summary);
    }
    save(state, library, &saved)?;
    if request.is_some()
        && saved.failed == 0
        && db(state)
            .get_setting(&import_key)
            .map_err(|e| e.to_string())?
            == request_raw
    {
        db(state)
            .set_setting(&import_key, "")
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn force_activity(request: &Option<Request>) -> bool {
    request.is_some()
}

async fn push_destinations(state: &AppState, lib: &NativeLibrary, saved: &mut SyncState) {
    let servers = state.runtime.list_servers().unwrap_or_default();
    let mut entries = match db(state).native_catalog(&lib.id) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    entries.sort_by_key(|e| match e.kind.as_str() {
        "series" | "movie" | "book_series" => 0,
        "season" => 1,
        _ => 2,
    });
    let root = match state.metadata.directory("", true) {
        Ok(root) => root,
        Err(_) => return,
    };
    for server in servers.into_iter().filter(|s| {
        Some(s.id) != lib.options.server_sync.server_id
            && (lib.options.server_sync.push_to_all
                || lib.options.server_sync.push_server_ids.contains(&s.id))
    }) {
        let Some(pending) = saved.mirrors.get(&server.id.to_string()).cloned() else {
            continue;
        };
        if pending.is_empty() {
            continue;
        }
        let Some(token) = db(state).decrypted_token(server.id).ok().flatten() else {
            continue;
        };
        let config = ConnectionConfig {
            server_type: server.server_type,
            base_url: &server.base_url,
            token: &token,
        };
        let plex = server.server_type == posterview_contracts::ServerType::Plex;
        let rows = if plex {
            Vec::new()
        } else {
            match sync_library_items(config.clone(), "").await {
                Ok(rows) => rows,
                Err(error) => {
                    saved.notices.push(format!("{}: {error}", server.name));
                    continue;
                }
            }
        };
        let mut links = BTreeMap::new();
        for entry in entries.iter().filter(|e| e.available) {
            let link_key = format!("{}:{}", server.id, entry.id);
            let linked = saved
                .mirror_links
                .get(&link_key)
                .filter(|id| rows.iter().any(|r| r["Id"] == **id));
            if let Ok(id) = linked
                .cloned()
                .map(Ok)
                .unwrap_or_else(|| match_entry(entry, &rows, &links, &entries, &root))
            {
                links.insert(entry.id.clone(), id);
            }
        }
        for (item, change) in pending {
            let Some(entry) = entries.iter().find(|e| e.id == item && e.available) else {
                continue;
            };
            let result = async {
                let id = if plex {
                    posterview_infra_media_servers::find_artwork_item(
                        config.clone(),
                        &root.join(&entry.path).to_string_lossy(),
                        &entry.kind,
                        &entry.metadata["identifiers"],
                    )
                    .await?
                } else {
                    links
                        .get(&item)
                        .cloned()
                        .ok_or("No unique destination item match.")?
                };
                if !plex && change["fields"].as_object().is_some_and(|v| !v.is_empty()) {
                    let mut dto = sync_item(config.clone(), &id).await?;
                    for (field, value) in change["fields"].as_object().into_iter().flatten() {
                        to_remote(&mut dto, field, value, &entry.kind);
                    }
                    let expected = shared(&dto, &entry.kind);
                    sync_update_item(config.clone(), &dto).await?;
                    let confirmed = shared(&sync_item(config.clone(), &id).await?, &entry.kind);
                    if change["fields"]
                        .as_object()
                        .into_iter()
                        .flatten()
                        .any(|(field, _)| {
                            !same_field(field, confirmed.get(field), expected.get(field))
                        })
                    {
                        return Err("Destination did not confirm the metadata update.".into());
                    }
                }
                for (kind, _) in change["art"].as_object().into_iter().flatten() {
                    if kind.ends_with("-animated")
                        || plex && !["poster", "backdrop", "logo", "thumb"].contains(&kind.as_str())
                    {
                        continue;
                    }
                    let target = if kind == "backdrop" {
                        "background"
                    } else {
                        kind
                    };
                    if let Some(art) = entry.artwork.iter().find(|a| &a.kind == kind) {
                        let name = art
                            .path
                            .strip_prefix("@managed/")
                            .ok_or("Static artwork file is unavailable.")?;
                        if name.ends_with(".gif") || name.ends_with(".webm") {
                            continue;
                        }
                        let bytes = tokio::fs::read(
                            state.runtime.data_dir().join("native-artwork").join(name),
                        )
                        .await
                        .map_err(|_| "Static artwork file is unavailable.")?;
                        set_image(
                            config.clone(),
                            &id,
                            target,
                            &bytes,
                            if name.ends_with(".png") {
                                "image/png"
                            } else if name.ends_with(".webp") {
                                "image/webp"
                            } else {
                                "image/jpeg"
                            },
                        )
                        .await?;
                    } else {
                        if plex {
                            let message = format!(
                                "{} / {}: Plex artwork deletion is unavailable; remove it in Plex.",
                                server.name, entry.title
                            );
                            saved.notices.push(message.clone());
                            note(saved, message);
                            continue;
                        }
                        if !plex
                            && rows
                                .iter()
                                .find(|row| row["Id"] == id)
                                .is_some_and(|row| tags(row, &entry.kind)[kind].is_null())
                        {
                            continue;
                        }
                        remove_image(config.clone(), &id, target).await?;
                    }
                }
                state
                    .runtime
                    .invalidate_media_item_images(server.id, &id)
                    .map_err(|e| e.to_string())?;
                saved
                    .mirror_links
                    .insert(format!("{}:{}", server.id, item), id);
                Ok::<(), String>(())
            }
            .await;
            match result {
                Ok(()) => {
                    if let Err(error) =
                        acknowledge(state, &lib.id, &item, &change, Some(&server.id.to_string()))
                            .await
                    {
                        saved.notices.push(error);
                        continue;
                    }
                    saved
                        .mirrors
                        .entry(server.id.to_string())
                        .or_default()
                        .remove(&item);
                }
                Err(error) => {
                    saved
                        .notices
                        .push(format!("{} / {}: {error}", server.name, entry.title));
                }
            }
        }
    }
    saved.notices.truncate(50);
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LinkRequest {
    item: String,
    server_item: String,
}
pub(crate) async fn link(
    State(state): State<AppState>,
    Path(library): Path<String>,
    Json(input): Json<LinkRequest>,
) -> Result<Json<Value>, HttpError> {
    let lib = active(&state, &library)
        .ok_or_else(|| HttpError::bad_request("Enable library sync first."))?;
    if !input
        .server_item
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-')
        || input.server_item.is_empty()
    {
        return Err(HttpError::bad_request(
            "Enter a valid Emby/Jellyfin item ID.",
        ));
    }
    let server = state
        .runtime
        .list_servers()
        .map_err(|e| HttpError::bad_request(e.to_string()))?
        .into_iter()
        .find(|s| Some(s.id) == lib.options.server_sync.server_id)
        .ok_or_else(HttpError::not_found)?;
    let token = db(&state)
        .decrypted_token(server.id)
        .map_err(|e| HttpError::bad_request(e.to_string()))?
        .unwrap_or_default();
    let rows = sync_library_items(
        ConnectionConfig {
            server_type: server.server_type,
            base_url: &server.base_url,
            token: &token,
        },
        source_library(&lib),
    )
    .await
    .map_err(HttpError::bad_request)?;
    let entry = db(&state)
        .native_catalog(&library)
        .map_err(|e| HttpError::bad_request(e.to_string()))?
        .into_iter()
        .find(|e| e.id == input.item && e.available)
        .ok_or_else(HttpError::not_found)?;
    let expected = match entry.kind.as_str() {
        "series" => "Series",
        "movie" => "Movie",
        "season" => "Season",
        "episode" => "Episode",
        "book" => "Book",
        "book_series" => "Folder",
        _ => return Err(HttpError::bad_request("Unsupported item type.")),
    };
    if !rows
        .iter()
        .any(|r| r["Id"] == input.server_item && r["Type"] == expected)
    {
        return Err(HttpError::bad_request(
            "Server item must belong to the selected library and have the same media type.",
        ));
    }
    let _guard = RUN_LOCK.lock().await;
    let mut saved = load(&state, &library).map_err(HttpError::bad_request)?;
    if saved
        .items
        .iter()
        .any(|(item, value)| item != &input.item && value.remote == input.server_item)
    {
        return Err(HttpError::bad_request(
            "This server item is already linked.",
        ));
    }
    saved.items.remove(&input.item);
    // Explicit link is trusted only within the validated selected server library.
    saved.items.insert(
        input.item,
        ItemState {
            remote: input.server_item,
            ..Default::default()
        },
    );
    save(&state, &library, &saved).map_err(HttpError::bad_request)?;
    Ok(Json(json!({"ok":true})))
}

#[cfg(test)]
mod tests {
    use super::*;
    use posterview_contracts::{
        ServerCreate, ServerType,
        native::{
            AnimeContent, NativeLibraryInput, NativeLibraryOptions, NativeLibraryType,
            NativeServerSync,
        },
    };
    #[test]
    fn replaces_shared_ids_without_retaining_removed_ids() {
        let mut dto = json!({"ProviderIds":{"Tvdb":"1","Tmdb":"2"},"CustomRating":"preserve"});
        to_remote(&mut dto, "identifiers", &json!({"tvdb":"3"}), "series");
        assert_eq!(dto["ProviderIds"], json!({"Tvdb":"3"}));
        assert_eq!(dto["CustomRating"], "preserve");
    }
    #[tokio::test]
    async fn acknowledging_an_old_edit_keeps_newer_queued_edits() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::native::scan_tests::state(temp.path());
        let old = json!({"fields":{"plot":"old"},"art":{}});
        let new = json!({"fields":{"plot":"new"},"art":{}});
        let mut queued = SyncState::default();
        queued.pending.insert("item".into(), new.clone());
        save_queue(&state, "library", &queued).unwrap();
        acknowledge(&state, "library", "item", &old, None)
            .await
            .unwrap();
        assert_eq!(load(&state, "library").unwrap().pending["item"], new);
        acknowledge(&state, "library", "item", &new, None)
            .await
            .unwrap();
        assert!(load(&state, "library").unwrap().pending.is_empty());
    }
    #[tokio::test]
    async fn pulls_initial_metadata_preserves_enhancements_and_pushes_edits_without_erasing_server_fields()
     {
        use axum::{Router, extract::State as AxumState, routing::get};
        use std::sync::{Arc, Mutex};
        let temp = tempfile::tempdir().unwrap();
        let state = crate::native::scan_tests::state(temp.path());
        std::fs::create_dir_all(temp.path().join("media/Anime/Example")).unwrap();
        std::fs::write(
            temp.path().join("media/Anime/Example/Example.S01E01.mkv"),
            b"fixture",
        )
        .unwrap();
        std::fs::write(temp.path().join("media/Anime/Example/tvshow.nfo"),"<tvshow><title>Local</title><uniqueid type=\"tvdb\">42</uniqueid><custom>keep</custom></tvshow>").unwrap();
        let remote = Arc::new(Mutex::new(
            json!({"Id":"123","Type":"Series","Name":"Server title","ProviderIds":{"Tvdb":"42"},"Overview":"Server plot","Genres":["Action"],"ImageTags":{},"BackdropImageTags":[],"CustomRating":"Keep server field","ParentId":"library"}),
        ));
        fn mock(remote: Arc<Mutex<Value>>) -> Router {
            Router::new().route("/Items",get(|AxumState(remote):AxumState<Arc<Mutex<Value>>>|async move{Json(json!({"Items":[remote.lock().unwrap().clone()],"TotalRecordCount":1}))}))
   .route("/Users",get(||async{Json(json!([{"Id":"user","Policy":{"IsAdministrator":true}}]))}))
   .route("/Users/user/Items/123",get(|AxumState(remote):AxumState<Arc<Mutex<Value>>>|async move{Json(remote.lock().unwrap().clone())}))
   .route("/Items/123/Images/Primary/0",get(||async{let mut bytes=std::io::Cursor::new(Vec::new());image::DynamicImage::new_rgb8(2,2).write_to(&mut bytes,image::ImageFormat::Png).unwrap();(axum::http::StatusCode::OK,bytes.into_inner())}))
   .route("/Items/123/Images/Primary",axum::routing::post(|AxumState(remote):AxumState<Arc<Mutex<Value>>>|async move{remote.lock().unwrap()["ImageTags"]["Primary"]=json!("updated-static");axum::http::StatusCode::NO_CONTENT}).delete(|AxumState(remote):AxumState<Arc<Mutex<Value>>>|async move{remote.lock().unwrap()["ImageTags"]=json!({});axum::http::StatusCode::NO_CONTENT}))
   .route("/Items/123",axum::routing::post(|AxumState(remote):AxumState<Arc<Mutex<Value>>>,Json(value):Json<Value>|async move{*remote.lock().unwrap()=value;axum::http::StatusCode::NO_CONTENT})).with_state(remote)
        }
        let app = mock(remote.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server_task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let store = db(&state);
        let server = store
            .create_server(&ServerCreate {
                name: "Emby".into(),
                server_type: ServerType::Emby,
                base_url: url,
                token: "test".into(),
                is_default: true,
                nfo_metadata_enabled: false,
            })
            .unwrap();
        let mirror = Arc::new(Mutex::new(remote.lock().unwrap().clone()));
        mirror.lock().unwrap()["Overview"] = json!("Old destination plot");
        let listener2 = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url2 = format!("http://{}", listener2.local_addr().unwrap());
        let app2 = mock(mirror.clone());
        let destination_task = tokio::spawn(async move {
            axum::serve(listener2, app2).await.unwrap();
        });
        let destination = store
            .create_server(&ServerCreate {
                name: "Jellyfin destination".into(),
                server_type: ServerType::Jellyfin,
                base_url: url2,
                token: "test".into(),
                is_default: false,
                nfo_metadata_enabled: false,
            })
            .unwrap();
        let lib = store
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
                        server_sync: NativeServerSync {
                            enabled: true,
                            server_id: Some(server.id),
                            library_id: "library".into(),
                            ..Default::default()
                        },
                        ..Default::default()
                    },
                },
            )
            .unwrap();
        crate::native::run_scan(state.clone(), lib.clone())
            .await
            .unwrap();
        let entry = store
            .native_catalog(&lib.id)
            .unwrap()
            .into_iter()
            .find(|e| e.kind == "series")
            .unwrap();
        store
            .edit_native_entry(
                &lib.id,
                &entry.id,
                entry.revision,
                &json!({"characters":[{"name":"Enhanced"}],"voice_cast":[{"name":"Voice"}]}),
            )
            .unwrap();
        reconcile(&state, &lib.id).await.unwrap();
        let entry = store
            .native_catalog(&lib.id)
            .unwrap()
            .into_iter()
            .find(|e| e.kind == "series")
            .unwrap();
        assert_eq!(entry.title, "Server title");
        assert_eq!(mirror.lock().unwrap()["Name"], "Server title");
        assert_eq!(mirror.lock().unwrap()["Overview"], "Server plot");
        assert_eq!(entry.metadata["plot"], "Server plot");
        assert_eq!(entry.metadata["characters"][0]["name"], "Enhanced");
        store
            .edit_native_entry(
                &lib.id,
                &entry.id,
                entry.revision,
                &json!({"plot":"New local plot"}),
            )
            .unwrap();
        let mut value = load(&state, &lib.id).unwrap();
        value.pending.insert(
            entry.id.clone(),
            json!({"fields":{"plot":"New local plot"},"art":{}}),
        );
        save_queue(&state, &lib.id, &value).unwrap();
        reconcile(&state, &lib.id).await.unwrap();
        assert_eq!(remote.lock().unwrap()["Overview"], "New local plot");
        assert_eq!(mirror.lock().unwrap()["Overview"], "New local plot");
        assert_eq!(remote.lock().unwrap()["CustomRating"], "Keep server field");
        assert!(load(&state, &lib.id).unwrap().pending.is_empty());
        // Locks protect incoming changes until override is explicitly enabled.
        remote.lock().unwrap()["Overview"] = json!("New remote plot");
        reconcile(&state, &lib.id).await.unwrap();
        assert_eq!(
            store
                .native_catalog(&lib.id)
                .unwrap()
                .into_iter()
                .find(|e| e.kind == "series")
                .unwrap()
                .metadata["plot"],
            "New local plot"
        );
        let updated = NativeLibraryInput {
            name: lib.name.clone(),
            library_type: lib.library_type,
            anime_content: lib.anime_content,
            paths: lib.paths.clone(),
            revision: Some(lib.revision),
            options: NativeLibraryOptions {
                server_sync: NativeServerSync {
                    override_locked: true,
                    ..lib.options.server_sync.clone()
                },
                ..lib.options.clone()
            },
        };
        store.save_native_library(Some(&lib.id), &updated).unwrap();
        store
            .set_setting(
                &format!("native-server-import:{}", lib.id),
                &json!({"fields":["plot"],"override_locked":true,"write_nfo":true}).to_string(),
            )
            .unwrap();
        reconcile(&state, &lib.id).await.unwrap();
        assert_eq!(
            store
                .native_catalog(&lib.id)
                .unwrap()
                .into_iter()
                .find(|e| e.kind == "series")
                .unwrap()
                .metadata["plot"],
            "New remote plot"
        );
        let nfo =
            std::fs::read_to_string(temp.path().join("media/Anime/Example/tvshow.nfo")).unwrap();
        assert!(nfo.contains("<custom>keep</custom>"));
        assert!(nfo.contains("Local"));
        assert!(nfo.contains("New remote plot"));
        // Offline conflict: server value wins rather than overwriting an unknown later edit.
        let current = store
            .native_catalog(&lib.id)
            .unwrap()
            .into_iter()
            .find(|e| e.kind == "series")
            .unwrap();
        store
            .edit_native_entry(
                &lib.id,
                &current.id,
                current.revision,
                &json!({"plot":"Offline local"}),
            )
            .unwrap();
        let mut value = load(&state, &lib.id).unwrap();
        value.pending.insert(
            current.id.clone(),
            json!({"fields":{"plot":"Offline local"},"art":{}}),
        );
        save_queue(&state, &lib.id, &value).unwrap();
        remote.lock().unwrap()["Overview"] = json!("Offline remote");
        reconcile(&state, &lib.id).await.unwrap();
        assert_eq!(
            store
                .native_catalog(&lib.id)
                .unwrap()
                .into_iter()
                .find(|e| e.kind == "series")
                .unwrap()
                .metadata["plot"],
            "Offline remote"
        );
        assert_eq!(remote.lock().unwrap()["Overview"], "Offline remote");
        assert_eq!(mirror.lock().unwrap()["Overview"], "Offline remote");
        // A source static image remains distinct from a managed animation.
        let current = store
            .native_catalog(&lib.id)
            .unwrap()
            .into_iter()
            .find(|e| e.kind == "series")
            .unwrap();
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 2)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        let managed = crate::native_provider::store_image(&state, &bytes.into_inner()).unwrap();
        let animation = NativeArtwork {
            kind: "poster-animated".into(),
            path: managed.clone(),
            source: "manual".into(),
        };
        store
            .save_native_artwork(&lib.id, &current.id, &animation)
            .unwrap();
        remote.lock().unwrap()["ImageTags"] = json!({"Primary":"new-static"});
        reconcile(&state, &lib.id).await.unwrap();
        assert!(
            store
                .native_artwork(&lib.id, &current.id, "poster")
                .unwrap()
                .is_some()
        );
        assert_eq!(
            store
                .native_artwork(&lib.id, &current.id, "poster-animated")
                .unwrap()
                .unwrap()
                .path,
            managed
        );
        remote.lock().unwrap()["ImageTags"] = json!({});
        reconcile(&state, &lib.id).await.unwrap();
        assert!(
            store
                .native_artwork(&lib.id, &current.id, "poster")
                .unwrap()
                .is_none()
        );
        assert!(
            store
                .native_artwork(&lib.id, &current.id, "poster-animated")
                .unwrap()
                .is_some()
        );
        // Rescans preserve imported server identity instead of restoring an older NFO title.
        let mut scan_lib = store
            .native_libraries()
            .unwrap()
            .into_iter()
            .find(|l| l.id == lib.id)
            .unwrap();
        scan_lib.options.save_nfo = false;
        crate::native::run_scan(state.clone(), scan_lib)
            .await
            .unwrap();
        assert_eq!(
            store
                .native_catalog(&lib.id)
                .unwrap()
                .into_iter()
                .find(|e| e.kind == "series")
                .unwrap()
                .title,
            "Server title"
        );
        destination_task.abort();
        tokio::task::yield_now().await;
        let mut queued = load(&state, &lib.id).unwrap();
        queued
            .mirrors
            .entry(destination.id.to_string())
            .or_default()
            .insert(
                current.id.clone(),
                json!({"fields":{"plot":"retry"},"art":{}}),
            );
        save_queue(&state, &lib.id, &queued).unwrap();
        reconcile(&state, &lib.id).await.unwrap();
        assert!(!load(&state, &lib.id).unwrap().mirrors[&destination.id.to_string()].is_empty());
        server_task.abort();
    }
    #[test]
    fn converts_shared_fields_without_touching_enhanced_data() {
        let remote = json!({"ProviderIds":{"Tvdb":"42"},"People":[{"Name":"Actor","Type":"Actor","Role":"Hero"}],"Studios":[{"Name":"Studio"}],"RunTimeTicks":1200000000,"ParentIndexNumber":1,"IndexNumber":2});
        let value = shared(&remote, "episode");
        assert_eq!(value["identifiers"]["tvdb"], "42");
        assert_eq!(value["runtime"], 2);
        assert_eq!(value["season"], 1);
        assert_eq!(value["episode"], 2);
        assert!(value.get("voice_cast").is_none());
        assert!(value.get("characters").is_none());
    }
}
