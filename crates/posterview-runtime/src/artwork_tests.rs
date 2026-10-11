use super::*;

#[test]
fn removed_artwork_provider_defaults_fall_back_to_supported_sources() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = Runtime::new(dir.path());
    runtime.initialize().unwrap();
    let store = runtime.server_store().unwrap();
    store.set_setting("artwork_default_provider", "deviantart").unwrap();
    store.set_setting("artwork_ereader_default_provider", "deviantart").unwrap();
    let settings = runtime.artwork_settings().unwrap();
    assert_eq!(settings.default_provider, "posterdb");
    assert_eq!(settings.ereader_default_provider, "anilist-manga");
    assert!(!settings.enabled_providers.iter().any(|provider| provider == "deviantart"));
    assert!(!runtime.artwork_providers().unwrap().iter().any(|provider| provider.name == "deviantart"));
}

#[tokio::test]
async fn tmdb_settings_preserve_saved_secret_and_return_only_configuration_status() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = Runtime::new(directory.path());
    runtime.initialize().unwrap();
    assert!(!runtime.artwork_settings().unwrap().tmdb_configured);
    let empty = runtime.test_artwork_provider(&ArtworkProviderTestRequest { provider: "tmdb".into(), ..Default::default() }).await.unwrap();
    assert!(!empty.ok);
    let input = ArtworkSettingsUpdate { tmdb_access_token: Some("  private-token  ".into()), ..Default::default() };
    let settings = runtime.set_artwork_settings(&input).await.unwrap();
    assert!(settings.tmdb_configured);
    assert!(!serde_json::to_string(&settings).unwrap().contains("private-token"));
    runtime.set_artwork_settings(&ArtworkSettingsUpdate { tmdb_access_token: Some("  ".into()), ..Default::default() }).await.unwrap();
    assert_eq!(runtime.server_store().unwrap().get_setting("tmdb_access_token").unwrap(), "private-token");
}

#[test]
fn legacy_disabled_sources_remain_available_without_disable_controls() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = Runtime::new(directory.path());
    runtime.initialize().unwrap();
    for saved in ["-", "tvdb", "posterdb,fanart"] {
        runtime.server_store().unwrap().set_setting("artwork_enabled_providers", saved).unwrap();
        let enabled = runtime.enabled_artwork_providers().unwrap();
        assert_eq!(enabled.len(), ARTWORK_PROVIDERS.len());
        assert!(ARTWORK_PROVIDERS.iter().all(|provider| enabled.contains(*provider)));
    }
}
use posterview_contracts::{ItemDetail, ItemType, Server, ServerCreate, ServerType};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};

fn provider_test_item(item_type: ItemType, external_ids: &[(&str, &str)]) -> ItemDetail {
    ItemDetail {
        rating: None, content_rating: None, genres: vec![], tags: vec![], studios: vec![], external_urls: vec![],
        source_path: None,
        file_name: None,
        volume: None,
        id: "item".into(),
        title: "Example".into(),
        year: None,
        item_type,
        poster: None,
        background: None,
        added_at: None,
        summary: None,
        season_count: None,
        seasons: Vec::new(),
        external_ids: external_ids
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect::<BTreeMap<_, _>>(),
        logo: None,
        members: Vec::new(),
    }
}

#[test]
fn sync_matches_providers_to_media_types_and_known_ids() {
    let manga = provider_test_item(ItemType::Folder, &[("anilist", "123")]);
    assert!(provider_applies_to_item("anilist-manga", &manga));
    assert!(!provider_applies_to_item("fanart", &manga));
    assert!(!provider_applies_to_item("tvdb", &manga));
    assert!(!provider_applies_to_item("anilist", &manga));
    assert!(!provider_applies_to_item("mediux", &manga));

    let show_without_ids = provider_test_item(ItemType::Show, &[]);
    assert!(provider_applies_to_item("anilist", &show_without_ids));
    assert!(provider_applies_to_item("fanart", &show_without_ids));
    assert!(provider_applies_to_item("tvdb", &show_without_ids));
    assert!(provider_item_id("fanart", &show_without_ids).is_none());

    let show = provider_test_item(ItemType::Show, &[("tvdb", "456"), ("tmdb", "789")]);
    assert!(provider_applies_to_item("fanart", &show));
    assert!(provider_applies_to_item("tvdb", &show));
    assert!(provider_applies_to_item("mediux", &show));
    assert_eq!(provider_item_id("fanart", &show), Some("456"));
}

