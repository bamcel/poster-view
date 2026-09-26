use super::*;
use posterview_contracts::{ItemDetail, ItemType, Server, ServerCreate, ServerType};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

#[test]
fn book_sync_queues_changed_links_or_stale_cache_but_skips_unchanged_books() {
    let links = BTreeMap::from([("anilist-manga".to_owned(), "123".to_owned())]);
    let previous = BookSyncState { source_path: Some("/media/Manga/Series".to_owned()), links: links.clone() };
    assert!(!book_sync_needs_refresh(&previous, &links, |_, _| false));
    assert!(book_sync_needs_refresh(&previous, &links, |provider, id| provider == "anilist-manga" && id == "123"));
    let changed = BTreeMap::from([("anilist-manga".to_owned(), "456".to_owned())]);
    assert!(book_sync_needs_refresh(&previous, &changed, |_, _| false));
    assert!(book_sync_needs_refresh(&previous, &BTreeMap::new(), |_, _| false));
    let empty = BookSyncState { source_path: None, links: BTreeMap::new() };
    assert!(!book_sync_needs_refresh(&empty, &BTreeMap::new(), |_, _| true));
}

fn provider_test_item(item_type: ItemType, external_ids: &[(&str, &str)]) -> ItemDetail {
    ItemDetail {
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
        seasons: Vec::new(), rating: None, content_rating: None,
            genres: Vec::new(), tags: Vec::new(), studios: Vec::new(), external_urls: Vec::new(),
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
fn migration_preserves_artwork_inventory_and_does_not_restore_cleared_data() {
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
    runtime
        .server_store()
        .unwrap()
        .set_setting(
            "artwork_watchdog_inventory",
            &serde_json::json!({format!("{}:one", a.id): "One", format!("{}:two", b.id): "Two"})
                .to_string(),
        )
        .unwrap();
    runtime
        .server_store()
        .unwrap()
        .set_setting("artwork_watchdog_checkpoint", &format!("{}:one", a.id))
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
        let inventory: std::collections::BTreeMap<String, String> = serde_json::from_str(
            &runtime
                .server_store()
                .unwrap()
                .get_setting(&Runtime::server_setting(
                    server.id,
                    "artwork_watchdog_inventory",
                ))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(inventory.len(), 1);
        assert!(
            inventory
                .keys()
                .all(|key| key.starts_with(&format!("{}:", server.id)))
        );
    }
    assert_eq!(runtime.artwork_cache.usage().unwrap().bytes, 0);
    assert!(runtime.watchdog_due(a.id).unwrap());
    assert!(!runtime.watchdog_due(b.id).unwrap());
    runtime.clear_artwork_cache(a.id).unwrap();
    drop(runtime);
    let runtime = Runtime::new(directory.path());
    runtime.initialize().unwrap();
    assert_eq!(runtime.artwork_cache_status(a.id).unwrap().used_bytes, 0);
    assert!(runtime.artwork_cache_status(b.id).unwrap().used_bytes > 0);
}

#[test]
fn scheduling_uses_each_servers_interval_and_failure_delay() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = Runtime::new(directory.path());
    runtime.initialize().unwrap();
    let a = add_server(&runtime, "A", "http://localhost:8096");
    let b = add_server(&runtime, "B", "http://localhost:8097");
    assert!(!runtime.watchdog_due(a.id).unwrap());
    for (server, interval) in [(&a, 6), (&b, 24)] {
        runtime
            .set_artwork_cache_settings(
                server.id,
                &ArtworkCacheSettings {
                    watchdog_enabled: true,
                    watchdog_interval_hours: interval,
                    ..Default::default()
                },
            )
            .unwrap();
        runtime
            .server_store()
            .unwrap()
            .set_setting(
                &Runtime::server_setting(server.id, "artwork_watchdog_last_run"),
                &(chrono::Utc::now() - chrono::Duration::hours(7)).to_rfc3339(),
            )
            .unwrap();
    }
    assert!(runtime.watchdog_due(a.id).unwrap());
    assert!(!runtime.watchdog_due(b.id).unwrap());
    let next = chrono::DateTime::parse_from_rfc3339(
        &runtime
            .artwork_cache_status(b.id)
            .unwrap()
            .watchdog_next_run
            .unwrap(),
    )
    .unwrap();
    assert!(next > chrono::Utc::now());
    runtime.watchdog_running.lock().unwrap().insert(a.id);
    assert!(!runtime.watchdog_due(a.id).unwrap());
    runtime.watchdog_running.lock().unwrap().remove(&a.id);
    let store = runtime.server_store().unwrap();
    store
        .set_setting(
            &Runtime::server_setting(a.id, "artwork_watchdog_checkpoint"),
            &format!("{}:one", a.id),
        )
        .unwrap();
    store
        .set_setting(
            &Runtime::server_setting(a.id, "artwork_watchdog_retry_after"),
            &(chrono::Utc::now() + chrono::Duration::minutes(5)).to_rfc3339(),
        )
        .unwrap();
    assert!(!runtime.watchdog_due(a.id).unwrap());
    store
        .set_setting(
            &Runtime::server_setting(a.id, "artwork_watchdog_retry_after"),
            &(chrono::Utc::now() - chrono::Duration::seconds(1)).to_rfc3339(),
        )
        .unwrap();
    assert!(runtime.watchdog_due(a.id).unwrap());
}

#[test]
fn watchdog_phase_and_successful_run_are_reported_independently() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = Runtime::new(directory.path());
    runtime.initialize().unwrap();
    let server = add_server(&runtime, "Family", "http://localhost:8096");
    assert_eq!(
        runtime
            .artwork_cache_status(server.id)
            .unwrap()
            .watchdog_state,
        WatchdogState::Idle
    );
    runtime.watchdog_running.lock().unwrap().insert(server.id);
    runtime
        .server_store()
        .unwrap()
        .set_setting(
            &Runtime::server_setting(server.id, "artwork_watchdog_state"),
            "preloading",
        )
        .unwrap();
    assert_eq!(
        runtime
            .artwork_cache_status(server.id)
            .unwrap()
            .watchdog_state,
        WatchdogState::Preloading
    );
    runtime.cancel_watchdog(server.id).unwrap();
    let status = runtime.artwork_cache_status(server.id).unwrap();
    assert_eq!(status.watchdog_state, WatchdogState::Stopping);
    assert!(status.watchdog_next_run.is_none());
}

