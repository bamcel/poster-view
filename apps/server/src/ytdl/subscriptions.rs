//! Durable weekly source checks; jobs retain the download worker's normal safeguards.
use super::{AppState, HttpError, Job, Settings, downloader, err, load, save, validate_settings};
use axum::{
    Json, Router,
    extract::{Path, State},
    routing::{get, post, put},
};
use chrono::{DateTime, Datelike, Duration, LocalResult, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

const KEY: &str = "plugin-ytdl-subscriptions";
const CURSOR_KEY: &str = "plugin-ytdl-subscription-cursors";
static CHECKING: std::sync::LazyLock<std::sync::Mutex<HashSet<String>>> =
    std::sync::LazyLock::new(Default::default);
#[derive(Clone, Serialize, Deserialize)]
struct Input {
    name: String,
    url: String,
    enabled: bool,
    weekdays: Vec<u32>,
    time: String,
    timezone: String,
}
#[derive(Clone, Serialize, Deserialize)]
struct Subscription {
    #[serde(flatten)]
    input: Input,
    id: String,
    last_checked: Option<String>,
    next_check: Option<String>,
    error: Option<String>,
}
fn validate(input: &Input) -> Result<(), HttpError> {
    downloader::validate_url(&input.url)?;
    let url = reqwest::Url::parse(&input.url).map_err(err)?;
    if !(downloader::is_channel_url(&input.url)
        || (url.path() == "/playlist"
            && url
                .query_pairs()
                .any(|(key, value)| key == "list" && downloader::valid_id(&value))))
    {
        return Err(err(
            "Subscriptions require a YouTube channel or playlist URL.",
        ));
    }
    if input.name.trim().is_empty()
        || input.name.len() > 150
        || input.weekdays.is_empty()
        || input.weekdays.len() > 7
        || input.weekdays.iter().any(|d| *d > 6)
        || input.weekdays.iter().collect::<HashSet<_>>().len() != input.weekdays.len()
    {
        return Err(err("Choose a name and one or more unique weekdays."));
    }
    if input.time.len() != 5 || NaiveTime::parse_from_str(&input.time, "%H:%M").is_err() {
        return Err(err("Choose a valid HH:mm check time."));
    }
    input
        .timezone
        .parse::<Tz>()
        .map_err(|_| err("Choose an IANA time zone."))?;
    Ok(())
}
fn next_check(input: &Input, after: DateTime<Utc>) -> Result<Option<DateTime<Utc>>, HttpError> {
    if !input.enabled {
        return Ok(None);
    }
    let zone = input.timezone.parse::<Tz>().map_err(err)?;
    let time = NaiveTime::parse_from_str(&input.time, "%H:%M").map_err(err)?;
    let today = after.with_timezone(&zone).date_naive();
    for offset in 0..15 {
        let date = today
            .checked_add_signed(Duration::days(offset))
            .ok_or_else(|| err("Schedule date overflow."))?;
        if !input
            .weekdays
            .contains(&date.weekday().num_days_from_monday())
        {
            continue;
        }
        let occurrence = match zone.from_local_datetime(&date.and_time(time)) {
            LocalResult::Single(value) => Some(value),
            LocalResult::Ambiguous(a, b) => Some(a.min(b)),
            LocalResult::None => None,
        };
        if let Some(value) = occurrence {
            let utc = value.with_timezone(&Utc);
            if utc > after {
                return Ok(Some(utc));
            }
        }
    }
    Err(err("Unable to calculate next scheduled check."))
}
fn refresh_next(subscription: &mut Subscription, now: DateTime<Utc>) -> Result<(), HttpError> {
    subscription.next_check = next_check(&subscription.input, now)?.map(|d| d.to_rfc3339());
    Ok(())
}
pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/plugins/ytdl/subscriptions", get(list).post(create))
        .route(
            "/api/plugins/ytdl/subscriptions/{id}",
            put(edit).delete(remove),
        )
        .route("/api/plugins/ytdl/subscriptions/{id}/check", post(manual))
}
async fn list(State(state): State<AppState>) -> Result<Json<Vec<Subscription>>, HttpError> {
    let _lock = state.ytdl_lock.lock().await;
    Ok(Json(load(&state, KEY)?))
}
async fn create(
    State(state): State<AppState>,
    Json(input): Json<Input>,
) -> Result<Json<Subscription>, HttpError> {
    validate(&input)?;
    let mut subscription = Subscription {
        input,
        id: uuid::Uuid::new_v4().to_string(),
        last_checked: None,
        next_check: None,
        error: None,
    };
    refresh_next(&mut subscription, Utc::now())?;
    let _lock = state.ytdl_lock.lock().await;
    let mut all: Vec<Subscription> = load(&state, KEY)?;
    if all.len() >= 100 {
        return Err(err("Subscription limit reached."));
    }
    all.push(subscription.clone());
    save(&state, KEY, &all)?;
    Ok(Json(subscription))
}
async fn edit(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<Input>,
) -> Result<Json<Subscription>, HttpError> {
    validate(&input)?;
    if CHECKING.lock().map_err(err)?.contains(&id) {
        return Err(err(
            "Wait for the current source check to finish before editing.",
        ));
    }
    let _lock = state.ytdl_lock.lock().await;
    if CHECKING.lock().map_err(err)?.contains(&id) {
        return Err(err(
            "Wait for the current source check to finish before editing.",
        ));
    }
    let mut all: Vec<Subscription> = load(&state, KEY)?;
    let subscription = all
        .iter_mut()
        .find(|s| s.id == id)
        .ok_or_else(|| err("Subscription not found."))?;
    subscription.input = input;
    subscription.error = None;
    refresh_next(subscription, Utc::now())?;
    let result = subscription.clone();
    save(&state, KEY, &all)?;
    Ok(Json(result))
}
async fn remove(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, HttpError> {
    let _lock = state.ytdl_lock.lock().await;
    let mut all: Vec<Subscription> = load(&state, KEY)?;
    all.retain(|s| s.id != id);
    save(&state, KEY, &all)?;
    let mut cursors: std::collections::HashMap<String, String> = load(&state, CURSOR_KEY)?;
    cursors.remove(&id);
    save(&state, CURSOR_KEY, &cursors)?;
    Ok(Json(serde_json::json!({"deleted":true})))
}
struct Checking(String);
impl Drop for Checking {
    fn drop(&mut self) {
        if let Ok(mut active) = CHECKING.lock() {
            active.remove(&self.0);
        }
    }
}
async fn check(state: &AppState, id: &str, automatic: bool) -> Result<Subscription, HttpError> {
    {
        let mut active = CHECKING.lock().map_err(err)?;
        if !active.insert(id.into()) {
            return Err(err("This source check is already running."));
        }
    }
    let _checking = Checking(id.into());
    let subscription = {
        let _lock = state.ytdl_lock.lock().await;
        let settings: Settings = load(state, "plugin-ytdl")?;
        if !settings.enabled {
            return Err(err("Enable YTDL before checking subscriptions."));
        }
        let mut all: Vec<Subscription> = load(state, KEY)?;
        let subscription = all
            .iter_mut()
            .find(|s| s.id == id)
            .ok_or_else(|| err("Subscription not found."))?;
        if automatic && !subscription.input.enabled {
            return Err(err("Subscription is paused."));
        }
        subscription.last_checked = Some(Utc::now().to_rfc3339());
        subscription.error = None;
        refresh_next(subscription, Utc::now())?;
        let result = subscription.clone();
        save(state, KEY, &all)?;
        result
    };
    let result = check_source(state, &subscription).await;
    let _lock = state.ytdl_lock.lock().await;
    let mut all: Vec<Subscription> = load(state, KEY)?;
    let current = all
        .iter_mut()
        .find(|s| s.id == id)
        .ok_or_else(|| err("Subscription was removed."))?;
    current.error = result.err().map(|e| e.detail);
    let response = current.clone();
    save(state, KEY, &all)?;
    Ok(response)
}
async fn manual(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Subscription>, HttpError> {
    check(&state, &id, false).await.map(Json)
}
fn active_video(jobs: &[Job], directory: &str, url: &str, id: &str) -> bool {
    jobs.iter().any(|job| {
        same_destination(&job.settings.directory, directory)
            && same_source(&job.url, url)
            && [
                "queued",
                "inspecting",
                "downloading",
                "processing",
                "importing",
            ]
            .contains(&job.status.as_str())
            && (job.video_ids.is_empty() || job.video_ids.iter().any(|v| v == id))
    })
}
fn same_destination(a: &str, b: &str) -> bool {
    let a = a.trim_end_matches('/');
    let b = b.trim_end_matches('/');
    #[cfg(windows)]
    {
        a.eq_ignore_ascii_case(b)
    }
    #[cfg(not(windows))]
    {
        a == b
    }
}
fn same_source(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let playlist = |raw: &str| {
        reqwest::Url::parse(raw).ok().and_then(|u| {
            u.query_pairs()
                .find(|(k, _)| k == "list")
                .map(|(_, v)| v.into_owned())
        })
    };
    match (playlist(a), playlist(b)) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}
#[cfg(test)]
fn downloaded(root: &std::path::Path, id: &str) -> bool {
    media_index(root)
        .ok()
        .and_then(|index| index.get(id).cloned())
        .is_some_and(|media| matches!(media, Ok(Some(_))))
}
struct Source {
    url: String,
    info: Value,
    playlist: bool,
}
fn valid_playlist_url(raw: &str) -> Result<String, HttpError> {
    downloader::validate_url(raw)?;
    let url = reqwest::Url::parse(raw).map_err(err)?;
    if url.path() != "/playlist" {
        return Err(err("Channel listing contains an invalid playlist URL."));
    }
    let id = url
        .query_pairs()
        .find(|(key, _)| key == "list")
        .map(|(_, v)| v.into_owned())
        .filter(|id| downloader::valid_id(id))
        .ok_or_else(|| err("Playlist listing has no valid playlist ID."))?;
    Ok(format!("https://www.youtube.com/playlist?list={id}"))
}
fn playlist_urls(info: &Value) -> (Vec<String>, Vec<String>) {
    let mut urls = Vec::new();
    let mut errors = Vec::new();
    let mut seen = HashSet::new();
    if let Some(entries) = info["entries"].as_array() {
        for entry in entries {
            let raw = entry["url"].as_str().unwrap_or_default();
            match valid_playlist_url(raw) {
                Ok(url) if seen.insert(url.clone()) => urls.push(url),
                Ok(_) => {}
                Err(e) => errors.push(e.detail),
            }
        }
    } else {
        errors.push("Channel has no playlist listing.".into());
    }
    (urls, errors)
}
fn resume_playlists(mut urls: Vec<String>, cursor: Option<&str>) -> Vec<String> {
    if let Some(index) = cursor.and_then(|cursor| urls.iter().position(|url| url == cursor)) {
        let length = urls.len();
        if length > 0 {
            urls.rotate_left((index + 1) % length);
        }
    }
    urls
}
async fn cursor_set(state: &AppState, id: &str, cursor: Option<&str>) -> Result<(), HttpError> {
    let _lock = state.ytdl_lock.lock().await;
    let mut cursors: std::collections::HashMap<String, String> = load(state, CURSOR_KEY)?;
    if cursor.is_some()
        && load::<Vec<Subscription>>(state, KEY)?
            .iter()
            .any(|s| s.id == id)
    {
        cursors.insert(id.into(), cursor.unwrap_or_default().into());
    } else {
        cursors.remove(id);
    }
    save(state, CURSOR_KEY, &cursors)
}
async fn discover_sources(
    state: &AppState,
    subscription: &Subscription,
) -> Result<(Vec<Source>, Vec<String>), HttpError> {
    let url = subscription.input.url.as_str();
    if !downloader::is_channel_url(url) {
        let canonical = valid_playlist_url(url)?;
        return Ok((
            vec![Source {
                info: downloader::inspect(&canonical).await?,
                url: canonical,
                playlist: true,
            }],
            vec![],
        ));
    }
    let mut sources = Vec::new();
    let mut errors = Vec::new();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15 * 60);
    let uploads = match downloader::inspect_channel_videos(url).await {
        Ok(info) => Some(Source {
            url: url.into(),
            info,
            playlist: false,
        }),
        Err(e) => {
            errors.push(format!("Channel uploads: {}", e.detail));
            None
        }
    };
    match downloader::inspect(url).await {
        Ok(info) => {
            let (urls, listing_errors) = playlist_urls(&info);
            errors.extend(listing_errors);
            let cursor = {
                let _lock = state.ytdl_lock.lock().await;
                load::<std::collections::HashMap<String, String>>(state, CURSOR_KEY)?
                    .remove(&subscription.id)
            };
            let urls = resume_playlists(urls, cursor.as_deref());
            let total = urls.len();
            let mut inspected = 0;
            for playlist in urls {
                if inspected >= 1000 {
                    errors.push("Channel discovery reached its 1000-playlist check limit; remaining playlists will be checked next time.".into());
                    break;
                }
                let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
                if remaining.is_zero() {
                    errors.push("Channel discovery exceeded its 15-minute check limit; remaining playlists will be checked next time.".into());
                    break;
                }
                let result = tokio::time::timeout(remaining, downloader::inspect(&playlist)).await;
                match result {
                    Ok(Ok(info)) => sources.push(Source {
                        url: playlist.clone(),
                        info,
                        playlist: true,
                    }),
                    Ok(Err(e)) => errors.push(format!("Playlist {playlist}: {}", e.detail)),
                    Err(_) => {
                        errors.push("Channel discovery exceeded its 15-minute check limit; remaining playlists will be checked next time.".into());
                        break;
                    }
                }
                inspected += 1;
                cursor_set(state, &subscription.id, Some(&playlist)).await?;
            }
            if inspected == total {
                cursor_set(state, &subscription.id, None).await?;
            }
        }
        Err(e) => errors.push(format!("Channel playlists: {}", e.detail)),
    }
    if let Some(uploads) = uploads {
        sources.push(uploads);
    }
    Ok((sources, errors))
}
type MediaIndex = std::collections::HashMap<String, Result<Option<std::path::PathBuf>, String>>;
fn media_index(root: &std::path::Path) -> Result<MediaIndex, HttpError> {
    let mut index = std::collections::HashMap::new();
    let channels = root.join("channels");
    let metadata = match std::fs::symlink_metadata(&channels) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(index),
        Err(error) => return Err(err(error)),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(err("YouTube channels directory must be a real directory."));
    }
    for channel in std::fs::read_dir(channels).map_err(err)? {
        let channel = channel.map_err(err)?;
        if !channel.file_type().map_err(err)?.is_dir() {
            continue;
        }
        for video in std::fs::read_dir(channel.path()).map_err(err)? {
            let video = video.map_err(err)?;
            if !video.file_type().map_err(err)?.is_dir() {
                continue;
            }
            let id = match super::naming::video_identity(&video.path())? {
                Some(id) => id,
                None => {
                    // Preserve downloads created before IDs were recorded in NFO files.
                    let channel_name = channel.file_name().to_string_lossy().into_owned();
                    let video_name = video.file_name().to_string_lossy().into_owned();
                    if !channel_name.starts_with("UC")
                        || !downloader::valid_id(&channel_name)
                        || !downloader::valid_id(&video_name)
                    {
                        continue;
                    }
                    video_name
                }
            };
            let media = super::naming::existing_media(&video.path()).map_err(|e| e.detail);
            match index.entry(id) {
                std::collections::hash_map::Entry::Occupied(mut entry) => {
                    *entry.get_mut() = Err(
                        "Video ID exists in multiple channel directories; resolve the duplicate."
                            .into(),
                    );
                }
                std::collections::hash_map::Entry::Vacant(entry) => {
                    entry.insert(media);
                }
            }
        }
    }
    Ok(index)
}
fn append_source_jobs(
    jobs: &mut Vec<Job>,
    sources: &[Source],
    settings: &Settings,
    index: &MediaIndex,
    errors: &mut Vec<String>,
) -> bool {
    let covered = sources
        .iter()
        .filter(|s| s.playlist)
        .flat_map(|s| s.info["entries"].as_array().into_iter().flatten())
        .filter_map(|e| e["id"].as_str())
        .filter(|id| downloader::valid_id(id))
        .collect::<HashSet<_>>();
    let mut added = false;
    for source in sources {
        let Some(entries) = source.info["entries"].as_array() else {
            errors.push(format!("Source {} has no video listing.", source.url));
            continue;
        };
        let mut ids = Vec::new();
        let mut seen = HashSet::new();
        for entry in entries {
            let Some(id) = entry["id"].as_str() else {
                continue;
            };
            if entry["kind"] == "playlist"
                || !downloader::valid_id(id)
                || !seen.insert(id)
                || (!source.playlist && covered.contains(id))
                || active_video(jobs, &settings.directory, &source.url, id)
            {
                continue;
            }
            let needed = match index.get(id) {
                Some(Ok(Some(media))) if source.playlist => {
                    match super::nfo::playlist_current(media, entry, &source.info) {
                        Ok(current) => !current,
                        Err(e) => {
                            errors.push(format!("Video {id}: {}", e.detail));
                            false
                        }
                    }
                }
                Some(Ok(Some(_))) => false,
                Some(Err(e)) => {
                    errors.push(format!("Video {id}: {e}"));
                    false
                }
                _ => true,
            };
            if needed {
                ids.push(id.to_string());
            }
        }
        if ids.is_empty() {
            continue;
        }
        if jobs.len() >= 1000 {
            errors.push("Download history limit reached.".into());
            break;
        }
        jobs.push(Job {
            id: uuid::Uuid::new_v4().to_string(),
            url: source.url.clone(),
            title: source.info["title"]
                .as_str()
                .unwrap_or("YouTube source")
                .to_string(),
            status: "queued".into(),
            progress: None,
            encoding_progress: None,
            total_videos: 0,
            completed_videos: 0,
            current_video_title: None,
            speed: None,
            eta: None,
            error: None,
            created_at: Utc::now().to_rfc3339(),
            finished_at: None,
            settings: settings.clone(),
            video_ids: ids,
        });
        added = true;
    }
    added
}
async fn check_source(state: &AppState, subscription: &Subscription) -> Result<(), HttpError> {
    validate_settings(state, &load::<Settings>(state, "plugin-ytdl")?)?;
    let (sources, mut errors) = discover_sources(state, subscription).await?;
    let _lock = state.ytdl_lock.lock().await;
    if !load::<Vec<Subscription>>(state, KEY)?
        .iter()
        .any(|s| s.id == subscription.id)
    {
        return Err(err("Subscription was removed."));
    }
    let settings: Settings = load(state, "plugin-ytdl")?;
    if !settings.enabled {
        return Err(err("YTDL was disabled while checking this source."));
    }
    let root = validate_settings(state, &settings)?;
    let index = media_index(&root)?;
    let mut jobs: Vec<Job> = load(state, "plugin-ytdl-jobs")?;
    let added = append_source_jobs(&mut jobs, &sources, &settings, &index, &mut errors);
    save(state, "plugin-ytdl-jobs", &jobs)?;
    if added {
        state.ytdl_notify.notify_one();
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(err(errors
            .into_iter()
            .take(20)
            .collect::<Vec<_>>()
            .join("\n")))
    }
}
pub(super) fn start(state: AppState) {
    tokio::spawn(async move {
        loop {
            let due = {
                let _lock = state.ytdl_lock.lock().await;
                if load::<Settings>(&state, "plugin-ytdl").is_ok_and(|s| s.enabled) {
                    load::<Vec<Subscription>>(&state, KEY)
                        .unwrap_or_default()
                        .into_iter()
                        .filter(|s| {
                            s.input.enabled
                                && s.next_check
                                    .as_deref()
                                    .and_then(|v| DateTime::parse_from_rfc3339(v).ok())
                                    .is_some_and(|d| d.with_timezone(&Utc) <= Utc::now())
                        })
                        .map(|s| s.id)
                        .collect::<Vec<_>>()
                } else {
                    Vec::new()
                }
            };
            for id in due {
                if let Err(e) = check(&state, &id, true).await {
                    tracing::warn!(subscription=%id,error=%e.detail,"YouTube subscription check failed");
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        }
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cursor_resumes_rotates_and_handles_removed_playlist() {
        let urls = vec!["PLone".into(), "PLtwo".into(), "PLthree".into()];
        assert_eq!(
            resume_playlists(urls.clone(), Some("PLone")),
            vec!["PLtwo", "PLthree", "PLone"]
        );
        assert_eq!(resume_playlists(urls.clone(), Some("PLthree")), urls);
        assert_eq!(resume_playlists(urls.clone(), Some("removed")), urls);
        assert_eq!(
            resume_playlists(Vec::new(), Some("removed")),
            Vec::<String>::new()
        );
        let resumed = resume_playlists(urls.clone(), Some("PLtwo"));
        assert_eq!(
            resumed.iter().collect::<HashSet<_>>(),
            urls.iter().collect::<HashSet<_>>()
        );
    }
    #[tokio::test]
    async fn cursor_persists_and_clears_after_complete_cycle() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        let subscription = Subscription {
            input: input(),
            id: "cursor-fixture".into(),
            last_checked: None,
            next_check: None,
            error: None,
        };
        save(&state, KEY, &vec![subscription]).unwrap();
        cursor_set(
            &state,
            "cursor-fixture",
            Some("https://www.youtube.com/playlist?list=PLone"),
        )
        .await
        .unwrap();
        let restored =
            load::<std::collections::HashMap<String, String>>(&state, CURSOR_KEY).unwrap();
        assert_eq!(
            restored.get("cursor-fixture").map(String::as_str),
            Some("https://www.youtube.com/playlist?list=PLone")
        );
        cursor_set(&state, "cursor-fixture", None).await.unwrap();
        assert!(
            load::<std::collections::HashMap<String, String>>(&state, CURSOR_KEY)
                .unwrap()
                .is_empty()
        );
        save(&state, KEY, &Vec::<Subscription>::new()).unwrap();
        cursor_set(&state, "cursor-fixture", Some("PLremoved"))
            .await
            .unwrap();
        assert!(
            load::<std::collections::HashMap<String, String>>(&state, CURSOR_KEY)
                .unwrap()
                .is_empty()
        );
    }
    fn source(id: &str, video_ids: &[&str], playlist: bool) -> Source {
        let title = format!("Playlist {id}");
        let entries=video_ids.iter().enumerate().map(|(index,id)|serde_json::json!({"id":id,"kind":"video","playlist_id":if playlist{"PL".to_string()+id}else{String::new()},"playlist_title":title,"playlist_index":index+1})).collect::<Vec<_>>();
        let entries = entries
            .into_iter()
            .map(|mut entry| {
                if playlist {
                    entry["playlist_id"] = Value::String(id.into());
                }
                entry
            })
            .collect::<Vec<_>>();
        Source {
            url: if playlist {
                format!("https://www.youtube.com/playlist?list={id}")
            } else {
                "https://www.youtube.com/@channel".into()
            },
            playlist,
            info: serde_json::json!({"id":id,"title":title,"description":"Description","entries":entries}),
        }
    }
    #[test]
    fn discovers_valid_playlist_urls_and_reports_invalid_entries() {
        let info = serde_json::json!({"entries":[{"url":"https://youtube.com/playlist?list=PLone&index=2"},{"url":"https://www.youtube.com/playlist?list=PLone"},{"url":"https://evil.test/playlist?list=PLbad"},{"url":"https://youtube.com/watch?v=vid"}]});
        let (urls, errors) = playlist_urls(&info);
        assert_eq!(urls, vec!["https://www.youtube.com/playlist?list=PLone"]);
        assert_eq!(errors.len(), 2);
    }
    #[test]
    fn shared_video_gets_each_playlist_and_rechecks_are_idempotent() {
        let temp = tempfile::tempdir().unwrap();
        let settings = Settings {
            library_id: "library".into(),
            ..Default::default()
        };
        let sources = vec![
            source("PLone", &["shared"], true),
            source("PLtwo", &["shared"], true),
            source("UCchannel", &["shared", "outside"], false),
        ];
        let mut jobs = Vec::new();
        let mut errors = Vec::new();
        assert!(append_source_jobs(
            &mut jobs,
            &sources,
            &settings,
            &media_index(temp.path()).unwrap(),
            &mut errors
        ));
        assert_eq!(jobs.len(), 3);
        assert_eq!(jobs[0].video_ids, vec!["shared"]);
        assert_eq!(jobs[1].video_ids, vec!["shared"]);
        assert_eq!(jobs[2].video_ids, vec!["outside"]);
        assert!(!append_source_jobs(
            &mut jobs,
            &sources,
            &settings,
            &media_index(temp.path()).unwrap(),
            &mut errors
        ));
        assert_eq!(jobs.len(), 3);
        let channel = temp.path().join("channels/UCchannel");
        let target = channel.join("shared");
        std::fs::create_dir_all(&target).unwrap();
        let media = target.join("Readable [shared].mp4");
        std::fs::write(&media, "original media").unwrap();
        let info = serde_json::json!({"id":"shared","channel_id":"UCchannel","channel":"Channel","title":"Video"});
        for source in &sources[..2] {
            super::super::nfo::write_named(
                &target,
                "Readable [shared]",
                &info,
                &source.info["entries"][0],
                &source.info,
                &Value::Null,
            )
            .unwrap();
        }
        let outside = channel.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("outside.mkv"), "original").unwrap();
        for job in &mut jobs {
            job.status = "completed".into();
        }
        let index = media_index(temp.path()).unwrap();
        assert!(!append_source_jobs(
            &mut jobs,
            &sources,
            &settings,
            &index,
            &mut errors
        ));
        let new = vec![source("PLnew", &["shared"], true)];
        assert!(append_source_jobs(
            &mut jobs,
            &new,
            &settings,
            &index,
            &mut errors
        ));
        assert_eq!(jobs.len(), 4);
        assert_eq!(jobs[3].video_ids, vec!["shared"]);
        super::super::nfo::write_named(
            &target,
            "Readable [shared]",
            &info,
            &new[0].info["entries"][0],
            &new[0].info,
            &Value::Null,
        )
        .unwrap();
        jobs[3].status = "completed".into();
        assert!(!append_source_jobs(
            &mut jobs,
            &new,
            &settings,
            &index,
            &mut errors
        ));
        assert_eq!(std::fs::read_to_string(media).unwrap(), "original media");
        assert!(errors.is_empty(), "{errors:?}");
    }
    #[test]
    fn empty_sources_and_partial_errors_never_queue_all_videos() {
        let settings = Settings::default();
        let mut jobs = Vec::new();
        let mut errors = vec!["One playlist failed".into()];
        let sources = vec![
            source("PLempty", &[], true),
            source("PLgood", &["vid"], true),
        ];
        assert!(append_source_jobs(
            &mut jobs,
            &sources,
            &settings,
            &Default::default(),
            &mut errors
        ));
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].video_ids, vec!["vid"]);
        assert_eq!(errors.len(), 1);
    }
    fn input() -> Input {
        Input {
            name: "Channel".into(),
            url: "https://www.youtube.com/@creator".into(),
            enabled: true,
            weekdays: vec![0],
            time: "08:30".into(),
            timezone: "America/Los_Angeles".into(),
        }
    }
    #[test]
    fn active_jobs_deduplicate_but_failures_can_retry() {
        let settings = Settings {
            directory: "downloads".into(),
            ..Default::default()
        };
        let mut jobs = vec![Job {
            id: "job".into(),
            url: "https://youtube.com/playlist?list=PLid".into(),
            title: String::new(),
            status: "queued".into(),
            progress: None,
            encoding_progress: None,
            total_videos: 0,
            completed_videos: 0,
            current_video_title: None,
            speed: None,
            eta: None,
            error: None,
            created_at: String::new(),
            finished_at: None,
            settings,
            video_ids: vec!["vid".into()],
        }];
        assert!(active_video(&jobs, "downloads", &jobs[0].url, "vid"));
        jobs[0].settings.library_id = "retired-library".into();
        assert!(active_video(&jobs, "downloads/", &jobs[0].url, "vid"));
        assert!(!active_video(&jobs, "other-downloads", &jobs[0].url, "vid"));
        assert!(!active_video(
            &jobs,
            "downloads",
            "https://youtube.com/playlist?list=PLother",
            "vid"
        ));
        assert!(!active_video(&jobs, "another", "other", "vid"));
        jobs[0].status = "failed".into();
        assert!(!active_video(&jobs, "downloads", "other", "vid"));
        jobs[0].status = "downloading".into();
        jobs[0].video_ids.clear();
        assert!(active_video(&jobs, "downloads", &jobs[0].url, "vid"));
        assert!(active_video(
            &jobs,
            "downloads",
            "https://www.youtube.com/playlist?list=PLid&index=3",
            "vid"
        ));
    }
    #[test]
    fn local_weekday_and_time() {
        let now = "2026-10-13T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
        assert_eq!(
            next_check(&input(), now).unwrap().unwrap().to_rfc3339(),
            "2026-10-19T15:30:00+00:00"
        );
    }
    #[test]
    fn dst_gap_is_skipped_and_fold_runs_once() {
        let mut schedule = input();
        schedule.weekdays = vec![6];
        schedule.time = "02:30".into();
        let now = "2026-03-08T08:00:00Z".parse().unwrap();
        assert_eq!(
            next_check(&schedule, now).unwrap().unwrap().to_rfc3339(),
            "2026-03-15T09:30:00+00:00"
        );
        schedule.time = "01:30".into();
        let first = next_check(&schedule, "2026-11-01T07:00:00Z".parse().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(first.to_rfc3339(), "2026-11-01T08:30:00+00:00");
        assert_eq!(
            next_check(&schedule, first).unwrap().unwrap().to_rfc3339(),
            "2026-11-08T09:30:00+00:00"
        );
    }
    #[test]
    fn invalid_inputs_and_disabled_schedule() {
        let mut schedule = input();
        schedule.url = "https://youtube.com/watch?v=vid".into();
        assert!(validate(&schedule).is_err());
        schedule = input();
        schedule.weekdays = vec![0, 0];
        assert!(validate(&schedule).is_err());
        schedule = input();
        schedule.enabled = false;
        assert!(next_check(&schedule, Utc::now()).unwrap().is_none());
    }
    #[test]
    fn subscriptions_survive_persistence() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        let mut subscription = Subscription {
            input: input(),
            id: "fixture".into(),
            last_checked: None,
            next_check: None,
            error: None,
        };
        refresh_next(&mut subscription, "2026-10-13T00:00:00Z".parse().unwrap()).unwrap();
        save(&state, KEY, &vec![subscription.clone()]).unwrap();
        let restored = load::<Vec<Subscription>>(&state, KEY).unwrap();
        assert_eq!(restored[0].next_check, subscription.next_check);
    }
    #[tokio::test]
    async fn claims_and_failures_are_durable_without_network() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        let subscription = Subscription {
            input: input(),
            id: "claim-fixture".into(),
            last_checked: None,
            next_check: Some("2020-01-01T00:00:00Z".into()),
            error: None,
        };
        save(&state, KEY, &vec![subscription]).unwrap();
        save(
            &state,
            "plugin-ytdl",
            &Settings {
                enabled: true,
                directory: "../outside".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let result = check(&state, "claim-fixture", false).await.unwrap();
        assert!(result.last_checked.is_some());
        assert!(result.error.as_ref().is_some_and(|e| e.contains("folder")));
        assert!(
            result
                .next_check
                .as_deref()
                .unwrap()
                .parse::<DateTime<Utc>>()
                .unwrap()
                > Utc::now()
        );
        let restored = load::<Vec<Subscription>>(&state, KEY).unwrap();
        assert_eq!(restored[0].last_checked, result.last_checked);
        assert_eq!(restored[0].error, result.error);
    }
    #[tokio::test]
    async fn disabled_plugin_does_not_consume_due_check() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        let subscription = Subscription {
            input: input(),
            id: "paused-fixture".into(),
            last_checked: None,
            next_check: Some("2020-01-01T00:00:00Z".into()),
            error: None,
        };
        save(&state, KEY, &vec![subscription]).unwrap();
        assert!(check(&state, "paused-fixture", false).await.is_err());
        let restored = load::<Vec<Subscription>>(&state, KEY).unwrap();
        assert!(restored[0].last_checked.is_none());
        assert_eq!(
            restored[0].next_check.as_deref(),
            Some("2020-01-01T00:00:00Z")
        );
    }
    #[test]
    fn readable_folders_use_nfo_identity_and_report_duplicate_ids() {
        let temp = tempfile::tempdir().unwrap();
        let folder = temp.path().join("channels/Readable Channel/Readable Video");
        std::fs::create_dir_all(&folder).unwrap();
        let media = folder.join("Readable Video.mkv");
        std::fs::write(&media, "original").unwrap();
        std::fs::write(
            folder.join("Readable Video.nfo"),
            "<episodedetails><uniqueid type=\"youtube\">video123</uniqueid><youtube><video_id>video123</video_id></youtube></episodedetails>",
        )
        .unwrap();
        let index = media_index(temp.path()).unwrap();
        assert_eq!(
            index.get("video123").unwrap().as_ref().unwrap(),
            &Some(media)
        );
        assert!(!index.contains_key("Readable Video"));
        assert!(downloaded(temp.path(), "video123"));
        let duplicate = temp.path().join("channels/Another Channel/Another Title");
        std::fs::create_dir_all(&duplicate).unwrap();
        std::fs::write(duplicate.join("another.mkv"), "original").unwrap();
        std::fs::write(
            duplicate.join("another.nfo"),
            "<episodedetails><uniqueid type=\"youtube\">video123</uniqueid></episodedetails>",
        )
        .unwrap();
        assert!(media_index(temp.path()).unwrap()["video123"].is_err());
    }
    #[test]
    fn readable_folders_without_identity_are_not_video_ids() {
        let temp = tempfile::tempdir().unwrap();
        let folder = temp.path().join("channels/Readable Channel/Title");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("video.mkv"), "original").unwrap();
        assert!(media_index(temp.path()).unwrap().is_empty());
    }
    #[test]
    fn downloaded_detection_preserves_named_files() {
        let temp = tempfile::tempdir().unwrap();
        let folder = temp.path().join("channels/UCcreator/vid");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("Readable [vid].mkv"), "original").unwrap();
        assert!(downloaded(temp.path(), "vid"));
        assert!(!downloaded(temp.path(), "missing"));
    }
}
