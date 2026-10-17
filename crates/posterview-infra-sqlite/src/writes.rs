//! Process-wide, per-database admission. Readers never enter the writer queue.
use crate::StoreError;
use rusqlite::Connection;
use std::{
    collections::{HashMap, VecDeque},
    ops::{Deref, DerefMut},
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex, OnceLock, Weak},
    time::{Duration, Instant},
};

#[derive(Default)]
struct Queue {
    state: Mutex<State>,
    changed: Condvar,
}
#[derive(Default)]
struct State {
    active: bool,
    next: u64,
    waiting: VecDeque<u64>,
}
struct Permit(Arc<Queue>);
impl Drop for Permit {
    fn drop(&mut self) {
        self.0
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .active = false;
        self.0.changed.notify_all();
    }
}
impl Queue {
    fn acquire(self: &Arc<Self>, timeout: Duration, capacity: usize) -> Result<Permit, StoreError> {
        let started = Instant::now();
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.waiting.len() >= capacity {
            return Err(StoreError::WriteUnavailable);
        }
        let ticket = state.next;
        state.next = state.next.wrapping_add(1);
        state.waiting.push_back(ticket);
        loop {
            if !state.active && state.waiting.front() == Some(&ticket) {
                state.waiting.pop_front();
                state.active = true;
                return Ok(Permit(self.clone()));
            }
            let remaining = timeout.saturating_sub(started.elapsed());
            if remaining.is_zero() {
                state.waiting.retain(|id| *id != ticket);
                self.changed.notify_all();
                return Err(StoreError::WriteUnavailable);
            }
            state = self
                .changed
                .wait_timeout(state, remaining)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
    }
}
fn identity(path: &Path) -> Result<PathBuf, StoreError> {
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()?.join(path)
    };
    let resolved = absolute.canonicalize().or_else(|_| {
        absolute
            .parent()
            .unwrap_or(Path::new("."))
            .canonicalize()
            .map(|parent| parent.join(absolute.file_name().unwrap_or_default()))
    })?;
    #[cfg(windows)]
    let resolved = PathBuf::from(resolved.to_string_lossy().to_lowercase());
    Ok(resolved)
}
fn queue(path: &Path) -> Result<Arc<Queue>, StoreError> {
    static REGISTRY: OnceLock<Mutex<HashMap<PathBuf, Weak<Queue>>>> = OnceLock::new();
    let key = identity(path)?;
    let mut registry = REGISTRY
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(queue) = registry.get(&key).and_then(Weak::upgrade) {
        return Ok(queue);
    }
    registry.retain(|_, queue| queue.strong_count() > 0);
    let queue = Arc::new(Queue::default());
    registry.insert(key, Arc::downgrade(&queue));
    Ok(queue)
}