#[tokio::test]
async fn cancel_interrupts_an_in_flight_media_request_and_cleans_state() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let directory = tempfile::tempdir().unwrap();
    let runtime = Arc::new(Runtime::new(directory.path()));
    runtime.initialize().unwrap();
    let server = add_server(&runtime, "Stalled", &url);
    let last_success = "2026-09-16T12:00:00+00:00";
    runtime
        .server_store()
        .unwrap()
        .set_setting(
            &Runtime::server_setting(server.id, "artwork_watchdog_last_successful_run"),
            last_success,
        )
        .unwrap();
    let worker_runtime = Arc::clone(&runtime);
    let worker = tokio::spawn(async move { worker_runtime.run_watchdog(server.id).await });
    let (_socket, _) = tokio::time::timeout(Duration::from_secs(2), listener.accept())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        runtime
            .artwork_cache_status(server.id)
            .unwrap()
            .watchdog_state,
        WatchdogState::Scanning
    );
    assert!(runtime.cancel_watchdog(server.id).unwrap().ok);
    let result = tokio::time::timeout(Duration::from_secs(1), worker)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(!result.ok);
    assert!(result.message.contains("cancelled"));
    let status = runtime.artwork_cache_status(server.id).unwrap();
    assert!(!status.watchdog_running);
    assert!(!status.watchdog_cancel_requested);
    assert!(status.watchdog_current_title.is_none());
    assert_eq!(status.watchdog_state, WatchdogState::Idle);
    assert_eq!(
        status.watchdog_last_successful_run.as_deref(),
        Some(last_success)
    );
    assert!(!runtime.watchdog_due(server.id).unwrap());
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
async fn cancel_drops_pending_provider_work_without_cancelling_another_server() {
    struct OnDrop<'a>(&'a AtomicBool);
    impl Drop for OnDrop<'_> {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }
    let directory = tempfile::tempdir().unwrap();
    let runtime = Runtime::new(directory.path());
    runtime.initialize().unwrap();
    let a = add_server(&runtime, "A", "http://localhost:8096");
    let b = add_server(&runtime, "B", "http://localhost:8097");
    runtime
        .watchdog_running
        .lock()
        .unwrap()
        .extend([a.id, b.id]);
    let dropped = AtomicBool::new(false);
    let work = async {
        let _guard = OnDrop(&dropped);
        request_with_retry::<(), _, _>("Provider", std::future::pending)
            .await
            .unwrap();
        unreachable!()
    };
    let cancel = async {
        tokio::time::sleep(Duration::from_millis(10)).await;
        runtime.cancel_watchdog(a.id).unwrap();
    };
    let (result, _) = tokio::join!(runtime.cancellable_watchdog(a.id, work), cancel);
    assert!(result.unwrap().message.contains("cancelled"));
    assert!(dropped.load(Ordering::SeqCst));
    assert!(!runtime.watchdog_cancel_requested(b.id));
    assert!(runtime.watchdog_is_running(b.id));
}

