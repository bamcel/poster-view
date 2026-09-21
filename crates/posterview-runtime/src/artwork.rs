use std::{sync::Arc, time::Duration};

use crate::{
    ARTWORK_PROVIDERS, Runtime, RuntimeError, optional_setting, parse_nonnegative,
    posterdb_top_three, watchdog_inventory_diff,
};
use posterview_contracts::{
    ApplyRequest, ApplyResult, ArtworkCacheClearResult, ArtworkCacheSettings, ArtworkCacheStatus,
    ArtworkProviderInfo, ArtworkProviderTestRequest, ArtworkProviderTestResult,
    ArtworkRefreshResult, ArtworkResults, ArtworkSearchResults, ArtworkSettings,
    ArtworkSettingsUpdate, ItemDetail, ItemType, PosterDbCredentials, PosterDbStatus,
    PosterSearchResults, PosterSet, WatchdogState,
};
use posterview_infra_artwork::{download_public_image, fetch_mediux_thumb};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(45);

fn temporary_failure(message: &str) -> bool {
    let message = message.to_lowercase();
    if message.contains("credentials")
        || message.contains("rejected")
        || message.contains("401")
        || message.contains("403")
    {
        return false;
    }
    [
        "timeout",
        "timed out",
        "unreachable",
        "could not reach",
        "unable to reach",
        "rate limit",
        "429",
        "temporarily unavailable",
        "500",
        "502",
        "503",
        "504",
        "outage",
    ]
    .iter()
    .any(|part| message.contains(part))
}

fn provider_applies_to_item(provider: &str, item: &ItemDetail) -> bool {
    let has_id = |name: &str| {
        item.external_ids
            .get(name)
            .is_some_and(|value| !value.trim().is_empty())
    };
    let book = matches!(
        item.item_type,
        ItemType::Book | ItemType::Audiobook | ItemType::Folder
    );
    match provider {
        "anilist-manga" => book,
        "anilist" => !book,
        "fanart" if item.item_type == ItemType::Movie => has_id("tmdb") || has_id("imdb"),
        "fanart" if item.item_type == ItemType::Show => has_id("tvdb"),
        "fanart" => false,
        "tvdb" => !book && has_id("tvdb"),
        "mediux" => !book && has_id("tmdb"),
        _ => true,
    }
}

async fn request_with_retry<T, F, Fut>(label: &str, mut request: F) -> Result<T, String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    for attempt in 0..3 {
        let result = tokio::time::timeout(REQUEST_TIMEOUT, request())
            .await
            .unwrap_or_else(|_| Err(format!("{label} request timed out.")));
        match result {
            Err(message) if attempt < 2 && temporary_failure(&message) => {
                tokio::time::sleep(Duration::from_secs(1 << attempt)).await;
            }
            Ok(value) => return Ok(value),
            Err(message) => return Err(format!("{label}: {message}")),
        }
    }
    unreachable!()
}

fn scoped_thumbnail(url: &mut String, server_id: i64) {
    if (url.starts_with("/api/posterdb/image?")
        || url.starts_with("/api/artwork/mediux/image?")
        || url.starts_with("/api/artwork/mangadex/image?"))
        && !url.contains("server_id=")
    {
        url.push_str(&format!("&server_id={server_id}"));
    }
}

fn scoped_artwork(mut result: ArtworkResults, server_id: i64) -> ArtworkResults {
    for item in &mut result.items {
        scoped_thumbnail(&mut item.thumb_url, server_id);
    }
    result
}

fn scoped_search(mut result: ArtworkSearchResults, server_id: i64) -> ArtworkSearchResults {
    for item in &mut result.results {
        if let Some(url) = &mut item.thumb_url {
            scoped_thumbnail(url, server_id);
        }
    }
    result
}

fn scoped_set(mut result: PosterSet, server_id: i64) -> PosterSet {
    for item in &mut result.posters {
        scoped_thumbnail(&mut item.thumb_url, server_id);
    }
    result
}

struct WatchdogRunGuard<'a> {
    runtime: &'a Runtime,
    server_id: i64,
}

impl Drop for WatchdogRunGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut running) = self.runtime.watchdog_running.lock() {
            // Use the same lock order as run registration.
            if let Ok(mut cancelled) = self.runtime.watchdog_cancelled.lock() {
                cancelled.remove(&self.server_id);
            }
            running.remove(&self.server_id);
        }
    }
}

impl Runtime {
    pub(crate) fn server_artwork_cache(
        &self,
        server_id: i64,
    ) -> Result<Arc<crate::ArtworkCache>, RuntimeError> {
        let mut caches = self
            .server_artwork_caches
            .lock()
            .map_err(|_| std::io::Error::other("server artwork cache lock poisoned"))?;
        if let Some(cache) = caches.get(&server_id) {
            return Ok(Arc::clone(cache));
        }
        self.artwork_cache_settings(server_id)?;
        let cache = Arc::new(crate::ArtworkCache::at(
            self.data_dir
                .join("artwork-cache")
                .join("servers")
                .join(server_id.to_string()),
        ));
        cache.initialize()?;
        let store = self.server_store()?;
        let marker = Self::server_setting(server_id, "artwork_cache_migrated_v2");
        if store.get_setting(&marker)?.is_empty() {
            cache.import_matching(&self.artwork_cache, |key| {
                if key.is_empty() {
                    return true;
                }
                if key.starts_with("artwork:") || key.starts_with("artwork-search:") {
                    key.split(':').nth(2) == Some(server_id.to_string().as_str())
                } else {
                    key.starts_with("posterdb-")
                        || key.starts_with("mangadex-image:")
                        || key.starts_with("mediux-image:")
                }
            })?;
            let inventory_key = Self::server_setting(server_id, "artwork_watchdog_inventory");
            if store.get_setting(&inventory_key)?.is_empty() {
                let inventory = serde_json::from_str::<std::collections::BTreeMap<String, String>>(
                    &store.get_setting("artwork_watchdog_inventory")?,
                )
                .unwrap_or_default();
                let prefix = format!("{server_id}:");
                let inventory = inventory
                    .into_iter()
                    .filter(|(key, _)| key.starts_with(&prefix))
                    .collect::<std::collections::BTreeMap<_, _>>();
                if !inventory.is_empty() {
                    store.set_setting(
                        &inventory_key,
                        &serde_json::to_string(&inventory).map_err(std::io::Error::other)?,
                    )?;
                }
            }
            for name in [
                "artwork_watchdog_last_run",
                "artwork_watchdog_last_message",
                "artwork_watchdog_checkpoint",
            ] {
                let target = Self::server_setting(server_id, name);
                let legacy = store.get_setting(name)?;
                if store.get_setting(&target)?.is_empty()
                    && !legacy.is_empty()
                    && (name != "artwork_watchdog_checkpoint"
                        || legacy.starts_with(&format!("{server_id}:")))
                {
                    store.set_setting(&target, &legacy)?;
                }
            }
            let settings = self.artwork_cache_settings(server_id)?;
            cache.prune(settings.max_mb, settings.ttl_days)?;
            store.set_setting(&marker, "true")?;
        }
        caches.insert(server_id, Arc::clone(&cache));
        Ok(cache)
    }

