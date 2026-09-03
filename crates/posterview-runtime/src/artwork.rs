use std::{sync::atomic::Ordering, time::Duration};

use crate::{
    ARTWORK_PROVIDERS, Runtime, RuntimeError, optional_setting, parse_nonnegative,
    posterdb_top_three, watchdog_inventory_diff,
};
use posterview_contracts::{
    ApplyRequest, ApplyResult, ArtworkCacheClearResult, ArtworkCacheSettings, ArtworkCacheStatus,
    ArtworkProviderInfo, ArtworkProviderTestRequest, ArtworkProviderTestResult,
    ArtworkRefreshResult, ArtworkResults, ArtworkSearchResults, ArtworkSettings,
    ArtworkSettingsUpdate, PosterDbCredentials, PosterDbStatus, PosterSearchResults, PosterSet,
};
use posterview_infra_artwork::{download_public_image, fetch_mediux_thumb};

impl Runtime {
    pub fn artwork_providers(&self) -> Result<Vec<ArtworkProviderInfo>, RuntimeError> {
        let store = self.server_store()?;
        let enabled = self.enabled_artwork_providers()?;
        Ok(self.artwork.provider_infos(
            &store.get_setting("fanart_api_key")?,
            &store.get_setting("tvdb_api_key")?,
            &enabled,
        ))
    }

    pub fn artwork_settings(&self) -> Result<ArtworkSettings, RuntimeError> {
        let store = self.server_store()?;
        let enabled = self.enabled_artwork_providers()?;
        let mut default_provider = store.get_setting("artwork_default_provider")?;
        if !enabled.contains(&default_provider) {
            default_provider = ARTWORK_PROVIDERS
                .iter()
                .find(|provider| enabled.contains(**provider))
                .unwrap_or(&"manual")
                .to_string();
        }
        Ok(ArtworkSettings {
            fanart_configured: !store.get_setting("fanart_api_key")?.is_empty(),
            tvdb_configured: !store.get_setting("tvdb_api_key")?.is_empty(),
            default_provider,
            enabled_providers: ARTWORK_PROVIDERS
                .iter()
                .filter(|provider| enabled.contains(**provider))
                .map(|provider| (*provider).to_owned())
                .collect(),
        })
    }

