//! Coalesced durable artwork generation after catalog/artwork changes.
use crate::{AppState, HttpError};
use posterview_contracts::jobs::BackgroundJobSpec;
use std::time::Duration;

pub(crate) fn request(state: &AppState) {
    // Requests arriving during a scan coalesce before touching SQLite. The
    // dispatcher below persists accepted work; it does not execute artwork jobs.
    state.artwork_generation_notify.notify_one();
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
    // Reconcile on every startup, including requests interrupted before their
    // enqueue transaction. Existing variants are reused instead of regenerated.
    request(&state);
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