    fn clear_all_artwork_caches(&self) -> Result<(), RuntimeError> {
        for server in self.list_servers()? {
            self.server_artwork_cache(server.id)?.clear()?;
        }
        self.artwork_cache.remove_matching("")?;
        Ok(())
    }

    fn server_setting(server_id: i64, name: &str) -> String {
        format!("{name}:{server_id}")
    }

    fn watchdog_is_running(&self, server_id: i64) -> bool {
        self.watchdog_running
            .lock()
            .is_ok_and(|running| running.contains(&server_id))
    }

    fn watchdog_cancel_requested(&self, server_id: i64) -> bool {
        self.watchdog_cancelled
            .lock()
            .is_ok_and(|cancelled| cancelled.contains(&server_id))
    }

    pub fn manga_selection(
        &self,
        server_id: i64,
        item_id: &str,
    ) -> Result<posterview_contracts::MangaSelection, RuntimeError> {
        let value = self
            .server_store()?
            .get_setting(&format!("mangadex-selection:{server_id}:{item_id}"))?;
        Ok(serde_json::from_str(&value).unwrap_or_default())
    }

    pub fn save_manga_selection(
        &self,
        server_id: i64,
        item_id: &str,
        selection: &posterview_contracts::MangaSelection,
    ) -> Result<(), RuntimeError> {
        let value = serde_json::to_string(selection).map_err(std::io::Error::other)?;
        self.server_store()?
            .set_setting(&format!("mangadex-selection:{server_id}:{item_id}"), &value)?;
        self.refresh_mangadex_cache(server_id, item_id);
        Ok(())
    }

    pub fn refresh_mangadex_cache(&self, server_id: i64, item_id: &str) {
        if let Ok(cache) = self.server_artwork_cache(server_id) {
            let _ = cache.remove_matching(&format!("artwork:mangadex:{server_id}:{item_id}:"));
            let _ =
                cache.remove_matching(&format!("artwork-search:mangadex:{server_id}:{item_id}:"));
        }
    }

    pub fn refresh_artwork_provider_cache(&self, provider: &str, server_id: i64, item_id: &str) {
        if let Ok(cache) = self.server_artwork_cache(server_id) {
            let _ = cache.remove_matching(&format!("artwork:{provider}:{server_id}:{item_id}:"));
        }
    }

    pub async fn mangadex_image(
        &self,
        server_id: i64,
        url: &str,
    ) -> Result<(Vec<u8>, String), String> {
        let settings = self
            .artwork_cache_settings(server_id)
            .map_err(|e| e.to_string())?;
        let cache = self
            .server_artwork_cache(server_id)
            .map_err(|error| error.to_string())?;
        let key = format!("mangadex-image:{url}");
        if let Some(image) = cache.get_image(&key, settings.ttl_days) {
            return Ok(image);
        }
        let image = download_public_image("mangadex", url).await?;
        let _ = cache.put_image(&key, &image.0, &image.1, settings.max_mb, settings.ttl_days);
        Ok(image)
    }

    pub fn artwork_providers(&self) -> Result<Vec<ArtworkProviderInfo>, RuntimeError> {
        let store = self.server_store()?;
        let enabled = self.enabled_artwork_providers()?;
        Ok(self.artwork.provider_infos(
            &store.get_setting("fanart_api_key")?,
            &store.get_setting("tvdb_api_key")?,
            &store.get_setting("comicvine_api_key")?,
            &enabled,
        ))
    }

    pub fn artwork_settings(&self) -> Result<ArtworkSettings, RuntimeError> {
        let store = self.server_store()?;
        let enabled = self.enabled_artwork_providers()?;
        let mut default_provider = store.get_setting("artwork_default_provider")?;
        let poster_providers = ["posterdb", "fanart", "tvdb", "anilist", "mediux"];
        let ereader_providers = ["anilist-manga", "mangadex", "viz", "comicvine"];
        if !enabled.contains(&default_provider)
            || !poster_providers.contains(&default_provider.as_str())
        {
            default_provider = poster_providers
                .iter()
                .find(|provider| enabled.contains(**provider))
                .unwrap_or(&"manual")
                .to_string();
        }
        let mut ereader_default_provider = store.get_setting("artwork_ereader_default_provider")?;
        if !enabled.contains(&ereader_default_provider)
            || !ereader_providers.contains(&ereader_default_provider.as_str())
        {
            ereader_default_provider = ereader_providers
                .iter()
                .find(|provider| enabled.contains(**provider))
                .unwrap_or(&"manual")
                .to_string();
        }
        Ok(ArtworkSettings {
            fanart_configured: !store.get_setting("fanart_api_key")?.is_empty(),
            tvdb_configured: !store.get_setting("tvdb_api_key")?.is_empty(),
            comicvine_configured: !store.get_setting("comicvine_api_key")?.is_empty(),
            default_provider,
            ereader_default_provider,
            enabled_providers: ARTWORK_PROVIDERS
                .iter()
                .filter(|provider| enabled.contains(**provider))
                .map(|provider| (*provider).to_owned())
                .collect(),
        })
    }

    fn enabled_artwork_providers(&self) -> Result<std::collections::HashSet<String>, RuntimeError> {
        let store = self.server_store()?;
        let stored = store.get_setting("artwork_enabled_providers")?;
        let mut values = if stored.trim().is_empty() {
            ARTWORK_PROVIDERS
                .iter()
                .map(|value| (*value).to_owned())
                .collect()
        } else if stored == "-" {
            std::collections::HashSet::new()
        } else {
            stored
                .split(',')
                .filter(|value| ARTWORK_PROVIDERS.contains(value))
                .map(str::to_owned)
                .collect()
        };
        let legacy_providers = [
            "posterdb", "fanart", "tvdb", "anilist", "mediux", "mangadex",
        ];
        if store.get_setting("artwork_viz_migrated")?.is_empty()
            && legacy_providers
                .iter()
                .all(|provider| values.contains(*provider))
        {
            values.insert("viz".to_owned());
            store.set_setting(
                "artwork_enabled_providers",
                &values.iter().cloned().collect::<Vec<_>>().join(","),
            )?;
        }
        if store.get_setting("artwork_viz_migrated")?.is_empty() {
            store.set_setting("artwork_viz_migrated", "true")?;
        }
        let pre_comicvine = [
            "posterdb", "fanart", "tvdb", "anilist", "mediux", "mangadex", "viz",
        ];
        if store.get_setting("artwork_comicvine_migrated")?.is_empty()
            && pre_comicvine
                .iter()
                .all(|provider| values.contains(*provider))
        {
            values.insert("comicvine".to_owned());
            store.set_setting(
                "artwork_enabled_providers",
                &values.iter().cloned().collect::<Vec<_>>().join(","),
            )?;
        }
        if store.get_setting("artwork_comicvine_migrated")?.is_empty() {
            store.set_setting("artwork_comicvine_migrated", "true")?;
        }
        if store.get_setting("artwork_anilist_manga_migrated")?.is_empty() {
            let previous = ["posterdb", "fanart", "tvdb", "anilist", "mediux", "mangadex", "viz", "comicvine"];
            if previous.iter().all(|provider| values.contains(*provider)) {
                values.insert("anilist-manga".to_owned());
                store.set_setting(
                    "artwork_enabled_providers",
                    &values.iter().cloned().collect::<Vec<_>>().join(","),
                )?;
            }
            store.set_setting("artwork_anilist_manga_migrated", "true")?;
        }
        Ok(values)
    }

