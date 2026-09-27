use crate::{ServerStore, StoreError};
use rusqlite::{OptionalExtension, params};

pub(crate) const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS library_items (
 server_id INTEGER NOT NULL REFERENCES media_servers(id) ON DELETE CASCADE,
 library_id TEXT NOT NULL,
 item_id TEXT NOT NULL,
 observed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
 PRIMARY KEY(server_id,item_id)
);
CREATE INDEX IF NOT EXISTS idx_library_items_library
 ON library_items(server_id,library_id,item_id);

CREATE TABLE IF NOT EXISTS artwork_inventory (
 server_id INTEGER NOT NULL REFERENCES media_servers(id) ON DELETE CASCADE,
 item_id TEXT NOT NULL,
 item_title TEXT NOT NULL DEFAULT '',
 item_type TEXT NOT NULL,
 artwork_type TEXT NOT NULL CHECK(artwork_type IN ('poster','background','logo')),
 reference TEXT NOT NULL,
 observed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
 PRIMARY KEY(server_id,item_id,artwork_type)
);
CREATE INDEX IF NOT EXISTS idx_artwork_inventory_type
 ON artwork_inventory(server_id,artwork_type,item_title COLLATE NOCASE);
"#;

impl ServerStore {
    pub fn record_library_items<I>(
        &self,
        server_id: i64,
        library_id: &str,
        item_ids: I,
    ) -> Result<(), StoreError>
    where
        I: IntoIterator<Item = String>,
    {
        let mut db = self.connection()?;
        let transaction = db.transaction()?;
        for item_id in item_ids {
            transaction.execute(
                "INSERT INTO library_items(server_id,library_id,item_id,observed_at)
                 VALUES(?1,?2,?3,strftime('%Y-%m-%dT%H:%M:%SZ','now'))
                 ON CONFLICT(server_id,item_id) DO UPDATE SET
                   library_id=excluded.library_id,observed_at=excluded.observed_at",
                params![server_id, library_id, item_id],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn item_library(
        &self,
        server_id: i64,
        item_id: &str,
    ) -> Result<Option<String>, StoreError> {
        self.connection()?
            .query_row(
                "SELECT library_id FROM library_items WHERE server_id=?1 AND item_id=?2",
                params![server_id, item_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn record_artwork(
        &self,
        server_id: i64,
        item_id: &str,
        item_title: &str,
        item_type: &str,
        artwork: &[(&str, Option<&str>)],
    ) -> Result<usize, StoreError> {
        let mut db = self.connection()?;
        let transaction = db.transaction()?;
        let mut changed = 0;
        for (artwork_type, reference) in artwork {
            if let Some(reference) = reference.filter(|value| !value.trim().is_empty()) {
                changed += transaction.execute(
                    "INSERT INTO artwork_inventory
                     (server_id,item_id,item_title,item_type,artwork_type,reference,observed_at)
                     VALUES(?1,?2,?3,?4,?5,?6,strftime('%Y-%m-%dT%H:%M:%SZ','now'))
                     ON CONFLICT(server_id,item_id,artwork_type) DO UPDATE SET
                       item_title=excluded.item_title,item_type=excluded.item_type,
                       reference=excluded.reference,observed_at=excluded.observed_at
                     WHERE artwork_inventory.reference<>excluded.reference
                        OR artwork_inventory.item_title<>excluded.item_title
                        OR artwork_inventory.item_type<>excluded.item_type",
                    params![server_id, item_id, item_title, item_type, artwork_type, reference],
                )?;
            } else {
                changed += transaction.execute(
                    "DELETE FROM artwork_inventory
                     WHERE server_id=?1 AND item_id=?2 AND artwork_type=?3",
                    params![server_id, item_id, artwork_type],
                )?;
            }
        }
        transaction.commit()?;
        Ok(changed)
    }

    pub fn artwork_inventory_count(&self, server_id: i64) -> Result<i64, StoreError> {
        self.connection()?
            .query_row(
                "SELECT COUNT(*) FROM artwork_inventory WHERE server_id=?1",
                [server_id],
                |row| row.get(0),
            )
            .map_err(StoreError::from)
    }

    pub(crate) fn migrate_item_library_settings(&self) -> Result<(), StoreError> {
        const MIGRATION_KEY: &str = "catalog_library_items_migrated";
        if self.get_setting(MIGRATION_KEY)?.eq_ignore_ascii_case("true") {
            return Ok(());
        }
        let db = self.connection()?;
        let mut statement = db.prepare(
            "SELECT key,value_enc FROM settings WHERE key LIKE 'item_library:%'",
        )?;
        let rows = statement
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        for (key, library_id) in rows {
            let mut parts = key.splitn(3, ':');
            let _ = parts.next();
            let Some(server_id) = parts.next().and_then(|value| value.parse::<i64>().ok()) else {
                continue;
            };
            let Some(item_id) = parts.next() else { continue };
            self.record_library_items(server_id, &library_id, [item_id.to_owned()])?;
        }
        self.set_setting(MIGRATION_KEY, "true")?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use posterview_contracts::{ServerCreate, ServerType};

    fn store() -> (tempfile::TempDir, ServerStore, i64) {
        let directory = tempfile::tempdir().unwrap();
        let store = ServerStore::new(directory.path());
        store.initialize().unwrap();
        let server = store
            .create_server(&ServerCreate {
                name: "Server".into(),
                server_type: ServerType::Emby,
                base_url: "http://localhost".into(),
                token: "token".into(),
                is_default: true,
                nfo_metadata_enabled: false,
            })
            .unwrap();
        (directory, store, server.id)
    }

    #[test]
    fn stores_library_membership_and_current_artwork() {
        let (_directory, store, server) = store();
        store
            .record_library_items(server, "tv", ["item".to_owned()])
            .unwrap();
        assert_eq!(store.item_library(server, "item").unwrap().as_deref(), Some("tv"));
        assert_eq!(
            store
                .record_artwork(
                    server,
                    "item",
                    "Title",
                    "show",
                    &[("poster", Some("poster-ref")), ("logo", None)],
                )
                .unwrap(),
            1
        );
        assert_eq!(store.artwork_inventory_count(server).unwrap(), 1);
        assert_eq!(
            store
                .record_artwork(
                    server,
                    "item",
                    "Title",
                    "show",
                    &[("poster", Some("poster-ref"))],
                )
                .unwrap(),
            0
        );
    }
}
