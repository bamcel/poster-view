use std::collections::HashSet;

use crate::{ServerStore, StoreError};
use posterview_contracts::collections::{
    CollectionMemberRef, CollectionMetadata, CollectionMetadataUpdate, CollectionRecord,
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};

pub(crate) const SCHEMA: &str = r#"
CREATE TABLE collections (
 id TEXT PRIMARY KEY, title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 120),
 overview TEXT NOT NULL DEFAULT '' CHECK(length(overview)<=4000),
 ordering TEXT NOT NULL CHECK(ordering IN ('release','title','custom')),
 revision INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT(datetime('now')), updated_at TEXT NOT NULL DEFAULT(datetime('now'))
);
CREATE TABLE collection_members (
 collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
 library_id TEXT NOT NULL, item_id TEXT NOT NULL, position INTEGER NOT NULL,
 PRIMARY KEY(collection_id,library_id,item_id), UNIQUE(collection_id,position),
 FOREIGN KEY(library_id,item_id) REFERENCES native_library_items(library_id,item_id) ON DELETE CASCADE
);
CREATE INDEX collection_members_library_item ON collection_members(library_id,item_id);
CREATE TABLE collection_library_preferences (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 library_id TEXT NOT NULL REFERENCES native_libraries(id) ON DELETE CASCADE,
 grouped INTEGER NOT NULL DEFAULT 0 CHECK(grouped IN (0,1)), PRIMARY KEY(user_id,library_id)
);
"#;

fn validate(title: &str, overview: &str, ordering: &str) -> Result<(), StoreError> {
    if title.trim().is_empty() || title.trim().chars().count() > 120 {
        return Err(StoreError::Validation(
            "Collection name must contain 1–120 characters.".into(),
        ));
    }
    if overview.chars().count() > 4000 {
        return Err(StoreError::Validation(
            "Collection description must not exceed 4000 characters.".into(),
        ));
    }
    if !matches!(ordering, "release" | "title" | "custom") {
        return Err(StoreError::Validation(
            "Collection ordering must be release, title or custom.".into(),
        ));
    }
    Ok(())
}

fn read(db: &Connection, id: &str) -> Result<Option<CollectionRecord>, StoreError> {
    let result = db.query_row(
        "SELECT id,title,overview,ordering,revision,created_at,updated_at,metadata_json FROM collections WHERE id=?1",
        [id], |row| Ok(CollectionRecord {
            id: row.get(0)?, title: row.get(1)?, overview: row.get(2)?, ordering: row.get(3)?,
            revision: row.get(4)?, created_at: row.get(5)?, updated_at: row.get(6)?, members: vec![],
            metadata: serde_json::from_str(&row.get::<_,String>(7)?).map_err(|error|rusqlite::Error::FromSqlConversionFailure(7,rusqlite::types::Type::Text,Box::new(error)))?,
        }),
    ).optional()?;
    let Some(mut result) = result else {
        return Ok(None);
    };
    result.members = db.prepare("SELECT library_id,item_id FROM collection_members WHERE collection_id=?1 ORDER BY position")?
        .query_map([id], |row| Ok(CollectionMemberRef { library_id: row.get(0)?, item_id: row.get(1)? }))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Some(result))
}

fn insert_members(
    db: &Connection,
    id: &str,
    members: &[CollectionMemberRef],
) -> Result<(usize, usize), StoreError> {
    let mut seen = HashSet::new();
    let mut added = 0;
    let mut existing = 0;
    let mut position: i64 = db.query_row(
        "SELECT coalesce(max(position)+1,0) FROM collection_members WHERE collection_id=?1",
        [id],
        |row| row.get(0),
    )?;
    for member in members {
        if !seen.insert((&member.library_id, &member.item_id)) {
            continue;
        }
        let permitted: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM native_library_items l JOIN catalog_items i ON i.id=l.item_id JOIN native_libraries n ON n.id=l.library_id WHERE l.library_id=?1 AND l.item_id=?2 AND i.kind IN ('movie','series') AND n.library_type IN ('movies','shows','anime'))",
            params![member.library_id, member.item_id], |row| row.get(0),
        )?;
        if !permitted {
            return Err(StoreError::Validation(
                "Collections may only contain movies and series from native video libraries."
                    .into(),
            ));
        }
        let changed = db.execute("INSERT INTO collection_members(collection_id,library_id,item_id,position) VALUES(?1,?2,?3,?4) ON CONFLICT(collection_id,library_id,item_id) DO NOTHING", params![id,member.library_id,member.item_id,position])?;
        if changed == 0 {
            existing += 1;
        } else {
            added += 1;
            position += 1;
        }
    }
    Ok((added, existing))
}