    pub fn artwork_cache_settings(
        &self,
        server_id: i64,
    ) -> Result<ArtworkCacheSettings, RuntimeError> {
        let store = self.server_store()?;
        if store.get_server(server_id)?.is_none() {
            return Err(RuntimeError::Watchdog("Media server not found.".to_owned()));
        }
        let get = |name: &str, fallback: &str| -> Result<String, RuntimeError> {
            let value = store.get_setting(&Self::server_setting(server_id, name))?;
            if value.is_empty() {
                let legacy = store.get_setting(name)?;
                Ok(if legacy.is_empty() {
                    fallback.to_owned()
                } else {
                    legacy
                })
            } else {
                Ok(value)
            }
        };
        Ok(ArtworkCacheSettings {
            max_mb: parse_nonnegative(&get("artwork_cache_max_mb", "250")?, 250).max(25),
            ttl_days: parse_nonnegative(&get("artwork_cache_ttl_days", "30")?, 30).max(1),
            watchdog_enabled: get("artwork_watchdog_enabled", "false")? == "true",
            watchdog_interval_hours: parse_nonnegative(
                &get("artwork_watchdog_interval_hours", "24")?,
                24,
            )
            .clamp(6, 168),
        })
    }

    pub fn artwork_cache_status(&self, server_id: i64) -> Result<ArtworkCacheStatus, RuntimeError> {
        let server = self
            .server_store()?
            .get_server(server_id)?
            .ok_or_else(|| RuntimeError::Watchdog("Media server not found.".to_owned()))?;
        let settings = self.artwork_cache_settings(server_id)?;
        let usage = self.server_artwork_cache(server_id)?.usage()?;
        let setting = |name: &str| {
            self.server_store()?
                .get_setting(&Self::server_setting(server_id, name))
                .map_err(RuntimeError::from)
        };
        let running = self.watchdog_is_running(server_id);
        let cancelled = self.watchdog_cancel_requested(server_id);
        let phase = setting("artwork_watchdog_state")?;
        let permanent_failure = setting("artwork_watchdog_failure_permanent")? == "true";
        let last_run = optional_setting(setting("artwork_watchdog_last_run")?);
        let last_message = optional_setting(setting("artwork_watchdog_last_message")?);
        let last_success = optional_setting(setting("artwork_watchdog_last_successful_run")?)
            .or_else(|| {
                last_message
                    .as_ref()
                    .filter(|message| {
                        message.starts_with("Watchdog initial build")
                            || message.starts_with("Watchdog incremental scan")
                    })
                    .and(last_run.clone())
            });
        let state = if running {
            if cancelled {
                WatchdogState::Stopping
            } else if phase == "preloading" {
                WatchdogState::Preloading
            } else {
                WatchdogState::Scanning
            }
        } else if phase == "failed"
            || permanent_failure
            || last_message.as_ref().is_some_and(|message| {
                message.starts_with("Watchdog paused") || message.starts_with("Watchdog stopped")
            })
        {
            WatchdogState::Failed
        } else {
            WatchdogState::Idle
        };
        let next_run = if running || permanent_failure {
            None
        } else if let Ok(retry) =
            chrono::DateTime::parse_from_rfc3339(&setting("artwork_watchdog_retry_after")?)
        {
            Some(retry.with_timezone(&chrono::Utc).to_rfc3339())
        } else if !setting("artwork_watchdog_checkpoint")?.is_empty() {
            Some(chrono::Utc::now().to_rfc3339())
        } else if settings.watchdog_enabled {
            Some(
                last_run
                    .as_ref()
                    .and_then(|last| chrono::DateTime::parse_from_rfc3339(last).ok())
                    .map(|last| {
                        last.with_timezone(&chrono::Utc)
                            + chrono::Duration::hours(settings.watchdog_interval_hours as i64)
                    })
                    .unwrap_or_else(chrono::Utc::now)
                    .to_rfc3339(),
            )
        } else {
            None
        };
        Ok(ArtworkCacheStatus {
            server_id,
            server_name: server.name,
            max_mb: settings.max_mb,
            ttl_days: settings.ttl_days,
            used_bytes: usage.bytes,
            file_count: usage.files,
            watchdog_enabled: settings.watchdog_enabled,
            watchdog_interval_hours: settings.watchdog_interval_hours,
            watchdog_running: running,
            watchdog_state: state,
            watchdog_last_successful_run: last_success,
            watchdog_next_run: next_run,
            watchdog_last_run: last_run,
            watchdog_last_message: last_message,
            watchdog_progress_current: parse_nonnegative(
                &self.server_store()?.get_setting(&Self::server_setting(
                    server_id,
                    "artwork_watchdog_progress_current",
                ))?,
                0,
            ) as usize,
            watchdog_progress_total: parse_nonnegative(
                &self.server_store()?.get_setting(&Self::server_setting(
                    server_id,
                    "artwork_watchdog_progress_total",
                ))?,
                0,
            ) as usize,
            watchdog_current_title: optional_setting(self.server_store()?.get_setting(
                &Self::server_setting(server_id, "artwork_watchdog_current_title"),
            )?),
            watchdog_cancel_requested: self.watchdog_cancel_requested(server_id),
        })
    }

    pub fn set_artwork_cache_settings(
        &self,
        server_id: i64,
        input: &ArtworkCacheSettings,
    ) -> Result<ArtworkCacheStatus, RuntimeError> {
        let store = self.server_store()?;
        let max_mb = input.max_mb.clamp(25, 10_240);
        let ttl_days = input.ttl_days.clamp(1, 365);
        let interval_hours = input.watchdog_interval_hours.clamp(6, 168);
        store.set_setting(
            &Self::server_setting(server_id, "artwork_cache_max_mb"),
            &max_mb.to_string(),
        )?;
        store.set_setting(
            &Self::server_setting(server_id, "artwork_cache_ttl_days"),
            &ttl_days.to_string(),
        )?;
        store.set_setting(
            &Self::server_setting(server_id, "artwork_watchdog_enabled"),
            if input.watchdog_enabled {
                "true"
            } else {
                "false"
            },
        )?;
        store.set_setting(
            &Self::server_setting(server_id, "artwork_watchdog_interval_hours"),
            &interval_hours.to_string(),
        )?;
        self.server_artwork_cache(server_id)?
            .prune(max_mb, ttl_days)?;
        self.artwork_cache_status(server_id)
    }