    fn enabled_artwork_providers(&self) -> Result<std::collections::HashSet<String>, RuntimeError> {
        let stored = self
            .server_store()?
            .get_setting("artwork_enabled_providers")?;
        let values = if stored.trim().is_empty() {
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
        Ok(values)
    }

    pub fn artwork_cache_settings(&self) -> Result<ArtworkCacheSettings, RuntimeError> {
        let store = self.server_store()?;
        Ok(ArtworkCacheSettings {
            max_mb: parse_nonnegative(&store.get_setting("artwork_cache_max_mb")?, 250).max(25),
            ttl_days: parse_nonnegative(&store.get_setting("artwork_cache_ttl_days")?, 30).max(1),
            watchdog_enabled: store.get_setting("artwork_watchdog_enabled")? == "true",
            watchdog_interval_hours: parse_nonnegative(
                &store.get_setting("artwork_watchdog_interval_hours")?,
                24,
            )
            .clamp(6, 168),
        })
    }

    pub fn artwork_cache_status(&self) -> Result<ArtworkCacheStatus, RuntimeError> {
        let settings = self.artwork_cache_settings()?;
        let usage = self.artwork_cache.usage()?;
        Ok(ArtworkCacheStatus {
            max_mb: settings.max_mb,
            ttl_days: settings.ttl_days,
            used_bytes: usage.bytes,
            file_count: usage.files,
            watchdog_enabled: settings.watchdog_enabled,
            watchdog_interval_hours: settings.watchdog_interval_hours,
            watchdog_running: self.watchdog_running.load(Ordering::Relaxed),
            watchdog_last_run: optional_setting(
                self.server_store()?
                    .get_setting("artwork_watchdog_last_run")?,
            ),
            watchdog_last_message: optional_setting(
                self.server_store()?
                    .get_setting("artwork_watchdog_last_message")?,
            ),
            watchdog_progress_current: parse_nonnegative(
                &self
                    .server_store()?
                    .get_setting("artwork_watchdog_progress_current")?,
                0,
            ) as usize,
            watchdog_progress_total: parse_nonnegative(
                &self
                    .server_store()?
                    .get_setting("artwork_watchdog_progress_total")?,
                0,
            ) as usize,
            watchdog_current_title: optional_setting(
                self.server_store()?
                    .get_setting("artwork_watchdog_current_title")?,
            ),
        })
    }

    pub fn set_artwork_cache_settings(
        &self,
        input: &ArtworkCacheSettings,
    ) -> Result<ArtworkCacheStatus, RuntimeError> {
        let store = self.server_store()?;
        let max_mb = input.max_mb.clamp(25, 10_240);
        let ttl_days = input.ttl_days.clamp(1, 365);
        let interval_hours = input.watchdog_interval_hours.clamp(6, 168);
        store.set_setting("artwork_cache_max_mb", &max_mb.to_string())?;
        store.set_setting("artwork_cache_ttl_days", &ttl_days.to_string())?;
        store.set_setting(
            "artwork_watchdog_enabled",
            if input.watchdog_enabled {
                "true"
            } else {
                "false"
            },
        )?;
        store.set_setting(
            "artwork_watchdog_interval_hours",
            &interval_hours.to_string(),
        )?;
        self.artwork_cache.prune(max_mb, ttl_days)?;
        self.artwork_cache_status()
    }

    pub fn clear_artwork_cache(&self) -> Result<ArtworkCacheClearResult, RuntimeError> {
        let usage = self.artwork_cache.clear()?;
        Ok(ArtworkCacheClearResult {
            cleared_bytes: usage.bytes,
            cleared_files: usage.files,
        })
    }

    pub fn watchdog_due(&self) -> Result<bool, RuntimeError> {
        let settings = self.artwork_cache_settings()?;
        if self.watchdog_running.load(Ordering::Relaxed) {
            return Ok(false);
        }
        if !self
            .server_store()?
            .get_setting("artwork_watchdog_checkpoint")?
            .is_empty()
        {
            return Ok(true);
        }
        if !settings.watchdog_enabled {
            return Ok(false);
        }
        let last = self
            .server_store()?
            .get_setting("artwork_watchdog_last_run")?;
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
        let Some(detail) = self.get_item_detail(server_id, item_id).await? else {
            return Ok(None);
        };
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
        if force {
            let item_pattern = format!(":{server_id}:{item_id}:");
            self.artwork_cache.remove_matching(&item_pattern)?;
            self.artwork_cache.remove_matching(&format!(
                "posterdb-search:{}",
                detail.title.trim().to_lowercase()
            ))?;
            self.artwork_cache.remove_matching(&format!(
                "posterdb-prewarm-search:{}",
                detail.title.trim().to_lowercase()
            ))?;
        }

        let store = self.server_store()?;
        let fanart_key = store.get_setting("fanart_api_key")?;
        let tvdb_key = store.get_setting("tvdb_api_key")?;
        let tvdb_pin = store.get_setting("tvdb_pin")?;
        let settings = self.artwork_cache_settings()?;
        let enabled = self.enabled_artwork_providers()?;
        let providers = ["fanart", "tvdb", "anilist", "mediux"];
        let mut warmed = 0;
        for provider in providers {
            let key = format!("artwork:{provider}:{server_id}:{item_id}:");
            if !enabled.contains(provider)
                || (!force && self.artwork_cache.has_fresh_json(&key, settings.ttl_days))
                || (provider == "fanart" && fanart_key.is_empty())
                || (provider == "tvdb" && tvdb_key.is_empty())
            {
                continue;
            }
            if let Ok(items) = self
                .artwork
                .fetch(provider, &detail, None, &fanart_key, &tvdb_key, &tvdb_pin)
                .await
            {
                let response = ArtworkResults {
                    provider: provider.to_owned(),
                    item_title: Some(detail.title.clone()),
                    items,
                    message: None,
                };
                let _ = self.artwork_cache.put_json(
                    &key,
                    &response,
                    settings.max_mb,
                    settings.ttl_days,
                );
                warmed += 1;
            }
        }

        let posterdb_key = format!(
            "posterdb-prewarm-search:{}",
            detail.title.trim().to_lowercase()
        );
        if enabled.contains("posterdb")
            && (force
                || !self
                    .artwork_cache
                    .has_fresh_json(&posterdb_key, settings.ttl_days))
            && let Ok(results) = self
                .artwork
                .posterdb()
                .search(
                    &detail.title,
                    &store.get_setting("posterdb_email")?,
                    &store.get_setting("posterdb_password")?,
                )
                .await
        {
            let results = posterdb_top_three(results);
            let _ = self.artwork_cache.put_json(
                &posterdb_key,
                &results,
                settings.max_mb,
                settings.ttl_days,
            );
            warmed += 1;
        }

        Ok(Some(ArtworkRefreshResult {
            ok: true,
            message: format!("Refreshed artwork for {}.", detail.title),
            providers_warmed: warmed,
        }))
    }

    pub async fn run_watchdog(&self) -> Result<ArtworkRefreshResult, RuntimeError> {
        if self
            .watchdog_running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Ok(ArtworkRefreshResult {
                ok: false,
                message: "Watchdog is already running.".to_owned(),
                providers_warmed: 0,
            });
        }
        let result = self.run_watchdog_inner().await;
        self.watchdog_running.store(false, Ordering::SeqCst);
        let store = self.server_store()?;
        if let Ok(summary) = &result {
            let now = chrono::Utc::now().to_rfc3339();
            store.set_setting("artwork_watchdog_last_run", &now)?;
            store.set_setting("artwork_watchdog_last_message", &summary.message)?;
        } else if let Err(error) = &result {
            store.set_setting(
                "artwork_watchdog_last_message",
                &format!("Watchdog paused and will resume: {error}"),
            )?;
        }
        result
    }

