use std::{
    fs,
    path::{Path, PathBuf},
};

use fernet::Fernet;
use posterview_contracts::{Server, ServerCreate, ServerType, ServerUpdate};
use rusqlite::{Connection, OptionalExtension, params};
use thiserror::Error;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS media_servers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    type        TEXT    NOT NULL CHECK (type IN ('plex', 'jellyfin', 'emby')),
    base_url    TEXT    NOT NULL,
    token_enc   TEXT    NOT NULL DEFAULT '',
    is_default  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (
    key       TEXT PRIMARY KEY,
    value_enc TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS apply_history (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id    INTEGER NOT NULL,
    item_id      TEXT    NOT NULL,
    item_title   TEXT    NOT NULL DEFAULT '',
    target       TEXT    NOT NULL,
    file_path    TEXT    NOT NULL,
    content_type TEXT    NOT NULL,
    provider     TEXT    NOT NULL DEFAULT '',
    applied_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_apply_history_item
    ON apply_history (server_id, item_id, target, applied_at DESC);
CREATE INDEX IF NOT EXISTS idx_apply_history_recent
    ON apply_history (applied_at DESC);
"#;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("secret key error: {0}")]
    SecretKey(#[from] std::io::Error),
    #[error("invalid secret key")]
    InvalidSecretKey,
    #[error("invalid server type stored in database: {0}")]
    InvalidServerType(String),
}

#[derive(Debug)]
pub struct ServerStore {
    db_path: PathBuf,
    secret_key_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryRow {
    pub id: i64,
    pub server_id: i64,
    pub item_id: String,
    pub item_title: String,
    pub target: String,
    pub file_path: String,
    pub content_type: String,
    pub provider: String,
    pub applied_at: String,
}

impl ServerStore {
    #[must_use]
    pub fn new(data_dir: impl AsRef<Path>) -> Self {
        Self {
            db_path: data_dir.as_ref().join("posterview.db"),
            secret_key_path: data_dir.as_ref().join("secret.key"),
        }
    }

    pub fn initialize(&self) -> Result<(), StoreError> {
        if let Some(parent) = self.db_path.parent() {
            fs::create_dir_all(parent)?;
        }
        self.cipher()?;
        let connection = self.connection()?;
        connection.execute_batch(SCHEMA)?;
        migrate(&connection)?;
        Ok(())
    }

    pub fn list_servers(&self) -> Result<Vec<Server>, StoreError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, name, type, base_url, is_default, token_enc, created_at, updated_at
             FROM media_servers ORDER BY is_default DESC, name COLLATE NOCASE",
        )?;
        statement
            .query_map([], server_from_row)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn get_server(&self, id: i64) -> Result<Option<Server>, StoreError> {
        self.connection()?
            .query_row(
                "SELECT id, name, type, base_url, is_default, token_enc, created_at, updated_at
                 FROM media_servers WHERE id = ?1",
                [id],
                server_from_row,
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn create_server(&self, input: &ServerCreate) -> Result<Server, StoreError> {
        let cipher = self.cipher()?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        if input.is_default {
            transaction.execute("UPDATE media_servers SET is_default = 0", [])?;
        }
        transaction.execute(
            "INSERT INTO media_servers (name, type, base_url, token_enc, is_default)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                input.name,
                input.server_type.as_str(),
                normalize_base_url(&input.base_url),
                cipher.encrypt(input.token.as_bytes()),
                input.is_default,
            ],
        )?;
        let id = transaction.last_insert_rowid();
        let default_count: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM media_servers WHERE is_default = 1",
            [],
            |row| row.get(0),
        )?;
        if default_count == 0 {
            transaction.execute(
                "UPDATE media_servers SET is_default = 1 WHERE id = ?1",
                [id],
            )?;
        }
        transaction.commit()?;
        self.get_server(id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows.into())
    }

    pub fn update_server(
        &self,
        id: i64,
        input: &ServerUpdate,
    ) -> Result<Option<Server>, StoreError> {
        if self.get_server(id)?.is_none() {
            return Ok(None);
        }
        let cipher = self.cipher()?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        if input.is_default == Some(true) {
            transaction.execute("UPDATE media_servers SET is_default = 0", [])?;
        }
        transaction.execute(
            "UPDATE media_servers SET
                name = COALESCE(?1, name),
                type = COALESCE(?2, type),
                base_url = COALESCE(?3, base_url),
                token_enc = COALESCE(?4, token_enc),
                is_default = COALESCE(?5, is_default),
                updated_at = datetime('now')
             WHERE id = ?6",
            params![
                input.name,
                input.server_type.map(ServerType::as_str),
                input.base_url.as_deref().map(normalize_base_url),
                input
                    .token
                    .as_deref()
                    .filter(|token| !token.is_empty())
                    .map(|token| cipher.encrypt(token.as_bytes())),
                input.is_default,
                id,
            ],
        )?;
        transaction.commit()?;
        self.get_server(id)
    }

    pub fn delete_server(&self, id: i64) -> Result<bool, StoreError> {
        Ok(self
            .connection()?
            .execute("DELETE FROM media_servers WHERE id = ?1", [id])?
            > 0)
    }

    pub fn decrypted_token(&self, id: i64) -> Result<Option<String>, StoreError> {
        let encrypted: Option<String> = self
            .connection()?
            .query_row(
                "SELECT token_enc FROM media_servers WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(encrypted) = encrypted else {
            return Ok(None);
        };
        if encrypted.is_empty() {
            return Ok(Some(String::new()));
        }
        let plaintext = self.cipher()?.decrypt(&encrypted).unwrap_or_default();
        Ok(Some(String::from_utf8(plaintext).unwrap_or_default()))
    }

    pub fn get_setting(&self, key: &str) -> Result<String, StoreError> {
        let value = self
            .connection()?
            .query_row(
                "SELECT value_enc FROM settings WHERE key = ?1",
                [key],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .unwrap_or_default();
        if value.is_empty() || !is_secret_setting(key) {
            return Ok(value);
        }
        let plaintext = self.cipher()?.decrypt(&value).unwrap_or_default();
        Ok(String::from_utf8(plaintext).unwrap_or_default())
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), StoreError> {
        let stored = if is_secret_setting(key) {
            self.cipher()?.encrypt(value.as_bytes())
        } else {
            value.to_owned()
        };
        self.connection()?.execute(
            "INSERT INTO settings (key, value_enc) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value_enc = excluded.value_enc",
            params![key, stored],
        )?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn insert_history(
        &self,
        server_id: i64,
        item_id: &str,
        item_title: &str,
        target: &str,
        file_path: &str,
        content_type: &str,
        provider: &str,
    ) -> Result<i64, StoreError> {
        let connection = self.connection()?;
        connection.execute(
            "INSERT INTO apply_history
             (server_id, item_id, item_title, target, file_path, content_type, provider)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                server_id,
                item_id,
                item_title,
                target,
                file_path,
                content_type,
                provider
            ],
        )?;
        Ok(connection.last_insert_rowid())
    }

    pub fn list_history(
        &self,
        server_id: Option<i64>,
        item_id: Option<&str>,
        target: Option<&str>,
        limit: Option<i64>,
    ) -> Result<Vec<HistoryRow>, StoreError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, server_id, item_id, item_title, target, file_path,
                    content_type, provider, applied_at
             FROM apply_history
             WHERE (?1 IS NULL OR server_id = ?1)
               AND (?2 IS NULL OR item_id = ?2)
               AND (?3 IS NULL OR target = ?3)
             ORDER BY applied_at DESC, id DESC
             LIMIT CASE WHEN ?4 IS NULL OR ?4 <= 0 THEN -1 ELSE ?4 END",
        )?;
        statement
            .query_map(params![server_id, item_id, target, limit], history_from_row)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn get_history(&self, id: i64) -> Result<Option<HistoryRow>, StoreError> {
        self.connection()?
            .query_row(
                "SELECT id, server_id, item_id, item_title, target, file_path,
                        content_type, provider, applied_at
                 FROM apply_history WHERE id = ?1",
                [id],
                history_from_row,
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn prune_history(&self, keep: i64) -> Result<Vec<String>, StoreError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let stale = {
            let mut statement = transaction.prepare(
                "SELECT id, file_path FROM apply_history
                 ORDER BY applied_at DESC, id DESC LIMIT -1 OFFSET ?1",
            )?;
            statement
                .query_map([keep.max(1)], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        for (id, _) in &stale {
            transaction.execute("DELETE FROM apply_history WHERE id = ?1", [id])?;
        }
        transaction.commit()?;
        Ok(stale.into_iter().map(|(_, path)| path).collect())
    }

    pub fn purge_history(&self, days: i64) -> Result<Vec<String>, StoreError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let stale = {
            let (query, argument) = if days > 0 {
                (
                    "SELECT id, file_path FROM apply_history
                     WHERE applied_at < datetime('now', ?1)",
                    format!("-{days} days"),
                )
            } else {
                (
                    "SELECT id, file_path FROM apply_history WHERE ?1 = ?1",
                    String::new(),
                )
            };
            let mut statement = transaction.prepare(query)?;
            statement
                .query_map([argument], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        for (id, _) in &stale {
            transaction.execute("DELETE FROM apply_history WHERE id = ?1", [id])?;
        }
        transaction.commit()?;
        Ok(stale.into_iter().map(|(_, path)| path).collect())
    }

    fn connection(&self) -> Result<Connection, StoreError> {
        let connection = Connection::open(&self.db_path)?;
        connection.execute_batch("PRAGMA foreign_keys = ON;")?;
        Ok(connection)
    }

    fn cipher(&self) -> Result<Fernet, StoreError> {
        let key = if self.secret_key_path.exists() {
            fs::read_to_string(&self.secret_key_path)?
        } else {
            let key = Fernet::generate_key();
            fs::write(&self.secret_key_path, &key)?;
            lock_down_key(&self.secret_key_path)?;
            key
        };
        Fernet::new(key.trim()).ok_or(StoreError::InvalidSecretKey)
    }
}

fn is_secret_setting(key: &str) -> bool {
    matches!(
        key,
        "posterdb_password" | "fanart_api_key" | "tvdb_api_key" | "tvdb_pin"
    )
}

fn history_from_row(row: &rusqlite::Row<'_>) -> Result<HistoryRow, rusqlite::Error> {
    Ok(HistoryRow {
        id: row.get(0)?,
        server_id: row.get(1)?,
        item_id: row.get(2)?,
        item_title: row.get(3)?,
        target: row.get(4)?,
        file_path: row.get(5)?,
        content_type: row.get(6)?,
        provider: row.get(7)?,
        applied_at: row.get(8)?,
    })
}

fn migrate(connection: &Connection) -> Result<(), rusqlite::Error> {
    let mut statement = connection.prepare("PRAGMA table_info(apply_history)")?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    if !columns.iter().any(|column| column == "item_title") {
        connection.execute(
            "ALTER TABLE apply_history ADD COLUMN item_title TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }
    Ok(())
}

fn normalize_base_url(value: &str) -> String {
    value.trim_end_matches('/').to_owned()
}

fn server_from_row(row: &rusqlite::Row<'_>) -> Result<Server, rusqlite::Error> {
    let raw_type: String = row.get(2)?;
    let server_type = match raw_type.as_str() {
        "plex" => ServerType::Plex,
        "jellyfin" => ServerType::Jellyfin,
        "emby" => ServerType::Emby,
        _ => {
            return Err(rusqlite::Error::FromSqlConversionFailure(
                2,
                rusqlite::types::Type::Text,
                Box::new(StoreError::InvalidServerType(raw_type)),
            ));
        }
    };
    let token: String = row.get(5)?;
    Ok(Server {
        id: row.get(0)?,
        name: row.get(1)?,
        server_type,
        base_url: row.get(3)?,
        is_default: row.get(4)?,
        has_token: !token.is_empty(),
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

#[cfg(unix)]
fn lock_down_key(path: &Path) -> Result<(), std::io::Error> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn lock_down_key(_path: &Path) -> Result<(), std::io::Error> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use posterview_contracts::{ServerCreate, ServerType, ServerUpdate};
    use rusqlite::params;
    use tempfile::tempdir;

    use super::ServerStore;

    #[test]
    fn crud_matches_existing_default_and_token_rules() {
        let directory = tempdir().unwrap();
        let store = ServerStore::new(directory.path());
        store.initialize().unwrap();

        let first = store
            .create_server(&ServerCreate {
                name: "Primary".into(),
                server_type: ServerType::Jellyfin,
                base_url: "http://jellyfin:8096///".into(),
                token: "secret-one".into(),
                is_default: false,
            })
            .unwrap();
        assert!(first.is_default);
        assert_eq!(first.base_url, "http://jellyfin:8096");
        assert!(first.has_token);
        assert_eq!(
            store.decrypted_token(first.id).unwrap().as_deref(),
            Some("secret-one")
        );

        let second = store
            .create_server(&ServerCreate {
                name: "Plex".into(),
                server_type: ServerType::Plex,
                base_url: "http://plex:32400".into(),
                token: "secret-two".into(),
                is_default: true,
            })
            .unwrap();
        assert!(second.is_default);
        assert!(!store.get_server(first.id).unwrap().unwrap().is_default);

        let updated = store
            .update_server(
                second.id,
                &ServerUpdate {
                    name: Some("Plex Updated".into()),
                    token: Some(String::new()),
                    ..ServerUpdate::default()
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(updated.name, "Plex Updated");
        assert_eq!(
            store.decrypted_token(second.id).unwrap().as_deref(),
            Some("secret-two")
        );
        assert!(store.delete_server(second.id).unwrap());
        assert!(!store.delete_server(second.id).unwrap());
    }

    #[test]
    fn decrypts_a_token_written_by_python_cryptography() {
        let directory = tempdir().unwrap();
        fs::write(
            directory.path().join("secret.key"),
            "ORPxWoqLKctKKfIcgpEOEcT0jiYy24w8tq9GmvUMG2Q=",
        )
        .unwrap();
        let store = ServerStore::new(directory.path());
        store.initialize().unwrap();
        let connection = store.connection().unwrap();
        connection.execute(
            "INSERT INTO media_servers (name, type, base_url, token_enc, is_default)
             VALUES (?1, 'plex', 'http://plex:32400', ?2, 1)",
            params![
                "Python fixture",
                "gAAAAABqleqHcw_AI4g5zhSPdsVzb2N6wRjAYliiz7NQ2-hL1rG7MBQdnPeexGTBcBjFnAwXTZJBwMsl_LxC3_PsF3CakTBTBlflqIOtn5HXce8nic0sq8E="
            ],
        ).unwrap();
        assert_eq!(
            store
                .decrypted_token(connection.last_insert_rowid())
                .unwrap()
                .as_deref(),
            Some("python-compatible-token")
        );
    }

    #[test]
    fn provider_secrets_are_encrypted_and_history_is_pruned_globally() {
        let directory = tempdir().unwrap();
        let store = ServerStore::new(directory.path());
        store.initialize().unwrap();
        store
            .set_setting("fanart_api_key", "provider-secret")
            .unwrap();
        assert_eq!(
            store.get_setting("fanart_api_key").unwrap(),
            "provider-secret"
        );
        let connection = store.connection().unwrap();
        let raw: String = connection
            .query_row(
                "SELECT value_enc FROM settings WHERE key = 'fanart_api_key'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_ne!(raw, "provider-secret");

        for index in 0..3 {
            store
                .insert_history(
                    1,
                    &format!("item-{index}"),
                    "Title",
                    "poster",
                    &format!("history-{index}.jpg"),
                    "image/jpeg",
                    "manual",
                )
                .unwrap();
        }
        assert_eq!(store.prune_history(2).unwrap().len(), 1);
        assert_eq!(store.list_history(None, None, None, None).unwrap().len(), 2);
    }
}