    pub fn clear_artwork_cache(
        &self,
        server_id: i64,
    ) -> Result<ArtworkCacheClearResult, RuntimeError> {
        let usage = self.server_artwork_cache(server_id)?.clear()?;
        Ok(ArtworkCacheClearResult {
            cleared_bytes: usage.bytes,
            cleared_files: usage.files,
        })
    }

    pub fn watchdog_due(&self, server_id: i64) -> Result<bool, RuntimeError> {
        self.server_artwork_cache(server_id)?;
        let settings = self.artwork_cache_settings(server_id)?;
        if self.watchdog_is_running(server_id) {
            return Ok(false);
        }
        if self.server_store()?.get_setting(&Self::server_setting(
            server_id,
            "artwork_watchdog_failure_permanent",
        ))? == "true"
        {
            return Ok(false);
        }
        let retry_after = self.server_store()?.get_setting(&Self::server_setting(
            server_id,
            "artwork_watchdog_retry_after",
        ))?;
        if let Ok(value) = chrono::DateTime::parse_from_rfc3339(&retry_after) {
            return Ok(value <= chrono::Utc::now());
        }
        if !self
            .server_store()?
            .get_setting(&Self::server_setting(
                server_id,
                "artwork_watchdog_checkpoint",
            ))?
            .is_empty()
        {
            return Ok(true);
        }
        if !settings.watchdog_enabled {
            return Ok(false);
        }
        let last = self.server_store()?.get_setting(&Self::server_setting(
            server_id,
            "artwork_watchdog_last_run",
        ))?;
        let elapsed = chrono::DateTime::parse_from_rfc3339(&last)
            .ok()
            .and_then(|value| {
                chrono::Utc::now()
                    .signed_duration_since(value)
                    .to_std()
                    .ok()
            });
        Ok(elapsed.is_none_or(|value| {
            value >= Duration::from_secs(settings.watchdog_interval_hours as u64 * 3600)
        }))
    }

    pub async fn refresh_artwork_item(
        &self,
        server_id: i64,
        item_id: &str,
    ) -> Result<Option<ArtworkRefreshResult>, RuntimeError> {
        self.refresh_artwork_item_inner(server_id, item_id, true)
            .await
    }

    async fn refresh_artwork_item_inner(
        &self,
        server_id: i64,
        item_id: &str,
        force: bool,
    ) -> Result<Option<ArtworkRefreshResult>, RuntimeError> {
        let detail = request_with_retry("Media server", || async {
            self.get_item_detail(server_id, item_id)
                .await
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "Item not found.".to_owned())?
        })
        .await;
        let detail = match detail {
            Ok(value) => value,
            Err(message) => {
                return Ok(Some(ArtworkRefreshResult {
                    ok: false,
                    message,
                    providers_warmed: 0,
                }));
            }
        };
        let cache = self.server_artwork_cache(server_id)?;
        if force {
            let item_pattern = format!(":{server_id}:{item_id}:");
            cache.remove_matching(&item_pattern)?;
            cache.remove_matching(&format!(
                "posterdb-search:{}",
                detail.title.trim().to_lowercase()
            ))?;
            cache.remove_matching(&format!(
                "posterdb-prewarm-search:{}",
                detail.title.trim().to_lowercase()
            ))?;
        }

        let store = self.server_store()?;
        let fanart_key = store.get_setting("fanart_api_key")?;
        let tvdb_key = store.get_setting("tvdb_api_key")?;
        let tvdb_pin = store.get_setting("tvdb_pin")?;
        let comicvine_key = store.get_setting("comicvine_api_key")?;
        let settings = self.artwork_cache_settings(server_id)?;
        let enabled = self.enabled_artwork_providers()?;
        let providers = ["fanart", "tvdb", "anilist", "anilist-manga", "mediux"];
        let mut warmed = 0;
        for provider in providers {
            let key = format!("artwork:{provider}:{server_id}:{item_id}:");
            if !provider_applies_to_item(provider, &detail)
                || !enabled.contains(provider)
                || (!force && cache.has_fresh_json(&key, settings.ttl_days))
                || (provider == "fanart" && fanart_key.is_empty())
                || (provider == "tvdb" && tvdb_key.is_empty())
            {
                continue;
            }
            let items = request_with_retry(provider, || {
                self.artwork.fetch(
                    provider,
                    &detail,
                    None,
                    &fanart_key,
                    &tvdb_key,
                    &tvdb_pin,
                    &comicvine_key,
                )
            })
            .await
            .map_err(RuntimeError::Watchdog)?;
            {
                let response = ArtworkResults {
                    provider: provider.to_owned(),
                    item_title: Some(detail.title.clone()),
                    items,
                    message: None,
                };
                cache.put_json(&key, &response, settings.max_mb, settings.ttl_days)?;
                warmed += 1;
            }
        }

        let posterdb_key = format!(
            "posterdb-prewarm-search:{}",
            detail.title.trim().to_lowercase()
        );
        let email = store.get_setting("posterdb_email")?;
        let password = store.get_setting("posterdb_password")?;
        if enabled.contains("posterdb")
            && !email.is_empty()
            && !password.is_empty()
            && (force || !cache.has_fresh_json(&posterdb_key, settings.ttl_days))
        {
            let results = request_with_retry("ThePosterDB", || {
                self.artwork
                    .posterdb()
                    .search(&detail.title, &email, &password)
            })
            .await
            .map_err(RuntimeError::Watchdog)?;
            let results = posterdb_top_three(results);
            cache.put_json(&posterdb_key, &results, settings.max_mb, settings.ttl_days)?;
            warmed += 1;
        }

