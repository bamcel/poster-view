//! User watch state is separate from catalog metadata and survives metadata refreshes.
//! SQLite transactions elect the latest playback session and reject stale reports.
mod series_tracks;
use crate::{AppState, HttpError};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::HeaderMap,
    http::StatusCode,
};
use posterview_contracts::native::{NativeCatalogEntry, NativeLibrary};
use posterview_infra_sqlite::ServerStore;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

fn failure(error: impl std::fmt::Display) -> HttpError {
    tracing::warn!(%error, "watch state operation failed");
    HttpError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        detail: "Unable to load or save watch information.".into(),
    }
}
fn conflict(message: &str) -> HttpError {
    HttpError {
        status: StatusCode::CONFLICT,
        detail: message.into(),
    }
}
fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn timestamp(milliseconds: i64) -> String {
    chrono::DateTime::from_timestamp_millis(milliseconds)
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339()
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub(crate) struct WatchState {
    pub version_id: Option<String>,
    pub position_seconds: f64,
    pub duration_seconds: f64,
    pub watched: bool,
    pub continue_dismissed: bool,
    pub play_count: u64,
    pub last_played_at: Option<String>,
    pub audio_index: Option<i64>,
    pub subtitle_index: Option<i64>,
    pub subtitle_delay_seconds: f64,
    pub session_id: Option<String>,
    pub version: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub(crate) struct ResumeRules {
    pub minimum_percentage: f64,
    pub maximum_percentage: f64,
    pub minimum_duration_seconds: f64,
}
impl Default for ResumeRules {
    fn default() -> Self {
        Self {
            minimum_percentage: 2.0,
            maximum_percentage: 90.0,
            minimum_duration_seconds: 120.0,
        }
    }
}
impl ResumeRules {
    fn validate(&self) -> Result<(), HttpError> {
        if !self.minimum_percentage.is_finite()
            || !self.maximum_percentage.is_finite()
            || !self.minimum_duration_seconds.is_finite()
            || !(0.0..=100.0).contains(&self.minimum_percentage)
            || !(0.0..=100.0).contains(&self.maximum_percentage)
            || self.minimum_percentage >= self.maximum_percentage
            || !(0.0..=86_400.0).contains(&self.minimum_duration_seconds)
        {
            return Err(HttpError::bad_request(
                "Resume thresholds must be finite, ordered percentages and a duration between 0 and 86400 seconds.",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub(crate) struct PlaybackPreferences {
    pub audio_languages: Vec<String>,
    pub subtitle_languages: Vec<String>,
    pub prefer_default_audio: bool,
    pub remember_audio: bool,
    pub remember_subtitles: bool,
    pub remember_series_tracks: bool,
    pub subtitle_mode: String,
    pub autoplay_next: bool,
    pub resume_rewind_seconds: u32,
    pub skip_back_seconds: u32,
    pub skip_forward_seconds: u32,
    pub still_watching_minutes: u32,
    pub still_watching_timeout_minutes: u32,
    pub up_next: bool,
    pub subtitle_size: u32,
    pub subtitle_color: String,
    pub subtitle_shadow: String,
    pub subtitle_background: String,
    pub subtitle_position: String,
}
impl Default for PlaybackPreferences {
    fn default() -> Self {
        Self {
            audio_languages: vec!["en".into()],
            subtitle_languages: vec!["en".into()],
            prefer_default_audio: true,
            remember_audio: true,
            remember_subtitles: true,
            remember_series_tracks: true,
            subtitle_mode: "default".into(),
            autoplay_next: true,
            resume_rewind_seconds: 5,
            skip_back_seconds: 10,
            skip_forward_seconds: 30,
            still_watching_minutes: 5,
            still_watching_timeout_minutes: 5,
            up_next: true,
            subtitle_size: 100,
            subtitle_color: "#ffffff".into(),
            subtitle_shadow: "none".into(),
            subtitle_background: "dark".into(),
            subtitle_position: "auto".into(),
        }
    }
}
impl PlaybackPreferences {
    fn validate(&self) -> Result<(), HttpError> {
        for values in [&self.audio_languages, &self.subtitle_languages] {
            if values.len() > 8
                || values.iter().any(|v| {
                    v.is_empty()
                        || v.len() > 24
                        || !v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                })
            {
                return Err(HttpError::bad_request(
                    "Choose at most eight valid language codes.",
                ));
            }
        }
        if ![
            "default",
            "smart",
            "forced",
            "hearing_impaired",
            "always",
            "off",
        ]
        .contains(&self.subtitle_mode.as_str())
            || self.resume_rewind_seconds > 60
            || !(1..=120).contains(&self.skip_back_seconds)
            || !(1..=120).contains(&self.skip_forward_seconds)
            || self.still_watching_minutes > 1_440
            || !(1..=1_440).contains(&self.still_watching_timeout_minutes)
            || !(50..=200).contains(&self.subtitle_size)
            || self.subtitle_color.len() != 7
            || !self.subtitle_color.starts_with('#')
            || !self.subtitle_color.as_bytes()[1..]
                .iter()
                .all(u8::is_ascii_hexdigit)
            || !["none", "drop", "outline"].contains(&self.subtitle_shadow.as_str())
            || !["none", "dark", "light"].contains(&self.subtitle_background.as_str())
            || !["auto", "top", "bottom"].contains(&self.subtitle_position.as_str())
        {
            return Err(HttpError::bad_request(
                "Playback preferences are out of range.",
            ));
        }
        Ok(())
    }
}

fn selection<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Option<i64>>, D::Error> {
    Option::<i64>::deserialize(d).map(Some)
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProgressInput {
    pub version_id: Option<String>,
    pub session_id: String,
    pub playback_session_id: Option<String>,
    pub sequence: u64,
    pub position_seconds: f64,
    pub duration_seconds: Option<f64>,
    #[serde(default)]
    pub paused: bool,
    #[serde(default)]
    pub ended: bool,
    #[serde(default)]
    pub seeking: bool,
    #[serde(default, deserialize_with = "selection")]
    pub audio_index: Option<Option<i64>>,
    #[serde(default, deserialize_with = "selection")]
    pub subtitle_index: Option<Option<i64>>,
    #[serde(default)]
    pub subtitle_delay_seconds: Option<f64>,
}
impl ProgressInput {
    fn validate(&self, duration: f64) -> Result<(), HttpError> {
        if self
            .version_id
            .as_ref()
            .is_some_and(|v| v.is_empty() || v.len() > 4096)
            || self.session_id.len() != 36
            || uuid::Uuid::parse_str(&self.session_id).is_err()
            || self.sequence > i64::MAX as u64
            || !self.position_seconds.is_finite()
            || self.position_seconds < 0.0
            || self.position_seconds > 7.0 * 86_400.0
            || self
                .duration_seconds
                .is_some_and(|v| !v.is_finite() || !(0.0..=7.0 * 86_400.0).contains(&v))
            || (duration > 0.0 && self.position_seconds > duration + 5.0)
            || self
                .audio_index
                .flatten()
                .is_some_and(|v| !(0..=1_024).contains(&v))
            || self
                .subtitle_index
                .flatten()
                .is_some_and(|v| !(-1..=1_024).contains(&v))
            || self
                .subtitle_delay_seconds
                .is_some_and(|v| !v.is_finite() || !(-60.0..=60.0).contains(&v))
        {
            return Err(HttpError::bad_request(
                "Invalid playback progress or track selection.",
            ));
        }
        Ok(())
    }
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ManualStateInput {
    pub watched: bool,
    #[serde(default = "yes")]
    pub clear_position: bool,
    #[serde(default)]
    pub reset_play_count: bool,
}
fn yes() -> bool {
    true
}
#[derive(Serialize)]
pub(crate) struct BeginResult {
    pub session_id: String,
    pub state: WatchState,
}
#[derive(Serialize)]
pub(crate) struct ContinueItem {
    pub library_id: String,
    pub library_name: String,
    pub item_id: String,
    pub series_item_id: Option<String>,
    pub title: String,
    pub kind: String,
    pub entry: NativeCatalogEntry,
    pub state: WatchState,
}

pub(crate) struct WatchStore {
    path: PathBuf,
}
struct VerifiedDuration<'a> {
    seconds: f64,
    signature: Option<&'a str>,
}
struct SessionProgress {
    session: Option<String>,
    sequence: i64,
    last_report: i64,
    last_position: f64,
    played: f64,
    counted: bool,
    raw_state: String,
}
impl WatchStore {
    pub(crate) fn new(path: PathBuf) -> Self {
        Self { path }
    }
    fn db(&self) -> Result<Connection, HttpError> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(failure)?;
        }
        let db = Connection::open(&self.path).map_err(failure)?;
        db.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(failure)?;
        db.execute_batch("PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS video_watch (
                user TEXT NOT NULL, library TEXT NOT NULL, item TEXT NOT NULL, state_json TEXT NOT NULL,
                active_session TEXT, last_sequence INTEGER NOT NULL DEFAULT -1,
                last_report_ms INTEGER NOT NULL DEFAULT 0, last_position REAL NOT NULL DEFAULT 0,
                played_seconds REAL NOT NULL DEFAULT 0, completed_counted INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY(user,library,item));
            CREATE TABLE IF NOT EXISTS video_preferences (user TEXT PRIMARY KEY, preferences_json TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS video_resume_rules (library TEXT PRIMARY KEY, rules_json TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS video_verified_durations (
                user TEXT NOT NULL, library TEXT NOT NULL, item TEXT NOT NULL,
                signature TEXT NOT NULL, duration REAL NOT NULL,
                PRIMARY KEY(user,library,item));")
            .map_err(failure)?;
        Ok(db)
    }
    fn state(
        db: &Connection,
        user: &str,
        library: &str,
        item: &str,
        duration: f64,
    ) -> Result<WatchState, HttpError> {
        let raw: Option<String> = db
            .query_row(
                "SELECT state_json FROM video_watch WHERE user=?1 AND library=?2 AND item=?3",
                params![user, library, item],
                |r| r.get(0),
            )
            .optional()
            .map_err(failure)?;
        let mut state = match raw {
            Some(raw) => serde_json::from_str(&raw).map_err(failure)?,
            None => WatchState::default(),
        };
        // A previously verified playback duration remains usable if a scan has no duration.
        if duration > 0.0 {
            state.duration_seconds = duration;
        }
        if duration > 0.0 {
            state.position_seconds = state.position_seconds.min(duration);
        }
        Ok(state)
    }
    fn write_state(
        db: &Connection,
        user: &str,
        library: &str,
        item: &str,
        state: &WatchState,
    ) -> Result<(), HttpError> {
        db.execute(
            "INSERT INTO video_watch(user,library,item,state_json) VALUES(?1,?2,?3,?4)
            ON CONFLICT(user,library,item) DO UPDATE SET state_json=excluded.state_json",
            params![
                user,
                library,
                item,
                serde_json::to_string(state).map_err(failure)?
            ],
        )
        .map_err(failure)?;
        Ok(())
    }
    pub(crate) fn get(
        &self,
        user: &str,
        library: &str,
        item: &str,
        duration: f64,
    ) -> Result<WatchState, HttpError> {
        Self::state(&self.db()?, user, library, item, duration)
    }
    fn dismiss_continue(&self, user: &str, library: &str, item: &str) -> Result<(), HttpError> {
        let mut db = self.db()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(failure)?;
        let raw: Option<String> = tx
            .query_row(
                "SELECT state_json FROM video_watch WHERE user=?1 AND library=?2 AND item=?3",
                params![user, library, item],
                |row| row.get(0),
            )
            .optional()
            .map_err(failure)?;
        // Keep unknown/private JSON fields and all playback/history values intact.
        let mut value = match raw {
            Some(raw) => serde_json::from_str::<serde_json::Value>(&raw).map_err(failure)?,
            None => serde_json::to_value(WatchState::default()).map_err(failure)?,
        };
        let active: Option<String> = tx
            .query_row(
                "SELECT active_session FROM video_watch WHERE user=?1 AND library=?2 AND item=?3",
                params![user, library, item],
                |row| row.get(0),
            )
            .optional()
            .map_err(failure)?
            .flatten();
        value["continue_dismissed"] = serde_json::json!(true);
        value["_continue_dismissed_session"] = serde_json::json!(active);
        tx.execute("INSERT INTO video_watch(user,library,item,state_json) VALUES(?1,?2,?3,?4) ON CONFLICT(user,library,item) DO UPDATE SET state_json=excluded.state_json", params![user,library,item,value.to_string()]).map_err(failure)?;
        tx.commit().map_err(failure)?;
        Ok(())
    }
    #[cfg(test)]
    pub(crate) fn begin_at(
        &self,
        user: &str,
        library: &str,
        item: &str,
        duration: f64,
        now: i64,
    ) -> Result<BeginResult, HttpError> {
        self.begin_version_at(user, library, item, duration, now, None)
    }
    fn begin_version_at(
        &self,
        user: &str,
        library: &str,
        item: &str,
        duration: f64,
        now: i64,
        version_id: Option<&str>,
    ) -> Result<BeginResult, HttpError> {
        let mut db = self.db()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(failure)?;
        let mut state = Self::state(&tx, user, library, item, duration)?;
        if let Some(version) = version_id {
            if state
                .version_id
                .as_deref()
                .is_some_and(|saved| saved != version)
            {
                state.position_seconds = 0.0;
                state.audio_index = None;
                state.subtitle_index = None;
                state.subtitle_delay_seconds = 0.0;
            }
            state.version_id = Some(version.to_owned());
        }
        let session_id = uuid::Uuid::new_v4().to_string();
        state.session_id = Some(session_id.clone());
        state.version += 1;
        // Opening a player does not manufacture a viewing event or clear a watched flag.
        Self::write_state(&tx, user, library, item, &state)?;
        tx.execute("UPDATE video_watch SET active_session=?4,last_sequence=-1,last_report_ms=?5,last_position=?6,
            played_seconds=0,completed_counted=0 WHERE user=?1 AND library=?2 AND item=?3",
            params![user, library, item, session_id, now, state.position_seconds]).map_err(failure)?;
        tx.commit().map_err(failure)?;
        Ok(BeginResult { session_id, state })
    }
    #[cfg(test)]
    pub(crate) fn report_at(
        &self,
        user: &str,
        library: &str,
        item: &str,
        duration: f64,
        input: ProgressInput,
        now: i64,
    ) -> Result<WatchState, HttpError> {
        self.report_verified_at(
            user,
            library,
            item,
            VerifiedDuration {
                seconds: duration,
                signature: None,
            },
            input,
            now,
        )
    }
    fn report_verified_at(
        &self,
        user: &str,
        library: &str,
        item: &str,
        verified: VerifiedDuration<'_>,
        input: ProgressInput,
        now: i64,
    ) -> Result<WatchState, HttpError> {
        let VerifiedDuration {
            seconds: duration,
            signature,
        } = verified;
        input.validate(duration)?;
        let mut db = self.db()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(failure)?;
        let row = tx.query_row(
            "SELECT active_session,last_sequence,last_report_ms,last_position,played_seconds,completed_counted,state_json
                FROM video_watch WHERE user=?1 AND library=?2 AND item=?3",
            params![user, library, item], |r| Ok(SessionProgress {
                session: r.get(0)?, sequence: r.get(1)?, last_report: r.get(2)?,
                last_position: r.get(3)?, played: r.get(4)?, counted: r.get(5)?, raw_state: r.get(6)?,
            })).optional().map_err(failure)?;
        let Some(SessionProgress {
            session,
            sequence,
            last_report,
            last_position,
            played,
            counted,
            raw_state,
        }) = row
        else {
            return Err(conflict(
                "Start a playback session before reporting progress.",
            ));
        };
        if session.as_deref() != Some(input.session_id.as_str()) {
            return Err(conflict(
                "A newer playback session or manual watch change superseded this session.",
            ));
        }
        if input.sequence as i64 <= sequence {
            return Err(conflict(
                "This playback progress report is older than the saved report.",
            ));
        }
        let mut state = Self::state(&tx, user, library, item, duration)?;
        if input
            .version_id
            .as_ref()
            .is_some_and(|version| state.version_id.as_ref() != Some(version))
        {
            return Err(conflict("The playback version changed. Reopen this video."));
        }
        let rules = Self::rules_from(&tx, &format!("{user}:{library}"))?;
        let position = if duration > 0.0 {
            input.position_seconds.min(duration)
        } else {
            input.position_seconds
        };
        let elapsed = ((now - last_report).max(0) as f64 / 1_000.0).min(30.0);
        let advanced = position - last_position;
        // Up to 4x playback is supported. A seek larger than elapsed playback cannot count as viewing.
        let credited = if !input.seeking && advanced > 0.0 && advanced <= elapsed * 4.0 + 2.0 {
            advanced.min(elapsed * 4.0)
        } else {
            0.0
        };
        let played = played + credited;
        let percentage = if duration > 0.0 {
            position * 100.0 / duration
        } else {
            0.0
        };
        let actual_playback = played >= 30.0_f64.min(duration * 0.05).max(1.0);
        // Existing viewing credit must not turn a later seek/paused heartbeat
        // into completion. A zero-delta EOF can follow a genuine final progress
        // report; counted sessions also retain their completed zero position.
        // Keep this report marker private in the existing JSON column. Wall-clock
        // timestamps can collide; the monotonic sequence identifies the exact report.
        let previous_viewed_sequence = serde_json::from_str::<serde_json::Value>(&raw_state)
            .map_err(failure)?["_last_viewed_sequence"]
            .as_u64();
        let previous_report_viewed =
            sequence >= 0 && previous_viewed_sequence == Some(sequence as u64);
        let valid_ended = input.ended && advanced.abs() <= 2.0 && previous_report_viewed;
        let completion_eligible = !input.seeking && (credited > 0.0 || valid_ended || counted);
        let finished = duration > 0.0
            && completion_eligible
            && actual_playback
            && (percentage >= rules.maximum_percentage
                || (input.ended && duration - position <= 2.0));
        if finished {
            state.watched = true;
            state.position_seconds = 0.0;
            if !counted {
                state.play_count += 1;
            }
        } else if duration == 0.0
            || (duration >= rules.minimum_duration_seconds
                && percentage >= rules.minimum_percentage)
        {
            state.position_seconds = position;
        } else {
            state.position_seconds = 0.0;
        }
        if credited > 0.0 {
            state.last_played_at = Some(timestamp(now));
        }
        let reset_session = serde_json::from_str::<serde_json::Value>(&raw_state)
            .map_err(failure)?["_track_reset_session"]
            .as_str()
            .map(str::to_owned);
        // Clearing saved selections must survive ordinary reports from an already-open player.
        // That player retains its current tracks, while a newly opened session can save choices.
        if reset_session.as_deref() != Some(input.session_id.as_str()) {
            if let Some(index) = input.audio_index {
                state.audio_index = index;
            }
            if let Some(index) = input.subtitle_index {
                state.subtitle_index = index;
            }
        }
        if let Some(delay) = input.subtitle_delay_seconds {
            state.subtitle_delay_seconds = delay;
        }
        let dismissed_session = serde_json::from_str::<serde_json::Value>(&raw_state)
            .map_err(failure)?["_continue_dismissed_session"]
            .as_str()
            .map(str::to_owned);
        // Only genuinely watching in a newly opened player restores a dismissed card.
        // Existing players, paused reports and seeks must not undo the user's action.
        if credited > 0.0
            && !input.paused
            && dismissed_session.as_deref() != Some(input.session_id.as_str())
        {
            state.continue_dismissed = false;
        }
        state.version += 1;
        let mut stored_state = serde_json::to_value(&state).map_err(failure)?;
        if state.continue_dismissed {
            if let Some(session) = dismissed_session {
                stored_state["_continue_dismissed_session"] = serde_json::json!(session);
            }
        }
        if let Some(session) = reset_session.filter(|s| s == &input.session_id) {
            stored_state["_track_reset_session"] = serde_json::json!(session);
        }
        if credited > 0.0 {
            stored_state["_last_viewed_sequence"] = serde_json::json!(input.sequence);
        }
        if let Some(signature) = signature.filter(|_| duration.is_finite() && duration > 0.0) {
            tx.execute("INSERT INTO video_verified_durations(user,library,item,signature,duration) VALUES(?1,?2,?3,?4,?5)
                ON CONFLICT(user,library,item) DO UPDATE SET signature=excluded.signature,duration=excluded.duration",
                params![user, library, item, signature, duration]).map_err(failure)?;
        }
        tx.execute("UPDATE video_watch SET last_sequence=?4,last_report_ms=?5,last_position=?6,played_seconds=?7,
            completed_counted=?8,state_json=?9 WHERE user=?1 AND library=?2 AND item=?3",
            params![user, library, item, input.sequence as i64, now, position, played, counted || finished, stored_state.to_string()]).map_err(failure)?;
        // Keep the token through a stopped/ended report for idempotent subsequent reports. The next
        // begin or manual edit supersedes it. This also tolerates cleanup heartbeats after `ended`.
        let _ = input.paused;
        tx.commit().map_err(failure)?;
        Ok(state)
    }
    pub(crate) fn manual(
        &self,
        user: &str,
        library: &str,
        item: &str,
        duration: f64,
        input: ManualStateInput,
    ) -> Result<WatchState, HttpError> {
        let mut db = self.db()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(failure)?;
        let mut state = Self::state(&tx, user, library, item, duration)?;
        state.watched = input.watched;
        if input.clear_position || input.watched {
            state.position_seconds = 0.0;
        }
        if input.reset_play_count {
            state.play_count = 0;
        }
        state.session_id = None;
        state.version += 1;
        Self::write_state(&tx, user, library, item, &state)?;
        tx.execute("UPDATE video_watch SET active_session=NULL,last_sequence=-1 WHERE user=?1 AND library=?2 AND item=?3",
            params![user, library, item]).map_err(failure)?;
        tx.commit().map_err(failure)?;
        Ok(state)
    }
    pub(crate) fn preferences(&self, user: &str) -> Result<PlaybackPreferences, HttpError> {
        let raw: Option<String> = self
            .db()?
            .query_row(
                "SELECT preferences_json FROM video_preferences WHERE user=?1",
                [user],
                |r| r.get(0),
            )
            .optional()
            .map_err(failure)?;
        match raw {
            Some(raw) => serde_json::from_str(&raw).map_err(failure),
            None => Ok(PlaybackPreferences::default()),
        }
    }
    pub(crate) fn save_preferences(
        &self,
        user: &str,
        prefs: PlaybackPreferences,
    ) -> Result<PlaybackPreferences, HttpError> {
        prefs.validate()?;
        self.db()?
            .execute(
                "INSERT INTO video_preferences(user,preferences_json) VALUES(?1,?2)
            ON CONFLICT(user) DO UPDATE SET preferences_json=excluded.preferences_json",
                params![user, serde_json::to_string(&prefs).map_err(failure)?],
            )
            .map_err(failure)?;
        Ok(prefs)
    }
    fn rules_from(db: &Connection, library: &str) -> Result<ResumeRules, HttpError> {
        let raw: Option<String> = db
            .query_row(
                "SELECT rules_json FROM video_resume_rules WHERE library=?1",
                [library],
                |r| r.get(0),
            )
            .optional()
            .map_err(failure)?;
        match raw {
            Some(raw) => serde_json::from_str(&raw).map_err(failure),
            None => Ok(ResumeRules::default()),
        }
    }
    pub(crate) fn rules(&self, library: &str) -> Result<ResumeRules, HttpError> {
        Self::rules_from(&self.db()?, library)
    }
    pub(crate) fn save_rules(
        &self,
        library: &str,
        rules: ResumeRules,
    ) -> Result<ResumeRules, HttpError> {
        rules.validate()?;
        self.db()?
            .execute(
                "INSERT INTO video_resume_rules(library,rules_json) VALUES(?1,?2)
            ON CONFLICT(library) DO UPDATE SET rules_json=excluded.rules_json",
                params![library, serde_json::to_string(&rules).map_err(failure)?],
            )
            .map_err(failure)?;
        Ok(rules)
    }
    fn verified_duration(
        &self,
        user: &str,
        library: &str,
        item: &str,
        signature: &str,
    ) -> Result<Option<f64>, HttpError> {
        let value: Option<f64> = self
            .db()?
            .query_row(
                "SELECT duration FROM video_verified_durations
            WHERE user=?1 AND library=?2 AND item=?3 AND signature=?4",
                params![user, library, item, signature],
                |r| r.get(0),
            )
            .optional()
            .map_err(failure)?;
        Ok(value.filter(|v| v.is_finite() && *v > 0.0))
    }
    fn library_states(
        &self,
        user: &str,
        library: &str,
    ) -> Result<std::collections::BTreeMap<String, WatchState>, HttpError> {
        let db = self.db()?;
        let mut query = db
            .prepare("SELECT item,state_json FROM video_watch WHERE user=?1 AND library=?2")
            .map_err(failure)?;
        let rows = query
            .query_map(params![user, library], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(failure)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(failure)?;
        rows.into_iter()
            .map(|(id, raw)| {
                serde_json::from_str(&raw)
                    .map(|state| (id, state))
                    .map_err(failure)
            })
            .collect()
    }
    fn recent(&self, user: &str) -> Result<Vec<(String, String, WatchState)>, HttpError> {
        let db = self.db()?;
        let mut statement = db
            .prepare("SELECT library,item,state_json FROM video_watch WHERE user=?1")
            .map_err(failure)?;
        let rows = statement
            .query_map([user], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(failure)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(failure)?;
        let mut result = Vec::new();
        for (library, item, json) in rows {
            let state: WatchState = serde_json::from_str(&json).map_err(failure)?;
            // A previously watched title can still have an interrupted rewatch to resume.
            if state.last_played_at.is_some() {
                result.push((library, item, state));
            }
        }
        result.sort_by(|a, b| b.2.last_played_at.cmp(&a.2.last_played_at));
        Ok(result)
    }
}

fn store(state: &AppState) -> WatchStore {
    WatchStore::new(state.runtime.data_dir().join("watch.sqlite"))
}
fn number(value: &serde_json::Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|s| s.parse::<f64>().ok()))
        .filter(|n| n.is_finite() && *n > 0.0)
}
fn probe_duration(entry: &NativeCatalogEntry) -> Option<f64> {
    entry
        .files
        .first()
        .and_then(|file| number(&file["media_info"]["format"]["duration"]))
        .or_else(|| {
            entry
                .files
                .first()
                .and_then(|file| file["media_info"]["streams"].as_array())
                .and_then(|streams| {
                    streams
                        .iter()
                        .filter(|s| s["codec_type"] == "video" || s["codec_type"] == "audio")
                        .filter_map(|s| number(&s["duration"]))
                        .max_by(f64::total_cmp)
                })
        })
}
pub(crate) fn duration(entry: &NativeCatalogEntry) -> f64 {
    probe_duration(entry)
        .or_else(|| number(&entry.metadata["runtime"]).map(|minutes| minutes * 60.0))
        .unwrap_or(0.0)
}
fn catalog_signature(entry: &NativeCatalogEntry) -> String {
    let file = entry.files.first().unwrap_or(&serde_json::Value::Null);
    serde_json::json!([
        entry.path,
        file["path"],
        file["size"],
        file["mtime_ns"],
        file["modified"]
    ])
    .to_string()
}
fn select_version(entry: &mut NativeCatalogEntry, version: Option<&str>) -> Result<(), HttpError> {
    if let Some(version) = version {
        let index = entry
            .files
            .iter()
            .position(|file| file["path"].as_str() == Some(version))
            .ok_or_else(|| HttpError::bad_request("This video version is unavailable."))?;
        entry.files.swap(0, index);
    }
    Ok(())
}
#[derive(Default, Deserialize)]
pub(crate) struct VersionQuery {
    pub version_id: Option<String>,
}
fn resolved_duration(
    store: &WatchStore,
    user: &str,
    library: &str,
    entry: &NativeCatalogEntry,
) -> Result<f64, HttpError> {
    if let Some(duration) =
        store.verified_duration(user, library, &entry.id, &catalog_signature(entry))?
    {
        return Ok(duration);
    }
    if let Some(duration) = probe_duration(entry) {
        return Ok(duration);
    }
    let saved_state = store.get(user, library, &entry.id, 0.0)?;
    let saved =
        if saved_state.version_id.as_deref().is_none_or(|version| {
            entry.files.first().and_then(|f| f["path"].as_str()) == Some(version)
        }) {
            saved_state.duration_seconds
        } else {
            0.0
        };
    Ok(if saved > 0.0 { saved } else { duration(entry) })
}
fn video(state: &AppState, library: &str, item: &str) -> Result<NativeCatalogEntry, HttpError> {
    ServerStore::new(state.runtime.data_dir())
        .native_catalog_item(library, item)
        .map_err(failure)?
        .filter(|e| {
            e.available
                && ["movie", "episode"].contains(&e.kind.as_str())
                && e.metadata["missing"] != true
        })
        .ok_or_else(HttpError::not_found)
}
fn library(state: &AppState, id: &str) -> Result<NativeLibrary, HttpError> {
    ServerStore::new(state.runtime.data_dir())
        .native_libraries()
        .map_err(failure)?
        .into_iter()
        .find(|l| l.id == id)
        .ok_or_else(HttpError::not_found)
}
pub(crate) async fn get_state(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((library, item)): Path<(String, String)>,
) -> Result<Json<WatchState>, HttpError> {
    let user = state.auth.request_user(&headers)?;
    tokio::task::spawn_blocking(move || {
        crate::access::require_item(&state, &user, &library, &item)?;
        let mut entry = video(&state, &library, &item)?;
        let store = store(&state);
        let saved = store.get(&user.id, &library, &item, 0.0)?;
        if let Some(version) = saved.version_id.as_deref() {
            let _ = select_version(&mut entry, Some(version));
        }
        let duration = resolved_duration(&store, &user.id, &library, &entry)?;
        store.get(&user.id, &library, &item, duration).map(Json)
    })
    .await
    .map_err(failure)?
}
pub(crate) async fn begin(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((library, item)): Path<(String, String)>,
    Query(query): Query<VersionQuery>,
) -> Result<Json<BeginResult>, HttpError> {
    let user = state.auth.request_user(&headers)?;
    tokio::task::spawn_blocking(move || {
        crate::access::require_item(&state, &user, &library, &item)?;
        let mut entry = video(&state, &library, &item)?;
        select_version(&mut entry, query.version_id.as_deref())?;
        let store = store(&state);
        let duration = resolved_duration(&store, &user.id, &library, &entry)?;
        let version = entry.files.first().and_then(|file| file["path"].as_str());
        store
            .begin_version_at(&user.id, &library, &item, duration, now_ms(), version)
            .map(Json)
    })
    .await
    .map_err(failure)?
}
pub(crate) async fn progress(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((library, item)): Path<(String, String)>,
    Json(mut input): Json<ProgressInput>,
) -> Result<Json<WatchState>, HttpError> {
    let user = state.auth.request_user(&headers)?;
    let playback_duration = if let Some(id) = &input.playback_session_id {
        if let Some((source_library, source_item, duration)) =
            state.playback.session_details_for(id, &user.id).await?
        {
            if source_library != library || source_item != item {
                return Err(HttpError::bad_request(
                    "The playback session belongs to a different video.",
                ));
            }
            if duration.is_finite() && duration > 0.0 {
                Some(duration)
            } else {
                None
            }
        } else {
            // Watch ownership is independent of conversion jobs. A job may stop while its final
            // heartbeat is in flight; retain server/catalog duration and still reject stale watch IDs.
            None
        }
    } else {
        None
    };
    tokio::task::spawn_blocking(move || {
        crate::access::require_item(&state, &user, &library, &item)?;
        let mut entry = video(&state, &library, &item)?;
        select_version(&mut entry, input.version_id.as_deref())?;
        input.version_id = entry
            .files
            .first()
            .and_then(|file| file["path"].as_str())
            .map(str::to_owned);
        // Playback creation validates actual source tracks. Catalog stream indices can be stale
        // after a file replacement; rejecting them here would lose otherwise valid watch progress.
        // Bounds are still validated and remembered selections absent from the live file are ignored.
        let store = store(&state);
        let duration = match playback_duration {
            Some(duration) => duration,
            None => resolved_duration(&store, &user.id, &library, &entry)?,
        };
        let signature = playback_duration.map(|_| catalog_signature(&entry));
        store
            .report_verified_at(
                &user.id,
                &library,
                &item,
                VerifiedDuration {
                    seconds: duration,
                    signature: signature.as_deref(),
                },
                input,
                now_ms(),
            )
            .map(Json)
    })
    .await
    .map_err(failure)?
}
pub(crate) async fn set_state(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((library, item)): Path<(String, String)>,
    Json(input): Json<ManualStateInput>,
) -> Result<Json<WatchState>, HttpError> {
    let user = state.auth.request_user(&headers)?;
    tokio::task::spawn_blocking(move || {
        crate::access::require_item(&state, &user, &library, &item)?;
        let mut entry = video(&state, &library, &item)?;
        let store = store(&state);
        let saved = store.get(&user.id, &library, &item, 0.0)?;
        if let Some(version) = saved.version_id.as_deref() {
            let _ = select_version(&mut entry, Some(version));
        }
        let duration = resolved_duration(&store, &user.id, &library, &entry)?;
        store
            .manual(&user.id, &library, &item, duration, input)
            .map(Json)
    })
    .await
    .map_err(failure)?
}
pub(crate) async fn dismiss_continue(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((library, item)): Path<(String, String)>,
) -> Result<StatusCode, HttpError> {
    let user = state.auth.request_user(&headers)?;
    tokio::task::spawn_blocking(move || {
        crate::access::require_item(&state, &user, &library, &item)?;
        video(&state, &library, &item)?;
        store(&state).dismiss_continue(&user.id, &library, &item)?;
        Ok(StatusCode::NO_CONTENT)
    })
    .await
    .map_err(failure)?
}
fn series_item_id(
    catalog: &ServerStore,
    library: &str,
    entry: &NativeCatalogEntry,
) -> Result<Option<String>, HttpError> {
    if entry.kind != "episode" {
        return Ok(None);
    }
    let Some(parent) = entry
        .parent_path
        .as_deref()
        .map(|path| catalog.native_catalog_path(library, path))
        .transpose()
        .map_err(failure)?
        .flatten()
    else {
        return Ok(None);
    };
    if parent.kind == "series" {
        return Ok(Some(parent.id));
    }
    if parent.kind != "season" {
        return Ok(None);
    }
    Ok(parent
        .parent_path
        .as_deref()
        .map(|path| catalog.native_catalog_path(library, path))
        .transpose()
        .map_err(failure)?
        .flatten()
        .filter(|series| series.kind == "series")
        .map(|series| series.id))
}
pub(crate) async fn continue_watching(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<ContinueItem>>, HttpError> {
    let user = state.auth.request_user(&headers)?;
    tokio::task::spawn_blocking(move || {
        let catalog = ServerStore::new(state.runtime.data_dir());
        let libraries = catalog.native_libraries().map_err(failure)?;
        let mut result = Vec::new();
        let watch_store = store(&state);
        for (library_id, item_id, mut saved) in watch_store.recent(&user.id)? {
            if !crate::access::allows_item(&state, &user, &library_id, &item_id) {
                continue;
            }
            let Some(lib) = libraries.iter().find(|l| l.id == library_id) else {
                continue;
            };
            let Some(mut entry) = catalog
                .native_catalog_item(&library_id, &item_id)
                .map_err(failure)?
                .filter(|e| {
                    e.available
                        && ["movie", "episode"].contains(&e.kind.as_str())
                        && e.metadata["missing"] != true
                })
            else {
                continue;
            };
            if let Some(version) = saved.version_id.as_deref() {
                let _ = select_version(&mut entry, Some(version));
            }
            saved.duration_seconds =
                resolved_duration(&watch_store, &user.id, &library_id, &entry)?;
            if saved.continue_dismissed
                || saved.position_seconds <= 0.0
                || (saved.duration_seconds > 0.0
                    && saved.position_seconds >= saved.duration_seconds)
            {
                continue;
            }
            // Home cards need identification/artwork, not full ffprobe dumps or NFO source XML.
            entry.files.clear();
            entry.nfo_xml = None;
            let series_item_id = series_item_id(&catalog, &library_id, &entry)?
                .filter(|id| crate::access::allows_item(&state, &user, &library_id, id));
            result.push(ContinueItem {
                series_item_id,
                library_id,
                library_name: lib.name.clone(),
                item_id,
                title: entry.title.clone(),
                kind: entry.kind.clone(),
                entry,
                state: saved,
            });
            if result.len() == 30 {
                break;
            }
        }
        Ok(Json(result))
    })
    .await
    .map_err(failure)?
}
pub(crate) async fn history(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<ContinueItem>>, HttpError> {
    let user = state.auth.request_user(&headers)?;
    tokio::task::spawn_blocking(move || {
        let catalog = ServerStore::new(state.runtime.data_dir());
        let libraries = catalog.native_libraries().map_err(failure)?;
        let mut result = Vec::new();
        let watch_store = store(&state);
        for (library_id, item_id, mut saved) in watch_store.recent(&user.id)? {
            if !crate::access::allows_item(&state, &user, &library_id, &item_id) {
                continue;
            }
            let Some(lib) = libraries.iter().find(|l| l.id == library_id) else {
                continue;
            };
            let Some(mut entry) = catalog
                .native_catalog_item(&library_id, &item_id)
                .map_err(failure)?
                .filter(|e| {
                    e.available
                        && ["movie", "episode"].contains(&e.kind.as_str())
                        && e.metadata["missing"] != true
                })
            else {
                continue;
            };
            if let Some(version) = saved.version_id.as_deref() {
                let _ = select_version(&mut entry, Some(version));
            }
            saved.duration_seconds =
                resolved_duration(&watch_store, &user.id, &library_id, &entry)?;

            // Home cards need identification/artwork, not full ffprobe dumps or NFO source XML.
            entry.files.clear();
            entry.nfo_xml = None;
            let series_item_id = series_item_id(&catalog, &library_id, &entry)?
                .filter(|id| crate::access::allows_item(&state, &user, &library_id, id));
            result.push(ContinueItem {
                series_item_id,
                library_id,
                library_name: lib.name.clone(),
                item_id,
                title: entry.title.clone(),
                kind: entry.kind.clone(),
                entry,
                state: saved,
            });
            if result.len() == 200 {
                break;
            }
        }
        Ok(Json(result))
    })
    .await
    .map_err(failure)?
}
pub(crate) async fn library_states(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<std::collections::BTreeMap<String, WatchState>>, HttpError> {
    let user = state.auth.request_user(&headers)?;
    tokio::task::spawn_blocking(move || {
        library(&state, &id)?;
        let mut saved = store(&state).library_states(&user.id, &id)?;
        saved.retain(|item, _| crate::access::allows_item(&state, &user, &id, item));
        Ok(Json(saved))
    })
    .await
    .map_err(failure)?
}
pub(crate) async fn get_preferences(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<PlaybackPreferences>, HttpError> {
    let user = state.auth.request_user(&headers)?;
    tokio::task::spawn_blocking(move || store(&state).preferences(&user.id).map(Json))
        .await
        .map_err(failure)?
}
pub(crate) async fn save_preferences(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(prefs): Json<PlaybackPreferences>,
) -> Result<Json<PlaybackPreferences>, HttpError> {
    let user = state.auth.request_user(&headers)?;
    tokio::task::spawn_blocking(move || store(&state).save_preferences(&user.id, prefs).map(Json))
        .await
        .map_err(failure)?
}
pub(crate) async fn get_rules(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<ResumeRules>, HttpError> {
    let user = state.auth.request_user(&headers)?;
    tokio::task::spawn_blocking(move || {
        library(&state, &id)?;
        store(&state).rules(&format!("{}:{id}", user.id)).map(Json)
    })
    .await
    .map_err(failure)?
}
pub(crate) async fn save_rules(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(rules): Json<ResumeRules>,
) -> Result<Json<ResumeRules>, HttpError> {
    let user = state.auth.request_user(&headers)?;
    tokio::task::spawn_blocking(move || {
        library(&state, &id)?;
        store(&state)
            .save_rules(&format!("{}:{id}", user.id), rules)
            .map(Json)
    })
    .await
    .map_err(failure)?
}

pub(crate) fn routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route(
            "/api/playback/track-selections",
            axum::routing::delete(series_tracks::clear),
        )
        .route(
            "/api/watch/native/{library}/{item}/series-tracks",
            axum::routing::get(series_tracks::get).put(series_tracks::save),
        )
        .route("/api/watch/history", axum::routing::get(history))
        .route(
            "/api/watch/native/{library}/{item}",
            axum::routing::get(get_state).put(set_state),
        )
        .route(
            "/api/watch/native/{library}/{item}/begin",
            axum::routing::post(begin),
        )
        .route(
            "/api/watch/native/{library}/{item}/progress",
            axum::routing::put(progress),
        )
        .route("/api/watch/continue", axum::routing::get(continue_watching))
        .route(
            "/api/watch/native/{library}/{item}/continue",
            axum::routing::delete(dismiss_continue),
        )
        .route(
            "/api/watch/libraries/{library}/rules",
            axum::routing::get(get_rules).put(save_rules),
        )
        .route(
            "/api/watch/libraries/{library}/states",
            axum::routing::get(library_states),
        )
        .route(
            "/api/playback/preferences",
            axum::routing::get(get_preferences).put(save_preferences),
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input(session: &str, sequence: u64, position: f64) -> ProgressInput {
        ProgressInput {
            version_id: None,
            session_id: session.into(),
            playback_session_id: None,
            sequence,
            position_seconds: position,
            duration_seconds: None,
            paused: false,
            ended: false,
            seeking: false,
            audio_index: None,
            subtitle_index: None,
            subtitle_delay_seconds: None,
        }
    }
    #[test]
    fn continue_dismissal_is_personal_preserves_resume_and_requires_new_viewing() {
        let temp = tempfile::tempdir().unwrap();
        let store = WatchStore::new(temp.path().join("watch.sqlite"));
        let first = store.begin_at("one", "l", "i", 1000.0, 0).unwrap();
        let mut report = input(&first.session_id, 0, 60.0);
        report.audio_index = Some(Some(3));
        report.subtitle_index = Some(Some(7));
        let before = store
            .report_at("one", "l", "i", 1000.0, report, 30_000)
            .unwrap();
        store.dismiss_continue("one", "l", "i").unwrap();
        let hidden = store.get("one", "l", "i", 1000.0).unwrap();
        assert!(hidden.continue_dismissed);
        assert_eq!(
            (
                hidden.position_seconds,
                hidden.audio_index,
                hidden.subtitle_index,
                hidden.watched,
                hidden.play_count,
                hidden.last_played_at
            ),
            (
                before.position_seconds,
                before.audio_index,
                before.subtitle_index,
                before.watched,
                before.play_count,
                before.last_played_at
            )
        );
        assert!(
            !store
                .get("two", "l", "i", 1000.0)
                .unwrap()
                .continue_dismissed
        );
        assert_eq!(store.recent("one").unwrap().len(), 1);
        let stale = store
            .report_at(
                "one",
                "l",
                "i",
                1000.0,
                input(&first.session_id, 1, 70.0),
                40_000,
            )
            .unwrap();
        assert!(stale.continue_dismissed);
        // A paused or seeking report in a new session is still not viewing.
        let next = store.begin_at("one", "l", "i", 1000.0, 50_000).unwrap();
        assert!(next.state.continue_dismissed);
        let mut paused = input(&next.session_id, 0, 75.0);
        paused.paused = true;
        assert!(
            store
                .report_at("one", "l", "i", 1000.0, paused, 60_000)
                .unwrap()
                .continue_dismissed
        );
        let mut seeking = input(&next.session_id, 1, 400.0);
        seeking.seeking = true;
        assert!(
            store
                .report_at("one", "l", "i", 1000.0, seeking, 70_000)
                .unwrap()
                .continue_dismissed
        );
        let viewed = store
            .report_at(
                "one",
                "l",
                "i",
                1000.0,
                input(&next.session_id, 2, 410.0),
                80_000,
            )
            .unwrap();
        assert!(!viewed.continue_dismissed);
        assert_eq!(viewed.position_seconds, 410.0);
        // Legacy JSON has no dismissal flag.
        assert!(
            !serde_json::from_str::<WatchState>("{}")
                .unwrap()
                .continue_dismissed
        );
    }
    #[tokio::test]
    async fn continue_removal_filters_only_continue_and_resolves_series() {
        use posterview_contracts::native::{AnimeContent, NativeLibraryInput, NativeLibraryType};
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        let db = ServerStore::new(state.runtime.data_dir());
        let lib = db
            .save_native_library(
                None,
                &NativeLibraryInput {
                    name: "TV".into(),
                    library_type: NativeLibraryType::Shows,
                    anime_content: AnimeContent::Both,
                    paths: vec!["TV".into()],
                    revision: None,
                    options: Default::default(),
                },
            )
            .unwrap();
        let entry = |path: &str, kind: &str, parent: Option<&str>| NativeCatalogEntry {
            id: String::new(),
            title: path.into(),
            kind: kind.into(),
            path: path.into(),
            parent_path: parent.map(str::to_owned),
            metadata: serde_json::json!({"runtime":20}),
            artwork: vec![],
            files: vec![],
            nfo_path: None,
            nfo_xml: None,
            available: true,
            revision: 1,
        };
        db.ingest_native_catalog(
            &lib.id,
            lib.revision,
            &[
                entry("TV/Show", "series", None),
                entry("TV/Show/S01", "season", Some("TV/Show")),
                entry("TV/Show/S01/E01.mkv", "episode", Some("TV/Show/S01")),
                entry("TV/Show/E02.mkv", "episode", Some("TV/Show")),
                entry("TV/Movie.mkv", "movie", None),
            ],
        )
        .unwrap();
        let catalog = db.native_catalog(&lib.id).unwrap();
        let series = catalog.iter().find(|e| e.kind == "series").unwrap();
        let episode = catalog
            .iter()
            .find(|e| e.path.ends_with("E01.mkv"))
            .unwrap();
        let user = state.auth.request_user(&HeaderMap::new()).unwrap();
        let watch = store(&state);
        for e in catalog
            .iter()
            .filter(|e| e.kind == "episode" || e.kind == "movie")
        {
            let session = watch.begin_at(&user.id, &lib.id, &e.id, 1200.0, 0).unwrap();
            watch
                .report_at(
                    &user.id,
                    &lib.id,
                    &e.id,
                    1200.0,
                    input(&session.session_id, 0, 60.0),
                    30_000,
                )
                .unwrap();
        }
        let items = continue_watching(State(state.clone()), HeaderMap::new())
            .await
            .unwrap()
            .0;
        assert_eq!(items.len(), 3);
        for item in &items {
            assert_eq!(
                item.series_item_id.as_deref(),
                if item.kind == "episode" {
                    Some(series.id.as_str())
                } else {
                    None
                }
            );
        }
        assert_eq!(
            dismiss_continue(
                State(state.clone()),
                HeaderMap::new(),
                Path((lib.id.clone(), episode.id.clone()))
            )
            .await
            .unwrap(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            continue_watching(State(state.clone()), HeaderMap::new())
                .await
                .unwrap()
                .0
                .len(),
            2
        );
        let history = history(State(state.clone()), HeaderMap::new())
            .await
            .unwrap()
            .0;
        assert_eq!(history.len(), 3);
        assert!(
            history
                .iter()
                .find(|item| item.item_id == episode.id)
                .unwrap()
                .state
                .continue_dismissed
        );
        assert!(
            dismiss_continue(
                State(state.clone()),
                HeaderMap::new(),
                Path((lib.id.clone(), "unknown".into()))
            )
            .await
            .is_err()
        );
        let mut protected = state;
        protected.auth = crate::AuthState::for_tests("continue-test-token");
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::COOKIE,
            "posterview_session=invalid".parse().unwrap(),
        );
        assert_eq!(
            dismiss_continue(
                State(protected),
                headers,
                Path((lib.id, episode.id.clone()))
            )
            .await
            .unwrap_err()
            .status,
            StatusCode::UNAUTHORIZED
        );
    }
    #[test]
    fn resume_pins_version_and_tracks_and_version_change_resets_timeline() {
        let temp = tempfile::tempdir().unwrap();
        let store = WatchStore::new(temp.path().join("watch.sqlite"));
        let first = store
            .begin_version_at("u", "l", "i", 1000.0, 0, Some("Movie - UHD.mkv"))
            .unwrap();
        let mut report = input(&first.session_id, 0, 60.0);
        report.version_id = Some("Movie - UHD.mkv".into());
        report.audio_index = Some(Some(3));
        report.subtitle_index = Some(Some(7));
        let saved = store
            .report_at("u", "l", "i", 1000.0, report, 30_000)
            .unwrap();
        assert_eq!(saved.version_id.as_deref(), Some("Movie - UHD.mkv"));
        let resumed = store
            .begin_version_at("u", "l", "i", 1000.0, 40_000, Some("Movie - UHD.mkv"))
            .unwrap();
        assert_eq!(
            (
                resumed.state.position_seconds,
                resumed.state.audio_index,
                resumed.state.subtitle_index
            ),
            (60.0, Some(3), Some(7))
        );
        let changed = store
            .begin_version_at(
                "u",
                "l",
                "i",
                1100.0,
                50_000,
                Some("Movie - Streamable.mp4"),
            )
            .unwrap();
        assert_eq!(
            (
                changed.state.position_seconds,
                changed.state.audio_index,
                changed.state.subtitle_index
            ),
            (0.0, None, None)
        );
        let mut stale = input(&first.session_id, 1, 65.0);
        stale.version_id = Some("Movie - UHD.mkv".into());
        assert!(
            store
                .report_at("u", "l", "i", 1100.0, stale, 60_000)
                .is_err()
        );
        let mut wrong = input(&changed.session_id, 0, 65.0);
        wrong.version_id = Some("Movie - UHD.mkv".into());
        assert!(
            store
                .report_at("u", "l", "i", 1100.0, wrong, 60_000)
                .is_err()
        );
    }
    #[test]
    fn version_selection_requires_catalog_membership_and_selects_duration() {
        let mut entry: NativeCatalogEntry = serde_json::from_value(serde_json::json!({
            "id":"i","path":"movie.mkv","kind":"movie","parent_path":null,"title":"Movie","metadata":{},"artwork":[],
            "files":[{"path":"movie.mkv","media_info":{"format":{"duration":"100"}}},{"path":"Movie - UHD.mkv","media_info":{"format":{"duration":"120"}}}],
            "nfo_path":null,"nfo_xml":null,"available":true,"revision":1
        })).unwrap();
        assert!(select_version(&mut entry, Some("../other.mkv")).is_err());
        select_version(&mut entry, Some("Movie - UHD.mkv")).unwrap();
        assert_eq!(duration(&entry), 120.0);
    }
    #[test]
    fn personal_history_includes_completed_titles_and_isolates_accounts() {
        let temp = tempfile::tempdir().unwrap();
        let store = WatchStore::new(temp.path().join("watch.sqlite"));
        let session = store
            .begin_at("one", "library", "item", 100.0, 0)
            .unwrap()
            .session_id;
        store
            .report_at(
                "one",
                "library",
                "item",
                100.0,
                input(&session, 0, 10.0),
                10_000,
            )
            .unwrap();
        assert_eq!(store.recent("one").unwrap().len(), 1);
        assert!(store.recent("two").unwrap().is_empty());
        assert_eq!(
            store
                .get("two", "library", "item", 100.0)
                .unwrap()
                .position_seconds,
            0.0
        );
        store
            .manual(
                "one",
                "library",
                "item",
                100.0,
                ManualStateInput {
                    watched: true,
                    clear_position: true,
                    reset_play_count: false,
                },
            )
            .unwrap();
        assert_eq!(store.recent("one").unwrap().len(), 1);
    }
    #[test]
    fn subtitle_appearance_defaults_legacy_json_and_survives_restart() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("watch.sqlite");
        let store = WatchStore::new(path.clone());
        let mut legacy = serde_json::to_value(PlaybackPreferences::default()).unwrap();
        for field in [
            "subtitle_color",
            "subtitle_shadow",
            "subtitle_background",
            "subtitle_position",
        ] {
            legacy.as_object_mut().unwrap().remove(field);
        }
        legacy["audio_languages"] = serde_json::json!(["ja", "en"]);
        store
            .db()
            .unwrap()
            .execute(
                "INSERT INTO video_preferences(user,preferences_json) VALUES(?1,?2)",
                params!["legacy", legacy.to_string()],
            )
            .unwrap();
        let loaded = store.preferences("legacy").unwrap();
        assert_eq!(loaded.audio_languages, ["ja", "en"]);
        assert_eq!(loaded.subtitle_color, "#ffffff");
        assert_eq!(loaded.subtitle_shadow, "none");
        assert_eq!(loaded.subtitle_background, "dark");
        assert_eq!(loaded.subtitle_position, "auto");
        store
            .save_preferences(
                "legacy",
                PlaybackPreferences {
                    subtitle_color: "#F9E23A".into(),
                    subtitle_shadow: "outline".into(),
                    subtitle_background: "none".into(),
                    subtitle_position: "top".into(),
                    ..loaded
                },
            )
            .unwrap();
        let reloaded = WatchStore::new(path);
        let prefs = reloaded.preferences("legacy").unwrap();
        assert_eq!(prefs.subtitle_color, "#F9E23A");
        assert_eq!(prefs.subtitle_shadow, "outline");
        assert_eq!(prefs.subtitle_background, "none");
        assert_eq!(prefs.subtitle_position, "top");
        assert_eq!(
            reloaded.preferences("other").unwrap().subtitle_color,
            "#ffffff"
        );
        // Older clients can still submit the previous JSON shape.
        let old_input: PlaybackPreferences = serde_json::from_value(legacy).unwrap();
        store.save_preferences("old-client", old_input).unwrap();
    }

    #[test]
    fn invalid_subtitle_appearance_does_not_replace_saved_preferences() {
        let temp = tempfile::tempdir().unwrap();
        let store = WatchStore::new(temp.path().join("watch.sqlite"));
        store
            .save_preferences(
                "u",
                PlaybackPreferences {
                    subtitle_color: "#ffee11".into(),
                    ..PlaybackPreferences::default()
                },
            )
            .unwrap();
        for (field, invalid) in [
            ("subtitle_color", "red"),
            ("subtitle_color", "#fff"),
            ("subtitle_color", "#ffffff;url(x)"),
            ("subtitle_color", "#gg0000"),
            ("subtitle_shadow", "unknown"),
            ("subtitle_background", "url(x)"),
            ("subtitle_position", "outside"),
        ] {
            let mut json = serde_json::to_value(PlaybackPreferences::default()).unwrap();
            json[field] = serde_json::json!(invalid);
            let input = serde_json::from_value(json).unwrap();
            assert_eq!(
                store.save_preferences("u", input).unwrap_err().status,
                StatusCode::BAD_REQUEST
            );
            assert_eq!(store.preferences("u").unwrap().subtitle_color, "#ffee11");
        }
    }

    #[test]
    fn preferences_and_rules_survive_restart_and_are_user_scoped() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("watch.sqlite");
        let store = WatchStore::new(path.clone());
        assert_eq!(store.preferences("user").unwrap().subtitle_mode, "default");
        let prefs = PlaybackPreferences {
            autoplay_next: false,
            audio_languages: vec!["ja".into()],
            ..PlaybackPreferences::default()
        };
        store.save_preferences("user", prefs).unwrap();
        store
            .save_rules(
                "anime",
                ResumeRules {
                    minimum_percentage: 5.0,
                    maximum_percentage: 95.0,
                    minimum_duration_seconds: 200.0,
                },
            )
            .unwrap();
        let reloaded = WatchStore::new(path);
        assert!(!reloaded.preferences("user").unwrap().autoplay_next);
        assert!(reloaded.preferences("someone else").unwrap().autoplay_next);
        assert_eq!(reloaded.rules("anime").unwrap().maximum_percentage, 95.0);
    }
    #[test]
    fn paused_watch_timeouts_default_to_five_and_persist_independently() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("watch.sqlite");
        let store = WatchStore::new(path.clone());
        let defaults = store.preferences("user").unwrap();
        assert_eq!(defaults.still_watching_minutes, 5);
        assert_eq!(defaults.still_watching_timeout_minutes, 5);
        let legacy: PlaybackPreferences =
            serde_json::from_str(r#"{"still_watching_minutes":0}"#).unwrap();
        assert_eq!(legacy.still_watching_minutes, 0);
        assert_eq!(legacy.still_watching_timeout_minutes, 5);
        let custom = PlaybackPreferences {
            still_watching_minutes: 2,
            still_watching_timeout_minutes: 3,
            ..defaults
        };
        store.save_preferences("user", custom).unwrap();
        let reloaded = WatchStore::new(path).preferences("user").unwrap();
        assert_eq!(reloaded.still_watching_minutes, 2);
        assert_eq!(reloaded.still_watching_timeout_minutes, 3);
        for timeout in [0, 1441] {
            assert!(
                store
                    .save_preferences(
                        "user",
                        PlaybackPreferences {
                            still_watching_timeout_minutes: timeout,
                            ..reloaded.clone()
                        }
                    )
                    .is_err()
            );
        }
    }
    #[test]
    fn invalid_preferences_and_rules_are_not_saved() {
        let temp = tempfile::tempdir().unwrap();
        let store = WatchStore::new(temp.path().join("watch.sqlite"));
        let prefs = PlaybackPreferences {
            subtitle_mode: "invented".into(),
            ..PlaybackPreferences::default()
        };
        assert!(store.save_preferences("user", prefs).is_err());
        let rules = ResumeRules {
            minimum_percentage: f64::NAN,
            ..ResumeRules::default()
        };
        assert!(store.save_rules("anime", rules).is_err());
        assert_eq!(store.rules("anime").unwrap().minimum_percentage, 2.0);
    }
    #[test]
    fn early_progress_and_short_titles_are_not_resumable() {
        let temp = tempfile::tempdir().unwrap();
        let store = WatchStore::new(temp.path().join("watch.sqlite"));
        let session = store
            .begin_at("u", "l", "i", 1_000.0, 0)
            .unwrap()
            .session_id;
        assert_eq!(
            store
                .report_at("u", "l", "i", 1_000.0, input(&session, 0, 10.0), 10_000)
                .unwrap()
                .position_seconds,
            0.0
        );
        assert_eq!(
            store
                .report_at("u", "l", "i", 1_000.0, input(&session, 1, 40.0), 20_000)
                .unwrap()
                .position_seconds,
            40.0
        );
        let session = store
            .begin_at("u", "l", "short", 90.0, 0)
            .unwrap()
            .session_id;
        assert_eq!(
            store
                .report_at("u", "l", "short", 90.0, input(&session, 0, 40.0), 10_000)
                .unwrap()
                .position_seconds,
            0.0
        );
    }
    #[test]
    fn completion_counts_once_and_seeking_alone_does_not_complete() {
        let temp = tempfile::tempdir().unwrap();
        let store = WatchStore::new(temp.path().join("watch.sqlite"));
        let session = store
            .begin_at("u", "l", "i", 1_000.0, 0)
            .unwrap()
            .session_id;
        let mut skipped = input(&session, 0, 999.0);
        skipped.ended = true;
        assert!(
            !store
                .report_at("u", "l", "i", 1_000.0, skipped, 10_000)
                .unwrap()
                .watched
        );
        store
            .report_at("u", "l", "i", 1_000.0, input(&session, 1, 900.0), 20_000)
            .unwrap();
        let watched = store
            .report_at("u", "l", "i", 1_000.0, input(&session, 2, 930.0), 30_000)
            .unwrap();
        assert!(watched.watched);
        assert_eq!(watched.position_seconds, 0.0);
        assert_eq!(watched.play_count, 1);
        assert_eq!(
            store
                .report_at("u", "l", "i", 1_000.0, input(&session, 3, 960.0), 40_000)
                .unwrap()
                .play_count,
            1
        );
        let restarted = WatchStore::new(temp.path().join("watch.sqlite"));
        assert!(restarted.get("u", "l", "i", 1_000.0).unwrap().watched);
        let history = restarted.recent("u").unwrap();
        assert_eq!(history.len(), 1);
        assert!(history[0].2.watched);
        assert_eq!(history[0].2.position_seconds, 0.0);
    }
    #[test]
    fn stale_sessions_and_out_of_order_reports_cannot_overwrite_progress() {
        let temp = tempfile::tempdir().unwrap();
        let store = WatchStore::new(temp.path().join("watch.sqlite"));
        let old = store
            .begin_at("u", "l", "i", 1_000.0, 0)
            .unwrap()
            .session_id;
        let new = store
            .begin_at("u", "l", "i", 1_000.0, 0)
            .unwrap()
            .session_id;
        assert_eq!(
            store
                .report_at("u", "l", "i", 1_000.0, input(&old, 100, 900.0), 10_000)
                .err()
                .unwrap()
                .status,
            StatusCode::CONFLICT
        );
        store
            .report_at("u", "l", "i", 1_000.0, input(&new, 2, 40.0), 10_000)
            .unwrap();
        assert_eq!(
            store
                .report_at("u", "l", "i", 1_000.0, input(&new, 1, 5.0), 20_000)
                .err()
                .unwrap()
                .status,
            StatusCode::CONFLICT
        );
        assert_eq!(
            store.get("u", "l", "i", 1_000.0).unwrap().position_seconds,
            40.0
        );
    }
    #[test]
    fn manual_changes_supersede_sessions_and_rewatch_preserves_watched() {
        let temp = tempfile::tempdir().unwrap();
        let store = WatchStore::new(temp.path().join("watch.sqlite"));
        let old = store
            .begin_at("u", "l", "i", 1_000.0, 0)
            .unwrap()
            .session_id;
        store
            .manual(
                "u",
                "l",
                "i",
                1_000.0,
                ManualStateInput {
                    watched: true,
                    clear_position: true,
                    reset_play_count: false,
                },
            )
            .unwrap();
        assert_eq!(
            store
                .report_at("u", "l", "i", 1_000.0, input(&old, 2, 40.0), 10_000)
                .err()
                .unwrap()
                .status,
            StatusCode::CONFLICT
        );
        let new = store
            .begin_at("u", "l", "i", 1_000.0, 0)
            .unwrap()
            .session_id;
        assert!(
            store
                .report_at("u", "l", "i", 1_000.0, input(&new, 0, 40.0), 10_000)
                .unwrap()
                .watched
        );
        assert_eq!(
            store.recent("u").unwrap().len(),
            1,
            "Interrupted rewatches remain resumable."
        );
    }
    #[test]
    fn invalid_values_and_client_duration_cannot_manufacture_completion() {
        let temp = tempfile::tempdir().unwrap();
        let store = WatchStore::new(temp.path().join("watch.sqlite"));
        let session = store
            .begin_at("u", "l", "i", 1_000.0, 0)
            .unwrap()
            .session_id;
        for value in [-1.0, f64::NAN, f64::INFINITY, 2_000.0] {
            assert!(
                store
                    .report_at("u", "l", "i", 1_000.0, input(&session, 0, value), 10_000)
                    .is_err()
            );
        }
        let mut fake = input(&session, 0, 40.0);
        fake.duration_seconds = Some(40.0);
        let state = store
            .report_at("u", "l", "i", 1_000.0, fake, 10_000)
            .unwrap();
        assert_eq!(state.duration_seconds, 1_000.0);
        assert!(!state.watched);
    }
    #[test]
    fn track_selection_supports_off_clear_and_omitted_values() {
        let temp = tempfile::tempdir().unwrap();
        let store = WatchStore::new(temp.path().join("watch.sqlite"));
        let session = store
            .begin_at("u", "l", "i", 1_000.0, 0)
            .unwrap()
            .session_id;
        let mut selected = input(&session, 0, 40.0);
        selected.audio_index = Some(Some(2));
        selected.subtitle_index = Some(Some(-1));
        let state = store
            .report_at("u", "l", "i", 1_000.0, selected, 10_000)
            .unwrap();
        assert_eq!(state.subtitle_index, Some(-1));
        let cleared: ProgressInput = serde_json::from_value(serde_json::json!({"session_id":session,"sequence":1,"position_seconds":50,"subtitle_index":null})).unwrap();
        let state = store
            .report_at("u", "l", "i", 1_000.0, cleared, 20_000)
            .unwrap();
        assert_eq!(state.audio_index, Some(2));
        assert_eq!(state.subtitle_index, None);
    }
    #[test]
    fn series_track_memory_is_a_durable_per_profile_option() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("watch.sqlite");
        let store = WatchStore::new(path.clone());
        assert!(store.preferences("one").unwrap().remember_series_tracks);
        store
            .save_preferences(
                "one",
                PlaybackPreferences {
                    remember_series_tracks: false,
                    ..Default::default()
                },
            )
            .unwrap();
        let restarted = WatchStore::new(path);
        assert!(!restarted.preferences("one").unwrap().remember_series_tracks);
        assert!(restarted.preferences("two").unwrap().remember_series_tracks);
        let legacy: PlaybackPreferences = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(legacy.remember_series_tracks);
    }
    #[test]
    fn subtitle_delay_persists_per_user_and_video_and_omitted_reports_preserve_it() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("watch.sqlite");
        let store = WatchStore::new(path.clone());
        let session = store
            .begin_at("u", "l", "i", 1_000.0, 0)
            .unwrap()
            .session_id;
        let mut selected = input(&session, 0, 40.0);
        selected.subtitle_delay_seconds = Some(1.25);
        let saved = store
            .report_at("u", "l", "i", 1_000.0, selected, 10_000)
            .unwrap();
        assert_eq!(saved.subtitle_delay_seconds, 1.25);
        let omitted: ProgressInput = serde_json::from_value(serde_json::json!({
            "session_id":session,"sequence":1,"position_seconds":50
        }))
        .unwrap();
        store
            .report_at("u", "l", "i", 1_000.0, omitted, 20_000)
            .unwrap();
        let restarted = WatchStore::new(path);
        assert_eq!(
            restarted
                .get("u", "l", "i", 1_000.0)
                .unwrap()
                .subtitle_delay_seconds,
            1.25
        );
        for (user, library, item) in [
            ("other", "l", "i"),
            ("u", "l", "other"),
            ("u", "other", "i"),
        ] {
            assert_eq!(
                restarted
                    .get(user, library, item, 1_000.0)
                    .unwrap()
                    .subtitle_delay_seconds,
                0.0
            );
        }
        let new = restarted.begin_at("u", "l", "i", 1_000.0, 30_000).unwrap();
        assert_eq!(new.state.subtitle_delay_seconds, 1.25);
        let mut reset = input(&new.session_id, 0, 50.0);
        reset.subtitle_delay_seconds = Some(0.0);
        assert_eq!(
            restarted
                .report_at("u", "l", "i", 1_000.0, reset, 40_000)
                .unwrap()
                .subtitle_delay_seconds,
            0.0
        );
        let legacy: WatchState =
            serde_json::from_value(serde_json::json!({"position_seconds":12})).unwrap();
        assert_eq!(legacy.subtitle_delay_seconds, 0.0);
    }
    #[test]
    fn subtitle_delay_rejects_nonfinite_or_out_of_range_values() {
        let session = uuid::Uuid::new_v4().to_string();
        for delay in [-60.01, 60.01, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let mut report = input(&session, 0, 40.0);
            report.subtitle_delay_seconds = Some(delay);
            assert_eq!(
                report.validate(1_000.0).unwrap_err().status,
                StatusCode::BAD_REQUEST
            );
        }
        for delay in [-60.0, 0.0, 60.0] {
            let mut report = input(&session, 0, 40.0);
            report.subtitle_delay_seconds = Some(delay);
            assert!(report.validate(1_000.0).is_ok());
        }
    }
    #[test]
    fn a_reported_seek_does_not_count_as_playing_even_when_its_delta_is_small() {
        let temp = tempfile::tempdir().unwrap();
        let store = WatchStore::new(temp.path().join("watch.sqlite"));
        let session = store.begin_at("u", "l", "i", 200.0, 0).unwrap().session_id;
        let mut skipped = input(&session, 0, 180.0);
        skipped.seeking = true;
        assert!(
            !store
                .report_at("u", "l", "i", 200.0, skipped, 30_000)
                .unwrap()
                .watched
        );
        let mut skipped = input(&session, 1, 190.0);
        skipped.seeking = true;
        assert!(
            !store
                .report_at("u", "l", "i", 200.0, skipped, 40_000)
                .unwrap()
                .watched
        );
    }
    #[test]
    fn previous_viewing_cannot_make_a_seek_or_paused_report_complete() {
        let temp = tempfile::tempdir().unwrap();
        let store = WatchStore::new(temp.path().join("watch.sqlite"));
        let session = store.begin_at("u", "l", "i", 200.0, 0).unwrap().session_id;
        store
            .report_at("u", "l", "i", 200.0, input(&session, 0, 30.0), 30_000)
            .unwrap();
        let mut seek = input(&session, 1, 195.0);
        seek.seeking = true;
        let saved = store.report_at("u", "l", "i", 200.0, seek, 40_000).unwrap();
        assert!(!saved.watched);
        assert_eq!(saved.play_count, 0);
        let mut paused = input(&session, 2, 195.0);
        paused.paused = true;
        paused.ended = true; // A browser can emit EOF after seeking to its end.
        let saved = store
            .report_at("u", "l", "i", 200.0, paused, 50_000)
            .unwrap();
        assert!(!saved.watched);
        assert_eq!(saved.play_count, 0);
        assert_eq!(saved.position_seconds, 195.0);
        let saved = store
            .report_at("u", "l", "i", 200.0, input(&session, 3, 196.0), 60_000)
            .unwrap();
        assert!(saved.watched);
        assert_eq!(saved.play_count, 1);
        assert_eq!(saved.position_seconds, 0.0);
    }
    #[test]
    fn seek_in_the_same_millisecond_as_viewing_cannot_complete() {
        let temp = tempfile::tempdir().unwrap();
        let store = WatchStore::new(temp.path().join("watch.sqlite"));
        let session = store.begin_at("u", "l", "i", 200.0, 0).unwrap().session_id;
        store
            .report_at("u", "l", "i", 200.0, input(&session, 0, 30.0), 30_000)
            .unwrap();
        let mut seek = input(&session, 1, 195.0);
        seek.seeking = true;
        store.report_at("u", "l", "i", 200.0, seek, 30_000).unwrap();
        let mut end = input(&session, 2, 195.0);
        end.ended = true;
        end.paused = true;
        let saved = store.report_at("u", "l", "i", 200.0, end, 30_001).unwrap();
        assert!(!saved.watched);
        assert_eq!(saved.play_count, 0);
        assert!(saved.last_played_at.is_some());
    }

    #[test]
    fn zero_delta_end_after_genuine_playback_completes_once() {
        let temp = tempfile::tempdir().unwrap();
        let store = WatchStore::new(temp.path().join("watch.sqlite"));
        store
            .save_rules(
                "u:l",
                ResumeRules {
                    maximum_percentage: 100.0,
                    ..ResumeRules::default()
                },
            )
            .unwrap();
        let session = store.begin_at("u", "l", "i", 100.0, 0).unwrap().session_id;
        store
            .report_at("u", "l", "i", 100.0, input(&session, 0, 20.0), 20_000)
            .unwrap();
        let mut seek = input(&session, 1, 99.8);
        seek.seeking = true;
        store.report_at("u", "l", "i", 100.0, seek, 30_000).unwrap();
        assert!(
            !store
                .report_at("u", "l", "i", 100.0, input(&session, 2, 99.9), 31_000)
                .unwrap()
                .watched
        );
        for (sequence, time) in [(3, 32_000), (4, 33_000)] {
            let mut end = input(&session, sequence, 99.9);
            end.ended = true;
            end.paused = true;
            let saved = store.report_at("u", "l", "i", 100.0, end, time).unwrap();
            assert!(saved.watched);
            assert_eq!(saved.play_count, 1);
            assert_eq!(saved.position_seconds, 0.0);
        }
    }
    #[test]
    fn ended_with_fractional_timestamp_completes_at_one_hundred_percent_threshold() {
        let temp = tempfile::tempdir().unwrap();
        let store = WatchStore::new(temp.path().join("watch.sqlite"));
        store
            .save_rules(
                "u:l",
                ResumeRules {
                    maximum_percentage: 100.0,
                    ..ResumeRules::default()
                },
            )
            .unwrap();
        let session = store.begin_at("u", "l", "i", 200.0, 0).unwrap().session_id;
        for n in 0..5 {
            store
                .report_at(
                    "u",
                    "l",
                    "i",
                    200.0,
                    input(&session, n, (n + 1) as f64 * 30.0),
                    (n + 1) as i64 * 10_000,
                )
                .unwrap();
        }
        let mut ended = input(&session, 5, 199.95);
        ended.ended = true;
        let state = store
            .report_at("u", "l", "i", 200.0, ended, 70_000)
            .unwrap();
        assert!(state.watched);
        assert_eq!(state.play_count, 1);
        assert_eq!(state.position_seconds, 0.0);
    }
    #[tokio::test]
    async fn endpoints_use_catalog_duration_and_refresh_preserves_watch_state() {
        use posterview_contracts::native::{AnimeContent, NativeLibraryInput, NativeLibraryType};
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        let db = ServerStore::new(state.runtime.data_dir());
        let lib = db
            .save_native_library(
                None,
                &NativeLibraryInput {
                    name: "TV".into(),
                    library_type: NativeLibraryType::Shows,
                    anime_content: AnimeContent::Both,
                    paths: vec!["TV".into()],
                    revision: None,
                    options: Default::default(),
                },
            )
            .unwrap();
        let mut entry = NativeCatalogEntry {
            id: String::new(),
            title: "Pilot".into(),
            kind: "episode".into(),
            path: "TV/Example/Season 01/Pilot.mkv".into(),
            parent_path: Some("TV/Example/Season 01".into()),
            metadata: serde_json::json!({"runtime":10}),
            artwork: vec![],
            files: vec![
                serde_json::json!({"path":"TV/Example/Season 01/Pilot.mkv","media_info":{"format":{"duration":"1000.25"},"streams":[{"index":1,"codec_type":"audio"}]}}),
            ],
            nfo_path: None,
            nfo_xml: None,
            available: true,
            revision: 1,
        };
        db.ingest_native_catalog(&lib.id, lib.revision, std::slice::from_ref(&entry))
            .unwrap();
        entry = db.native_catalog(&lib.id).unwrap().pop().unwrap();
        let result = begin(
            State(state.clone()),
            HeaderMap::new(),
            Path((lib.id.clone(), entry.id.clone())),
            Query(VersionQuery::default()),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(result.state.duration_seconds, 1000.25);
        let mut report = input(&result.session_id, 0, 40.0);
        report.duration_seconds = Some(40.0);
        let saved = progress(
            State(state.clone()),
            HeaderMap::new(),
            Path((lib.id.clone(), entry.id.clone())),
            Json(report),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(saved.duration_seconds, 1000.25);
        assert!(!saved.watched);
        assert_eq!(saved.position_seconds, 40.0);
        entry.title = "Updated title".into();
        entry.metadata["plot"] = serde_json::json!("Updated provider synopsis");
        db.ingest_native_catalog(&lib.id, lib.revision, std::slice::from_ref(&entry))
            .unwrap();
        let refreshed = get_state(
            State(state.clone()),
            HeaderMap::new(),
            Path((lib.id.clone(), entry.id.clone())),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(refreshed.position_seconds, 40.0);
        assert_eq!(refreshed.session_id, Some(result.session_id.clone()));
        let mut report = input(&result.session_id, 1, 50.0);
        report.audio_index = Some(Some(99));
        let saved = progress(
            State(state.clone()),
            HeaderMap::new(),
            Path((lib.id.clone(), entry.id.clone())),
            Json(report),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(
            saved.audio_index,
            Some(99),
            "Live file indices need not match an older catalog probe."
        );
        let mut invalid = input(&result.session_id, 2, 60.0);
        invalid.audio_index = Some(Some(1025));
        assert!(
            progress(
                State(state),
                HeaderMap::new(),
                Path((lib.id, entry.id)),
                Json(invalid)
            )
            .await
            .is_err()
        );
    }
    #[test]
    fn verified_playback_duration_survives_stale_catalog_but_invalidates_after_file_rescan() {
        let temp = tempfile::tempdir().unwrap();
        let store = WatchStore::new(temp.path().join("watch.sqlite"));
        let mut entry = NativeCatalogEntry {
            id: "i".into(),
            title: "Pilot".into(),
            kind: "episode".into(),
            path: "TV/Pilot.mkv".into(),
            parent_path: None,
            metadata: serde_json::json!({"runtime":10}),
            artwork: vec![],
            files: vec![
                serde_json::json!({"path":"TV/Pilot.mkv","size":100,"mtime_ns":"old","media_info":{"format":{"duration":600}}}),
            ],
            nfo_path: None,
            nfo_xml: None,
            available: true,
            revision: 1,
        };
        let session = store.begin_at("u", "l", "i", 600.0, 0).unwrap().session_id;
        store
            .report_verified_at(
                "u",
                "l",
                "i",
                VerifiedDuration {
                    seconds: 1_000.0,
                    signature: Some(&catalog_signature(&entry)),
                },
                input(&session, 0, 40.0),
                10_000,
            )
            .unwrap();
        assert_eq!(
            resolved_duration(&store, "u", "l", &entry).unwrap(),
            1_000.0
        );
        entry.files[0]["mtime_ns"] = serde_json::json!("new");
        entry.files[0]["media_info"]["format"]["duration"] = serde_json::json!(1_200);
        assert_eq!(
            resolved_duration(&store, "u", "l", &entry).unwrap(),
            1_200.0
        );
        assert_eq!(
            resolved_duration(&store, "other", "l", &entry).unwrap(),
            1_200.0
        );
    }
    #[test]
    fn bulk_states_are_user_and_library_scoped_and_do_not_create_defaults() {
        let temp = tempfile::tempdir().unwrap();
        let store = WatchStore::new(temp.path().join("watch.sqlite"));
        assert!(store.library_states("u", "l").unwrap().is_empty());
        store
            .manual(
                "u",
                "l",
                "i",
                1000.0,
                ManualStateInput {
                    watched: true,
                    clear_position: true,
                    reset_play_count: false,
                },
            )
            .unwrap();
        store
            .manual(
                "other",
                "l",
                "secret",
                1000.0,
                ManualStateInput {
                    watched: true,
                    clear_position: true,
                    reset_play_count: false,
                },
            )
            .unwrap();
        store
            .manual(
                "u",
                "other library",
                "another",
                1000.0,
                ManualStateInput {
                    watched: true,
                    clear_position: true,
                    reset_play_count: false,
                },
            )
            .unwrap();
        let states = store.library_states("u", "l").unwrap();
        assert_eq!(states.len(), 1);
        assert!(states["i"].watched);
    }
}
