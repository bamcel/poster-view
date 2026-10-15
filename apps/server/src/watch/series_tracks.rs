//! Profile-specific track characteristics, scoped to a catalog series rather than track indexes.
use super::*;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct TrackPreference {
    language: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    codec: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    channels: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    forced: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    hearing_impaired: Option<bool>,
}
impl TrackPreference {
    fn validate(&self) -> Result<(), HttpError> {
        if self.language.is_empty()
            || self.language.len() > 24
            || !self
                .language
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-')
            || self
                .title
                .as_ref()
                .is_some_and(|s| s.len() > 256 || s.chars().any(char::is_control))
            || self
                .codec
                .as_ref()
                .is_some_and(|s| s.len() > 64 || s.chars().any(char::is_control))
            || self.channels.is_some_and(|v| v == 0 || v > 64)
        {
            return Err(HttpError::bad_request(
                "Track characteristics are out of range.",
            ));
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(default)]
pub(super) struct SeriesTracks {
    #[serde(skip_serializing_if = "Option::is_none")]
    audio: Option<TrackPreference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    subtitle: Option<TrackPreference>,
    subtitles_off: bool,
}
fn selected<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<Option<TrackPreference>>, D::Error> {
    Option::<TrackPreference>::deserialize(d).map(Some)
}
#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub(super) struct TrackPatch {
    #[serde(deserialize_with = "selected")]
    audio: Option<Option<TrackPreference>>,
    #[serde(deserialize_with = "selected")]
    subtitle: Option<Option<TrackPreference>>,
    subtitles_off: Option<bool>,
}
impl TrackPatch {
    fn validate(&self) -> Result<(), HttpError> {
        for track in [&self.audio, &self.subtitle]
            .into_iter()
            .flatten()
            .flatten()
        {
            track.validate()?;
        }
        if self.subtitles_off == Some(true) && self.subtitle.as_ref().is_some_and(Option::is_some) {
            return Err(HttpError::bad_request(
                "Choose subtitles or turn subtitles off.",
            ));
        }
        Ok(())
    }
}
fn database(store: &WatchStore) -> Result<Connection, HttpError> {
    let db = store.db()?;
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS video_series_tracks (
        user TEXT NOT NULL, library TEXT NOT NULL, series TEXT NOT NULL, tracks_json TEXT NOT NULL,
        PRIMARY KEY(user,library,series));",
    )
    .map_err(failure)?;
    Ok(db)
}
fn read(
    db: &Connection,
    user: &str,
    library: &str,
    series: &str,
) -> Result<SeriesTracks, HttpError> {
    let raw: Option<String> = db.query_row(
        "SELECT tracks_json FROM video_series_tracks WHERE user=?1 AND library=?2 AND series=?3",
        params![user, library, series], |r| r.get(0),
    ).optional().map_err(failure)?;
    raw.map(|raw| serde_json::from_str(&raw).map_err(failure))
        .unwrap_or_else(|| Ok(SeriesTracks::default()))
}
fn clear_saved(store: &WatchStore, user: &str) -> Result<(), HttpError> {
    let mut db = database(store)?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(failure)?;
    let rows = {
        let mut statement = tx
            .prepare("SELECT library,item,state_json,active_session FROM video_watch WHERE user=?1")
            .map_err(failure)?;
        let rows = statement
            .query_map([user], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(failure)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(failure)?
    };
    for (library, item, raw, active_session) in rows {
        let mut saved: serde_json::Value = serde_json::from_str(&raw).map_err(failure)?;
        saved["audio_index"] = serde_json::Value::Null;
        saved["subtitle_index"] = serde_json::Value::Null;
        if let Some(session) = active_session {
            saved["_track_reset_session"] = serde_json::json!(session);
        }
        tx.execute(
            "UPDATE video_watch SET state_json=?4 WHERE user=?1 AND library=?2 AND item=?3",
            params![user, library, item, saved.to_string()],
        )
        .map_err(failure)?;
    }
    tx.execute("DELETE FROM video_series_tracks WHERE user=?1", [user])
        .map_err(failure)?;
    tx.commit().map_err(failure)?;
    Ok(())
}
pub(super) async fn clear(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<StatusCode, HttpError> {
    let user = state.auth.request_user(&headers)?;
    tokio::task::spawn_blocking(move || clear_saved(&store(&state), &user.id))
        .await
        .map_err(failure)??;
    Ok(StatusCode::NO_CONTENT)
}
fn write(
    store: &WatchStore,
    user: &str,
    library: &str,
    series: &str,
    patch: TrackPatch,
) -> Result<SeriesTracks, HttpError> {
    patch.validate()?;
    let mut db = database(store)?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(failure)?;
    let mut tracks = read(&tx, user, library, series)?;
    if let Some(audio) = patch.audio {
        tracks.audio = audio;
    }
    if let Some(subtitle) = patch.subtitle {
        tracks.subtitle = subtitle;
        tracks.subtitles_off = false;
    }
    if let Some(off) = patch.subtitles_off {
        tracks.subtitles_off = off;
        if off {
            tracks.subtitle = None;
        }
    }
    tx.execute(
        "INSERT INTO video_series_tracks(user,library,series,tracks_json) VALUES(?1,?2,?3,?4)
        ON CONFLICT(user,library,series) DO UPDATE SET tracks_json=excluded.tracks_json",
        params![
            user,
            library,
            series,
            serde_json::to_string(&tracks).map_err(failure)?
        ],
    )
    .map_err(failure)?;
    tx.commit().map_err(failure)?;
    Ok(tracks)
}
fn resolve_series(
    entry: NativeCatalogEntry,
    mut parent: impl FnMut(&str) -> Result<Option<NativeCatalogEntry>, HttpError>,
) -> Result<Option<String>, HttpError> {
    if entry.kind != "episode" {
        return Ok(None);
    }
    let mut path = entry.parent_path;
    let mut seen = std::collections::HashSet::new();
    for _ in 0..16 {
        let Some(value) = path.filter(|p| seen.insert(p.clone())) else {
            return Ok(None);
        };
        let Some(entry) = parent(&value)? else {
            return Ok(None);
        };
        if entry.kind == "series" {
            return Ok(Some(entry.id));
        }
        path = entry.parent_path;
    }
    Ok(None)
}
fn series(state: &AppState, library: &str, item: &str) -> Result<Option<String>, HttpError> {
    let entry = video(state, library, item)?;
    let catalog = ServerStore::new(state.runtime.data_dir());
    resolve_series(entry, |path| {
        catalog.native_catalog_path(library, path).map_err(failure)
    })
}
pub(super) async fn get(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((library, item)): Path<(String, String)>,
) -> Result<Json<SeriesTracks>, HttpError> {
    let user = state.auth.request_user(&headers)?;
    tokio::task::spawn_blocking(move || {
        crate::access::require_item(&state, &user, &library, &item)?;
        match series(&state, &library, &item)? {
            Some(series) => read(&database(&store(&state))?, &user.id, &library, &series).map(Json),
            None => Ok(Json(SeriesTracks::default())),
        }
    })
    .await
    .map_err(failure)?
}
pub(super) async fn save(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((library, item)): Path<(String, String)>,
    Json(patch): Json<TrackPatch>,
) -> Result<Json<SeriesTracks>, HttpError> {
    let user = state.auth.request_user(&headers)?;
    tokio::task::spawn_blocking(move || {
        crate::access::require_item(&state, &user, &library, &item)?;
        let series = series(&state, &library, &item)?.ok_or_else(|| {
            HttpError::bad_request("Track preferences require an episode belonging to a series.")
        })?;
        write(&store(&state), &user.id, &library, &series, patch).map(Json)
    })
    .await
    .map_err(failure)?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn patch(value: serde_json::Value) -> TrackPatch {
        serde_json::from_value(value).unwrap()
    }
    #[test]
    fn clearing_is_profile_scoped_durable_and_keeps_watch_state_and_active_session() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("watch.sqlite");
        let store = WatchStore::new(path.clone());
        let mut sessions = Vec::new();
        for user in ["one", "two"] {
            let session = store
                .begin_at(user, "library", "episode", 1_000.0, 0)
                .unwrap()
                .session_id;
            let report = serde_json::from_value(serde_json::json!({
                "session_id": session, "sequence": 0, "position_seconds": 40,
                "audio_index": 2, "subtitle_index": -1, "subtitle_delay_seconds": 1.5
            }))
            .unwrap();
            store
                .report_at(user, "library", "episode", 1_000.0, report, 10_000)
                .unwrap();
            write(
                &store,
                user,
                "library",
                "series",
                patch(serde_json::json!({"audio":{"language":"en"},"subtitles_off":true})),
            )
            .unwrap();
            sessions.push(session);
        }
        let before = store.get("one", "library", "episode", 1_000.0).unwrap();
        let preferences = serde_json::to_value(store.preferences("one").unwrap()).unwrap();
        clear_saved(&store, "one").unwrap();
        let store = WatchStore::new(path);
        let after = store.get("one", "library", "episode", 1_000.0).unwrap();
        let mut expected = serde_json::to_value(&before).unwrap();
        expected["audio_index"] = serde_json::Value::Null;
        expected["subtitle_index"] = serde_json::Value::Null;
        assert_eq!(serde_json::to_value(&after).unwrap(), expected);
        assert_eq!(
            serde_json::to_value(store.preferences("one").unwrap()).unwrap(),
            preferences
        );
        assert_eq!(
            store
                .get("two", "library", "episode", 1_000.0)
                .unwrap()
                .audio_index,
            Some(2)
        );
        let db = database(&store).unwrap();
        assert_eq!(
            read(&db, "one", "library", "series").unwrap(),
            SeriesTracks::default()
        );
        assert!(
            read(&db, "two", "library", "series")
                .unwrap()
                .audio
                .is_some()
        );
        // Multiple later reports keep saving progress and subtitle timing, but cannot resurrect tracks.
        for sequence in 1..=2 {
            let report = serde_json::from_value(serde_json::json!({
                "session_id": sessions[0], "sequence": sequence, "position_seconds": 40 + sequence * 10,
                "audio_index": 2, "subtitle_index": -1, "subtitle_delay_seconds": 2.0
            })).unwrap();
            let saved = store
                .report_at(
                    "one",
                    "library",
                    "episode",
                    1_000.0,
                    report,
                    10_000 + sequence as i64 * 10_000,
                )
                .unwrap();
            assert_eq!(saved.audio_index, None);
            assert_eq!(saved.subtitle_index, None);
            assert_eq!(saved.position_seconds, (40 + sequence * 10) as f64);
            assert_eq!(saved.subtitle_delay_seconds, 2.0);
        }
        let session = store
            .begin_at("one", "library", "episode", 1_000.0, 40_000)
            .unwrap()
            .session_id;
        let report = serde_json::from_value(serde_json::json!({"session_id":session,"sequence":0,"position_seconds":65,"audio_index":3,"subtitle_index":4})).unwrap();
        let saved = store
            .report_at("one", "library", "episode", 1_000.0, report, 50_000)
            .unwrap();
        assert_eq!(
            (saved.audio_index, saved.subtitle_index),
            (Some(3), Some(4))
        );
    }
    #[test]
    fn preferences_survive_restart_and_isolate_profiles_libraries_and_series() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("watch.sqlite");
        let saved = write(&WatchStore::new(path.clone()), "user", "library", "series", patch(serde_json::json!({"audio":{"language":"ja","codec":"flac","channels":2},"subtitle":{"language":"en","forced":false}}))).unwrap();
        let db = database(&WatchStore::new(path)).unwrap();
        assert_eq!(read(&db, "user", "library", "series").unwrap(), saved);
        for (u, l, s) in [
            ("other", "library", "series"),
            ("user", "other", "series"),
            ("user", "library", "other"),
        ] {
            assert_eq!(read(&db, u, l, s).unwrap(), SeriesTracks::default());
        }
    }
    #[test]
    fn partial_updates_preserve_other_kind_and_off_is_explicit() {
        let temp = tempfile::tempdir().unwrap();
        let store = WatchStore::new(temp.path().join("watch.sqlite"));
        write(
            &store,
            "u",
            "l",
            "s",
            patch(serde_json::json!({"audio":{"language":"ja"}})),
        )
        .unwrap();
        let selected = write(
            &store,
            "u",
            "l",
            "s",
            patch(serde_json::json!({"subtitle":{"language":"en"}})),
        )
        .unwrap();
        assert_eq!(selected.audio.unwrap().language, "ja");
        let off = write(
            &store,
            "u",
            "l",
            "s",
            patch(serde_json::json!({"subtitle":null,"subtitles_off":true})),
        )
        .unwrap();
        assert!(off.subtitles_off && off.subtitle.is_none() && off.audio.is_some());
        let restored = write(
            &store,
            "u",
            "l",
            "s",
            patch(serde_json::json!({"subtitle":{"language":"en"}})),
        )
        .unwrap();
        assert!(!restored.subtitles_off);
        assert!(restored.audio.is_some());
        assert!(
            patch(serde_json::json!({"audio":{"language":"en","channels":100}}))
                .validate()
                .is_err()
        );
        assert!(
            patch(serde_json::json!({"subtitle":{"language":"en"},"subtitles_off":true}))
                .validate()
                .is_err()
        );
    }
    fn entry(id: &str, kind: &str, parent: Option<&str>) -> NativeCatalogEntry {
        NativeCatalogEntry {
            id: id.into(),
            path: id.into(),
            kind: kind.into(),
            parent_path: parent.map(str::to_owned),
            title: "Same title".into(),
            metadata: serde_json::Value::Null,
            artwork: vec![],
            files: vec![],
            nfo_path: None,
            nfo_xml: None,
            available: true,
            revision: 0,
        }
    }
    #[test]
    fn series_scope_uses_parent_identity_and_ignores_titles_or_movie_metadata() {
        let parents = [
            entry("season", "season", Some("stable-series")),
            entry("stable-series", "series", None),
        ];
        assert_eq!(
            resolve_series(entry("ep", "episode", Some("season")), |p| Ok(parents
                .iter()
                .find(|e| e.path == p)
                .cloned()))
            .unwrap()
            .as_deref(),
            Some("stable-series")
        );
        assert_eq!(
            resolve_series(entry("movie", "movie", Some("stable-series")), |_| panic!(
                "movie must not resolve ancestry"
            ))
            .unwrap(),
            None
        );
        assert_eq!(
            resolve_series(entry("ep", "episode", Some("missing")), |_| Ok(None)).unwrap(),
            None
        );
        assert_eq!(
            resolve_series(entry("ep", "episode", Some("cycle")), |_| Ok(Some(entry(
                "cycle",
                "season",
                Some("cycle")
            ))))
            .unwrap(),
            None
        );
    }
    #[tokio::test]
    async fn endpoints_reject_unknown_episodes_and_invalid_authentication() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        let path = || Path(("library".into(), "unknown".into()));
        let error = get(State(state.clone()), HeaderMap::new(), path())
            .await
            .err()
            .unwrap();
        assert_eq!(error.status, StatusCode::NOT_FOUND);
        let error = save(
            State(state.clone()),
            HeaderMap::new(),
            path(),
            Json(TrackPatch::default()),
        )
        .await
        .err()
        .unwrap();
        assert_eq!(error.status, StatusCode::NOT_FOUND);
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::COOKIE,
            "posterview_session=invalid".parse().unwrap(),
        );
        assert_eq!(
            get(State(state), headers, path())
                .await
                .err()
                .unwrap()
                .status,
            StatusCode::UNAUTHORIZED
        );
    }
    #[test]
    fn library_permission_is_required_before_reading_series_preferences() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        let mut user = state.auth.request_user(&HeaderMap::new()).unwrap();
        user.role = posterview_contracts::UserRole::User;
        user.permissions.all_libraries = false;
        user.permissions.library_ids.clear();
        assert!(crate::access::require_item(&state, &user, "private", "episode").is_err());
    }
}
