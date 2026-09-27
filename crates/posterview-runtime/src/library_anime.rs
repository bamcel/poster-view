use crate::{Runtime, RuntimeError};
use posterview_contracts::LibraryType;
use posterview_infra_media_servers::{ConnectionConfig, get_video_inventory};
use std::collections::BTreeMap;

impl Runtime {
    pub fn anime_libraries(&self, server: i64) -> Result<BTreeMap<String, bool>, RuntimeError> {
        let raw = self.server_store()?.get_setting(&format!("anime_libraries:{server}"))?;
        Ok(serde_json::from_str(&raw).unwrap_or_default())
    }
    pub(crate) fn record_library_items(&self, server: i64, library: &str, ids: impl Iterator<Item=String>) -> Result<(), RuntimeError> {
        let store = self.server_store()?;
        for id in ids { store.set_setting(&format!("item_library:{server}:{id}"), library)?; }
        Ok(())
    }
    pub(crate) fn item_is_anime(&self, server: i64, item: &str) -> Result<bool, RuntimeError> {
        let library = self.server_store()?.get_setting(&format!("item_library:{server}:{item}"))?;
        Ok(self.anime_libraries(server)?.get(&library).copied().unwrap_or(false))
    }
    pub async fn set_library_anime(&self, server_id: i64, library_id: &str, anime: bool) -> Result<(), RuntimeError> {
        let fail = |s: &str| RuntimeError::Watchdog(s.into());
        let server = self.get_server(server_id)?.ok_or_else(|| fail("Server not found"))?;
        let libraries = self.get_libraries(server_id).await?.ok_or_else(|| fail("Server not found"))?.map_err(RuntimeError::Watchdog)?;
        let library = libraries.iter().find(|l| l.id == library_id).ok_or_else(|| fail("Library not found"))?;
        if !matches!(library.library_type, LibraryType::Movie | LibraryType::Show | LibraryType::Other) { return Err(fail("Anime is supported for video libraries only.")); }
        let token = self.server_store()?.decrypted_token(server_id)?.unwrap_or_default();
        let mut ids = Vec::new();
        let kinds = if library.library_type == LibraryType::Other { vec![false, true] } else { vec![library.library_type == LibraryType::Movie] };
        for movie in kinds {
            let inventory = get_video_inventory(ConnectionConfig { server_type: server.server_type.clone(), base_url: &server.base_url, token: &token }, library_id, movie).await.map_err(RuntimeError::Watchdog)?;
            ids.extend(inventory.into_iter().map(|item| item.id));
        }
        self.record_library_items(server_id, library_id, ids.into_iter())?;
        let mut settings = self.anime_libraries(server_id)?;
        settings.insert(library_id.into(), anime);
        self.server_store()?.set_setting(&format!("anime_libraries:{server_id}"), &serde_json::to_string(&settings).map_err(|e| fail(&e.to_string()))?)?;
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_classification_tracks_membership_and_can_be_reversed() {
        let dir = tempfile::tempdir().unwrap(); let runtime = Runtime::new(dir.path()); runtime.initialize().unwrap();
        runtime.record_library_items(1, "anime", ["show1".to_string()].into_iter()).unwrap();
        runtime.server_store().unwrap().set_setting("anime_libraries:1", r#"{"anime":true}"#).unwrap();
        assert!(runtime.item_is_anime(1, "show1").unwrap());
        assert!(!runtime.item_is_anime(1, "other").unwrap());
        assert!(!runtime.item_is_anime(2, "show1").unwrap());
        runtime.server_store().unwrap().set_setting("anime_libraries:1", r#"{"anime":false}"#).unwrap();
        assert!(!runtime.item_is_anime(1, "show1").unwrap());
    }
}
