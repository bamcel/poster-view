//! Coalesced generation after catalog/artwork changes; daily backfill is scheduled separately.
use crate::AppState;
use std::time::Duration;

pub(crate) fn request(state: &AppState) {
    // Notify stores at most one permit, so a scan cannot build an unbounded work queue.
    state.artwork_generation_notify.notify_one();
}

pub(crate) fn start(state: AppState) {
    tokio::spawn(async move {
        loop {
            state.artwork_generation_notify.notified().await;
            // Coalesce artwork downloaded during the same scan or bulk operation.
            tokio::time::sleep(Duration::from_secs(2)).await;
            let copy = state.clone();
            match tokio::task::spawn_blocking(move || {
                crate::native_artwork_variants::backfill(&copy)
            })
            .await
            {
                Ok(Ok(_)) => {}
                Ok(Err(error)) => tracing::warn!(%error, "Artwork generation failed"),
                Err(error) => tracing::warn!(%error, "Artwork generation worker failed"),
            }
        }
    });
}
