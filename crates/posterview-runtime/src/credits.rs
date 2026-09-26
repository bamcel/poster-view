use crate::{Runtime, RuntimeError};
use posterview_contracts::{CreditProviderSettings, CreditSearchResult, SeriesCredits};
use posterview_infra_artwork::{valid_credit_id, valid_credit_provider};
use tokio::sync::Mutex;

static IMPORT_LOCK: Mutex<()> = Mutex::const_new(());

impl Runtime {
    pub fn credit_provider_settings(&self) -> Result<CreditProviderSettings, RuntimeError> {
        let store = self.server_store()?;
        Ok(CreditProviderSettings {
            tmdb_configured: !store.get_setting("tmdb_access_token")?.is_empty(),
            tvdb_configured: !store.get_setting("tvdb_api_key")?.is_empty(),
        })
    }
    pub fn set_credit_tmdb_token(
        &self,
        token: &str,
    ) -> Result<CreditProviderSettings, RuntimeError> {
        if token.len() > 4096 || token.contains(['\r', '\n']) {
            return Err(RuntimeError::Watchdog("Invalid TMDb token.".into()));
        }
        self.server_store()?
            .set_setting("tmdb_access_token", token.trim())?;
        self.credit_provider_settings()
    }
    pub fn series_credits(&self, server: i64, item: &str) -> Result<SeriesCredits, RuntimeError> {
        Ok(self.server_store()?.series_credits(server, item)?)
    }
    pub fn set_credit_language(
        &self,
        server: i64,
        item: &str,
        language: Option<&str>,
    ) -> Result<SeriesCredits, RuntimeError> {
        self.server_store()?
            .set_credit_language(server, item, language)?;
        self.series_credits(server, item)
    }
    pub async fn remove_credit_source(
        &self,
        server: i64,
        item: &str,
        provider: &str,
        external_id: &str,
    ) -> Result<SeriesCredits, RuntimeError> {
        let _guard = IMPORT_LOCK.lock().await;
        self.server_store()?
            .remove_credit_source(server, item, provider, external_id)?;
        self.series_credits(server, item)
    }
    pub async fn search_credits(
        &self,
        provider: &str,
        query: &str,
    ) -> Result<Vec<CreditSearchResult>, RuntimeError> {
        if !valid_credit_provider(provider) || query.trim().is_empty() || query.len() > 200 {
            return Err(RuntimeError::Watchdog(
                "Choose a provider and a search term of 1–200 characters.".into(),
            ));
        }
        let store = self.server_store()?;
        self.artwork
            .search_credits(
                provider,
                query.trim(),
                &store.get_setting("tmdb_access_token")?,
                &store.get_setting("tvdb_api_key")?,
                &store.get_setting("tvdb_pin")?,
            )
            .await
            .map_err(RuntimeError::Watchdog)
    }
    pub async fn import_credits(
        &self,
        server: i64,
        item: &str,
        provider: &str,
        id: &str,
    ) -> Result<SeriesCredits, RuntimeError> {
        if !valid_credit_provider(provider) || !valid_credit_id(id) {
            return Err(RuntimeError::Watchdog(
                "Choose a valid provider and series ID.".into(),
            ));
        }
        let _guard = IMPORT_LOCK.lock().await;
        let store = self.server_store()?;
        let source = self
            .artwork
            .fetch_credits(
                provider,
                id,
                &store.get_setting("tmdb_access_token")?,
                &store.get_setting("tvdb_api_key")?,
                &store.get_setting("tvdb_pin")?,
            )
            .await
            .map_err(RuntimeError::Watchdog)?;
        store.save_credit_source(server, item, &source)?;
        self.series_credits(server, item)
    }
}