fn check_revision(record: &CollectionRecord, revision: i64) -> Result<(), StoreError> {
    if record.revision != revision {
        return Err(StoreError::RevisionConflict);
    }
    Ok(())
}

fn apply_metadata(
    db: &Connection,
    update: &CollectionMetadataUpdate,
) -> Result<Option<CollectionRecord>, StoreError> {
    validate_locks(&update.locks)?;
    let Some(record) = read(db, &update.id)? else {
        return Ok(None);
    };
    check_revision(&record, update.revision)?;
    let locked = |field: &str| update.locks.iter().any(|value| value == field);
    let title = if locked("title") {
        &record.title
    } else {
        &update.title
    };
    let overview = if locked("overview") {
        &record.overview
    } else {
        &update.overview
    };
    validate(title, overview, &record.ordering)?;
    let mut metadata = update.metadata.clone();
    metadata.locks = update.locks.clone();
    if locked("poster") {
        metadata.poster_url = record.metadata.poster_url;
    }
    if locked("backdrop") {
        metadata.backdrop_url = record.metadata.backdrop_url;
    }
    db.execute(
        "UPDATE collections SET title=?2,overview=?3 WHERE id=?1",
        params![update.id, title.trim(), overview],
    )?;
    insert_members(db, &update.id, &update.members)?;
    save_metadata(db, &update.id, &metadata)?;
    read(db, &update.id)
}

impl ServerStore {
    /// Save a manual collection image without replacing its metadata or membership.
    pub fn save_collection_artwork(
        &self,
        id: &str,
        field: &str,
        url: &str,
    ) -> Result<Option<CollectionRecord>, StoreError> {
        if !matches!(field, "poster" | "backdrop") {
            return Err(StoreError::Validation(
                "Unsupported collection artwork.".into(),
            ));
        }
        let mut db = self.write_connection()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some(mut record) = read(&tx, id)? else {
            return Ok(None);
        };
        if field == "poster" {
            record.metadata.poster_url = url.into();
        } else {
            record.metadata.backdrop_url = url.into();
        }
        if !record.metadata.locks.iter().any(|lock| lock == field) {
            record.metadata.locks.push(field.into());
        }
        save_metadata(&tx, id, &record.metadata)?;
        let result = read(&tx, id)?;
        tx.commit()?;
        Ok(result)
    }

    pub fn save_collection_metadata_locks(
        &self,
        id: &str,
        revision: i64,
        locks: &[String],
    ) -> Result<Option<CollectionRecord>, StoreError> {
        validate_locks(locks)?;
        let mut db = self.write_connection()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some(mut record) = read(&tx, id)? else {
            return Ok(None);
        };
        check_revision(&record, revision)?;
        record.metadata.locks = locks.to_vec();
        save_metadata(&tx, id, &record.metadata)?;
        let record = read(&tx, id)?;
        tx.commit()?;
        Ok(record)
    }

    pub fn apply_collection_metadata(
        &self,
        id: &str,
        revision: i64,
        candidate: &CollectionMetadata,
        text: (&str, &str),
        locks: &[String],
        members: &[CollectionMemberRef],
    ) -> Result<Option<CollectionRecord>, StoreError> {
        let update = CollectionMetadataUpdate {
            id: id.into(),
            revision,
            metadata: candidate.clone(),
            title: text.0.into(),
            overview: text.1.into(),
            locks: locks.to_vec(),
            members: members.to_vec(),
        };
        let mut db = self.write_connection()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = apply_metadata(&tx, &update)?;
        tx.commit()?;
        Ok(result)
    }

