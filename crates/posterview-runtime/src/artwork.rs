use std::{sync::Arc, time::Duration};

use crate::{ARTWORK_PROVIDERS, Runtime, RuntimeError, posterdb_top_three};
use posterview_contracts::{
    ApplyRequest, ApplyResult, ArtworkCacheClearResult, ArtworkCacheSettings, ArtworkCacheStatus,
    ArtworkProviderInfo, ArtworkProviderTestRequest, ArtworkProviderTestResult,
    ArtworkRefreshResult, ArtworkResults, ArtworkSearchResults, ArtworkSettings,
    ArtworkSettingsUpdate, ItemDetail, ItemType, PosterDbCredentials, PosterDbStatus,
    PosterSearchResults, PosterSet,
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
    let book = matches!(
        item.item_type,
        ItemType::Book | ItemType::Audiobook | ItemType::Folder
    );
    match provider {
        "anilist-manga" => book,
        "anilist" | "myanimelist" => !book,
        "myanimelist-manga" => book,
        "fanart" if item.item_type == ItemType::Movie => true,
        "fanart" if item.item_type == ItemType::Show => true,
        "fanart" => false,
        "tvdb" => !book,
        "mediux" => !book,
        _ => true,
    }
}

fn provider_item_id<'a>(provider: &str, item: &'a ItemDetail) -> Option<&'a str> {
    let id = |name: &str| {
        item.external_ids
            .get(name)
            .map(String::as_str)
            .filter(|value| !value.trim().is_empty())
    };
    match provider {
        "fanart" if item.item_type == ItemType::Movie => id("tmdb").or_else(|| id("imdb")),
        "fanart" | "tvdb" => id("tvdb"),
        "mediux" => id("tmdb"),
        _ => None,
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
            let settings = self.artwork_cache_settings(server_id)?;
            cache.prune(settings.max_mb, settings.ttl_days)?;
            store.set_setting(&marker, "true")?;
        }
        caches.insert(server_id, Arc::clone(&cache));
        Ok(cache)
    }

    pub fn clear_all_artwork_caches(&self) -> Result<(), RuntimeError> {
        let directory = self.data_dir.join("artwork-cache/servers");
        if directory.is_dir() && !directory.is_symlink() {
            let mut caches = self
                .server_artwork_caches
                .lock()
                .map_err(|_| std::io::Error::other("cache lock poisoned"))?;
            for entry in std::fs::read_dir(directory)? {
                let entry = entry?;
                if !entry.file_type()?.is_dir() {
                    continue;
                }
                let Ok(id) = entry.file_name().to_string_lossy().parse::<i64>() else {
                    continue;
                };
                caches
                    .entry(id)
                    .or_insert_with(|| Arc::new(crate::ArtworkCache::at(entry.path())))
                    .clear()?;
            }
        }
        self.artwork_cache.remove_matching("")?;
        Ok(())
    }

    fn server_setting(server_id: i64, name: &str) -> String {
        format!("{name}:{server_id}")
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
        let mut providers = self.artwork.provider_infos(
            &store.get_setting("fanart_api_key")?,
            &store.get_setting("tvdb_api_key")?,
            &store.get_setting("comicvine_api_key")?,
            &enabled,
        );
        let configured = !store.get_setting("mal_client_id")?.is_empty();
        for (name, label) in [
            ("myanimelist", "MyAnimeList"),
            ("myanimelist-manga", "MyAnimeList Manga"),
        ] {
            providers.push(ArtworkProviderInfo {
                name: name.into(),
                label: label.into(),
                configured,
                needs_key: true,
                enabled: true,
            });
        }
        Ok(providers)
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
            tmdb_configured: !store.get_setting("tmdb_access_token")?.is_empty(),
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
        // All supported sources are available. Ignore legacy disable preferences.
        Ok(ARTWORK_PROVIDERS
            .iter()
            .map(|provider| (*provider).to_owned())
            .collect())
    }

    pub fn artwork_cache_settings(
        &self,
        server_id: i64,
    ) -> Result<ArtworkCacheSettings, RuntimeError> {
        let store = self.server_store()?;
        if server_id != 0 && store.get_server(server_id)?.is_none() {
            return Err(RuntimeError::Artwork("Media server not found.".to_owned()));
        }
        Ok(ArtworkCacheSettings {
            max_mb: 250,
            ttl_days: 30,
        })
    }

    pub fn cleanup_provider_cache(&self, apply: bool) -> Result<(usize, u64), RuntimeError> {
        let mut usage = self.artwork_cache.expired_usage(30, apply)?;
        let directory = self.data_dir.join("artwork-cache/servers");
        if directory.is_dir() && !directory.is_symlink() {
            let mut caches = self
                .server_artwork_caches
                .lock()
                .map_err(|_| std::io::Error::other("cache lock poisoned"))?;
            for entry in std::fs::read_dir(directory)? {
                let entry = entry?;
                if !entry.file_type()?.is_dir() {
                    continue;
                }
                let Ok(id) = entry.file_name().to_string_lossy().parse::<i64>() else {
                    continue;
                };
                let cache = caches
                    .entry(id)
                    .or_insert_with(|| Arc::new(crate::ArtworkCache::at(entry.path())));
                let removed = cache.expired_usage(30, apply)?;
                usage.files += removed.files;
                usage.bytes += removed.bytes;
            }
        }
        Ok((usage.files, usage.bytes))
    }

    pub fn artwork_cache_status(&self, server_id: i64) -> Result<ArtworkCacheStatus, RuntimeError> {
        let server = self
            .server_store()?
            .get_server(server_id)?
            .ok_or_else(|| RuntimeError::Artwork("Media server not found.".to_owned()))?;
        let settings = self.artwork_cache_settings(server_id)?;
        let usage = self.server_artwork_cache(server_id)?.usage()?;
        Ok(ArtworkCacheStatus {
            server_id,
            server_name: server.name,
            max_mb: settings.max_mb,
            ttl_days: settings.ttl_days,
            used_bytes: usage.bytes,
            file_count: usage.files,
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
        store.set_setting(
            &Self::server_setting(server_id, "artwork_cache_max_mb"),
            &max_mb.to_string(),
        )?;
        store.set_setting(
            &Self::server_setting(server_id, "artwork_cache_ttl_days"),
            &ttl_days.to_string(),
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

    pub async fn refresh_artwork_item(
        &self,
        server_id: i64,
        item_id: &str,
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
        {
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
        let mut warmed = 0;
        for provider in ["fanart", "tvdb", "anilist", "anilist-manga", "mediux"] {
            let key = format!("artwork:{provider}:{server_id}:{item_id}:");
            if !provider_applies_to_item(provider, &detail)
                || !enabled.contains(provider)
                || (provider == "fanart" && fanart_key.is_empty())
                || (provider == "tvdb" && tvdb_key.is_empty())
                || (provider == "comicvine" && comicvine_key.is_empty())
            {
                continue;
            }
            let mut resolved_id = provider_item_id(provider, &detail).map(str::to_owned);
            if matches!(provider, "fanart" | "tvdb" | "mediux") && resolved_id.is_none() {
                if tvdb_key.is_empty() {
                    continue;
                }
                let kind = if detail.item_type == ItemType::Movie {
                    "movie"
                } else {
                    "series"
                };
                let matches = request_with_retry("TheTVDB title search", || {
                    self.artwork.search(
                        provider,
                        &detail.title,
                        kind,
                        &tvdb_key,
                        &tvdb_pin,
                        &comicvine_key,
                    )
                })
                .await
                .map_err(RuntimeError::Artwork)?;
                resolved_id = matches.into_iter().next().map(|result| result.id);
                if resolved_id.is_none() {
                    continue;
                }
            }
            let items = request_with_retry(provider, || {
                self.artwork.fetch(
                    provider,
                    &detail,
                    resolved_id.as_deref(),
                    &fanart_key,
                    &tvdb_key,
                    &tvdb_pin,
                    &comicvine_key,
                )
            })
            .await
            .map_err(RuntimeError::Artwork)?;
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
        if enabled.contains("posterdb") && !email.is_empty() && !password.is_empty() {
            let results = request_with_retry("ThePosterDB", || {
                self.artwork
                    .posterdb()
                    .search(&detail.title, &email, &password)
            })
            .await
            .map_err(RuntimeError::Artwork)?;
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

    pub async fn set_artwork_settings(
        &self,
        input: &ArtworkSettingsUpdate,
    ) -> Result<ArtworkSettings, RuntimeError> {
        let store = self.server_store()?;
        if let Some(value) = input
            .tmdb_access_token
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            store.set_setting("tmdb_access_token", value)?;
        }
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
        // Keep accepting legacy requests, but source availability is no longer configurable.
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
            "tmdb" => {
                self.artwork
                    .test_tmdb(&store.get_setting("tmdb_access_token")?)
                    .await
            }
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
                    "tmdb" => "TMDB API connection succeeded.",
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
        let result = if matches!(provider, "myanimelist" | "myanimelist-manga") {
            self.artwork
                .fetch_myanimelist(
                    provider,
                    &store.get_setting("mal_client_id")?,
                    &detail,
                    id_override,
                )
                .await
        } else {
            self.artwork
                .fetch(
                    provider,
                    &detail,
                    id_override,
                    &store.get_setting("fanart_api_key")?,
                    &store.get_setting("tvdb_api_key")?,
                    &store.get_setting("tvdb_pin")?,
                    &store.get_setting("comicvine_api_key")?,
                )
                .await
        };
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
        let result = if matches!(provider, "myanimelist" | "myanimelist-manga") {
            self.artwork
                .search_myanimelist(provider, &store.get_setting("mal_client_id")?, query)
                .await
        } else {
            self.artwork
                .search(
                    provider,
                    query,
                    kind,
                    &store.get_setting("tvdb_api_key")?,
                    &store.get_setting("tvdb_pin")?,
                    &store.get_setting("comicvine_api_key")?,
                )
                .await
        };
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
        self.posterdb_search_with_refresh(server_id, term, false)
            .await
    }

    pub async fn posterdb_search_with_refresh(
        &self,
        server_id: i64,
        term: &str,
        refresh: bool,
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
        let cache = self
            .server_artwork_cache(server_id)
            .map_err(|error| error.to_string())?;
        let key = format!("posterdb-search:{}", term.trim().to_lowercase());
        if refresh {
            cache
                .remove_matching(&key)
                .map_err(|error| error.to_string())?;
            cache
                .remove_matching(&format!(
                    "posterdb-prewarm-search:{}",
                    term.trim().to_lowercase()
                ))
                .map_err(|error| error.to_string())?;
        }
        if let Some(cached) = cache.get_json(&key, settings.ttl_days) {
            return Ok(cached);
        }
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
        let _ = cache.put_json(&key, &result, settings.max_mb, settings.ttl_days);
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

    pub async fn download_artwork_image(
        &self,
        input: &ApplyRequest,
    ) -> Result<(Vec<u8>, String), RuntimeError> {
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
        downloaded.map_err(RuntimeError::Artwork)
    }

    pub async fn apply_download(
        &self,
        input: &ApplyRequest,
    ) -> Result<Option<ApplyResult>, RuntimeError> {
        if self.server_store()?.get_server(input.server_id)?.is_none() {
            return Ok(None);
        }
        let downloaded = self
            .download_artwork_image(input)
            .await
            .map_err(|e| e.to_string());
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
