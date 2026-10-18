//! Coalesced durable artwork generation after catalog/artwork changes.
use crate::{AppState, HttpError};
use posterview_contracts::jobs::BackgroundJobSpec;
use std::time::Duration;

pub(crate) fn request(state: &AppState) {
    // Requests arriving during a scan coalesce before touching SQLite. The
    // dispatcher below persists accepted work; it does not execute artwork jobs.
    state.artwork_generation_notify.notify_one();
}
pub(crate) fn has_new_artwork(
    entries: &[posterview_contracts::native::NativeCatalogEntry],
    existing: &std::collections::BTreeMap<String, posterview_contracts::native::NativeCatalogEntry>,
) -> bool {
    entries
        .iter()
        .filter(|entry| entry.available && entry.metadata["missing"] != true)
        .any(|entry| {
            entry.artwork.iter().any(|art| {
                !existing.get(&entry.path).is_some_and(|old| {
                    old.artwork
                        .iter()
                        .any(|previous| previous.kind == art.kind && previous.path == art.path)
                })
            })
        })
}
fn spec() -> BackgroundJobSpec {
    BackgroundJobSpec {
        kind: "artwork_backfill".into(),
        title: "Generate artwork display sizes".into(),
        resource_key: "artwork".into(),
        dedupe_key: "global".into(),
        payload: serde_json::json!({}),
        max_attempts: 3,
    }
}
pub(crate) fn start(state: AppState) {
    // Wait for artwork changes. Scheduled maintenance covers missing variants;
    // starting the dispatcher must not enqueue a fresh full-library pass.
    tokio::spawn(async move {
        loop {
            state.artwork_generation_notify.notified().await;
            tokio::time::sleep(Duration::from_secs(2)).await;
            for attempt in 0..3 {
                match crate::jobs::enqueue(&state, spec()).await {
                    Ok(_) => break,
                    Err(error) => {
                        tracing::warn!(attempt = attempt + 1, status = %error.status,
                            "Could not queue automatic artwork generation");
                        if attempt < 2 {
                            tokio::time::sleep(Duration::from_secs(2)).await;
                        }
                    }
                }
            }
        }
    });
}
pub(crate) async fn execute_background_job(
    state: AppState,
    context: crate::jobs::JobContext,
) -> Result<serde_json::Value, HttpError> {
    context.check()?;
    tokio::task::spawn_blocking(move || {
        let result = crate::native_artwork_variants::backfill_checked(&state, || {
            context.check().map_err(|error| error.detail)
        });
        context.check()?;
        let generated = result
            .map_err(|_| HttpError::bad_gateway("Artwork optimization could not complete."))?;
        Ok(serde_json::json!({"generated":generated}))
    })
    .await
    .map_err(|_| HttpError::bad_gateway("Artwork generation interrupted."))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use posterview_infra_sqlite::ServerStore;
    use std::sync::{Arc, atomic::AtomicBool};

    #[test]
    fn scan_requests_require_added_or_replaced_artwork() {
        use posterview_contracts::native::{NativeArtwork, NativeCatalogEntry};
        let mut entry = NativeCatalogEntry {
            id: "item".into(),
            path: "Movies/title".into(),
            kind: "movie".into(),
            parent_path: None,
            title: "Title".into(),
            metadata: serde_json::json!({}),
            artwork: vec![],
            files: vec![],
            nfo_path: None,
            nfo_xml: None,
            available: true,
            revision: 1,
        };
        let mut old = std::collections::BTreeMap::new();
        old.insert(entry.path.clone(), entry.clone());
        assert!(!has_new_artwork(&[entry.clone()], &old));
        entry.artwork.push(NativeArtwork {
            kind: "poster".into(),
            path: "poster.jpg".into(),
            source: "local".into(),
        });
        assert!(has_new_artwork(&[entry.clone()], &old));
        old.insert(entry.path.clone(), entry.clone());
        entry.title = "Metadata edit".into();
        entry.artwork[0].source = "manual".into();
        assert!(!has_new_artwork(&[entry.clone()], &old));
        entry.artwork[0].path = "new-poster.jpg".into();
        assert!(has_new_artwork(&[entry.clone()], &old));
        entry.available = false;
        assert!(!has_new_artwork(&[entry.clone()], &old));
        entry.available = true;
        entry.artwork.clear();
        assert!(!has_new_artwork(&[entry], &old));
    }
    #[tokio::test]
    async fn startup_waits_for_an_artwork_change_before_enqueuing() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        let store = ServerStore::new(state.runtime.data_dir());
        start(state.clone());
        tokio::time::sleep(Duration::from_millis(2200)).await;
        assert!(
            store
                .claim_background_job(chrono::Utc::now().timestamp())
                .unwrap()
                .is_none()
        );
        request(&state);
        let job = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(job) = store
                    .claim_background_job(chrono::Utc::now().timestamp())
                    .unwrap()
                {
                    break job;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(job.kind, "artwork_backfill");
    }

    #[test]
    fn automatic_requests_coalesce_and_running_work_allows_one_followup() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        let store = ServerStore::new(state.runtime.data_dir());
        let first = store.enqueue_background_job(&spec(), 100).unwrap();
        let duplicate = store.enqueue_background_job(&spec(), 101).unwrap();
        assert_eq!(first.id, duplicate.id);
        let running = store.claim_background_job(101).unwrap().unwrap();
        assert_eq!(running.kind, "artwork_backfill");
        assert_eq!(running.resource_key, "artwork");
        assert_eq!(running.max_attempts, 3);
        let followup = store.enqueue_background_job(&spec(), 102).unwrap();
        assert_ne!(followup.id, running.id);
        assert_eq!(
            store.enqueue_background_job(&spec(), 103).unwrap().id,
            followup.id
        );
        assert!(store.claim_background_job(103).unwrap().is_none());
    }
    #[tokio::test]
    async fn cancelled_automatic_work_does_not_generate_or_cleanup() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        let store = ServerStore::new(state.runtime.data_dir());
        store.enqueue_background_job(&spec(), 0).unwrap();
        let record = store.claim_background_job(0).unwrap().unwrap();
        let context = crate::jobs::JobContext {
            record,
            cancelled: Arc::new(AtomicBool::new(true)),
        };
        let error = execute_background_job(state.clone(), context)
            .await
            .unwrap_err();
        assert_eq!(error.status, axum::http::StatusCode::CONFLICT);
        assert!(!state.runtime.data_dir().join("artwork-variants").exists());
    }
    #[tokio::test]
    async fn automatic_executor_returns_a_safe_completion_receipt() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        let store = ServerStore::new(state.runtime.data_dir());
        store.enqueue_background_job(&spec(), 0).unwrap();
        let record = store.claim_background_job(0).unwrap().unwrap();
        let context = crate::jobs::JobContext {
            record,
            cancelled: Arc::new(AtomicBool::new(false)),
        };
        assert_eq!(
            execute_background_job(state, context).await.unwrap(),
            serde_json::json!({"generated":0})
        );
    }
}
