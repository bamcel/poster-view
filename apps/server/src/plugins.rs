use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};
use crate::{AppState, HttpError};
use posterview_infra_sqlite::ServerStore;
#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn artwork_plugin_preserves_defaults_and_persists_disabled_state() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        let settings=super::artwork_load(&state).unwrap();
        assert!(settings.enabled && settings.poster_edit && settings.backdrop_edit);
        assert!(!settings.pinned);
        let _=super::artwork_save(axum::extract::State(state.clone()),axum::Json(super::ArtworkSettings {enabled:false,..Default::default()})).await.unwrap();
        assert!(!super::artwork_enabled(&state));
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
