use crate::{ServerStore, StoreError};
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use posterview_contracts::{UserAccount, UserCreate, UserPermissions, UserRole, UserUpdate};
use rusqlite::{Connection, OptionalExtension, params};

pub(crate) fn migrate(connection: &Connection) -> Result<(), StoreError> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','user')), enabled INTEGER NOT NULL, permissions TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT(datetime('now')));")?;
    Ok(())
}
fn hash_password(password: &str) -> Result<String, StoreError> {
    // UUID v4 contributes OS-generated random entropy; passwords never enter reversible storage.
    let salt = SaltString::encode_b64(uuid::Uuid::new_v4().as_bytes())
        .map_err(|_| StoreError::Validation("Could not generate password salt.".into()))?;
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|_| StoreError::Validation("Could not hash password.".into()))
}
fn account(row: &rusqlite::Row<'_>) -> rusqlite::Result<UserAccount> {
    let permissions: String = row.get(5)?;
    Ok(UserAccount {
        id: row.get(0)?,
        username: row.get(1)?,
        display_name: row.get(2)?,
        role: if row.get::<_, String>(3)? == "admin" {
            UserRole::Admin
        } else {
            UserRole::User
        },
        enabled: row.get(4)?,
        permissions: serde_json::from_str(&permissions).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                5,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        revision: row.get(6)?,
        created_at: row.get(7)?,
    })
}
const SELECT: &str =
    "SELECT id,username,display_name,role,enabled,permissions,revision,created_at FROM users";
