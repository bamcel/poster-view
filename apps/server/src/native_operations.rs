use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};
use tokio::sync::Notify;
#[derive(Default)]
struct Coordinator {
    active: Mutex<HashMap<u64, (String, Vec<String>)>>,
    changed: Notify,
}
fn coordinator() -> Arc<Coordinator> {
    static VALUE: OnceLock<Arc<Coordinator>> = OnceLock::new();
    VALUE.get_or_init(Default::default).clone()
}
fn overlaps(a: &str, b: &str) -> bool {
    a.is_empty()
        || b.is_empty()
        || a == b
        || a.starts_with(&format!("{b}/"))
        || b.starts_with(&format!("{a}/"))
}
pub(crate) struct Guard {
    owner: Arc<Coordinator>,
    id: u64,
}
impl Drop for Guard {
    fn drop(&mut self) {
        self.owner.active.lock().unwrap().remove(&self.id);
        self.owner.changed.notify_waiters();
    }
}
pub(crate) async fn acquire(key: String, scopes: Option<&[String]>) -> Guard {
    let owner = coordinator();
    let paths = scopes
        .map(<[String]>::to_vec)
        .unwrap_or_else(|| vec![String::new()]);
    loop {
        let changed = owner.changed.notified();
        tokio::pin!(changed);
        changed.as_mut().enable();
        {
            let mut active = owner.active.lock().unwrap();
            if !active.values().any(|(other, roots)| {
                other == &key && paths.iter().any(|a| roots.iter().any(|b| overlaps(a, b)))
            }) {
                static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
                let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                active.insert(id, (key.clone(), paths.clone()));
                return Guard {
                    owner: owner.clone(),
                    id,
                };
            }
        }
        changed.await;
    }
}
pub(crate) fn same_manual_fields(a: &serde_json::Value, b: &serde_json::Value) -> bool {
    fn manual(value: &serde_json::Value) -> serde_json::Value {
        let mut result = serde_json::Map::new();
        for key in ["_field_locks", "_metadata_locked", "_title_locked"] {
            result.insert(key.into(), value[key].clone());
        }
        for (field, source) in value["_sources"].as_object().into_iter().flatten() {
            if source == "manual" {
                result.insert(field.clone(), value[field].clone());
            }
        }
        serde_json::Value::Object(result)
    }
    manual(a) == manual(b)
}

pub(crate) fn metadata_field_locked(metadata: &serde_json::Value, field: &str) -> bool {
    metadata["_field_locks"][field]
        .as_bool()
        .unwrap_or_else(|| {
            metadata["_metadata_locked"] == true
                || (field == "title" && metadata["_title_locked"] == true)
        })
}

