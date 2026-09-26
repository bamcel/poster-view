use crate::{ServerStore, StoreError};
use posterview_contracts::{Credit, CreditSource, SeriesCredits};
use rusqlite::{OptionalExtension, params};

pub(crate) const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS credit_series (
 id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
 server_id INTEGER NOT NULL REFERENCES media_servers(id) ON DELETE CASCADE,
 item_id TEXT NOT NULL,
 original_language TEXT,
 UNIQUE(server_id, item_id)
);
CREATE TABLE IF NOT EXISTS credit_sources (
 series_id TEXT NOT NULL REFERENCES credit_series(id) ON DELETE CASCADE,
 provider TEXT NOT NULL,
 external_id TEXT NOT NULL,
 title TEXT NOT NULL,
 source_url TEXT NOT NULL,
 original_language TEXT,
 fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
 PRIMARY KEY(series_id, provider, external_id)
);
CREATE TABLE IF NOT EXISTS series_credits (
 series_id TEXT NOT NULL,
 provider TEXT NOT NULL,
 external_id TEXT NOT NULL,
 ordinal INTEGER NOT NULL,
 person_id TEXT NOT NULL,
 name TEXT NOT NULL,
 image TEXT,
 person_url TEXT,
 character_id TEXT,
 character TEXT,
 character_image TEXT,
 category TEXT NOT NULL CHECK(category IN ('cast','crew')),
 role TEXT NOT NULL,
 language TEXT,
 dub_group TEXT,
 notes TEXT,
 billing_order INTEGER NOT NULL,
 PRIMARY KEY(series_id, provider, external_id, ordinal),
 FOREIGN KEY(series_id, provider, external_id) REFERENCES credit_sources(series_id, provider, external_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_series_credits_language ON series_credits(series_id, category, language);
"#;

impl ServerStore {
    pub fn series_credits(&self, server: i64, item: &str) -> Result<SeriesCredits, StoreError> {
        let mut db = self.connection()?;
        let tx = db.transaction()?;
        let row: Option<(String, Option<String>)> = tx
            .query_row(
                "SELECT id,original_language FROM credit_series WHERE server_id=?1 AND item_id=?2",
                params![server, item],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((id, language)) = row else {
            return Ok(SeriesCredits::default());
        };
        let mut sources = tx.prepare("SELECT provider,external_id,title,source_url,original_language,fetched_at FROM credit_sources WHERE series_id=?1 ORDER BY CASE provider WHEN 'anilist' THEN 0 WHEN 'mal' THEN 1 WHEN 'tmdb' THEN 2 ELSE 3 END")?
            .query_map([&id], |r| Ok(CreditSource {
                provider:r.get(0)?,external_id:r.get(1)?,title:r.get(2)?,source_url:r.get(3)?,
                original_language:r.get(4)?,fetched_at:r.get(5)?,credits:Vec::new(),
            }))?.collect::<Result<Vec<_>,_>>()?;
        for source in &mut sources {
            source.credits = tx.prepare("SELECT person_id,name,image,person_url,character_id,character,character_image,category,role,language,dub_group,notes,billing_order FROM series_credits WHERE series_id=?1 AND provider=?2 AND external_id=?3 ORDER BY billing_order,ordinal")?
                .query_map(params![id,source.provider,source.external_id], |r| Ok(Credit {
                    person_id:r.get(0)?,name:r.get(1)?,image:r.get(2)?,person_url:r.get(3)?,
                    character_id:r.get(4)?,character:r.get(5)?,character_image:r.get(6)?,
                    category:r.get(7)?,role:r.get(8)?,language:r.get(9)?,dub_group:r.get(10)?,notes:r.get(11)?,order:r.get(12)?,
                }))?.collect::<Result<Vec<_>,_>>()?;
        }
        tx.commit()?;
        Ok(SeriesCredits {
            catalog_id: Some(id),
            original_language: language,
            sources,
        })
    }

    /// Replace only this source, atomically, after the entire fetch succeeds.
    pub fn save_credit_source(
        &self,
        server: i64,
        item: &str,
        source: &CreditSource,
    ) -> Result<(), StoreError> {
        let mut db = self.connection()?;
        let tx = db.transaction()?;
        tx.execute(
            "INSERT INTO credit_series(server_id,item_id) VALUES(?1,?2) ON CONFLICT DO NOTHING",
            params![server, item],
        )?;
        let id: String = tx.query_row(
            "SELECT id FROM credit_series WHERE server_id=?1 AND item_id=?2",
            params![server, item],
            |r| r.get(0),
        )?;
        tx.execute(
            "DELETE FROM credit_sources WHERE series_id=?1 AND provider=?2 AND external_id=?3",
            params![id, source.provider, source.external_id],
        )?;
        tx.execute("INSERT INTO credit_sources(series_id,provider,external_id,title,source_url,original_language) VALUES(?1,?2,?3,?4,?5,?6)",params![id,source.provider,source.external_id,source.title,source.source_url,source.original_language])?;
        for (index, c) in source.credits.iter().enumerate() {
            tx.execute("INSERT INTO series_credits VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",params![id,source.provider,source.external_id,index as i64,c.person_id,c.name,c.image,c.person_url,c.character_id,c.character,c.character_image,c.category,c.role,c.language,c.dub_group,c.notes,c.order])?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn set_credit_language(
        &self,
        server: i64,
        item: &str,
        language: Option<&str>,
    ) -> Result<(), StoreError> {
        self.connection()?.execute("INSERT INTO credit_series(server_id,item_id,original_language) VALUES(?1,?2,?3) ON CONFLICT(server_id,item_id) DO UPDATE SET original_language=excluded.original_language",params![server,item,language])?;
        Ok(())
    }

    pub fn remove_credit_source(
        &self,
        server: i64,
        item: &str,
        provider: &str,
        external_id: &str,
    ) -> Result<(), StoreError> {
        self.connection()?.execute("DELETE FROM credit_sources WHERE provider=?3 AND external_id=?4 AND series_id=(SELECT id FROM credit_series WHERE server_id=?1 AND item_id=?2)",params![server,item,provider,external_id])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use posterview_contracts::{ServerCreate, ServerType};
    #[test]
    fn refresh_is_atomic_scoped_and_survives_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let store = ServerStore::new(dir.path());
        store.initialize().unwrap();
        let server = store
            .create_server(&ServerCreate {
                name: "test".into(),
                server_type: ServerType::Plex,
                base_url: "http://localhost".into(),
                token: String::new(),
                is_default: false,
                nfo_metadata_enabled: false,
            })
            .unwrap();
        let mut source = CreditSource {
            provider: "anilist".into(),
            external_id: "1".into(),
            credits: vec![
                Credit {
                    name: "Actor".into(),
                    category: "cast".into(),
                    language: Some("ja".into()),
                    ..Default::default()
                },
                Credit {
                    name: "Actor EN".into(),
                    category: "cast".into(),
                    language: Some("en".into()),
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        store
            .save_credit_source(server.id, "show", &source)
            .unwrap();
        source.provider = "mal".into();
        store
            .save_credit_source(server.id, "show", &source)
            .unwrap();
        source.credits[0].category = "invalid".into();
        assert!(
            store
                .save_credit_source(server.id, "show", &source)
                .is_err()
        );
        let reopened = ServerStore::new(dir.path());
        let result = reopened.series_credits(server.id, "show").unwrap();
        assert_eq!(result.sources.len(), 2);
        assert_eq!(result.sources[1].credits.len(), 2);
        assert!(
            reopened
                .series_credits(server.id, "other")
                .unwrap()
                .sources
                .is_empty()
        );
        reopened
            .set_credit_language(server.id, "show", Some("ja"))
            .unwrap();
        reopened
            .remove_credit_source(server.id, "show", "mal", "1")
            .unwrap();
        assert_eq!(
            reopened
                .series_credits(server.id, "show")
                .unwrap()
                .original_language
                .as_deref(),
            Some("ja")
        );
        assert_eq!(
            reopened
                .series_credits(server.id, "show")
                .unwrap()
                .sources
                .len(),
            1
        );
        source.provider = "anilist".into();
        source.external_id = "2".into();
        source.credits[0].category = "cast".into();
        reopened
            .save_credit_source(server.id, "show", &source)
            .unwrap();
        reopened
            .save_credit_source(server.id, "show", &source)
            .unwrap();
        let seasons = reopened.series_credits(server.id, "show").unwrap();
        assert_eq!(
            seasons.sources.len(),
            2,
            "Reimport is idempotent and retains other season entries"
        );
        assert!(seasons.sources.iter().all(|s| s.credits.len() == 2));
        reopened
            .remove_credit_source(server.id, "show", "anilist", "2")
            .unwrap();
        assert_eq!(
            reopened.series_credits(server.id, "show").unwrap().sources[0].external_id,
            "1"
        );
    }
}