    /// Collection changes and their durable receipt commit together. A recovered
    /// worker can safely replay this operation without applying metadata twice.
    pub fn apply_collection_metadata_for_job(
        &self,
        job_id: &str,
        lease: &str,
        update: &CollectionMetadataUpdate,
    ) -> Result<Option<CollectionRecord>, StoreError> {
        let mut db = self.write_connection()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let receipt: Option<Option<String>> = tx
            .query_row(
                "SELECT result FROM background_jobs WHERE id=?1 AND lease=?2 AND status='running'",
                params![job_id, lease],
                |row| row.get(0),
            )
            .optional()?;
        let Some(receipt) = receipt else {
            return Err(StoreError::Validation(
                "Background task cancelled or superseded.".into(),
            ));
        };
        if let Some(receipt) = receipt {
            let receipt: serde_json::Value = serde_json::from_str(&receipt)
                .map_err(|_| StoreError::Validation("Invalid background task receipt.".into()))?;
            if let Some(applied_id) = receipt
                .get("applied_collection_id")
                .and_then(serde_json::Value::as_str)
            {
                if applied_id != update.id {
                    return Err(StoreError::Validation(
                        "Background task receipt does not match this collection.".into(),
                    ));
                }
                let result = read(&tx, &update.id)?;
                tx.commit()?;
                return Ok(result);
            }
        }
        let result = apply_metadata(&tx, update)?;
        if let Some(record) = &result {
            let receipt =
                serde_json::json!({"applied_collection_id":record.id,"revision":record.revision});
            tx.execute("UPDATE background_jobs SET result=?2,updated_at=CAST(strftime('%s','now') AS INTEGER) WHERE id=?1", params![job_id, receipt.to_string()])?;
        }
        tx.commit()?;
        Ok(result)
    }
    pub fn collections(&self) -> Result<Vec<CollectionRecord>, StoreError> {
        let db = self.connection()?;
        let tx = db.unchecked_transaction()?;
        let ids = tx
            .prepare("SELECT id FROM collections ORDER BY title COLLATE NOCASE,id")?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids.iter()
            .map(|id| {
                read(&tx, id)?
                    .ok_or_else(|| StoreError::Validation("Collection no longer exists.".into()))
            })
            .collect()
    }

    pub fn collection(&self, id: &str) -> Result<Option<CollectionRecord>, StoreError> {
        let db = self.connection()?;
        let tx = db.unchecked_transaction()?;
        read(&tx, id)
    }

    pub fn create_collection(
        &self,
        title: &str,
        overview: &str,
        ordering: &str,
        members: &[CollectionMemberRef],
    ) -> Result<CollectionRecord, StoreError> {
        validate(title, overview, ordering)?;
        let mut db = self.write_connection()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let id = uuid::Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO collections(id,title,overview,ordering) VALUES(?1,?2,?3,?4)",
            params![id, title.trim(), overview, ordering],
        )?;
        insert_members(&tx, &id, members)?;
        let record = read(&tx, &id)?
            .ok_or_else(|| StoreError::Validation("Collection no longer exists.".into()))?;
        tx.commit()?;
        Ok(record)
    }

    pub fn update_collection(
        &self,
        id: &str,
        revision: i64,
        title: &str,
        overview: &str,
        ordering: &str,
        members: &[CollectionMemberRef],
    ) -> Result<Option<CollectionRecord>, StoreError> {
        validate(title, overview, ordering)?;
        let mut db = self.write_connection()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some(record) = read(&tx, id)? else {
            return Ok(None);
        };
        check_revision(&record, revision)?;
        tx.execute("UPDATE collections SET title=?2,overview=?3,ordering=?4,revision=revision+1,updated_at=datetime('now') WHERE id=?1",params![id,title.trim(),overview,ordering])?;
        tx.execute(
            "DELETE FROM collection_members WHERE collection_id=?1",
            [id],
        )?;
        insert_members(&tx, id, members)?;
        let record = read(&tx, id)?;
        tx.commit()?;
        Ok(record)
    }

    pub fn delete_collection(&self, id: &str) -> Result<bool, StoreError> {
        Ok(self
            .write_connection()?
            .execute("DELETE FROM collections WHERE id=?1", [id])?
            > 0)
    }

    pub fn add_collection_members(
        &self,
        id: &str,
        revision: i64,
        members: &[CollectionMemberRef],
    ) -> Result<Option<(CollectionRecord, usize, usize)>, StoreError> {
        let mut db = self.write_connection()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some(record) = read(&tx, id)? else {
            return Ok(None);
        };
        check_revision(&record, revision)?;
        let (added, existing) = insert_members(&tx, id, members)?;
        if added > 0 {
            tx.execute(
                "UPDATE collections SET revision=revision+1,updated_at=datetime('now') WHERE id=?1",
                [id],
            )?;
        }
        let record = read(&tx, id)?
            .ok_or_else(|| StoreError::Validation("Collection no longer exists.".into()))?;
        tx.commit()?;
        Ok(Some((record, added, existing)))
    }

    pub fn collection_grouping(&self, user: &str, library: &str) -> Result<bool, StoreError> {
        Ok(self.connection()?.query_row("SELECT grouped FROM collection_library_preferences WHERE user_id=?1 AND library_id=?2",params![user,library],|row| row.get(0)).optional()?.unwrap_or(false))
    }

    pub fn set_collection_grouping(
        &self,
        user: &str,
        library: &str,
        grouped: bool,
    ) -> Result<(), StoreError> {
        self.write_connection()?.execute("INSERT INTO collection_library_preferences(user_id,library_id,grouped) VALUES(?1,?2,?3) ON CONFLICT(user_id,library_id) DO UPDATE SET grouped=excluded.grouped",params![user,library,grouped])?;
        Ok(())
    }
}

