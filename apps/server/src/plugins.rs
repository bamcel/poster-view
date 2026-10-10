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
pub(crate) fn enabled(_state: &AppState) -> bool { false }
pub(crate) async fn get(State(state): State<AppState>) -> Result<Json<ServerConnectSettings>, HttpError> { let _ = load(&state)?; Ok(Json(ServerConnectSettings {enabled:false,pinned:false})) }
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
        assert!(!super::enabled(&state));
        let _ = super::save(axum::extract::State(state.clone()), axum::Json(super::ServerConnectSettings { enabled: false, pinned: true })).await.unwrap();
        assert!(!super::enabled(&state));
        assert!(super::load(&state).unwrap().pinned);
    }
    #[tokio::test]
    async fn artwork_plugin_preserves_defaults_and_persists_disabled_state() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::native::scan_tests::state(temp.path());
        let settings=super::artwork_load(&state).unwrap();
        assert!(settings.enabled && settings.poster_edit && settings.backdrop_edit);
        assert!(!settings.pinned);
        let _=super::artwork_save(axum::extract::State(state.clone()),axum::Json(super::ArtworkSettings {enabled:false,..Default::default()})).await.unwrap();
        assert!(!super::artwork_enabled(&state));
    }
    #[test]
    fn defaults_preserve_sync_and_leave_shortcut_unpinned() {
        let settings: super::ServerConnectSettings = serde_json::from_str("{}").unwrap();
        assert!(settings.enabled);
        assert!(!settings.pinned);
    }
}

#[derive(Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct ArtworkSettings { pub enabled: bool, pub pinned: bool, pub poster_edit: bool, pub backdrop_edit: bool }
impl Default for ArtworkSettings { fn default() -> Self { Self {enabled:true,pinned:false,poster_edit:true,backdrop_edit:true} } }
fn artwork_load(state: &AppState) -> Result<ArtworkSettings, HttpError> {
 let raw=ServerStore::new(state.runtime.data_dir()).get_setting("plugin-artwork").map_err(|e|HttpError::bad_request(e.to_string()))?;
 if raw.is_empty(){Ok(Default::default())}else{serde_json::from_str(&raw).map_err(|e|HttpError::bad_request(e.to_string()))}
}
pub(crate) fn artwork_enabled(state:&AppState)->bool {artwork_load(state).is_ok_and(|value|value.enabled)}
pub(crate) async fn artwork_get(State(state):State<AppState>)->Result<Json<ArtworkSettings>,HttpError>{Ok(Json(artwork_load(&state)?))}
pub(crate) async fn artwork_save(State(state):State<AppState>,Json(settings):Json<ArtworkSettings>)->Result<Json<ArtworkSettings>,HttpError>{
 ServerStore::new(state.runtime.data_dir()).set_setting("plugin-artwork",&serde_json::to_string(&settings).map_err(|e|HttpError::bad_request(e.to_string()))?).map_err(|e|HttpError::bad_request(e.to_string()))?;Ok(Json(settings))
}