#[tokio::test]
async fn successful_watchdog_records_success_and_next_scheduled_run() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let fixture = tokio::spawn(async move {
        for _ in 0..3 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                request.push(socket.read_u8().await.unwrap());
            }
            let body = if String::from_utf8_lossy(&request).contains("/Users") {
                "[{\"Id\":\"reader\"}]"
            } else {
                "{\"Items\":[]}"
            };
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        }
    });
    let directory = tempfile::tempdir().unwrap();
    let runtime = Runtime::new(directory.path());
    runtime.initialize().unwrap();
    let server = add_server(&runtime, "Family", &url);
    runtime
        .set_artwork_cache_settings(
            server.id,
            &ArtworkCacheSettings {
                watchdog_enabled: true,
                ..Default::default()
            },
        )
        .unwrap();
    assert!(runtime.run_watchdog(server.id).await.unwrap().ok);
    fixture.await.unwrap();
    let status = runtime.artwork_cache_status(server.id).unwrap();
    assert_eq!(status.watchdog_state, WatchdogState::Idle);
    let success =
        chrono::DateTime::parse_from_rfc3339(&status.watchdog_last_successful_run.unwrap())
            .unwrap();
    let next = chrono::DateTime::parse_from_rfc3339(&status.watchdog_next_run.unwrap()).unwrap();
    assert_eq!(next - success, chrono::Duration::hours(24));
}

#[tokio::test]
async fn invalid_credentials_stop_scheduling_and_preserve_failure_details() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let fixture = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            request.push(socket.read_u8().await.unwrap());
        }
        socket
            .write_all(
                b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();
    });
    let directory = tempfile::tempdir().unwrap();
    let runtime = Runtime::new(directory.path());
    runtime.initialize().unwrap();
    let server = add_server(&runtime, "Invalid", &url);
    runtime
        .set_artwork_cache_settings(
            server.id,
            &ArtworkCacheSettings {
                watchdog_enabled: true,
                ..Default::default()
            },
        )
        .unwrap();
    assert!(runtime.watchdog_due(server.id).unwrap());
    let result = runtime.run_watchdog(server.id).await;
    fixture.await.unwrap();
    let message = result.unwrap_err().to_string();
    assert!(message.contains("rejected"), "{message}");
    let status = runtime.artwork_cache_status(server.id).unwrap();
    assert!(!status.watchdog_running);
    assert_eq!(status.watchdog_state, WatchdogState::Failed);
    assert!(status.watchdog_next_run.is_none());
    assert!(status.watchdog_last_message.unwrap().contains("rejected"));
    assert!(status.watchdog_last_run.is_none());
    assert!(!runtime.watchdog_due(server.id).unwrap());
    assert!(
        runtime
            .server_store()
            .unwrap()
            .get_setting(&Runtime::server_setting(
                server.id,
                "artwork_watchdog_checkpoint"
            ))
            .unwrap()
            .is_empty()
    );
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
