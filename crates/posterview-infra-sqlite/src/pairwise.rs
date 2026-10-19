//! Private ranking boards, serialized before acquiring the shared write permit.
use crate::{ServerStore, StoreError};
use posterview_contracts::pairwise::RankingBoard;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};

pub(crate) fn migrate(db: &Connection) -> Result<(), StoreError> {
    let tx = db.unchecked_transaction()?;
    let applied: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=7)",
        [],
        |row| row.get(0),
    )?;
    if !applied {
        tx.execute_batch(
            "CREATE TABLE pairwise_boards(
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            library_id TEXT NOT NULL REFERENCES native_libraries(id) ON DELETE CASCADE,
            revision INTEGER NOT NULL CHECK(revision>0),
            board_json TEXT NOT NULL CHECK(json_valid(board_json)),
            updated_at TEXT NOT NULL DEFAULT(datetime('now')),
            PRIMARY KEY(user_id,library_id)
        );
        CREATE INDEX pairwise_boards_library ON pairwise_boards(library_id);
        INSERT INTO schema_migrations(version,name) VALUES(7,'personal_pairwise_rankings');",
        )?;
    }
    tx.commit()?;
    Ok(())
}

impl ServerStore {
    pub fn pairwise_board(
        &self,
        user: &str,
        library: &str,
    ) -> Result<(i64, RankingBoard), StoreError> {
        let result: Option<(i64, String)> = self.connection()?.query_row(
            "SELECT revision,board_json FROM pairwise_boards WHERE user_id=?1 AND library_id=?2",
            params![user, library], |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?;
        match result {
            Some((revision, json)) => Ok((
                revision,
                serde_json::from_str(&json).map_err(|_| {
                    StoreError::Validation("Stored ranking could not be read.".into())
                })?,
            )),
            None => Ok((0, RankingBoard::default())),
        }
    }

    pub fn save_pairwise_board(
        &self,
        user: &str,
        library: &str,
        expected_revision: i64,
        board: &RankingBoard,
    ) -> Result<i64, StoreError> {
        if expected_revision < 0 || expected_revision == i64::MAX {
            return Err(StoreError::Validation("Invalid ranking revision.".into()));
        }
        if board.events.len() > 100_000 || board.recent.len() > 32 {
            return Err(StoreError::Validation(
                "Ranking history exceeds the supported size.".into(),
            ));
        }
        let json = serde_json::to_string(board)
            .map_err(|_| StoreError::Validation("Invalid ranking data.".into()))?;
        if json.len() > 32 * 1024 * 1024 {
            return Err(StoreError::Validation(
                "Ranking history exceeds the supported size.".into(),
            ));
        }
        let mut connection = self.write_connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = if expected_revision == 0 {
            tx.execute("INSERT INTO pairwise_boards(user_id,library_id,revision,board_json) VALUES(?1,?2,1,?3) ON CONFLICT(user_id,library_id) DO NOTHING", params![user,library,json])?
        } else {
            tx.execute("UPDATE pairwise_boards SET revision=revision+1,board_json=?3,updated_at=datetime('now') WHERE user_id=?1 AND library_id=?2 AND revision=?4",params![user,library,json,expected_revision])?
        };
        if changed != 1 {
            return Err(StoreError::RevisionConflict);
        }
        tx.commit()?;
        Ok(expected_revision + 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use posterview_contracts::{
        native::NativeLibraryInput,
        pairwise::{RankingEvent, RankingPair},
    };

    fn fixture() -> (tempfile::TempDir, ServerStore, String) {
        let temp = tempfile::tempdir().unwrap();
        let store = ServerStore::new(temp.path());
        store.initialize().unwrap();
        let library = store.save_native_library(None, &serde_json::from_value::<NativeLibraryInput>(serde_json::json!({
            "name":"Movies", "library_type":"movies", "anime_content":"both", "paths":["Movies"]
        })).unwrap()).unwrap();
        for user in ["one", "two"] {
            store.connection().unwrap().execute("INSERT INTO users(id,username,display_name,password_hash,role,enabled,permissions) VALUES(?1,?1,?1,'','user',1,'{}')",[user]).unwrap();
        }
        (temp, store, library.id)
    }

    #[test]
    fn private_boards_survive_restart_and_reject_duplicate_or_stale_writes() {
        let (temp, store, library) = fixture();
        let board = RankingBoard {
            events: vec![RankingEvent {
                left_id: "a".into(),
                right_id: Some("b".into()),
                outcome: "tie".into(),
                pair: None,
            }],
            pair: Some(RankingPair {
                token: "prompt".into(),
                left_id: "a".into(),
                right_id: "b".into(),
            }),
            recent: vec![],
        };
        assert_eq!(store.pairwise_board("one", &library).unwrap().0, 0);
        assert_eq!(
            store
                .save_pairwise_board("one", &library, 0, &board)
                .unwrap(),
            1
        );
        assert!(matches!(
            store.save_pairwise_board("one", &library, 0, &board),
            Err(StoreError::RevisionConflict)
        ));
        let restarted = ServerStore::new(temp.path());
        restarted.initialize().unwrap();
        let (revision, persisted) = restarted.pairwise_board("one", &library).unwrap();
        assert_eq!(revision, 1);
        assert_eq!(persisted.events.len(), 1);
        assert_eq!(persisted.pair.unwrap().token, "prompt");
        assert_eq!(restarted.pairwise_board("two", &library).unwrap().0, 0);
        assert_eq!(
            restarted
                .save_pairwise_board("one", &library, 1, &board)
                .unwrap(),
            2
        );
        assert!(matches!(
            restarted.save_pairwise_board("one", &library, 1, &board),
            Err(StoreError::RevisionConflict)
        ));
    }

    #[test]
    fn account_and_library_deletion_cascade_but_catalog_titles_are_independent() {
        let (_temp, store, library) = fixture();
        let board = RankingBoard::default();
        store
            .save_pairwise_board("one", &library, 0, &board)
            .unwrap();
        store
            .save_pairwise_board("two", &library, 0, &board)
            .unwrap();
        store
            .connection()
            .unwrap()
            .execute("DELETE FROM users WHERE id='one'", [])
            .unwrap();
        assert_eq!(store.pairwise_board("one", &library).unwrap().0, 0);
        assert_eq!(store.pairwise_board("two", &library).unwrap().0, 1);
        store.delete_native_library(&library, 1).unwrap();
        assert_eq!(store.pairwise_board("two", &library).unwrap().0, 0);
        assert!(
            store
                .save_pairwise_board("two", "missing", 0, &board)
                .is_err()
        );
    }
}
