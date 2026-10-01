use crate::AppState;
use posterview_contracts::native::{NativeScanProgress, NativeScanStatus};
use posterview_infra_sqlite::ServerStore;
use std::time::{Duration, Instant};

pub(crate) struct Reporter {
    store: ServerStore,
    library: String,
    last: Instant,
}
impl Reporter {
    pub(crate) fn new(state: &AppState, library: &str) -> Self {
        Self {
            store: ServerStore::new(state.runtime.data_dir()),
            library: library.into(),
            last: Instant::now() - Duration::from_secs(1),
        }
    }
    pub(crate) fn report(
        &mut self,
        phase: &str,
        processed: usize,
        total: Option<usize>,
        count: usize,
        current: &str,
        force: bool,
    ) {
        if !force && self.last.elapsed() < Duration::from_millis(500) {
            return;
        }
        self.last = Instant::now();
        let status = NativeScanStatus {
            status: "scanning".into(),
            count,
            warnings: vec![],
            progress: Some(NativeScanProgress {
                phase: phase.into(),
                processed,
                total,
                current: current.into(),
            }),
        };
        if let Err(error) = self
            .store
            .update_native_scan_progress(&self.library, &status)
        {
            tracing::warn!(%error, "Unable to publish library scan progress");
        }
    }
}