        Ok(Some(ArtworkRefreshResult {
            ok: true,
            message: format!("Refreshed artwork for {}.", detail.title),
            providers_warmed: warmed,
        }))
    }

    pub async fn run_watchdog(&self, server_id: i64) -> Result<ArtworkRefreshResult, RuntimeError> {
        {
            let mut running = self
                .watchdog_running
                .lock()
                .map_err(|_| std::io::Error::other("watchdog state lock poisoned"))?;
            if !running.insert(server_id) {
                return Ok(ArtworkRefreshResult {
                    ok: false,
                    message: "Watchdog is already running for this server.".to_owned(),
                    providers_warmed: 0,
                });
            }
            if let Ok(mut cancelled) = self.watchdog_cancelled.lock() {
                cancelled.remove(&server_id);
            }
        }
        let guard = WatchdogRunGuard {
            runtime: self,
            server_id,
        };
        self.server_store()?.set_setting(
            &Self::server_setting(server_id, "artwork_watchdog_failure_permanent"),
            "",
        )?;
        for (name, value) in [
            ("artwork_watchdog_state", "scanning"),
            ("artwork_watchdog_current_title", ""),
            ("artwork_watchdog_progress_current", "0"),
            ("artwork_watchdog_progress_total", "0"),
        ] {
            self.server_store()?
                .set_setting(&Self::server_setting(server_id, name), value)?;
        }
        let result = self
            .cancellable_watchdog(server_id, self.run_watchdog_inner(server_id))
            .await;
        drop(guard);
        let store = self.server_store()?;
        if let Ok(summary) = &result {
            store.set_setting(
                &Self::server_setting(server_id, "artwork_watchdog_state"),
                "idle",
            )?;
            store.set_setting(
                &Self::server_setting(server_id, "artwork_watchdog_retry_after"),
                "",
            )?;
            let now = chrono::Utc::now().to_rfc3339();
            if summary.ok {
                store.set_setting(
                    &Self::server_setting(server_id, "artwork_watchdog_last_successful_run"),
                    &now,
                )?;
            }
            store.set_setting(
                &Self::server_setting(server_id, "artwork_watchdog_last_run"),
                &now,
            )?;
            store.set_setting(
                &Self::server_setting(server_id, "artwork_watchdog_last_message"),
                &summary.message,
            )?;
        } else if let Err(error) = &result {
            store.set_setting(
                &Self::server_setting(server_id, "artwork_watchdog_state"),
                "failed",
            )?;
            let temporary = temporary_failure(&error.to_string());
            store.set_setting(
                &Self::server_setting(server_id, "artwork_watchdog_failure_permanent"),
                if temporary { "" } else { "true" },
            )?;
            store.set_setting(
                &Self::server_setting(server_id, "artwork_watchdog_retry_after"),
                &if temporary {
                    (chrono::Utc::now() + chrono::Duration::minutes(5)).to_rfc3339()
                } else {
                    String::new()
                },
            )?;
            store.set_setting(
                &Self::server_setting(server_id, "artwork_watchdog_last_message"),
                &if temporary {
                    format!("Watchdog paused and will resume: {error}")
                } else {
                    format!("Watchdog stopped; resolve the error and run it again: {error}")
                },
            )?;
        }
        result
    }

    async fn cancellable_watchdog(
        &self,
        server_id: i64,
        work: impl std::future::Future<Output = Result<ArtworkRefreshResult, RuntimeError>>,
    ) -> Result<ArtworkRefreshResult, RuntimeError> {
        tokio::select! {
            result = work => result,
            _ = async {
                loop {
                    if self.watchdog_cancel_requested(server_id) { break; }
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
            } => {
                let store = self.server_store()?;
                store.set_setting(&Self::server_setting(server_id, "artwork_watchdog_checkpoint"), "")?;
                store.set_setting(&Self::server_setting(server_id, "artwork_watchdog_current_title"), "")?;
                Ok(ArtworkRefreshResult { ok: false, message: "Watchdog cancelled.".to_owned(), providers_warmed: 0 })
            }
        }
    }

    pub fn cancel_watchdog(&self, server_id: i64) -> Result<ArtworkRefreshResult, RuntimeError> {
        if !self.watchdog_is_running(server_id) {
            return Ok(ArtworkRefreshResult {
                ok: false,
                message: "Watchdog is not running for this server.".to_owned(),
                providers_warmed: 0,
            });
        }
        self.watchdog_cancelled
            .lock()
            .map_err(|_| std::io::Error::other("watchdog cancellation lock poisoned"))?
            .insert(server_id);
        Ok(ArtworkRefreshResult {
            ok: true,
            message: "Watchdog cancellation requested.".to_owned(),
            providers_warmed: 0,
        })
    }

    async fn run_watchdog_inner(
        &self,
        server_id: i64,
    ) -> Result<ArtworkRefreshResult, RuntimeError> {
        self.server_artwork_cache(server_id)?;
        let server = self
            .server_store()?
            .get_server(server_id)?
            .ok_or_else(|| RuntimeError::Watchdog("Media server not found.".to_owned()))?;
        let mut seen = std::collections::HashSet::new();
        let mut discovered = Vec::new();
        let libraries = request_with_retry(&server.name, || async {
            self.get_libraries(server.id)
                .await
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "Media server not found.".to_owned())?
        })
        .await
        .map_err(RuntimeError::Watchdog)?;
        for library in libraries {
            if self.watchdog_cancel_requested(server_id) {
                let store = self.server_store()?;
                store.set_setting(
                    &Self::server_setting(server_id, "artwork_watchdog_checkpoint"),
                    "",
                )?;
                store.set_setting(
                    &Self::server_setting(server_id, "artwork_watchdog_current_title"),
                    "",
                )?;
                return Ok(ArtworkRefreshResult {
                    ok: false,
                    message: "Watchdog cancelled.".to_owned(),
                    providers_warmed: 0,
                });
            }
            if library.library_type == posterview_contracts::LibraryType::Other {
                continue;
            }
            let items = request_with_retry(&server.name, || async {
                self.get_items(server.id, &library.id, false)
                    .await
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| "Media server not found.".to_owned())?
            })
            .await
            .map_err(RuntimeError::Watchdog)?;
            for item in items {
                if seen.insert(item.id.clone()) {
                    discovered.push((server.id, item.id, item.title));
                }
            }
        }

        let store = self.server_store()?;
        let previous_inventory =
            serde_json::from_str::<std::collections::BTreeMap<String, String>>(
                &store.get_setting(&Self::server_setting(
                    server_id,
                    "artwork_watchdog_inventory",
                ))?,
            )
            .unwrap_or_default();
        let current_inventory = discovered
            .iter()
            .map(|(server_id, item_id, title)| (format!("{server_id}:{item_id}"), title.clone()))
            .collect::<std::collections::BTreeMap<_, _>>();
        let initial_build = previous_inventory.is_empty();
        let (new_items, removed_inventory) =
            watchdog_inventory_diff(&previous_inventory, &current_inventory);
        let queue = discovered
            .into_iter()
            .filter(|(server_id, item_id, _)| new_items.contains(&format!("{server_id}:{item_id}")))
            .collect::<Vec<_>>();
        let checkpoint = store.get_setting(&Self::server_setting(
            server_id,
            "artwork_watchdog_checkpoint",
        ))?;
        let start = queue
            .iter()
            .position(|(server_id, item_id, _)| format!("{server_id}:{item_id}") == checkpoint)
            .map_or(0, |index| index + 1);
        store.set_setting(
            &Self::server_setting(server_id, "artwork_watchdog_progress_total"),
            &queue.len().to_string(),
        )?;
        store.set_setting(
            &Self::server_setting(server_id, "artwork_watchdog_progress_current"),
            &start.to_string(),
        )?;

        let mut items_refreshed = 0;
        let mut providers_warmed = 0;
        store.set_setting(
            &Self::server_setting(server_id, "artwork_watchdog_state"),
            "preloading",
        )?;
        for (index, (server_id, item_id, title)) in queue.iter().enumerate().skip(start) {
            if self.watchdog_cancel_requested(*server_id) {
                store.set_setting(
                    &Self::server_setting(*server_id, "artwork_watchdog_checkpoint"),
                    "",
                )?;
                store.set_setting(
                    &Self::server_setting(*server_id, "artwork_watchdog_current_title"),
                    "",
                )?;
                return Ok(ArtworkRefreshResult {
                    ok: false,
                    message: format!("Watchdog cancelled after {items_refreshed} titles."),
                    providers_warmed,
                });
            }
            store.set_setting(
                &Self::server_setting(*server_id, "artwork_watchdog_current_title"),
                title,
            )?;
            if let Some(result) = self
                .refresh_artwork_item_inner(*server_id, item_id, false)
                .await?
            {
                if !result.ok {
                    return Err(RuntimeError::Watchdog(result.message));
                }
                items_refreshed += 1;
                providers_warmed += result.providers_warmed;
            }
            store.set_setting(
                &Self::server_setting(*server_id, "artwork_watchdog_checkpoint"),
                &format!("{server_id}:{item_id}"),
            )?;
            store.set_setting(
                &Self::server_setting(*server_id, "artwork_watchdog_progress_current"),
                &(index + 1).to_string(),
            )?;
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        let settings = self.artwork_cache_settings(server_id)?;
        self.server_artwork_cache(server_id)?
            .prune(settings.max_mb, settings.ttl_days)?;

        let current_titles = current_inventory
            .values()
            .map(|title| title.trim().to_lowercase())
            .collect::<std::collections::HashSet<_>>();
        let mut removed_items = 0;
        for (key, title) in &removed_inventory {
            if let Some((_inventory_server_id, item_id)) = key.split_once(':') {
                let cache = self.server_artwork_cache(server_id)?;
                let _ = cache.remove_matching(&format!(":{server_id}:{item_id}:"));
            }
            if !current_titles.contains(&title.trim().to_lowercase()) {
                let cache = self.server_artwork_cache(server_id)?;
                let _ = cache
                    .remove_matching(&format!("posterdb-search:{}", title.trim().to_lowercase()));
                let _ = cache.remove_matching(&format!(
                    "posterdb-prewarm-search:{}",
                    title.trim().to_lowercase()
                ));
            }
            removed_items += 1;
        }
        store.set_setting(
            &Self::server_setting(server_id, "artwork_watchdog_inventory"),
            &serde_json::to_string(&current_inventory).map_err(|error| {
                RuntimeError::Watchdog(format!("Could not save Watchdog inventory: {error}"))
            })?,
        )?;
        store.set_setting(
            &Self::server_setting(server_id, "artwork_watchdog_checkpoint"),
            "",
        )?;
        store.set_setting(
            &Self::server_setting(server_id, "artwork_watchdog_current_title"),
            "",
        )?;
        let run_kind = if initial_build {
            "initial build"
        } else {
            "incremental scan"
        };
        Ok(ArtworkRefreshResult {
            ok: true,
            message: format!(
                "Watchdog {run_kind} added {items_refreshed} new titles, removed {removed_items} missing titles, and warmed {providers_warmed} provider lookups ({}/{} queued).",
                queue.len().saturating_sub(start),
                queue.len()
            ),
            providers_warmed,
        })
    }

    pub async fn set_artwork_settings(
        &self,
        input: &ArtworkSettingsUpdate,
    ) -> Result<ArtworkSettings, RuntimeError> {
        let store = self.server_store()?;
        if let Some(value) = input
            .fanart_api_key
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            store.set_setting("fanart_api_key", value.trim())?;
        }
        if let Some(value) = input
            .tvdb_api_key
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            store.set_setting("tvdb_api_key", value.trim())?;
        }
        if let Some(value) = &input.tvdb_pin {
            store.set_setting("tvdb_pin", value.trim())?;
        }
        if let Some(value) = input
            .comicvine_api_key
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            store.set_setting("comicvine_api_key", value.trim())?;
        }
        if input
            .tvdb_api_key
            .as_deref()
            .is_some_and(|value| !value.is_empty())
            || input.tvdb_pin.is_some()
            || input.comicvine_api_key.is_some()
        {
            self.artwork.reset_tvdb_cache().await;
        }
        if input.fanart_api_key.is_some()
            || input.tvdb_api_key.is_some()
            || input.tvdb_pin.is_some()
        {
            self.clear_all_artwork_caches()?;
        }
        if let Some(providers) = &input.enabled_providers {
            let enabled = ARTWORK_PROVIDERS
                .iter()
                .filter(|provider| providers.iter().any(|value| value == **provider))
                .copied()
                .collect::<Vec<_>>();
            let enabled_value = if enabled.is_empty() {
                "-".to_owned()
            } else {
                enabled.join(",")
            };
            store.set_setting("artwork_enabled_providers", &enabled_value)?;
            for provider in ARTWORK_PROVIDERS {
                if !enabled.contains(&provider) {
                    let pattern = if provider == "posterdb" {
                        "posterdb-"
                    } else {
                        provider
                    };
                    for server in self.list_servers()? {
                        self.server_artwork_cache(server.id)?
                            .remove_matching(pattern)?;
                    }
                    self.artwork_cache.remove_matching(pattern)?;
                }
            }
        }
        if let Some(provider) = input.default_provider.as_deref()
            && (["posterdb", "fanart", "tvdb", "anilist", "mediux"].contains(&provider)
                || provider == "manual")
        {
            store.set_setting("artwork_default_provider", provider)?;
        }
        if let Some(provider) = input.ereader_default_provider.as_deref()
            && (["anilist-manga", "mangadex", "viz", "comicvine"].contains(&provider)
                || provider == "manual")
        {
            store.set_setting("artwork_ereader_default_provider", provider)?;
        }
        self.artwork_settings()
    }

    pub async fn test_artwork_provider(
        &self,
        input: &ArtworkProviderTestRequest,
    ) -> Result<ArtworkProviderTestResult, RuntimeError> {
        let store = self.server_store()?;
        let result = match input.provider.as_str() {
            "fanart" => {
                let key = input
                    .fanart_api_key
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .map(str::trim)
                    .map(str::to_owned)
                    .unwrap_or(store.get_setting("fanart_api_key")?);
                self.artwork.test_fanart(&key).await
            }
            "tvdb" => {
                let typed_key = input
                    .tvdb_api_key
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .map(str::trim);
                let key = match typed_key {
                    Some(value) => value.to_owned(),
                    None => store.get_setting("tvdb_api_key")?,
                };
                let pin = if typed_key.is_some() {
                    input.tvdb_pin.as_deref().unwrap_or("").trim().to_owned()
                } else {
                    input
                        .tvdb_pin
                        .as_deref()
                        .filter(|value| !value.trim().is_empty())
                        .map(str::trim)
                        .map(str::to_owned)
                        .unwrap_or(store.get_setting("tvdb_pin")?)
                };
                self.artwork.test_tvdb(&key, &pin).await
            }
            "comicvine" => {
                let key = input
                    .comicvine_api_key
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .map(str::trim)
                    .map(str::to_owned)
                    .unwrap_or(store.get_setting("comicvine_api_key")?);
                self.artwork.test_comicvine(&key).await
            }
            _ => Err(format!("Unknown artwork provider: {}", input.provider)),
        };
        Ok(match result {
            Ok(()) => ArtworkProviderTestResult {
                ok: true,
                message: match input.provider.as_str() {
                    "fanart" => "Fanart.tv API connection succeeded.",
                    "tvdb" => "TheTVDB API connection succeeded.",
                    "comicvine" => "ComicVine API connection succeeded.",
                    _ => "Artwork provider connection succeeded.",
                }
                .to_owned(),
            },
            Err(message) => ArtworkProviderTestResult { ok: false, message },
        })
    }

    pub async fn get_artwork(
        &self,
        provider: &str,
        server_id: i64,
        item_id: &str,
        id_override: Option<&str>,
    ) -> Result<Option<Result<ArtworkResults, String>>, RuntimeError> {
        let selection = self.manga_selection(server_id, item_id)?;
        let id_override = if provider == "mangadex" {
            id_override.or_else(|| {
                (!selection.mangadex_id.is_empty()).then_some(selection.mangadex_id.as_str())
            })
        } else {
            id_override
        };
        if !self.enabled_artwork_providers()?.contains(provider) {
            return Ok(Some(Err(format!(
                "{provider} is disabled in Database settings."
            ))));
        }
        let cache_key = format!(
            "artwork:{provider}:{server_id}:{item_id}:{}",
            id_override.unwrap_or("")
        );
        let cache_settings = self.artwork_cache_settings(server_id)?;
        let cache = self.server_artwork_cache(server_id)?;
        if let Some(cached) = cache.get_json(&cache_key, cache_settings.ttl_days) {
            return Ok(Some(Ok(scoped_artwork(cached, server_id))));
        }
        let Some(detail) = self.get_item_detail(server_id, item_id).await? else {
            return Ok(None);
        };
        let detail = match detail {
            Ok(detail) => detail,
            Err(message) => {
                return Ok(Some(Err(message)));
            }
        };
        let store = self.server_store()?;
        let result = self
            .artwork
            .fetch(
                provider,
                &detail,
                id_override,
                &store.get_setting("fanart_api_key")?,
                &store.get_setting("tvdb_api_key")?,
                &store.get_setting("tvdb_pin")?,
                &store.get_setting("comicvine_api_key")?,
            )
            .await;
        let response = match result {
            Ok(items) => ArtworkResults {
                provider: provider.to_owned(),
                item_title: Some(detail.title),
                items,
                message: None,
            },
            Err(message) => ArtworkResults {
                provider: provider.to_owned(),
                item_title: Some(detail.title),
                items: Vec::new(),
                message: Some(message),
            },
        };
        if response.message.is_none() {
            let _ = cache.put_json(
                &cache_key,
                &response,
                cache_settings.max_mb,
                cache_settings.ttl_days,
            );
        }
        Ok(Some(Ok(scoped_artwork(response, server_id))))
    }

    pub async fn search_artwork(
        &self,
        provider: &str,
        server_id: i64,
        item_id: &str,
        query: &str,
    ) -> Result<Option<Result<ArtworkSearchResults, String>>, RuntimeError> {
        if !self.enabled_artwork_providers()?.contains(provider) {
            return Ok(Some(Err(format!(
                "{provider} is disabled in Database settings."
            ))));
        }
        let cache_key = format!(
            "artwork-search:{provider}:{server_id}:{item_id}:v2:{}",
            query.trim().to_lowercase()
        );
        let cache_settings = self.artwork_cache_settings(server_id)?;
        let cache = self.server_artwork_cache(server_id)?;
        if let Some(cached) = cache.get_json(&cache_key, cache_settings.ttl_days) {
            return Ok(Some(Ok(scoped_search(cached, server_id))));
        }
        let Some(detail) = self.get_item_detail(server_id, item_id).await? else {
            return Ok(None);
        };
        let detail = match detail {
            Ok(detail) => detail,
            Err(message) => {
                return Ok(Some(Err(message)));
            }
        };
        let store = self.server_store()?;
        let kind = if detail.item_type == posterview_contracts::ItemType::Movie {
            "movie"
        } else {
            "series"
        };
        let result = self
            .artwork
            .search(
                provider,
                query,
                kind,
                &store.get_setting("tvdb_api_key")?,
                &store.get_setting("tvdb_pin")?,
                &store.get_setting("comicvine_api_key")?,
            )
            .await;
        let response = match result {
            Ok(results) => ArtworkSearchResults {
                provider: provider.to_owned(),
                results,
                message: None,
            },
            Err(message) => ArtworkSearchResults {
                provider: provider.to_owned(),
                results: Vec::new(),
                message: Some(message),
            },
        };
        if response.message.is_none() {
            let _ = cache.put_json(
                &cache_key,
                &response,
                cache_settings.max_mb,
                cache_settings.ttl_days,
            );
        }
        Ok(Some(Ok(scoped_search(response, server_id))))
    }

    pub async fn mediux_image(
        &self,
        server_id: i64,
        url: &str,
    ) -> Result<(Vec<u8>, String), String> {
        let settings = self
            .artwork_cache_settings(server_id)
            .map_err(|error| error.to_string())?;
        let cache = self
            .server_artwork_cache(server_id)
            .map_err(|error| error.to_string())?;
        let key = format!("mediux-image:{url}");
        if let Some(cached) = cache.get_image(&key, settings.ttl_days) {
            return Ok(cached);
        }
        let fetched = fetch_mediux_thumb(url).await?;
        let _ = cache.put_image(
            &key,
            &fetched.0,
            &fetched.1,
            settings.max_mb,
            settings.ttl_days,
        );
        Ok(fetched)
    }

    pub async fn posterdb_status(&self, message: &str) -> Result<PosterDbStatus, RuntimeError> {
        let store = self.server_store()?;
        Ok(self
            .artwork
            .posterdb()
            .status(
                &store.get_setting("posterdb_email")?,
                &store.get_setting("posterdb_password")?,
                message,
            )
            .await)
    }

    pub async fn set_posterdb_credentials(
        &self,
        input: &PosterDbCredentials,
    ) -> Result<PosterDbStatus, RuntimeError> {
        let store = self.server_store()?;
        store.set_setting("posterdb_email", input.email.trim())?;
        if !input.password.is_empty() {
            store.set_setting("posterdb_password", &input.password)?;
        }
        self.artwork.posterdb().reset().await;
        self.clear_all_artwork_caches()?;
        self.posterdb_status("").await
    }

    pub async fn posterdb_login(&self) -> Result<PosterDbStatus, RuntimeError> {
        let store = self.server_store()?;
        let email = store.get_setting("posterdb_email")?;
        let password = store.get_setting("posterdb_password")?;
        self.artwork.posterdb().reset().await;
        let message = match self.artwork.posterdb().login(&email, &password).await {
            Ok(()) => "Logged in to ThePosterDB.".to_owned(),
            Err(message) => message,
        };
        self.posterdb_status(&message).await
    }

    pub async fn posterdb_search(
        &self,
        server_id: i64,
        term: &str,
    ) -> Result<PosterSearchResults, String> {
        if !self
            .enabled_artwork_providers()
            .map_err(|error| error.to_string())?
            .contains("posterdb")
        {
            return Err("ThePosterDB is disabled in Database settings.".to_owned());
        }
        let settings = self
            .artwork_cache_settings(server_id)
            .map_err(|error| error.to_string())?;
        let store = self.server_store().map_err(|error| error.to_string())?;
        let result = self
            .artwork
            .posterdb()
            .search(
                term,
                &store
                    .get_setting("posterdb_email")
                    .map_err(|error| error.to_string())?,
                &store
                    .get_setting("posterdb_password")
                    .map_err(|error| error.to_string())?,
            )
            .await?;
        let preview = posterdb_top_three(result.clone());
        let cache = self
            .server_artwork_cache(server_id)
            .map_err(|error| error.to_string())?;
        let key = format!("posterdb-prewarm-search:{}", term.trim().to_lowercase());
        let _ = cache.put_json(&key, &preview, settings.max_mb, settings.ttl_days);
        Ok(result)
    }

    pub fn posterdb_search_preview(
        &self,
        server_id: i64,
        term: &str,
    ) -> Result<Option<PosterSearchResults>, String> {
        if !self
            .enabled_artwork_providers()
            .map_err(|error| error.to_string())?
            .contains("posterdb")
        {
            return Ok(None);
        }
        let settings = self
            .artwork_cache_settings(server_id)
            .map_err(|error| error.to_string())?;
        let cache = self
            .server_artwork_cache(server_id)
            .map_err(|error| error.to_string())?;
        let key = format!("posterdb-prewarm-search:{}", term.trim().to_lowercase());
        Ok(cache.get_json(&key, settings.ttl_days))
    }

    pub async fn posterdb_set(&self, server_id: i64, url: &str) -> Result<PosterSet, String> {
        let settings = self
            .artwork_cache_settings(server_id)
            .map_err(|error| error.to_string())?;
        let cache = self
            .server_artwork_cache(server_id)
            .map_err(|error| error.to_string())?;
        let key = format!("posterdb-set:{url}");
        if let Some(cached) = cache.get_json(&key, settings.ttl_days) {
            return Ok(scoped_set(cached, server_id));
        }
        let store = self.server_store().map_err(|error| error.to_string())?;
        let result = self
            .artwork
            .posterdb()
            .get_set(
                url,
                &store
                    .get_setting("posterdb_email")
                    .map_err(|error| error.to_string())?,
                &store
                    .get_setting("posterdb_password")
                    .map_err(|error| error.to_string())?,
            )
            .await?;
        let _ = cache.put_json(&key, &result, settings.max_mb, settings.ttl_days);
        Ok(scoped_set(result, server_id))
    }

    pub async fn posterdb_verify(
        &self,
        server_id: i64,
        ids: &[String],
    ) -> Result<std::collections::HashMap<String, i64>, String> {
        let settings = self
            .artwork_cache_settings(server_id)
            .map_err(|error| error.to_string())?;
        let mut sorted_ids = ids.to_vec();
        sorted_ids.sort();
        let cache = self
            .server_artwork_cache(server_id)
            .map_err(|error| error.to_string())?;
        let key = format!("posterdb-verify:{}", sorted_ids.join(","));
        if let Some(cached) = cache.get_json(&key, settings.ttl_days) {
            return Ok(cached);
        }
        let store = self.server_store().map_err(|error| error.to_string())?;
        let result = self
            .artwork
            .posterdb()
            .verify_titles(
                ids,
                &store
                    .get_setting("posterdb_email")
                    .map_err(|error| error.to_string())?,
                &store
                    .get_setting("posterdb_password")
                    .map_err(|error| error.to_string())?,
            )
            .await?;
        let _ = cache.put_json(&key, &result, settings.max_mb, settings.ttl_days);
        Ok(result)
    }

    pub async fn posterdb_image(
        &self,
        server_id: i64,
        url: &str,
    ) -> Result<(Vec<u8>, String), String> {
        let settings = self
            .artwork_cache_settings(server_id)
            .map_err(|error| error.to_string())?;
        let cache = self
            .server_artwork_cache(server_id)
            .map_err(|error| error.to_string())?;
        let key = format!("posterdb-image:{url}");
        if let Some(cached) = cache.get_image(&key, settings.ttl_days) {
            return Ok(cached);
        }
        let store = self.server_store().map_err(|error| error.to_string())?;
        let result = self
            .artwork
            .posterdb()
            .image(
                url,
                &store
                    .get_setting("posterdb_email")
                    .map_err(|error| error.to_string())?,
                &store
                    .get_setting("posterdb_password")
                    .map_err(|error| error.to_string())?,
                true,
            )
            .await?;
        let _ = cache.put_image(
            &key,
            &result.0,
            &result.1,
            settings.max_mb,
            settings.ttl_days,
        );
        Ok(result)
    }

    pub async fn apply_download(
        &self,
        input: &ApplyRequest,
    ) -> Result<Option<ApplyResult>, RuntimeError> {
        if self.server_store()?.get_server(input.server_id)?.is_none() {
            return Ok(None);
        }
        let downloaded = if input.provider == "mangadex" {
            self.mangadex_image(input.server_id, &input.download_url)
                .await
        } else if input.provider == "posterdb" {
            let store = self.server_store()?;
            self.artwork
                .posterdb()
                .image(
                    &input.download_url,
                    &store.get_setting("posterdb_email")?,
                    &store.get_setting("posterdb_password")?,
                    false,
                )
                .await
        } else {
            download_public_image(&input.provider, &input.download_url).await
        };
        let (data, content_type) = match downloaded {
            Ok(image) => image,
            Err(message) => {
                return Ok(Some(ApplyResult {
                    ok: false,
                    message: format!("Download failed: {message}"),
                }));
            }
        };
        self.apply_image(
            input.server_id,
            &input.item_id,
            &input.target,
            &data,
            &content_type,
            &input.provider,
            &input.item_title,
        )
        .await
    }
}

#[cfg(test)]
#[path = "artwork_tests.rs"]
mod regression_tests;