fn validate_locks(locks: &[String]) -> Result<(), StoreError> {
    if locks.len() > 4
        || locks
            .iter()
            .any(|field| !matches!(field.as_str(), "title" | "overview" | "poster" | "backdrop"))
    {
        return Err(StoreError::Validation(
            "Unknown collection metadata lock.".into(),
        ));
    }
    Ok(())
}
fn save_metadata(
    db: &Connection,
    id: &str,
    metadata: &CollectionMetadata,
) -> Result<(), StoreError> {
    let json = serde_json::to_string(metadata)
        .map_err(|_| StoreError::Validation("Invalid collection metadata.".into()))?;
    db.execute("UPDATE collections SET metadata_json=?2,revision=revision+1,updated_at=datetime('now') WHERE id=?1",params![id,json])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use posterview_contracts::native::{NativeCatalogEntry, NativeLibraryInput};

    fn fixture() -> (
        tempfile::TempDir,
        ServerStore,
        String,
        Vec<CollectionMemberRef>,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let store = ServerStore::new(dir.path());
        store.initialize().unwrap();
        let library = store.save_native_library(None, &serde_json::from_value::<NativeLibraryInput>(serde_json::json!({
            "name":"Movies", "library_type":"movies", "anime_content":"both", "paths":["Movies"]
        })).unwrap()).unwrap();
        let members = ["A", "B"]
            .iter()
            .map(|title| CollectionMemberRef {
                library_id: library.id.clone(),
                item_id: store
                    .create_native_catalog_item(&library.id, "movie", title)
                    .unwrap(),
            })
            .collect();
        (dir, store, library.id, members)
    }

    fn metadata_job(
        store: &ServerStore,
        collection: &CollectionRecord,
    ) -> posterview_contracts::jobs::BackgroundJobRecord {
        let spec = posterview_contracts::jobs::BackgroundJobSpec {
            kind: "collection_metadata".into(),
            title: "Refresh collection".into(),
            resource_key: format!("collection:{}", collection.id),
            dedupe_key: collection.id.clone(),
            payload: serde_json::json!({"collection_id":collection.id}),
            max_attempts: 3,
        };
        store.enqueue_background_job(&spec, 100).unwrap();
        store.claim_background_job(100).unwrap().unwrap()
    }
    fn metadata_update(
        record: &CollectionRecord,
        members: &[CollectionMemberRef],
    ) -> CollectionMetadataUpdate {
        CollectionMetadataUpdate {
            id: record.id.clone(),
            revision: record.revision,
            metadata: CollectionMetadata {
                provider: "tmdb".into(),
                provider_id: "10".into(),
                ..Default::default()
            },
            title: "Provider title".into(),
            overview: "Provider overview".into(),
            locks: vec![],
            members: members.to_vec(),
        }
    }
    #[test]
    fn durable_metadata_receipt_survives_restart_without_applying_twice() {
        let (_dir, store, _library, members) = fixture();
        let collection = store
            .create_collection("Original", "", "release", &members[..1])
            .unwrap();
        let job = metadata_job(&store, &collection);
        let update = metadata_update(&collection, &members);
        let applied = store
            .apply_collection_metadata_for_job(&job.id, job.lease.as_deref().unwrap(), &update)
            .unwrap()
            .unwrap();
        assert_eq!(applied.revision, 2);
        assert_eq!(applied.members.len(), 2);
        let receipt = store
            .background_job(&job.id)
            .unwrap()
            .unwrap()
            .result
            .unwrap();
        assert_eq!(receipt["applied_collection_id"], collection.id);
        assert_eq!(receipt["revision"], 2);
        assert_eq!(
            store.background_job(&job.id).unwrap().unwrap().status,
            "running"
        );
        // Simulate termination after the metadata transaction, before worker finish.
        store.recover_background_jobs(101).unwrap();
        let resumed = store.claim_background_job(101).unwrap().unwrap();
        assert_ne!(resumed.lease, job.lease);
        assert_eq!(resumed.result, Some(receipt));
        let replay = store
            .apply_collection_metadata_for_job(&job.id, resumed.lease.as_deref().unwrap(), &update)
            .unwrap()
            .unwrap();
        assert_eq!(replay.revision, applied.revision);
        assert_eq!(replay.title, "Provider title");
        assert_eq!(replay.members, applied.members);
    }
    #[test]
    fn durable_metadata_rejects_stale_leases_and_cancelling_jobs() {
        let (_dir, store, _library, members) = fixture();
        let collection = store
            .create_collection("Original", "", "release", &members[..1])
            .unwrap();
        let job = metadata_job(&store, &collection);
        let update = metadata_update(&collection, &members);
        store.recover_background_jobs(101).unwrap();
        let resumed = store.claim_background_job(101).unwrap().unwrap();
        assert!(
            store
                .apply_collection_metadata_for_job(&job.id, job.lease.as_deref().unwrap(), &update)
                .is_err()
        );
        store.request_background_job_cancel(&job.id, 102).unwrap();
        assert!(
            store
                .apply_collection_metadata_for_job(
                    &job.id,
                    resumed.lease.as_deref().unwrap(),
                    &update
                )
                .is_err()
        );
        let original = store.collection(&collection.id).unwrap().unwrap();
        assert_eq!(original.title, "Original");
        assert_eq!(original.revision, 1);
        assert!(
            store
                .background_job(&job.id)
                .unwrap()
                .unwrap()
                .result
                .is_none()
        );
    }
    #[test]
    fn durable_metadata_invalid_member_rolls_back_changes_and_receipt() {
        let (_dir, store, library, members) = fixture();
        let collection = store
            .create_collection("Original", "", "release", &members[..1])
            .unwrap();
        let job = metadata_job(&store, &collection);
        let mut update = metadata_update(&collection, &members);
        update.members.push(CollectionMemberRef {
            library_id: library,
            item_id: "missing".into(),
        });
        assert!(
            store
                .apply_collection_metadata_for_job(&job.id, job.lease.as_deref().unwrap(), &update)
                .is_err()
        );
        let original = store.collection(&collection.id).unwrap().unwrap();
        assert_eq!(original.title, "Original");
        assert_eq!(original.overview, "");
        assert_eq!(original.members, members[..1]);
        assert_eq!(original.revision, 1);
        assert!(
            store
                .background_job(&job.id)
                .unwrap()
                .unwrap()
                .result
                .is_none()
        );
    }

    #[test]
    fn metadata_migration_preserves_existing_collections() {
        let (_dir, store, _library, members) = fixture();
        let old = store
            .create_collection(
                "Existing collection",
                "Existing description",
                "release",
                &members,
            )
            .unwrap();
        let db = store.connection().unwrap();
        db.execute_batch("ALTER TABLE collections DROP COLUMN metadata_json; DELETE FROM schema_migrations WHERE version=5;").unwrap();
        drop(db);
        store.initialize().unwrap();
        let migrated = store.collection(&old.id).unwrap().unwrap();
        assert_eq!(migrated.title, old.title);
        assert_eq!(migrated.members, old.members);
        assert_eq!(migrated.revision, old.revision);
        assert_eq!(migrated.metadata, Default::default());
    }

    #[test]
    fn metadata_refresh_respects_locks_and_adds_members_atomically() {
        let (_dir, store, _library, members) = fixture();
        let original = store
            .create_collection("Custom title", "Custom overview", "custom", &members[..1])
            .unwrap();
        let metadata = CollectionMetadata {
            provider: "tmdb".into(),
            provider_id: "10".into(),
            poster_url: "https://image.tmdb.org/t/p/original/a.jpg".into(),
            backdrop_url: "https://image.tmdb.org/t/p/original/b.jpg".into(),
            locks: vec![],
        };
        let locks = vec!["title".into(), "poster".into()];
        let refreshed = store
            .apply_collection_metadata(
                &original.id,
                1,
                &metadata,
                ("Provider title", "Provider overview"),
                &locks,
                &members,
            )
            .unwrap()
            .unwrap();
        assert_eq!(refreshed.title, "Custom title");
        assert_eq!(refreshed.overview, "Provider overview");
        assert!(refreshed.metadata.poster_url.is_empty());
        assert_eq!(refreshed.metadata.backdrop_url, metadata.backdrop_url);
        assert_eq!(refreshed.members.len(), 2);
        assert_eq!(refreshed.members[0], members[0]);
        assert!(matches!(
            store.apply_collection_metadata(
                &original.id,
                1,
                &metadata,
                ("stale", "stale"),
                &[],
                &[]
            ),
            Err(StoreError::RevisionConflict)
        ));
        let locked = store
            .save_collection_metadata_locks(&original.id, 2, &["overview".into()])
            .unwrap()
            .unwrap();
        let invalid = CollectionMemberRef {
            library_id: members[0].library_id.clone(),
            item_id: "missing".into(),
        };
        assert!(
            store
                .apply_collection_metadata(
                    &original.id,
                    locked.revision,
                    &metadata,
                    ("Changed", "Changed"),
                    &[],
                    &[invalid]
                )
                .is_err()
        );
        let restored = store.collection(&original.id).unwrap().unwrap();
        assert_eq!(restored.title, "Custom title");
        assert_eq!(restored.revision, locked.revision);
        assert_eq!(restored.metadata.locks, vec!["overview"]);
        let edited = store
            .update_collection(
                &original.id,
                restored.revision,
                "Manual edit",
                "Manual overview",
                "custom",
                &members,
            )
            .unwrap()
            .unwrap();
        assert_eq!(edited.metadata, restored.metadata);
        store.initialize().unwrap();
        assert_eq!(
            store.collection(&original.id).unwrap().unwrap().metadata,
            restored.metadata
        );
        assert!(
            store
                .save_collection_metadata_locks(&original.id, edited.revision, &["invalid".into()])
                .is_err()
        );
    }

    #[test]
    fn collection_deduplicates_and_preserves_custom_order() {
        let (_dir, store, _library, members) = fixture();
        let collection = store
            .create_collection(
                "  Franchise  ",
                "Description",
                "custom",
                &[members[1].clone(), members[0].clone(), members[1].clone()],
            )
            .unwrap();
        assert_eq!(collection.title, "Franchise");
        assert_eq!(collection.members[0].item_id, members[1].item_id);
        assert_eq!(collection.members.len(), 2);
        let (unchanged, added, existing) = store
            .add_collection_members(&collection.id, 1, &[members[0].clone(), members[0].clone()])
            .unwrap()
            .unwrap();
        assert_eq!((added, existing), (0, 1));
        assert_eq!(unchanged.revision, 1);
        let updated = store
            .update_collection(&collection.id, 1, "New name", "", "release", &members[..1])
            .unwrap()
            .unwrap();
        assert_eq!(updated.revision, 2);
        assert!(matches!(
            store.add_collection_members(&collection.id, 1, &members),
            Err(StoreError::RevisionConflict)
        ));
        assert_eq!(store.collections().unwrap().len(), 1);
        assert!(store.delete_collection(&collection.id).unwrap());
        assert!(!store.delete_collection(&collection.id).unwrap());
        assert!(store.collection(&collection.id).unwrap().is_none());
        assert!(
            store
                .collection_grouping("missing-user", "missing-library")
                .is_ok_and(|grouped| !grouped)
        );
    }

    #[test]
    fn collection_invalid_members_roll_back_entire_operation() {
        let (_dir, store, library, members) = fixture();
        let invalid = CollectionMemberRef {
            library_id: library,
            item_id: "missing".into(),
        };
        assert!(
            store
                .create_collection("Bad", "", "release", &[members[0].clone(), invalid.clone()])
                .is_err()
        );
        assert!(store.collections().unwrap().is_empty());
        let collection = store
            .create_collection("Good", "", "release", &members[..1])
            .unwrap();
        assert!(
            store
                .add_collection_members(&collection.id, 1, &[members[1].clone(), invalid.clone()])
                .is_err()
        );
        assert!(
            store
                .update_collection(&collection.id, 1, "Changed", "", "custom", &[invalid])
                .is_err()
        );
        let restored = store.collection(&collection.id).unwrap().unwrap();
        assert_eq!(restored.title, "Good");
        assert_eq!(restored.members.len(), 1);
        assert_eq!(restored.revision, 1);
        for (title, overview, order) in [("", "", "release"), ("ok", "", "bad")] {
            assert!(
                store
                    .create_collection(title, overview, order, &[])
                    .is_err()
            );
        }
        assert!(
            store
                .create_collection(&"x".repeat(121), "", "release", &[])
                .is_err()
        );
        assert!(
            store
                .create_collection("ok", &"x".repeat(4001), "release", &[])
                .is_err()
        );
        let db = store.connection().unwrap();
        db.execute(
            "INSERT INTO catalog_items(id,kind,title) VALUES('episode','episode','Episode')",
            [],
        )
        .unwrap();
        db.execute(
            "INSERT INTO native_library_items(library_id,item_id) VALUES(?1,'episode')",
            [&members[0].library_id],
        )
        .unwrap();
        assert!(
            store
                .create_collection(
                    "Episodes",
                    "",
                    "release",
                    &[CollectionMemberRef {
                        library_id: members[0].library_id.clone(),
                        item_id: "episode".into(),
                    }]
                )
                .is_err()
        );
    }

    #[test]
    fn collection_survives_rescan_and_library_deletion_cascades_members() {
        let (_dir, store, library, _members) = fixture();
        let entry = NativeCatalogEntry {
            id: String::new(),
            path: "Movies/Film".into(),
            kind: "movie".into(),
            parent_path: None,
            title: "Film".into(),
            metadata: serde_json::json!({}),
            artwork: vec![],
            files: vec![],
            nfo_path: None,
            nfo_xml: None,
            available: true,
            revision: 1,
        };
        store
            .ingest_native_catalog(&library, 1, std::slice::from_ref(&entry))
            .unwrap();
        let item = store
            .native_catalog(&library)
            .unwrap()
            .into_iter()
            .find(|item| item.path == entry.path)
            .unwrap();
        let collection = store
            .create_collection(
                "Film set",
                "",
                "release",
                &[CollectionMemberRef {
                    library_id: library.clone(),
                    item_id: item.id.clone(),
                }],
            )
            .unwrap();
        store.ingest_native_catalog(&library, 1, &[entry]).unwrap();
        assert_eq!(
            store.collection(&collection.id).unwrap().unwrap().members[0].item_id,
            item.id
        );
        store.delete_native_library(&library, 1).unwrap();
        assert!(
            store
                .collection(&collection.id)
                .unwrap()
                .unwrap()
                .members
                .is_empty()
        );
    }

    #[test]
    fn collection_grouping_is_per_user_library_and_cascades() {
        let (_dir, store, library, _members) = fixture();
        let db = store.connection().unwrap();
        for user in ["one", "two"] {
            db.execute("INSERT INTO users(id,username,display_name,password_hash,role,enabled,permissions) VALUES(?1,?1,?1,'','user',1,'{}')",[user]).unwrap();
        }
        assert!(!store.collection_grouping("one", &library).unwrap());
        store
            .set_collection_grouping("one", &library, true)
            .unwrap();
        assert!(store.collection_grouping("one", &library).unwrap());
        assert!(!store.collection_grouping("two", &library).unwrap());
        store
            .set_collection_grouping("one", &library, false)
            .unwrap();
        assert!(!store.collection_grouping("one", &library).unwrap());
        db.execute("DELETE FROM users WHERE id='one'", []).unwrap();
        let count: i64 = db
            .query_row(
                "SELECT count(*) FROM collection_library_preferences",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
        store
            .set_collection_grouping("two", &library, true)
            .unwrap();
        store.delete_native_library(&library, 1).unwrap();
        assert!(!store.collection_grouping("two", &library).unwrap());
    }
}
