use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};
use crate::{AppState, HttpError};
use posterview_infra_sqlite::ServerStore;
#[derive(Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct ServerConnectSettings { pub enabled: bool, pub pinned: bool }
impl Default for ServerConnectSettings {
    fn default() -> Self { Self { enabled: true, pinned: false } }
}
fn load(state: &AppState) -> Result<ServerConnectSettings, HttpError> {
    let raw = ServerStore::new(state.runtime.data_dir()).get_setting("plugin-server-connect").map_err(|e| HttpError::bad_request(e.to_string()))?;
    if raw.is_empty() { Ok(Default::default()) } else { serde_json::from_str(&raw).map_err(|e| HttpError::bad_request(e.to_string())) }
}
pub(crate) fn enabled(state: &AppState) -> bool { load(state).is_ok_and(|settings| settings.enabled) }
pub(crate) async fn get(State(state): State<AppState>) -> Result<Json<ServerConnectSettings>, HttpError> { Ok(Json(load(&state)?)) }
pub(crate) async fn save(State(state): State<AppState>, Json(settings): Json<ServerConnectSettings>) -> Result<Json<ServerConnectSettings>, HttpError> {
    ServerStore::new(state.runtime.data_dir()).set_setting("plugin-server-connect", &serde_json::to_string(&settings).map_err(|e| HttpError::bad_request(e.to_string()))?).map_err(|e| HttpError::bad_request(e.to_string()))?;
    Ok(Json(settings))
}
#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn plugin_settings_persist_and_disable_sync_without_removing_libraries() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::native::scan_tests::state(temp.path());
        assert!(super::enabled(&state));
        let _ = super::save(axum::extract::State(state.clone()), axum::Json(super::ServerConnectSettings { enabled: false, pinned: true })).await.unwrap();
        assert!(!super::enabled(&state));
        assert!(super::load(&state).unwrap().pinned);
    }
    #[test]
    fn defaults_preserve_sync_and_leave_shortcut_unpinned() {
        let settings: super::ServerConnectSettings = serde_json::from_str("{}").unwrap();
        assert!(settings.enabled);
        assert!(!settings.pinned);
    }
}