/// A coordinated connection for a short database-only write unit. Do not hold it
/// across network, filesystem work, or calls to another coordinated writer.
/// SQLite still arbitrates external processes through its busy timeout.
pub struct WriteConnection {
    connection: Connection,
    _permit: Permit,
}
impl Deref for WriteConnection {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        &self.connection
    }
}
impl DerefMut for WriteConnection {
    fn deref_mut(&mut self) -> &mut Connection {
        &mut self.connection
    }
}
pub(crate) fn open(path: &Path) -> Result<WriteConnection, StoreError> {
    let permit = queue(path)?.acquire(Duration::from_secs(5), 128)?;
    let connection = crate::open_connection(path)?;
    Ok(WriteConnection {
        connection,
        _permit: permit,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn timeout_and_overload_release_the_queue_without_stranding_followers() {
        let queue = Arc::new(Queue::default());
        let held = queue.acquire(Duration::from_secs(1), 1).unwrap();
        assert!(matches!(
            queue.acquire(Duration::from_millis(5), 0),
            Err(StoreError::WriteUnavailable)
        ));
        assert!(matches!(
            queue.acquire(Duration::from_millis(5), 1),
            Err(StoreError::WriteUnavailable)
        ));
        drop(held);
        assert!(queue.acquire(Duration::from_secs(1), 1).is_ok());
    }
    #[test]
    fn equivalent_paths_share_admission_but_other_databases_do_not() {
        let temp = tempfile::tempdir().unwrap();
        let first = queue(&temp.path().join("posterview.db")).unwrap();
        let alias = queue(&temp.path().join(".").join("posterview.db")).unwrap();
        assert!(Arc::ptr_eq(&first, &alias));
        assert!(!Arc::ptr_eq(
            &first,
            &queue(&temp.path().join("other.db")).unwrap()
        ));
    }
    #[test]
    fn settings_batches_roll_back_together_and_preserve_secret_encryption() {
        let temp = tempfile::tempdir().unwrap();
        let store = crate::ServerStore::new(temp.path());
        store.initialize().unwrap();
        store
            .set_settings(&[
                ("subscription".into(), "original".into()),
                ("fanart_api_key".into(), "private-token".into()),
            ])
            .unwrap();
        assert_eq!(
            store.get_setting("fanart_api_key").unwrap(),
            "private-token"
        );
        let db = store.read_connection().unwrap();
        let raw: String = db
            .query_row(
                "SELECT value_enc FROM settings WHERE key='fanart_api_key'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_ne!(raw, "private-token");
        drop(db);
        let db = store.write_connection().unwrap();
        db.execute_batch("CREATE TRIGGER reject_setting BEFORE INSERT ON settings WHEN NEW.key='reject' BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
        drop(db);
        assert!(
            store
                .set_settings(&[
                    ("subscription".into(), "changed".into()),
                    ("reject".into(), "bad".into())
                ])
                .is_err()
        );
        assert_eq!(store.get_setting("subscription").unwrap(), "original");
        assert!(
            store
                .set_settings(&vec![("same".into(), "value".into()); 129])
                .is_err()
        );
    }
    #[test]
    fn external_process_locks_fail_without_replaying_or_partially_committing() {
        let temp = tempfile::tempdir().unwrap();
        let store = crate::ServerStore::new(temp.path());
        store.initialize().unwrap();
        let external = Connection::open(temp.path().join("posterview.db")).unwrap();
        external.execute_batch("BEGIN IMMEDIATE;").unwrap();
        let writer = store.write_connection().unwrap();
        writer.busy_timeout(Duration::from_millis(10)).unwrap();
        let error = writer
            .execute(
                "INSERT INTO settings(key,value_enc) VALUES('external-test','value')",
                [],
            )
            .unwrap_err();
        assert!(
            matches!(error, rusqlite::Error::SqliteFailure(code, _) if code.code == rusqlite::ErrorCode::DatabaseBusy)
        );
        drop(writer);
        external.execute_batch("ROLLBACK;").unwrap();
        assert_eq!(store.get_setting("external-test").unwrap(), "");
        store.set_setting("external-test", "recovered").unwrap();
    }

    #[test]
    fn concurrent_store_instances_serialize_read_modify_write_and_readers_keep_working() {
        let temp = tempfile::tempdir().unwrap();
        let store = crate::ServerStore::new(temp.path());
        store.initialize().unwrap();
        store.set_setting("counter", "0").unwrap();
        let held = store.write_connection().unwrap();
        assert_eq!(
            crate::ServerStore::new(temp.path())
                .get_setting("counter")
                .unwrap(),
            "0"
        );
        drop(held);
        std::thread::scope(|scope| {
            for _ in 0..8 {
                let path = temp.path();
                scope.spawn(move || {
                    let store = crate::ServerStore::new(path);
                    for _ in 0..10 {
                        let mut db = store.write_connection().unwrap();
                        let tx = db.transaction().unwrap();
                        let n: String = tx
                            .query_row(
                                "SELECT value_enc FROM settings WHERE key='counter'",
                                [],
                                |row| row.get(0),
                            )
                            .unwrap();
                        tx.execute(
                            "UPDATE settings SET value_enc=?1 WHERE key='counter'",
                            [(n.parse::<u32>().unwrap() + 1).to_string()],
                        )
                        .unwrap();
                        tx.commit().unwrap();
                    }
                });
            }
        });
        assert_eq!(store.get_setting("counter").unwrap(), "80");
    }
}