fn validate(
    username: &str,
    display_name: &str,
    password: Option<&str>,
    permissions: &UserPermissions,
) -> Result<(), StoreError> {
    if permissions.max_playback_streams > 64 {
        return Err(StoreError::Validation(
            "Simultaneous playback limit must be between 0 and 64 (0 means unlimited).".into(),
        ));
    }
    if username.trim().is_empty()
        || username.len() > 64
        || !username
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
    {
        return Err(StoreError::Validation(
            "Username must contain 1–64 letters, numbers, dots, dashes or underscores.".into(),
        ));
    }
    if display_name.trim().is_empty() || display_name.len() > 128 {
        return Err(StoreError::Validation(
            "Display name must contain 1–128 characters.".into(),
        ));
    }
    if password.is_some_and(|p| !(8..=1024).contains(&p.len())) {
        return Err(StoreError::Validation(
            "Password must contain 8–1024 bytes.".into(),
        ));
    }
    if permissions
        .max_movie_rating
        .as_deref()
        .is_some_and(|r| !["G", "PG", "PG-13", "R", "NC-17"].contains(&r))
        || permissions
            .max_tv_rating
            .as_deref()
            .is_some_and(|r| !["TV-Y", "TV-Y7", "TV-G", "TV-PG", "TV-14", "TV-MA"].contains(&r))
    {
        return Err(StoreError::Validation("Unsupported rating limit.".into()));
    }
    Ok(())
}
impl ServerStore {
    pub fn users(&self) -> Result<Vec<UserAccount>, StoreError> {
        let c = self.connection()?;
        let mut s = c.prepare(&format!("{SELECT} ORDER BY username COLLATE NOCASE"))?;
        s.query_map([], account)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(Into::into)
    }
    pub fn user(&self, id: &str) -> Result<Option<UserAccount>, StoreError> {
        self.connection()?
            .query_row(&format!("{SELECT} WHERE id=?1"), [id], account)
            .optional()
            .map_err(Into::into)
    }
    pub fn verify_user(
        &self,
        username: &str,
        password: &str,
    ) -> Result<Option<UserAccount>, StoreError> {
        let c = self.connection()?;
        let credentials: Option<(String, String, i64)> = c
            .query_row(
                "SELECT id,password_hash,revision FROM users WHERE username=?1 COLLATE NOCASE AND enabled=1",
                [username],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let Some((id, hash, revision)) = credentials else {
            return Ok(None);
        };
        let valid = PasswordHash::new(&hash).ok().is_some_and(|hash| {
            Argon2::default()
                .verify_password(password.as_bytes(), &hash)
                .is_ok()
        });
        if valid {
            self.verified_user(&id, revision)
        } else {
            Ok(None)
        }
    }
    // Password verification takes time. A reset or disable during verification must
    // not issue a session using the edited account's fresh revision.
    fn verified_user(&self, id: &str, revision: i64) -> Result<Option<UserAccount>, StoreError> {
        Ok(self
            .user(id)?
            .filter(|user| user.enabled && user.revision == revision))
    }
    pub fn bootstrap_user(&self, username: &str, password: &str) -> Result<(), StoreError> {
        let c = self.connection()?;
        let count: i64 = c.query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))?;
        if count == 0 {
            let hash = hash_password(password)?;
            c.execute("INSERT OR IGNORE INTO users(id,username,display_name,password_hash,role,enabled,permissions) VALUES (?1,?1,?1,?2,'admin',1,?3)",params![username,hash,serde_json::to_string(&UserPermissions{all_libraries:true,allow_unrated:true,..Default::default()}).unwrap()])?;
        }
        Ok(())
    }
    pub fn create_first_admin(
        &self,
        legacy_id: &str,
        input: &UserCreate,
    ) -> Result<UserAccount, StoreError> {
        let permissions = UserPermissions {
            all_libraries: true,
            allow_unrated: true,
            ..Default::default()
        };
        validate(
            &input.username,
            &input.display_name,
            Some(&input.password),
            &permissions,
        )?;
        let hash = hash_password(&input.password)?;
        let id = legacy_id;
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let count: i64 = tx.query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))?;
        if count != 0 {
            return Err(StoreError::RevisionConflict);
        }
        tx.execute("INSERT INTO users(id,username,display_name,password_hash,role,enabled,permissions) VALUES(?1,?2,?3,?4,'admin',1,?5)",params![id,input.username.trim(),input.display_name.trim(),hash,serde_json::to_string(&permissions).unwrap()])?;
        let result = tx.query_row(&format!("{SELECT} WHERE id=?1"), [id], account)?;
        tx.commit()?;
        Ok(result)
    }

    pub fn create_user(&self, input: &UserCreate) -> Result<UserAccount, StoreError> {
        validate(
            &input.username,
            &input.display_name,
            Some(&input.password),
            &input.permissions,
        )?;
        let hash = hash_password(&input.password)?;
        let id = uuid::Uuid::new_v4().to_string();
        let c = self.connection()?;
        c.execute("INSERT INTO users(id,username,display_name,password_hash,role,enabled,permissions) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![id,input.username.trim(),input.display_name.trim(),hash,if input.role==UserRole::Admin{"admin"}else{"user"},input.enabled,serde_json::to_string(&input.permissions).unwrap()]).map_err(user_write_error)?;
        self.user(&id)?
            .ok_or_else(|| StoreError::Validation("Account not found.".into()))
    }
    pub fn update_user(
        &self,
        id: &str,
        input: &UserUpdate,
    ) -> Result<Option<UserAccount>, StoreError> {
        validate(
            &input.username,
            &input.display_name,
            input.password.as_deref(),
            &input.permissions,
        )?;
        let password = input.password.as_deref().map(hash_password).transpose()?;
        let mut c = self.connection()?;
        let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let existing = tx
            .query_row(&format!("{SELECT} WHERE id=?1"), [id], account)
            .optional()?;
        let Some(existing) = existing else {
            return Ok(None);
        };
        if existing.revision != input.revision {
            return Err(StoreError::RevisionConflict);
        }
        protect_last_admin(
            &tx,
            &existing,
            input.enabled && input.role == UserRole::Admin,
        )?;
        tx.execute("UPDATE users SET username=?2,display_name=?3,password_hash=COALESCE(?4,password_hash),role=?5,enabled=?6,permissions=?7,revision=revision+1 WHERE id=?1",params![id,input.username.trim(),input.display_name.trim(),password,if input.role==UserRole::Admin{"admin"}else{"user"},input.enabled,serde_json::to_string(&input.permissions).unwrap()]).map_err(user_write_error)?;
        tx.commit()?;
        self.user(id)
    }
    pub fn delete_user(&self, id: &str) -> Result<bool, StoreError> {
        let mut c = self.connection()?;
        let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let existing = tx
            .query_row(&format!("{SELECT} WHERE id=?1"), [id], account)
            .optional()?;
        let Some(existing) = existing else {
            return Ok(false);
        };
        protect_last_admin(&tx, &existing, false)?;
        tx.execute("DELETE FROM users WHERE id=?1", [id])?;
        tx.commit()?;
        Ok(true)
    }
}
fn user_write_error(error: rusqlite::Error) -> StoreError {
    if matches!(error,rusqlite::Error::SqliteFailure(ref e,_) if e.code==rusqlite::ErrorCode::ConstraintViolation)
    {
        StoreError::Validation("Username already exists.".into())
    } else {
        error.into()
    }
}
fn protect_last_admin(
    c: &Connection,
    existing: &UserAccount,
    remains_admin: bool,
) -> Result<(), StoreError> {
    if existing.role == UserRole::Admin && existing.enabled && !remains_admin {
        let count: i64 = c.query_row(
            "SELECT COUNT(*) FROM users WHERE role='admin' AND enabled=1",
            [],
            |r| r.get(0),
        )?;
        if count <= 1 {
            return Err(StoreError::Validation(
                "At least one enabled administrator is required.".into(),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn playback_limits_persist_on_create_and_update_and_validate_range() {
        let dir = tempfile::tempdir().unwrap();
        let store = ServerStore::new(dir.path());
        store.initialize().unwrap();
        let mut input = UserCreate {
            username: "viewer".into(),
            display_name: "Viewer".into(),
            password: "password123".into(),
            role: UserRole::User,
            enabled: true,
            permissions: UserPermissions {
                max_playback_streams: 2,
                ..Default::default()
            },
        };
        let created = store.create_user(&input).unwrap();
        assert_eq!(
            store
                .user(&created.id)
                .unwrap()
                .unwrap()
                .permissions
                .max_playback_streams,
            2
        );
        let mut update = UserUpdate {
            revision: created.revision,
            username: created.username,
            display_name: created.display_name,
            role: created.role,
            enabled: true,
            permissions: UserPermissions {
                max_playback_streams: 0,
                ..created.permissions
            },
            password: None,
        };
        let updated = store.update_user(&created.id, &update).unwrap().unwrap();
        assert_eq!(updated.permissions.max_playback_streams, 0);
        update.revision = updated.revision;
        update.permissions.max_playback_streams = 65;
        assert!(matches!(
            store.update_user(&created.id, &update),
            Err(StoreError::Validation(_))
        ));
        input.permissions.max_playback_streams = 65;
        assert!(matches!(
            store.create_user(&input),
            Err(StoreError::Validation(_))
        ));
    }
    #[test]
    fn first_admin_setup_is_atomic_and_forces_administrator_permissions() {
        let dir = tempfile::tempdir().unwrap();
        let store = std::sync::Arc::new(ServerStore::new(dir.path()));
        store.initialize().unwrap();
        let input = UserCreate {
            username: "owner".into(),
            display_name: "Owner".into(),
            password: "password123".into(),
            role: UserRole::User,
            enabled: false,
            permissions: Default::default(),
        };
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let workers: Vec<_> = (0..2)
            .map(|_| {
                let store = store.clone();
                let barrier = barrier.clone();
                let input = input.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    store.create_first_admin("legacy-admin", &input)
                })
            })
            .collect();
        let results: Vec<_> = workers.into_iter().map(|w| w.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|r| matches!(r, Err(StoreError::RevisionConflict)))
                .count(),
            1
        );
        let users = store.users().unwrap();
        assert_eq!(users.len(), 1);
        assert_eq!(users[0].id, "legacy-admin");
        assert_eq!(users[0].username, "owner");
        assert_eq!(users[0].role, UserRole::Admin);
        assert!(
            users[0].enabled
                && users[0].permissions.all_libraries
                && users[0].permissions.allow_unrated
        );
    }

    #[test]
    fn account_changes_during_password_verification_reject_the_old_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let store = ServerStore::new(dir.path());
        store.initialize().unwrap();
        store.bootstrap_user("admin", "password").unwrap();
        // Capture what a login worker sees immediately before its expensive hash check.
        let (hash, revision): (String, i64) = store
            .connection()
            .unwrap()
            .query_row(
                "SELECT password_hash,revision FROM users WHERE id='admin'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let admin = store.user("admin").unwrap().unwrap();
        store
            .update_user(
                "admin",
                &UserUpdate {
                    revision,
                    username: admin.username,
                    display_name: admin.display_name,
                    role: admin.role,
                    enabled: true,
                    permissions: admin.permissions,
                    password: Some("replacement".into()),
                },
            )
            .unwrap();
        assert!(
            Argon2::default()
                .verify_password(b"password", &PasswordHash::new(&hash).unwrap())
                .is_ok()
        );
        assert!(store.verified_user("admin", revision).unwrap().is_none());
        assert!(store.verify_user("admin", "replacement").unwrap().is_some());
    }

    #[test]
    fn revisions_and_password_resets_are_atomic() {
        let dir = tempfile::tempdir().unwrap();
        let store = ServerStore::new(dir.path());
        store.initialize().unwrap();
        store.bootstrap_user("admin", "password").unwrap();
        let admin = store.user("admin").unwrap().unwrap();
        let mut change = UserUpdate {
            revision: admin.revision,
            username: "renamed".into(),
            display_name: "Owner".into(),
            role: UserRole::User,
            enabled: true,
            permissions: admin.permissions,
            password: None,
        };
        assert!(store.update_user("admin", &change).is_err());
        change.role = UserRole::Admin;
        change.password = Some("new-password".into());
        let edited = store.update_user("admin", &change).unwrap().unwrap();
        assert_eq!(edited.id, "admin");
        assert_eq!(edited.revision, 2);
        assert!(store.verify_user("renamed", "password").unwrap().is_none());
        assert!(
            store
                .verify_user("renamed", "new-password")
                .unwrap()
                .is_some()
        );
        assert!(matches!(
            store.update_user("admin", &change),
            Err(StoreError::RevisionConflict)
        ));
        change.revision = 2;
        change.enabled = false;
        assert!(store.update_user("admin", &change).is_err());
    }

    #[test]
    fn passwords_are_salted_and_last_admin_is_protected() {
        let dir = tempfile::tempdir().unwrap();
        let store = ServerStore::new(dir.path());
        store.initialize().unwrap();
        store.bootstrap_user("admin", "password").unwrap();
        assert!(store.verify_user("ADMIN", "password").unwrap().is_some());
        assert!(store.verify_user("admin", "wrong").unwrap().is_none());
        assert!(store.delete_user("admin").is_err());
        let input = UserCreate {
            username: "viewer".into(),
            display_name: "Viewer".into(),
            password: "password".into(),
            role: UserRole::User,
            enabled: true,
            permissions: Default::default(),
        };
        let user = store.create_user(&input).unwrap();
        let hashes: Vec<String> = store
            .connection()
            .unwrap()
            .prepare("SELECT password_hash FROM users")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_ne!(hashes[0], hashes[1]);
        assert!(hashes.iter().all(|h| h.starts_with("$argon2id$")));
        assert!(!serde_json::to_string(&user).unwrap().contains("password"));
        assert!(
            store
                .create_user(&UserCreate {
                    username: "VIEWER".into(),
                    ..input
                })
                .is_err()
        );
    }
}
