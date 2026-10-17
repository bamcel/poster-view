//! Cookie contents never enter public settings, jobs, errors or responses.
use super::{AppState, HttpError, err};
use axum::{
    Json, Router,
    extract::{State, rejection::JsonRejection},
    routing::get,
};
use posterview_infra_sqlite::ServerStore;
use serde::{Deserialize, Serialize};
use std::io::Write;

const KEY: &str = "ytdl_authentication";
const LIMIT: usize = 1024 * 1024;
#[derive(Default, Serialize, Deserialize)]
struct Stored {
    cookies: String,
    updated_at: Option<String>,
}
#[derive(Serialize)]
struct Status {
    configured: bool,
    updated_at: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Upload {
    cookies: String,
}
impl Stored {
    fn status(&self) -> Status {
        Status {
            configured: !self.cookies.is_empty(),
            updated_at: self.updated_at.clone(),
        }
    }
}
fn load(state: &AppState) -> Result<Stored, HttpError> {
    let raw = ServerStore::new(state.runtime.data_dir())
        .get_setting(KEY)
        .map_err(|_| err("Could not read YouTube authentication settings."))?;
    if raw.is_empty() {
        Ok(Stored::default())
    } else {
        serde_json::from_str(&raw)
            .map_err(|_| err("Could not read YouTube authentication settings."))
    }
}
fn save(state: &AppState, value: &Stored) -> Result<(), HttpError> {
    ServerStore::new(state.runtime.data_dir())
        .set_setting(
            KEY,
            &serde_json::to_string(value)
                .map_err(|_| err("Could not save YouTube authentication settings."))?,
        )
        .map_err(|_| err("Could not save YouTube authentication settings."))
}
pub(super) fn routes() -> Router<AppState> {
    Router::new().route(
        "/api/plugins/ytdl/cookies",
        get(status).put(upload).delete(remove),
    )
}
async fn status(State(state): State<AppState>) -> Result<Json<Status>, HttpError> {
    Ok(Json(load(&state)?.status()))
}
async fn upload(
    State(state): State<AppState>,
    input: Result<Json<Upload>, JsonRejection>,
) -> Result<Json<Status>, HttpError> {
    let Json(input) =
        input.map_err(|_| err("Upload a Netscape-format YouTube cookies text file."))?;
    let value = Stored {
        cookies: validate(&input.cookies)?,
        updated_at: Some(chrono::Utc::now().to_rfc3339()),
    };
    let _lock = state.ytdl_lock.lock().await;
    save(&state, &value)?;
    Ok(Json(value.status()))
}
async fn remove(State(state): State<AppState>) -> Result<Json<Status>, HttpError> {
    let _lock = state.ytdl_lock.lock().await;
    let value = Stored::default();
    save(&state, &value)?;
    Ok(Json(value.status()))
}
fn validate(raw: &str) -> Result<String, HttpError> {
    let invalid = || {
        err(
            "Use a valid Netscape cookies.txt export containing only YouTube cookies (maximum 1 MiB). Re-export cookies for youtube.com only.",
        )
    };
    if raw.len() > LIMIT
        || raw.is_empty()
        || raw
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\t' | '\n' | '\r'))
    {
        return Err(invalid());
    }
    let raw = raw.trim_start_matches('\u{feff}');
    let mut lines = raw.lines();
    if !matches!(
        lines.next().map(str::trim),
        Some("# Netscape HTTP Cookie File" | "# HTTP Cookie File")
    ) {
        return Err(invalid());
    }
    let mut output = String::from("# Netscape HTTP Cookie File\n");
    let mut count = 0;
    for line in lines {
        let line = line.trim_end_matches('\r');
        if line.is_empty() || (line.starts_with('#') && !line.starts_with("#HttpOnly_")) {
            continue;
        }
        let fields = line.split('\t').collect::<Vec<_>>();
        if fields.len() != 7 {
            return Err(invalid());
        }
        let domain = fields[0]
            .trim_start_matches("#HttpOnly_")
            .trim_start_matches('.')
            .to_ascii_lowercase();
        if !(domain == "youtube.com" || domain.ends_with(".youtube.com"))
            || !matches!(fields[1], "TRUE" | "FALSE")
            || !fields[2].starts_with('/')
            || !matches!(fields[3], "TRUE" | "FALSE")
            || fields[4].parse::<u64>().is_err()
            || fields[5].is_empty()
            || fields[6].is_empty()
        {
            return Err(invalid());
        }
        count += 1;
        if count > 5000 {
            return Err(invalid());
        }
        output.push_str(line);
        output.push('\n');
    }
    if count == 0 {
        return Err(invalid());
    }
    Ok(output)
}
pub(super) async fn request_file(
    state: &AppState,
) -> Result<Option<tempfile::NamedTempFile>, HttpError> {
    let saved = load(state)?;
    if saved.cookies.is_empty() {
        return Ok(None);
    }
    let mut file = tempfile::NamedTempFile::new()
        .map_err(|_| err("Could not prepare YouTube authentication."))?;
    file.write_all(saved.cookies.as_bytes())
        .and_then(|_| file.flush())
        .map_err(|_| err("Could not prepare YouTube authentication."))?;
    Ok(Some(file))
}
pub(super) fn authentication_required(detail: &str) -> bool {
    let value = detail.to_ascii_lowercase();
    if [
        "permission denied",
        "no space left",
        "cancelled",
        "http error 429",
        "timed out",
    ]
    .iter()
    .any(|text| value.contains(text))
    {
        return false;
    }
    [
        "sign in to confirm your age",
        "sign in to confirm you’re not a bot",
        "sign in to confirm you're not a bot",
        "login required",
        "sign in if you've been granted access",
        "age-restricted",
        "age restricted",
        "only available for registered users",
        "join this channel",
        "members-only",
        "authentication required",
    ]
    .iter()
    .any(|text| value.contains(text))
}
pub(super) fn redact(detail: &str) -> String {
    let lower = detail.to_ascii_lowercase();
    if lower.contains("cancelled") {
        return "Download cancelled.".into();
    }
    if lower.contains("permission denied") {
        return "Permission denied while writing the YouTube download.".into();
    }
    if lower.contains("no space left") {
        return "No space left while writing the YouTube download.".into();
    }
    if lower.contains("timed out") {
        return "Downloader timed out.".into();
    }
    "YouTube authentication failed or access is unavailable. Replace expired cookies and confirm the account can watch this video. Cookie contents are never shown.".into()
}

#[cfg(test)]
mod tests {
    use super::*;
    const COOKIE: &str =
        "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tprivate-session-value\n";
    #[test]
    fn validates_export_without_echoing_secrets() {
        assert!(validate(COOKIE).is_ok());
        for value in [
            COOKIE.replace(".youtube.com", ".notyoutube.com"),
            COOKIE.replace("TRUE", "MAYBE"),
            "SID=private-session-value".into(),
        ] {
            let error = validate(&value).unwrap_err();
            assert!(!error.detail.contains("private-session-value"));
        }
        assert!(validate(&"x".repeat(LIMIT + 1)).is_err());
    }
    #[test]
    fn only_authentication_failures_trigger_cookie_use() {
        assert!(!authentication_required(
            "Permission denied: /media/age-restricted.mp4"
        ));
        assert_eq!(redact("Download cancelled."), "Download cancelled.");
        assert!(!redact("private-session-value").contains("private-session-value"));
        for error in [
            "Sign in to confirm your age. Use --cookies",
            "This video is age-restricted",
            "Sign in if you've been granted access",
        ] {
            assert!(authentication_required(error));
        }
        for error in [
            "HTTP Error 403: Forbidden",
            "HTTP Error 429",
            "database is locked",
            "Permission denied",
            "Unable to download video data",
        ] {
            assert!(!authentication_required(error));
        }
    }
    #[tokio::test]
    async fn encrypted_storage_private_tempfile_and_metadata_only_response() {
        let root = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(root.path());
        let stored = Stored {
            cookies: COOKIE.into(),
            updated_at: Some("today".into()),
        };
        save(&state, &stored).unwrap();
        let connection =
            rusqlite::Connection::open(state.runtime.data_dir().join("posterview.db")).unwrap();
        let raw: String = connection
            .query_row(
                "SELECT value_enc FROM settings WHERE key=?1",
                [KEY],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!raw.contains("private-session-value"));
        let response = serde_json::to_string(&load(&state).unwrap().status()).unwrap();
        assert!(!response.contains("SID"));
        let file = request_file(&state).await.unwrap().unwrap();
        let path = file.path().to_path_buf();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), COOKIE);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        drop(file);
        assert!(!path.exists());
        let removed = remove(State(state.clone())).await.unwrap();
        assert!(!removed.0.configured);
        assert!(request_file(&state).await.unwrap().is_none());
    }
}