    async fn run_watchdog_inner(&self) -> Result<ArtworkRefreshResult, RuntimeError> {
        let mut seen = std::collections::HashSet::new();
        let mut discovered = Vec::new();
        let mut discovery_complete = true;
        for server in self.list_servers()? {
            let Some(Ok(libraries)) = self.get_libraries(server.id).await? else {
                discovery_complete = false;
                continue;
            };
            for library in libraries {
                if library.library_type == posterview_contracts::LibraryType::Other {
                    continue;
                }
                let Some(Ok(items)) = self.get_items(server.id, &library.id, false).await? else {
                    discovery_complete = false;
                    continue;
                };
                for item in items {
                    if seen.insert((server.id, item.id.clone())) {
                        discovered.push((server.id, item.id, item.title));
                    }
                }
            }
        }

        let store = self.server_store()?;
        if !discovery_complete {
            return Err(RuntimeError::Watchdog(
                "Watchdog could not read every library. Existing inventory and cached data were preserved for a safe retry."
                    .to_owned(),
            ));
        }

        let previous_inventory =
            serde_json::from_str::<std::collections::BTreeMap<String, String>>(
                &store.get_setting("artwork_watchdog_inventory")?,
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
        let checkpoint = store.get_setting("artwork_watchdog_checkpoint")?;
        let start = queue
            .iter()
            .position(|(server_id, item_id, _)| format!("{server_id}:{item_id}") == checkpoint)
            .map_or(0, |index| index + 1);
        store.set_setting("artwork_watchdog_progress_total", &queue.len().to_string())?;
        store.set_setting("artwork_watchdog_progress_current", &start.to_string())?;

        let mut items_refreshed = 0;
        let mut providers_warmed = 0;
        for (index, (server_id, item_id, title)) in queue.iter().enumerate().skip(start) {
            store.set_setting("artwork_watchdog_current_title", title)?;
            if let Some(result) = self
                .refresh_artwork_item_inner(*server_id, item_id, false)
                .await?
                && result.ok
            {
                items_refreshed += 1;
                providers_warmed += result.providers_warmed;
            }
            store.set_setting(
                "artwork_watchdog_checkpoint",
                &format!("{server_id}:{item_id}"),
            )?;
            store.set_setting(
                "artwork_watchdog_progress_current",
                &(index + 1).to_string(),
            )?;
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        let settings = self.artwork_cache_settings()?;
        self.artwork_cache
            .prune(settings.max_mb, settings.ttl_days)?;

        let current_titles = current_inventory
            .values()
            .map(|title| title.trim().to_lowercase())
            .collect::<std::collections::HashSet<_>>();
        let mut removed_items = 0;
        for (key, title) in &removed_inventory {
            if let Some((server_id, item_id)) = key.split_once(':') {
                let _ = self
                    .artwork_cache
                    .remove_matching(&format!(":{server_id}:{item_id}:"));
            }
            if !current_titles.contains(&title.trim().to_lowercase()) {
                let _ = self
                    .artwork_cache
                    .remove_matching(&format!("posterdb-search:{}", title.trim().to_lowercase()));
                let _ = self.artwork_cache.remove_matching(&format!(
                    "posterdb-prewarm-search:{}",
                    title.trim().to_lowercase()
                ));
            }
            removed_items += 1;
        }
        store.set_setting(
            "artwork_watchdog_inventory",
            &serde_json::to_string(&current_inventory).map_err(|error| {
                RuntimeError::Watchdog(format!("Could not save Watchdog inventory: {error}"))
            })?,
        )?;
        store.set_setting("artwork_watchdog_checkpoint", "")?;
        store.set_setting("artwork_watchdog_current_title", "")?;
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
        if input
            .tvdb_api_key
            .as_deref()
            .is_some_and(|value| !value.is_empty())
            || input.tvdb_pin.is_some()
        {
            self.artwork.reset_tvdb_cache().await;
        }
        if input.fanart_api_key.is_some()
            || input.tvdb_api_key.is_some()
            || input.tvdb_pin.is_some()
        {
            let _ = self.artwork_cache.clear();
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
                    let _ = self.artwork_cache.remove_matching(pattern);
                }
            }
        }
        if let Some(provider) = input.default_provider.as_deref()
            && (ARTWORK_PROVIDERS.contains(&provider) || provider == "manual")
        {
            store.set_setting("artwork_default_provider", provider)?;
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
            _ => Err(format!("Unknown artwork provider: {}", input.provider)),
        };
        Ok(match result {
            Ok(()) => ArtworkProviderTestResult {
                ok: true,
                message: match input.provider.as_str() {
                    "fanart" => "Fanart.tv API connection succeeded.",
                    "tvdb" => "TheTVDB API connection succeeded.",
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
        if !self.enabled_artwork_providers()?.contains(provider) {
            return Ok(Some(Err(format!(
                "{provider} is disabled in Database settings."
            ))));
        }
        let cache_key = format!(
            "artwork:{provider}:{server_id}:{item_id}:{}",
            id_override.unwrap_or("")
        );
        let cache_settings = self.artwork_cache_settings()?;
        if let Some(cached) = self
            .artwork_cache
            .get_json(&cache_key, cache_settings.ttl_days)
        {
            return Ok(Some(Ok(cached)));
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
            let _ = self.artwork_cache.put_json(
                &cache_key,
                &response,
                cache_settings.max_mb,
                cache_settings.ttl_days,
            );
        }
        Ok(Some(Ok(response)))
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
            "artwork-search:{provider}:{server_id}:{item_id}:{}",
            query.trim().to_lowercase()
        );
        let cache_settings = self.artwork_cache_settings()?;
        if let Some(cached) = self
            .artwork_cache
            .get_json(&cache_key, cache_settings.ttl_days)
        {
            return Ok(Some(Ok(cached)));
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
            let _ = self.artwork_cache.put_json(
                &cache_key,
                &response,
                cache_settings.max_mb,
                cache_settings.ttl_days,
            );
        }
        Ok(Some(Ok(response)))
    }

    pub async fn mediux_image(&self, url: &str) -> Result<(Vec<u8>, String), String> {
        let settings = self
            .artwork_cache_settings()
            .map_err(|error| error.to_string())?;
        let key = format!("mediux-image:{url}");
        if let Some(cached) = self.artwork_cache.get_image(&key, settings.ttl_days) {
            return Ok(cached);
        }
        let fetched = fetch_mediux_thumb(url).await?;
        let _ = self.artwork_cache.put_image(
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
        let _ = self.artwork_cache.clear();
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

    pub async fn posterdb_search(&self, term: &str) -> Result<PosterSearchResults, String> {
        if !self
            .enabled_artwork_providers()
            .map_err(|error| error.to_string())?
            .contains("posterdb")
        {
            return Err("ThePosterDB is disabled in Database settings.".to_owned());
        }
        let settings = self
            .artwork_cache_settings()
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
        let key = format!("posterdb-prewarm-search:{}", term.trim().to_lowercase());
        let _ = self
            .artwork_cache
            .put_json(&key, &preview, settings.max_mb, settings.ttl_days);
        Ok(result)
    }

    pub fn posterdb_search_preview(
        &self,
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
            .artwork_cache_settings()
            .map_err(|error| error.to_string())?;
        let key = format!("posterdb-prewarm-search:{}", term.trim().to_lowercase());
        Ok(self.artwork_cache.get_json(&key, settings.ttl_days))
    }

    pub async fn posterdb_set(&self, url: &str) -> Result<PosterSet, String> {
        let settings = self
            .artwork_cache_settings()
            .map_err(|error| error.to_string())?;
        let key = format!("posterdb-set:{url}");
        if let Some(cached) = self.artwork_cache.get_json(&key, settings.ttl_days) {
            return Ok(cached);
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
        let _ = self
            .artwork_cache
            .put_json(&key, &result, settings.max_mb, settings.ttl_days);
        Ok(result)
    }

    pub async fn posterdb_verify(
        &self,
        ids: &[String],
    ) -> Result<std::collections::HashMap<String, i64>, String> {
        let settings = self
            .artwork_cache_settings()
            .map_err(|error| error.to_string())?;
        let mut sorted_ids = ids.to_vec();
        sorted_ids.sort();
        let key = format!("posterdb-verify:{}", sorted_ids.join(","));
        if let Some(cached) = self.artwork_cache.get_json(&key, settings.ttl_days) {
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
        let _ = self
            .artwork_cache
            .put_json(&key, &result, settings.max_mb, settings.ttl_days);
        Ok(result)
    }

    pub async fn posterdb_image(&self, url: &str) -> Result<(Vec<u8>, String), String> {
        let settings = self
            .artwork_cache_settings()
            .map_err(|error| error.to_string())?;
        let key = format!("posterdb-image:{url}");
        if let Some(cached) = self.artwork_cache.get_image(&key, settings.ttl_days) {
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
        let _ = self.artwork_cache.put_image(
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
        let downloaded = if input.provider == "posterdb" {
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
