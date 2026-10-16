//! Shared native-library channels. Frozen lineups keep guide and playback in sync.
mod schedule;
#[cfg(test)]
mod tests;
use crate::{AppState, HttpError};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use posterview_contracts::{
    UserAccount, UserRole,
    native::{NativeCatalogEntry, NativeLibraryType},
};
use posterview_infra_sqlite::ServerStore;
use schedule::{Candidate, Program};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};

#[derive(Default)]
pub(crate) struct Store {
    cache: RwLock<Option<Arc<Document>>>,
}

static WRITE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const KEY: &str = "plugin-virtual-tv";

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Settings {
    enabled: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Channel {
    id: String,
    name: String,
    number: u32,
    library_ids: Vec<String>,
    show_ids: Vec<String>,
    movie_ids: Vec<String>,
    genres: Vec<String>,
    order: String,
    start_at: String,
    revision: u64,
    #[serde(default)]
    schedule_revision: Option<u64>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ChannelInput {
    name: String,
    number: u32,
    library_ids: Vec<String>,
    #[serde(default)]
    show_ids: Vec<String>,
    #[serde(default)]
    movie_ids: Vec<String>,
    #[serde(default)]
    genres: Vec<String>,
    order: String,
    start_at: String,
    revision: Option<u64>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Record {
    channel: Channel,
    candidates: Vec<Candidate>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct Document {
    enabled: bool,
    channels: Vec<Record>,
}

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/plugins/virtual-tv", get(settings).put(save_settings))
        .route("/api/virtual-tv/channels", get(channels).post(create))
        .route(
            "/api/virtual-tv/channels/{id}",
            axum::routing::put(update).delete(delete),
        )
        .route("/api/virtual-tv/channels/{id}/guide", get(guide))
        .route("/api/virtual-tv/channels/{id}/tune", post(tune))
        .route("/api/virtual-tv/channels/{id}/image", get(channel_image))
        .route(
            "/api/virtual-tv/channels/{id}/artwork/{library}/{item}",
            get(artwork),
        )
}
fn storage(error: impl std::fmt::Display) -> HttpError {
    tracing::error!(%error, "Virtual TV storage operation failed");
    HttpError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        detail: "Unable to load or save Virtual TV.".into(),
    }
}
fn load(state: &AppState) -> Result<Arc<Document>, HttpError> {
    if let Some(doc) = state.virtual_tv.cache.read().map_err(storage)?.as_ref() {
        return Ok(doc.clone());
    }
    let mut cache = state.virtual_tv.cache.write().map_err(storage)?;
    if let Some(doc) = cache.as_ref() {
        return Ok(doc.clone());
    }
    let raw = ServerStore::new(state.runtime.data_dir())
        .get_setting(KEY)
        .map_err(storage)?;
    let doc = Arc::new(if raw.is_empty() {
        Document::default()
    } else {
        serde_json::from_str(&raw).map_err(storage)?
    });
    *cache = Some(doc.clone());
    Ok(doc)
}
fn persist(state: &AppState, doc: &Document) -> Result<(), HttpError> {
    ServerStore::new(state.runtime.data_dir())
        .set_setting(KEY, &serde_json::to_string(doc).map_err(storage)?)
        .map_err(storage)?;
    *state.virtual_tv.cache.write().map_err(storage)? = Some(Arc::new(doc.clone()));
    Ok(())
}
fn admin(state: &AppState, headers: &HeaderMap) -> Result<(), HttpError> {
    if state.auth.request_user(headers)?.role == UserRole::Admin {
        Ok(())
    } else {
        Err(HttpError {
            status: StatusCode::FORBIDDEN,
            detail: "Administrator access required.".into(),
        })
    }
}
fn allowed(user: &UserAccount, channel: &Channel) -> bool {
    !channel.library_ids.is_empty()
        && channel.library_ids.iter().all(|library| {
            user.role == UserRole::Admin
                || user.permissions.all_libraries
                || user.permissions.library_ids.contains(library)
        })
}
fn visible(state: &AppState, user: &UserAccount, record: &Record) -> bool {
    if !allowed(user, &record.channel) {
        return false;
    }
    let Ok(libraries) = ServerStore::new(state.runtime.data_dir()).native_libraries() else {
        return false;
    };
    record
        .channel
        .library_ids
        .iter()
        .all(|id| libraries.iter().any(|library| &library.id == id))
}
pub(crate) fn require_channel(
    state: &AppState,
    user: &UserAccount,
    id: &str,
) -> Result<(), HttpError> {
    let doc = load(state)?;
    if doc.enabled
        && doc
            .channels
            .iter()
            .any(|record| record.channel.id == id && visible(state, user, record))
    {
        Ok(())
    } else {
        Err(HttpError::not_found())
    }
}
fn authorized(state: &AppState, user: &UserAccount, id: &str) -> Result<Record, HttpError> {
    let doc = load(state)?;
    if !doc.enabled {
        return Err(HttpError::not_found());
    }
    doc.channels
        .iter()
        .find(|record| record.channel.id == id && visible(state, user, record))
        .cloned()
        .ok_or_else(HttpError::not_found)
}
fn program_list(record: &Record) -> Result<Vec<Program>, HttpError> {
    schedule::generate(&record.channel, record.candidates.clone(), Utc::now())
        .map_err(HttpError::bad_request)
}
#[derive(Default, Deserialize)]
struct GuideWindow {
    from: Option<String>,
    until: Option<String>,
}
pub(crate) fn live_position(
    state: &AppState,
    user: &UserAccount,
    id: &str,
    library: &str,
    item: &str,
) -> Result<f64, HttpError> {
    let record = authorized(state, user, id)?;
    let now = Utc::now();
    let program = schedule::current_program(&record.channel, record.candidates, now)
        .map_err(HttpError::bad_request)?
        .ok_or_else(HttpError::not_found)?;
    if program.library_id != library || program.item_id != item {
        return Err(HttpError::bad_request(
            "The channel has advanced. Tune in again.",
        ));
    }
    crate::access::require_item(state, user, library, item)?;
    Ok((now
        - DateTime::parse_from_rfc3339(&program.starts_at)
            .map_err(storage)?
            .with_timezone(&Utc))
    .num_milliseconds() as f64
        / 1000.0)
}
async fn settings(State(state): State<AppState>) -> Result<Json<Settings>, HttpError> {
    Ok(Json(Settings {
        enabled: load(&state)?.enabled,
    }))
}
async fn save_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<Settings>,
) -> Result<Json<Settings>, HttpError> {
    admin(&state, &headers)?;
    let _guard = WRITE.lock().await;
    let mut doc = (*load(&state)?).clone();
    doc.enabled = input.enabled;
    persist(&state, &doc)?;
    Ok(Json(input))
}
async fn channels(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<Channel>>, HttpError> {
    let user = state.auth.request_user(&headers)?;
    let doc = load(&state)?;
    if !doc.enabled && user.role != UserRole::Admin {
        return Ok(Json(vec![]));
    }
    let mut channels: Vec<_> = doc
        .channels
        .iter()
        .filter(|r| visible(&state, &user, r))
        .map(|r| r.channel.clone())
        .collect();
    channels.sort_by_key(|c| c.number);
    Ok(Json(channels))
}
fn number(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str()?.parse().ok())
        .filter(|v| v.is_finite() && *v >= 1.0)
}
fn source_title(entry: &NativeCatalogEntry) -> bool {
    let parts: Vec<_> = entry.path.split('/').collect();
    let auxiliary = |part: &str| {
        matches!(
            part.to_ascii_lowercase().as_str(),
            "extra"
                | "extras"
                | "trailer"
                | "trailers"
                | "featurettes"
                | "behind the scenes"
                | "deleted scenes"
                | "interviews"
                | "backdrop"
                | "backdrops"
        )
    };
    if parts.iter().any(|part| auxiliary(part)) {
        return false;
    }
    static SEASON: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?i)^(?:.+?[ ._-]+)?(?:season|s)[ ._-]*\d{1,3}$").unwrap()
    });
    let season = |part: &str| {
        part.eq_ignore_ascii_case("special")
            || part.eq_ignore_ascii_case("specials")
            || SEASON.is_match(part)
    };
    if entry.kind == "series" {
        return !parts.last().is_some_and(|part| season(part));
    }
    if is_special(entry) && special_placement(entry).is_none() {
        return false;
    }
    if entry.kind == "movie" {
        static TRAILER: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
            regex::Regex::new(r"(?i)(?:^|[ ._-])trailer(?:[ ._-]*\d+)?$").unwrap()
        });
        let stem = std::path::Path::new(&entry.path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        return !parts
            .iter()
            .take(parts.len().saturating_sub(1))
            .any(|part| season(part))
            && !TRAILER.is_match(stem)
            && !TRAILER.is_match(&entry.title)
            && entry.metadata["extra_type"].is_null()
            && entry.metadata["extratype"].is_null();
    }
    true
}
fn is_special(entry: &NativeCatalogEntry) -> bool {
    if entry.kind != "episode" {
        return false;
    }
    static ZERO: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?i)^(?:.+?[ ._-]+)?(?:season|s)[ ._-]*0{1,3}$").unwrap()
    });
    entry.metadata["season"].as_i64() == Some(0)
        || entry.path.split('/').any(|part| {
            part.eq_ignore_ascii_case("special")
                || part.eq_ignore_ascii_case("specials")
                || ZERO.is_match(part)
        })
}
fn special_placement(entry: &NativeCatalogEntry) -> Option<(i64, i64, u8)> {
    let positive = |key: &str| entry.metadata[key].as_i64().filter(|n| *n > 0);
    match (
        positive("airs_before_season"),
        positive("airs_after_season"),
    ) {
        (Some(season), None)
            if entry.metadata["airs_before_episode"].is_null()
                || positive("airs_before_episode").is_some() =>
        {
            Some((season, positive("airs_before_episode").unwrap_or(1), 0))
        }
        (None, Some(season)) if entry.metadata["airs_before_episode"].is_null() => {
            Some((season, i64::MAX, 2))
        }
        _ => None,
    }
}
fn candidates(state: &AppState, channel: &Channel) -> Result<Vec<Candidate>, HttpError> {
    let store = ServerStore::new(state.runtime.data_dir());
    let libraries = store.native_libraries().map_err(storage)?;
    let mut result = vec![];
    let mut found_shows = HashSet::new();
    let mut found_movies = HashSet::new();
    for library in &channel.library_ids {
        if !libraries
            .iter()
            .any(|l| &l.id == library && l.library_type != NativeLibraryType::Books)
        {
            return Err(HttpError::bad_request(
                "Choose existing native video libraries.",
            ));
        }
        let entries = store.native_catalog(library).map_err(storage)?;
        let by_path: HashMap<_, _> = entries.iter().map(|e| (e.path.as_str(), e)).collect();
        for entry in &entries {
            if !source_title(entry) {
                continue;
            }
            if entry.kind == "series" && channel.show_ids.contains(&entry.id) {
                found_shows.insert(entry.id.clone());
            }
            if entry.kind == "movie" && channel.movie_ids.contains(&entry.id) {
                found_movies.insert(entry.id.clone());
            }
            if !entry.available
                || entry.metadata["missing"] == true
                || !matches!(entry.kind.as_str(), "episode" | "movie")
                || entry.files.is_empty()
            {
                continue;
            }
            let mut series: Option<&NativeCatalogEntry> = None;
            let mut path = entry.parent_path.as_deref();
            let mut seen = HashSet::new();
            while let Some(parent) = path {
                if !seen.insert(parent) {
                    break;
                }
                let Some(ancestor) = by_path.get(parent) else {
                    break;
                };
                if ancestor.kind == "series" && source_title(ancestor) {
                    series = Some(ancestor);
                    break;
                }
                path = ancestor.parent_path.as_deref();
            }
            let selected = channel.movie_ids.contains(&entry.id)
                || series.is_some_and(|s| channel.show_ids.contains(&s.id));
            let genre_match = std::iter::once(entry).chain(series).any(|e| {
                ["genre", "genres"].iter().any(|key| {
                    let v = &e.metadata[*key];
                    let genres: Vec<&str> = v
                        .as_array()
                        .map(|a| a.iter().filter_map(Value::as_str).collect())
                        .unwrap_or_else(|| {
                            v.as_str()
                                .map(|s| s.split(['|', ',', '/']).collect())
                                .unwrap_or_default()
                        });
                    genres.iter().any(|g| {
                        channel
                            .genres
                            .iter()
                            .any(|filter| filter.eq_ignore_ascii_case(g.trim()))
                    })
                })
            });
            let unfiltered = channel.show_ids.is_empty()
                && channel.movie_ids.is_empty()
                && channel.genres.is_empty();
            if !unfiltered && !selected && !genre_match {
                continue;
            }
            let duration = entry
                .files
                .first()
                .and_then(|f| number(&f["media_info"]["format"]["duration"]))
                .or_else(|| number(&entry.metadata["youtube"]["duration_seconds"]))
                .or_else(|| number(&entry.metadata["duration_seconds"]));
            let Some(duration_seconds) = duration else {
                return Err(HttpError::bad_request(format!(
                    "{} has no measured duration. Scan the library before scheduling.",
                    entry.title
                )));
            };
            result.push(Candidate {
                library_id: library.clone(),
                item_id: entry.id.clone(),
                title: entry.title.clone(),
                series_title: series.map(|s| s.title.clone()),
                series_id: series.map(|s| s.id.clone()),
                season: if is_special(entry) {
                    Some(0)
                } else {
                    entry.metadata["season"].as_i64()
                },
                episode: entry.metadata["episode"].as_i64(),
                placement: if is_special(entry) {
                    special_placement(entry)
                } else {
                    None
                },
                duration_seconds,
                artwork_url: None,
            });
            if result.len() > 10000 {
                return Err(HttpError::bad_request("Limit channels to 10,000 videos."));
            }
        }
    }
    if channel.show_ids.iter().any(|id| !found_shows.contains(id))
        || channel
            .movie_ids
            .iter()
            .any(|id| !found_movies.contains(id))
    {
        return Err(HttpError::bad_request(
            "Selected titles must belong to the chosen libraries.",
        ));
    }
    if result.is_empty() {
        return Err(HttpError::bad_request(
            "No playable videos match this channel.",
        ));
    }
    Ok(result)
}
fn validate(input: ChannelInput, id: String, revision: u64) -> Result<Channel, HttpError> {
    if input.name.trim().is_empty()
        || input.name.len() > 120
        || input.number == 0
        || input.number > 99999
        || input.library_ids.is_empty()
        || input.library_ids.len() > 100
        || !matches!(
            input.order.as_str(),
            "sequential" | "random" | "random_shows"
        )
        || DateTime::parse_from_rfc3339(&input.start_at).is_err()
    {
        return Err(HttpError::bad_request(
            "Provide a channel name, number, native libraries, valid ordering, and start time.",
        ));
    }
    if input.show_ids.len() + input.movie_ids.len() > 10000
        || input.genres.len() > 100
        || input
            .library_ids
            .iter()
            .chain(&input.show_ids)
            .chain(&input.movie_ids)
            .chain(&input.genres)
            .any(|v| v.is_empty() || v.len() > 512)
    {
        return Err(HttpError::bad_request(
            "Channel selection is too large or invalid.",
        ));
    }
    let mut library_ids = input.library_ids;
    library_ids.sort();
    library_ids.dedup();
    Ok(Channel {
        id,
        name: input.name.trim().into(),
        number: input.number,
        library_ids,
        show_ids: input.show_ids,
        movie_ids: input.movie_ids,
        genres: input.genres,
        order: input.order,
        start_at: input.start_at,
        revision,
        schedule_revision: Some(revision),
    })
}
async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<ChannelInput>,
) -> Result<Json<Channel>, HttpError> {
    admin(&state, &headers)?;
    let _guard = WRITE.lock().await;
    let mut doc = (*load(&state)?).clone();
    if doc.channels.len() >= 128 {
        return Err(HttpError::bad_request("Limit reached: 128 channels."));
    }
    let channel = validate(input, uuid::Uuid::new_v4().to_string(), 1)?;
    if doc
        .channels
        .iter()
        .any(|r| r.channel.number == channel.number)
    {
        return Err(HttpError::bad_request("Channel number is already in use."));
    }
    let record = Record {
        candidates: candidates(&state, &channel)?,
        channel: channel.clone(),
    };
    program_list(&record)?;
    doc.channels.push(record);
    persist(&state, &doc)?;
    Ok(Json(channel))
}
async fn update(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<ChannelInput>,
) -> Result<Json<Channel>, HttpError> {
    admin(&state, &headers)?;
    let _guard = WRITE.lock().await;
    let mut doc = (*load(&state)?).clone();
    let index = doc
        .channels
        .iter()
        .position(|r| r.channel.id == id)
        .ok_or_else(HttpError::not_found)?;
    let previous = &doc.channels[index].channel;
    if input.revision != Some(previous.revision) {
        return Err(HttpError {
            status: StatusCode::CONFLICT,
            detail: "Channel changed. Reload before saving.".into(),
        });
    }
    let mut channel = validate(
        input,
        id.clone(),
        previous
            .revision
            .checked_add(1)
            .ok_or_else(|| HttpError::bad_request("Channel revision exhausted."))?,
    )?;
    if doc
        .channels
        .iter()
        .any(|r| r.channel.id != id && r.channel.number == channel.number)
    {
        return Err(HttpError::bad_request("Channel number is already in use."));
    }
    let mut record = Record {
        candidates: candidates(&state, &channel)?,
        channel: channel.clone(),
    };
    program_list(&record)?;
    if channel.library_ids == previous.library_ids
        && channel.show_ids == previous.show_ids
        && channel.movie_ids == previous.movie_ids
        && channel.genres == previous.genres
        && channel.order == previous.order
        && channel.start_at == previous.start_at
        && record.candidates == doc.channels[index].candidates
    {
        channel.schedule_revision = Some(previous.schedule_revision.unwrap_or(previous.revision));
    }
    record.channel = channel.clone();
    doc.channels[index] = record;
    persist(&state, &doc)?;
    Ok(Json(channel))
}
async fn delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<StatusCode, HttpError> {
    admin(&state, &headers)?;
    let _guard = WRITE.lock().await;
    let mut doc = (*load(&state)?).clone();
    let count = doc.channels.len();
    doc.channels.retain(|r| r.channel.id != id);
    if count == doc.channels.len() {
        return Err(HttpError::not_found());
    }
    persist(&state, &doc)?;
    Ok(StatusCode::NO_CONTENT)
}
async fn channel_image(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<(StatusCode, HeaderMap, Vec<u8>), HttpError> {
    let user = state.auth.request_user(&headers)?;
    let record = authorized(&state, &user, &id)?;
    let program = schedule::current_program(&record.channel, record.candidates.clone(), Utc::now())
        .map_err(HttpError::bad_request)?
        .ok_or_else(HttpError::not_found)?;
    program_thumbnail(
        state,
        headers,
        record,
        user,
        program.library_id,
        program.item_id,
        ArtworkPurpose::Thumbnail,
    )
    .await
}
enum ArtworkPurpose {
    Thumbnail,
    Backdrop,
}
async fn program_thumbnail(
    state: AppState,
    headers: HeaderMap,
    record: Record,
    user: UserAccount,
    library: String,
    item: String,
    purpose: ArtworkPurpose,
) -> Result<(StatusCode, HeaderMap, Vec<u8>), HttpError> {
    let selected = record
        .candidates
        .iter()
        .find(|c| c.library_id == library && c.item_id == item)
        .ok_or_else(HttpError::not_found)?;
    if !item_available(&state, &user, &library, &item) {
        return Err(HttpError::not_found());
    }
    crate::access::require_item(&state, &user, &library, &item)?;
    let store = ServerStore::new(state.runtime.data_dir());
    let mut sources = vec![item];
    if let Some(series) = selected.series_id.clone() {
        sources.push(series);
    }
    let kinds: &[&str] = match purpose {
        ArtworkPurpose::Thumbnail => &["thumb", "landscape", "poster", "backdrop"],
        ArtworkPurpose::Backdrop => {
            sources.reverse();
            &["backdrop"]
        }
    };
    for item in sources {
        if !crate::access::allows_item(&state, &user, &library, &item) {
            continue;
        }
        for &kind in kinds {
            if store
                .native_artwork(&library, &item, kind)
                .map_err(storage)?
                .is_none()
            {
                continue;
            }
            match crate::native::artwork(
                State(state.clone()),
                Path((library.clone(), item.clone(), kind.into())),
                axum::extract::Query(HashMap::from([("still".into(), "1".into())])),
                headers.clone(),
            )
            .await
            {
                Ok(result) => return Ok(result),
                Err(error) if error.status == StatusCode::NOT_FOUND => continue,
                Err(error) => return Err(error),
            }
        }
    }
    Err(HttpError::not_found())
}
async fn guide(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    axum::extract::Query(window): axum::extract::Query<GuideWindow>,
) -> Result<Json<Vec<Program>>, HttpError> {
    let user = state.auth.request_user(&headers)?;
    let record = authorized(&state, &user, &id)?;
    let from = window
        .from
        .map(|v| DateTime::parse_from_rfc3339(&v).map(|t| t.with_timezone(&Utc)))
        .transpose()
        .map_err(|_| HttpError::bad_request("Invalid guide start time."))?
        .unwrap_or_else(Utc::now);
    let until = window
        .until
        .map(|v| DateTime::parse_from_rfc3339(&v).map(|t| t.with_timezone(&Utc)))
        .transpose()
        .map_err(|_| HttpError::bad_request("Invalid guide end time."))?
        .unwrap_or(
            from.checked_add_signed(chrono::Duration::days(7))
                .ok_or_else(|| {
                    HttpError::bad_request("Guide time is outside the supported range.")
                })?,
        );
    let state_copy = state.clone();
    let programs = tokio::task::spawn_blocking(move || {
        let mut programs =
            schedule::generate_range(&record.channel, record.candidates, from, until)
                .map_err(HttpError::bad_request)?;
        let mut permission = HashMap::new();
        for p in &mut programs {
            let permitted = *permission
                .entry((p.library_id.clone(), p.item_id.clone()))
                .or_insert_with(|| item_available(&state_copy, &user, &p.library_id, &p.item_id));
            if !permitted {
                p.title = "Unavailable program".into();
                p.series_title = None;
                p.season = None;
                p.episode = None;
                p.item_id.clear();
                p.library_id.clear();
                p.artwork_url = None;
            } else {
                p.artwork_url = Some(format!(
                    "/api/virtual-tv/channels/{id}/artwork/{}/{}",
                    p.library_id, p.item_id
                ));
            }
        }
        Ok::<_, HttpError>(programs)
    })
    .await
    .map_err(storage)??;
    Ok(Json(programs))
}
fn item_available(state: &AppState, user: &UserAccount, library: &str, item: &str) -> bool {
    ServerStore::new(state.runtime.data_dir())
        .native_catalog_item(library, item)
        .ok()
        .flatten()
        .is_some_and(|e| e.available && e.metadata["missing"] != true && !e.files.is_empty())
        && crate::access::allows_item(state, user, library, item)
}
async fn tune(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, HttpError> {
    let user = state.auth.request_user(&headers)?;
    let record = authorized(&state, &user, &id)?;
    let now = Utc::now();
    let p = schedule::current_program(&record.channel, record.candidates, now)
        .map_err(HttpError::bad_request)?
        .ok_or_else(|| HttpError::bad_request("This channel has not started yet."))?;
    if !item_available(&state, &user, &p.library_id, &p.item_id) {
        return Err(HttpError::not_found());
    }
    crate::access::require_item(&state, &user, &p.library_id, &p.item_id)?;
    let position = (now
        - DateTime::parse_from_rfc3339(&p.starts_at)
            .map_err(storage)?
            .with_timezone(&Utc))
    .num_milliseconds() as f64
        / 1000.0;
    Ok(Json(
        json!({"library_id":p.library_id,"item_id":p.item_id,"position_seconds":position,"ends_at":p.ends_at,"program_id":p.id,"channel_name":record.channel.name,"title":p.title}),
    ))
}
async fn artwork(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, library, item)): Path<(String, String, String)>,
    axum::extract::Query(query): axum::extract::Query<HashMap<String, String>>,
) -> Result<(StatusCode, HeaderMap, Vec<u8>), HttpError> {
    let user = state.auth.request_user(&headers)?;
    let record = authorized(&state, &user, &id)?;
    let purpose = if query.get("kind").is_some_and(|kind| kind == "backdrop") {
        ArtworkPurpose::Backdrop
    } else {
        ArtworkPurpose::Thumbnail
    };
    program_thumbnail(state, headers, record, user, library, item, purpose).await
}