/// Provider and file discovery may update unlocked fields; user locks travel with
/// the saved values even before the relational projection is published.
pub(crate) fn preserve_locked_metadata(
    previous: &posterview_contracts::native::NativeCatalogEntry,
    entry: &mut posterview_contracts::native::NativeCatalogEntry,
) {
    let mut fields = previous
        .metadata
        .as_object()
        .into_iter()
        .flatten()
        .map(|(field, _)| field.clone())
        .collect::<std::collections::BTreeSet<_>>();
    fields.extend(
        entry
            .metadata
            .as_object()
            .into_iter()
            .flatten()
            .map(|(field, _)| field.clone()),
    );
    if let Some(locks) = previous.metadata["_field_locks"].as_object() {
        fields.extend(locks.keys().cloned());
    }
    for field in fields {
        if field.starts_with('_') || !metadata_field_locked(&previous.metadata, &field) {
            continue;
        }
        if let Some(value) = previous.metadata.get(&field) {
            entry.metadata[&field] = value.clone();
            if let Some(source) = previous.metadata["_sources"].get(&field) {
                entry.metadata["_sources"][&field] = source.clone();
            }
        } else if let Some(values) = entry.metadata.as_object_mut() {
            values.remove(&field);
        }
        if field == "title" {
            entry.title = previous.title.clone();
        }
    }
    for field in ["_field_locks", "_metadata_locked", "_title_locked"] {
        if let Some(value) = previous.metadata.get(field) {
            entry.metadata[field] = value.clone();
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn entry(metadata: serde_json::Value) -> posterview_contracts::native::NativeCatalogEntry {
        posterview_contracts::native::NativeCatalogEntry {
            id: "id".into(),
            path: "Show".into(),
            kind: "series".into(),
            parent_path: None,
            title: metadata["title"].as_str().unwrap_or("Show").into(),
            metadata,
            artwork: vec![],
            files: vec![],
            nfo_path: None,
            nfo_xml: None,
            available: true,
            revision: 1,
        }
    }
    #[test]
    fn field_locks_preserve_values_while_unlocked_fields_refresh() {
        let old = entry(
            serde_json::json!({"title":"Saved","plot":"Saved plot","year":2000,"_field_locks":{"plot":true}}),
        );
        let mut scanned = entry(serde_json::json!({"title":"New","plot":"New plot","year":2020}));
        preserve_locked_metadata(&old, &mut scanned);
        assert_eq!(scanned.metadata["plot"], "Saved plot");
        assert_eq!(scanned.metadata["year"], 2020);
        assert_eq!(scanned.title, "New");
    }
    #[test]
    fn lock_all_preserves_missing_fields_and_allows_explicit_exceptions() {
        let old = entry(
            serde_json::json!({"title":"Saved","plot":"Saved plot","year":2000,"_metadata_locked":true,"_field_locks":{"year":false}}),
        );
        let mut scanned = entry(serde_json::json!({"title":"New","year":2020,"rating":9}));
        preserve_locked_metadata(&old, &mut scanned);
        assert_eq!(scanned.metadata["plot"], "Saved plot");
        assert_eq!(scanned.metadata["year"], 2020);
        assert!(scanned.metadata.get("rating").is_none());
        assert_eq!(scanned.title, "Saved");
    }
    #[test]
    fn revision_rebase_rejects_concurrent_lock_changes() {
        assert!(!same_manual_fields(
            &serde_json::json!({"_field_locks":{}}),
            &serde_json::json!({"_field_locks":{"plot":true}})
        ));
    }
    #[test]
    fn revision_rebase_preserves_other_users_manual_changes() {
        let before = serde_json::json!({"plot":"Old","title":"Title","_sources":{"plot":"anilist","title":"manual"}});
        let scanned = serde_json::json!({"plot":"New","title":"Title","_sources":{"plot":"anilist","title":"manual"}});
        assert!(same_manual_fields(&before, &scanned));
        let edited = serde_json::json!({"plot":"New","title":"Changed","_sources":{"plot":"anilist","title":"manual"}});
        assert!(!same_manual_fields(&before, &edited));
    }
    #[tokio::test]
    async fn full_scan_waits_for_edits_and_other_libraries_continue() {
        let key = uuid::Uuid::new_v4().to_string();
        let edit = acquire(key.clone(), Some(&["A".into()])).await;
        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(20),
                acquire(key.clone(), None)
            )
            .await
            .is_err()
        );
        let _other = acquire(format!("{key}-other"), None).await;
        drop(edit);
        let _scan = acquire(key, None).await;
    }
    #[tokio::test]
    async fn unrelated_series_can_run_while_overlapping_changes_wait() {
        let key = uuid::Uuid::new_v4().to_string();
        let first = acquire(key.clone(), Some(&["Anime/A".into()])).await;
        let second = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            acquire(key.clone(), Some(&["Anime/B".into()])),
        )
        .await
        .unwrap();
        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(20),
                acquire(key.clone(), Some(&["Anime/A/Season 1".into()]))
            )
            .await
            .is_err()
        );
        drop(first);
        let _third = acquire(key, Some(&["Anime/A".into()])).await;
        drop(second);
    }
}
