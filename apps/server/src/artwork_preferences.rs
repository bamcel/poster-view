use crate::{AppState, HttpError};
use axum::{Json, extract::State};
use posterview_infra_sqlite::ServerStore;
use serde::{Deserialize, Serialize};
#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn artwork_plugin_preserves_defaults_and_persists_disabled_state() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        let settings = super::artwork_load(&state).unwrap();
        assert!(settings.enabled && settings.poster_edit && settings.backdrop_edit);
        assert!(!settings.pinned);
        let _ = super::artwork_save(
            axum::extract::State(state.clone()),
            axum::Json(super::ArtworkSettings {
                enabled: false,
                ..Default::default()
            }),
        )
        .await
        .unwrap();
        assert!(!super::artwork_enabled(&state));
    }

    #[tokio::test]
    async fn legacy_artwork_settings_retain_editor_choices_and_other_settings() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        let store = posterview_infra_sqlite::ServerStore::new(state.runtime.data_dir());
        store
            .set_setting(
                "plugin-artwork",
                r#"{"enabled":false,"pinned":true,"poster_edit":true,"backdrop_edit":false}"#,
            )
            .unwrap();
        store
            .set_setting("artwork-test-credential", "unchanged")
            .unwrap();

        let loaded = super::artwork_get(axum::extract::State(state.clone()))
            .await
            .unwrap()
            .0;
        assert!(!loaded.enabled);
        assert!(loaded.pinned && loaded.poster_edit);
        assert!(!loaded.backdrop_edit);
        assert!(!super::artwork_enabled(&state));

        // Automatic fetching is independent of optional editor preferences.
        let saved = super::artwork_save(
            axum::extract::State(state.clone()),
            axum::Json(super::ArtworkSettings {
                enabled: true,
                ..loaded
            }),
        )
        .await
        .unwrap()
        .0;
        assert!(super::artwork_enabled(&state));
        assert!(saved.pinned && saved.poster_edit);
        assert!(!saved.backdrop_edit);
        assert_eq!(
            store.get_setting("artwork-test-credential").unwrap(),
            "unchanged"
        );
        let persisted: serde_json::Value =
            serde_json::from_str(&store.get_setting("plugin-artwork").unwrap()).unwrap();
        assert_eq!(persisted["enabled"], true);
        assert_eq!(persisted["pinned"], true);
        assert_eq!(persisted["poster_edit"], true);
        assert_eq!(persisted["backdrop_edit"], false);
    }
}

#[derive(Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct ArtworkSettings {
    // Persisted legacy name: controls automatic fetching, not manual artwork tools.
    pub enabled: bool,
    pub pinned: bool,
    pub poster_edit: bool,
    pub backdrop_edit: bool,
}
impl Default for ArtworkSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            pinned: false,
            poster_edit: true,
            backdrop_edit: true,
        }
    }
}
fn artwork_load(state: &AppState) -> Result<ArtworkSettings, HttpError> {
    let raw = ServerStore::new(state.runtime.data_dir())
        .get_setting("plugin-artwork")
        .map_err(|e| HttpError::bad_request(e.to_string()))?;
    if raw.is_empty() {
        Ok(Default::default())
    } else {
        serde_json::from_str(&raw).map_err(|e| HttpError::bad_request(e.to_string()))
    }
}
pub(crate) fn artwork_enabled(state: &AppState) -> bool {
    artwork_load(state).is_ok_and(|value| value.enabled)
}
pub(crate) async fn artwork_get(
    State(state): State<AppState>,
) -> Result<Json<ArtworkSettings>, HttpError> {
    Ok(Json(artwork_load(&state)?))
}
pub(crate) async fn artwork_save(
    State(state): State<AppState>,
    Json(settings): Json<ArtworkSettings>,
) -> Result<Json<ArtworkSettings>, HttpError> {
    ServerStore::new(state.runtime.data_dir())
        .set_setting(
            "plugin-artwork",
            &serde_json::to_string(&settings).map_err(|e| HttpError::bad_request(e.to_string()))?,
        )
        .map_err(|e| HttpError::bad_request(e.to_string()))?;
    Ok(Json(settings))
}