#[test]
fn search_thumbnails_receive_the_server_scope_required_by_image_proxies() {
    let result = scoped_search(
        ArtworkSearchResults {
            provider: "mangadex".into(),
            results: vec![posterview_contracts::ArtworkSearchResult {
                alternate_titles: Vec::new(),
                status: None,
                id: "manga".into(),
                name: "Manga".into(),
                year: None,
                thumb_url: Some(
                    "/api/artwork/mangadex/image?url=https://uploads.mangadex.org/cover.jpg"
                        .into(),
                ),
                volume_count: None,
                publisher: None,
            }],
            message: None,
        },
        42,
    );
    assert!(
        result.results[0]
            .thumb_url
            .as_deref()
            .unwrap()
            .ends_with("&server_id=42")
    );
}

fn add_server(runtime: &Runtime, name: &str, base_url: &str) -> Server {
    runtime
        .create_server(&ServerCreate {
            name: name.into(),
            server_type: ServerType::Jellyfin,
            base_url: base_url.into(),
            token: "test".into(),
            is_default: false,
            nfo_metadata_enabled: false,
        })
        .unwrap()
}

#[test]
fn server_quotas_and_clear_are_independent() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = Runtime::new(directory.path());
    runtime.initialize().unwrap();
    let a = add_server(&runtime, "A", "http://localhost:8096");
    let b = add_server(&runtime, "B", "http://localhost:8097");
    for (server, max_mb) in [(&a, 25), (&b, 50)] {
        runtime
            .set_artwork_cache_settings(
                server.id,
                &ArtworkCacheSettings {
                    max_mb,
                    ..Default::default()
                },
            )
            .unwrap();
    }
    let bytes = vec![1; 26 * 1024 * 1024];
    let key = "posterdb-image:shared-url";
    let cache_b = runtime.server_artwork_cache(b.id).unwrap();
    cache_b
        .put_image(key, &bytes, "image/jpeg", 50, 30)
        .unwrap();
    let usage_b = runtime.artwork_cache_status(b.id).unwrap().used_bytes;
    let cache_a = runtime.server_artwork_cache(a.id).unwrap();
    cache_a
        .put_image(key, &bytes, "image/jpeg", 25, 30)
        .unwrap();
    assert_eq!(runtime.artwork_cache_status(a.id).unwrap().used_bytes, 0);
    assert_eq!(
        runtime.artwork_cache_status(b.id).unwrap().used_bytes,
        usage_b
    );
    cache_a
        .put_json("posterdb-set:one", &"one", 25, 30)
        .unwrap();
    assert!(runtime.clear_artwork_cache(a.id).unwrap().cleared_bytes > 0);
    assert_eq!(runtime.artwork_cache_status(a.id).unwrap().used_bytes, 0);
    assert!(cache_b.get_image(key, 30).is_some());
    assert_eq!(
        runtime.artwork_cache_status(b.id).unwrap().used_bytes,
        usage_b
    );
}

#[test]
fn migration_preserves_cached_artwork_and_does_not_restore_cleared_data() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = Runtime::new(directory.path());
    runtime.initialize().unwrap();
    let a = add_server(&runtime, "A", "http://localhost:8096");
    let b = add_server(&runtime, "B", "http://localhost:8097");
    let key_a = format!("artwork:anilist:{}:one:", a.id);
    let key_b = format!("artwork:anilist:{}:two:", b.id);
    runtime
        .artwork_cache
        .put_json(&key_a, &"a", 250, 30)
        .unwrap();
    runtime
        .artwork_cache
        .put_json(&key_b, &"b", 250, 30)
        .unwrap();
    runtime
        .artwork_cache
        .put_image("mediux-image:url", b"jpeg", "image/jpeg", 250, 30)
        .unwrap();
    drop(runtime);
    let runtime = Runtime::new(directory.path());
    runtime.initialize().unwrap();
    let ca = runtime.server_artwork_cache(a.id).unwrap();
    let cb = runtime.server_artwork_cache(b.id).unwrap();
    assert_eq!(ca.get_json::<String>(&key_a, 30), Some("a".into()));
    assert!(ca.get_json::<String>(&key_b, 30).is_none());
    assert_eq!(cb.get_json::<String>(&key_b, 30), Some("b".into()));
    assert!(cb.get_json::<String>(&key_a, 30).is_none());
    for server in [&a, &b] {
        assert!(
            runtime
                .server_artwork_cache(server.id)
                .unwrap()
                .get_image("mediux-image:url", 30)
                .is_some()
        );
    }
    assert_eq!(runtime.artwork_cache.usage().unwrap().bytes, 0);
    runtime.clear_artwork_cache(a.id).unwrap();
    drop(runtime);
    let runtime = Runtime::new(directory.path());
    runtime.initialize().unwrap();
    assert_eq!(runtime.artwork_cache_status(a.id).unwrap().used_bytes, 0);
    assert!(runtime.artwork_cache_status(b.id).unwrap().used_bytes > 0);
}

