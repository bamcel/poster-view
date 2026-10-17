//! Volatile scan telemetry stays off SQLite's single-writer path.
use crate::AppState;
use posterview_contracts::native::{NativeScanProgress, NativeScanStatus};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

pub(crate) type LiveProgress = Arc<Mutex<HashMap<String, NativeScanStatus>>>;

pub(crate) fn current(state: &AppState, library: &str) -> Option<NativeScanStatus> {
    state
        .native_scan_progress
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(library)
        .cloned()
}

pub(crate) fn clear(state: &AppState, library: &str) {
    state
        .native_scan_progress
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .remove(library);
}

pub(crate) struct Reporter {
    live: LiveProgress,
    library: String,
}
impl Reporter {
    pub(crate) fn new(state: &AppState, library: &str) -> Self {
        Self {
            live: Arc::clone(&state.native_scan_progress),
            library: library.into(),
        }
    }
    pub(crate) fn report(
        &mut self,
        phase: &str,
        processed: usize,
        total: Option<usize>,
        count: usize,
        current: &str,
        _force: bool,
    ) {
        let status = NativeScanStatus {
            status: "scanning".into(),
            count,
            warnings: vec![],
            progress: Some(NativeScanProgress {
                phase: safe_label(phase, 64),
                processed: total.map_or(processed, |total| processed.min(total)),
                total,
                current: safe_label(current, 2048),
            }),
        };
        // Every report replaces the snapshot, including the final counts. This is
        // deliberately synchronous and cheap: no SQLite, timers or runtime tasks.
        self.live
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(self.library.clone(), status);
    }
}

fn safe_label(value: &str, maximum: usize) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .take(maximum)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use posterview_infra_sqlite::ServerStore;
    use std::{sync::mpsc, time::Duration};

    #[test]
    fn reports_publish_latest_counts_and_clamp_processed_to_total() {
        let directory = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(directory.path());
        let mut reporter = Reporter::new(&state, "library");
        reporter.report("reading", 4, Some(10), 2, "first.mkv", true);
        reporter.report("reading", 11, Some(10), 8, "last.mkv", false);
        let status = current(&state, "library").unwrap();
        assert_eq!(status.status, "scanning");
        assert_eq!(status.count, 8);
        assert!(status.warnings.is_empty());
        let progress = status.progress.unwrap();
        assert_eq!(progress.processed, 10);
        assert_eq!(progress.total, Some(10));
        assert_eq!(progress.current, "last.mkv");
        reporter.report("discovering", 15, None, 8, "", false);
        let progress = current(&state, "library").unwrap().progress.unwrap();
        assert_eq!(progress.processed, 15);
        assert_eq!(progress.total, None);
        reporter.report("saving", 1, Some(0), 0, "", true);
        assert_eq!(
            current(&state, "library")
                .unwrap()
                .progress
                .unwrap()
                .processed,
            0
        );
    }

    #[test]
    fn live_progress_remains_available_while_sqlite_writer_is_locked() {
        let directory = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(directory.path());
        ServerStore::new(state.runtime.data_dir())
            .native_libraries()
            .unwrap();
        let writer =
            rusqlite::Connection::open(state.runtime.data_dir().join("posterview.db")).unwrap();
        writer.execute_batch("BEGIN IMMEDIATE").unwrap();
        let mut reporter = Reporter::new(&state, "library-without-a-database-row");
        let (sent, received) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            reporter.report("inspecting", 9, Some(10), 5, "movie.mkv", false);
            sent.send(()).unwrap();
        });
        let completed = received.recv_timeout(Duration::from_secs(1));
        let snapshot = current(&state, "library-without-a-database-row");
        writer.execute_batch("ROLLBACK").unwrap();
        worker.join().unwrap();
        completed.expect("Publishing live progress must not wait for SQLite's writer lock");
        assert_eq!(snapshot.unwrap().progress.unwrap().processed, 9);
        // Progress has no persistent row or library requirement.
        assert!(
            ServerStore::new(state.runtime.data_dir())
                .native_libraries()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn clear_and_read_are_isolated_by_library_and_state() {
        let directory = tempfile::tempdir().unwrap();
        let other_directory = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(directory.path());
        let other = crate::test_support::state(other_directory.path());
        let mut first = Reporter::new(&state, "first");
        let mut second = Reporter::new(&state, "second");
        first.report("reading", 1, Some(2), 1, "one", false);
        second.report("saving", 2, Some(2), 2, "two", false);
        let mut detached = current(&state, "second").unwrap();
        detached.count = 100;
        assert_eq!(current(&state, "second").unwrap().count, 2);
        assert!(current(&other, "second").is_none());
        clear(&state, "first");
        clear(&state, "first");
        assert!(current(&state, "first").is_none());
        assert!(current(&state, "second").is_some());
    }

    #[test]
    fn telemetry_labels_are_bounded_and_exclude_control_characters() {
        let directory = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(directory.path());
        let mut reporter = Reporter::new(&state, "library");
        reporter.report(
            &"x".repeat(100),
            0,
            None,
            0,
            &format!("bad\n\0{}", "é".repeat(3000)),
            true,
        );
        let progress = current(&state, "library").unwrap().progress.unwrap();
        assert_eq!(progress.phase.chars().count(), 64);
        assert_eq!(progress.current.chars().count(), 2048);
        assert!(!progress.current.chars().any(char::is_control));
    }
}