#[tokio::test]
async fn cached_provider_images_and_thumbnail_links_use_the_requested_server() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = Runtime::new(directory.path());
    runtime.initialize().unwrap();
    let a = add_server(&runtime, "A", "http://localhost:8096");
    let b = add_server(&runtime, "B", "http://localhost:8097");
    for (server, bytes) in [(&a, b"a".as_slice()), (&b, b"b".as_slice())] {
        let cache = runtime.server_artwork_cache(server.id).unwrap();
        for provider in ["mangadex", "mediux", "posterdb"] {
            cache
                .put_image(
                    &format!("{provider}-image:url"),
                    bytes,
                    "image/jpeg",
                    25,
                    30,
                )
                .unwrap();
        }
        assert_eq!(
            runtime.mangadex_image(server.id, "url").await.unwrap().0,
            bytes
        );
        assert_eq!(
            runtime.mediux_image(server.id, "url").await.unwrap().0,
            bytes
        );
        assert_eq!(
            runtime.posterdb_image(server.id, "url").await.unwrap().0,
            bytes
        );
        let artwork: ArtworkResults = serde_json::from_value(serde_json::json!({
            "provider": "mediux", "items": [{"id": "one", "provider": "mediux", "type": "poster", "kind": "movie", "thumb_url": "/api/artwork/mediux/image?url=test", "download_url": "test", "applyable": true}]
        })).unwrap();
        cache
            .put_json(
                &format!("artwork:mediux:{}:one:", server.id),
                &artwork,
                25,
                30,
            )
            .unwrap();
        let scoped = runtime
            .get_artwork("mediux", server.id, "one", None)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(
            scoped.items[0]
                .thumb_url
                .ends_with(&format!("&server_id={}", server.id))
        );
        let set: PosterSet = serde_json::from_value(serde_json::json!({
            "set_url": "test", "posters": [{"id": "one", "title": "One", "kind": "movie", "thumb_url": "/api/posterdb/image?url=test", "download_url": "test"}]
        })).unwrap();
        cache.put_json("posterdb-set:test", &set, 25, 30).unwrap();
        let scoped = runtime.posterdb_set(server.id, "test").await.unwrap();
        assert!(
            scoped.posters[0]
                .thumb_url
                .ends_with(&format!("&server_id={}", server.id))
        );
    }
    assert_eq!(runtime.posterdb_image(a.id, "url").await.unwrap().0, b"a");
    assert_eq!(runtime.posterdb_image(b.id, "url").await.unwrap().0, b"b");
}

#[tokio::test(start_paused = true)]
async fn retries_temporary_failures_with_delay_but_not_invalid_credentials() {
    let attempts = AtomicUsize::new(0);
    let started = tokio::time::Instant::now();
    let result = request_with_retry("Provider", || async {
        if attempts.fetch_add(1, Ordering::SeqCst) < 2 {
            Err("Provider is rate limiting requests (429).".into())
        } else {
            Ok(42)
        }
    })
    .await
    .unwrap();
    assert_eq!(result, 42);
    assert_eq!(attempts.load(Ordering::SeqCst), 3);
    assert_eq!(started.elapsed(), Duration::from_secs(3));
    let attempts = AtomicUsize::new(0);
    let result = request_with_retry::<(), _, _>("Provider", || async {
        attempts.fetch_add(1, Ordering::SeqCst);
        Err("Provider rejected the credentials (401).".into())
    })
    .await;
    assert!(result.unwrap_err().contains("credentials"));
    assert_eq!(attempts.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn stalled_provider_has_a_bounded_retry_budget() {
    let attempts = AtomicUsize::new(0);
    let started = tokio::time::Instant::now();
    let result = request_with_retry::<(), _, _>("Provider", || {
        attempts.fetch_add(1, Ordering::SeqCst);
        std::future::pending()
    })
    .await;
    assert!(result.unwrap_err().contains("timed out"));
    assert_eq!(attempts.load(Ordering::SeqCst), 3);
    assert_eq!(
        started.elapsed(),
        REQUEST_TIMEOUT * 3 + Duration::from_secs(3)
    );
}

#[test]
fn myanimelist_artwork_reuses_the_saved_client_id_without_exposing_it() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = Runtime::new(dir.path()); runtime.initialize().unwrap();
    let sources = runtime.artwork_providers().unwrap();
    assert!(!sources.iter().find(|p|p.name=="myanimelist").unwrap().configured);
    runtime.server_store().unwrap().set_setting("mal_client_id","test-client-id").unwrap();
    for name in ["myanimelist","myanimelist-manga"] {
        let info = runtime.artwork_providers().unwrap().into_iter().find(|p|p.name==name).unwrap();
        assert!(info.configured && info.needs_key && info.enabled);
        assert!(!serde_json::to_string(&info).unwrap().contains("test-client-id"));
        assert!(runtime.enabled_artwork_providers().unwrap().contains(name));
    }
}
