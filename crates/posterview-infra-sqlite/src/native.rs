use crate::{ServerStore, StoreError};
use posterview_contracts::native::{NativeLibrary, NativeLibraryInput};
use rusqlite::{Connection, OptionalExtension, params};

// Native catalog ownership is independent of any connected server.
const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS schema_migrations (
 version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE native_libraries (
 id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
 library_type TEXT NOT NULL CHECK(library_type IN ('movies','shows','anime','books')),
 anime_content TEXT NOT NULL CHECK(anime_content IN ('both','shows','movies')),
 revision INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX native_library_name ON native_libraries(name COLLATE NOCASE);
CREATE TABLE native_library_roots (
 library_id TEXT NOT NULL REFERENCES native_libraries(id) ON DELETE CASCADE,
 relative_path TEXT NOT NULL, position INTEGER NOT NULL,
 PRIMARY KEY(library_id,relative_path), UNIQUE(library_id,position)
);
CREATE TABLE catalog_items (
 id TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN ('movie','series','season','episode','book_series','book','collection','folder')),
 parent_id TEXT REFERENCES catalog_items(id) ON DELETE RESTRICT,
 title TEXT NOT NULL, original_title TEXT, sort_title TEXT, synopsis TEXT,
 year INTEGER, release_date TEXT, status TEXT, revision INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX catalog_parent ON catalog_items(parent_id);
CREATE TABLE native_library_items (
 library_id TEXT NOT NULL REFERENCES native_libraries(id) ON DELETE CASCADE,
 item_id TEXT NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
 PRIMARY KEY(library_id,item_id)
);
CREATE TABLE catalog_identifiers (
 item_id TEXT NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
 provider TEXT NOT NULL, namespace TEXT NOT NULL, external_id TEXT NOT NULL,
 PRIMARY KEY(item_id,provider,namespace,external_id)
);
CREATE INDEX catalog_identifier_lookup ON catalog_identifiers(provider,namespace,external_id);
CREATE TABLE catalog_terms (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('tag','genre','studio','publisher')),
 name TEXT NOT NULL, UNIQUE(kind,name)
);
CREATE TABLE catalog_item_terms (
 item_id TEXT NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
 term_id TEXT NOT NULL REFERENCES catalog_terms(id) ON DELETE CASCADE,
 PRIMARY KEY(item_id,term_id)
);
CREATE TABLE catalog_people (id TEXT PRIMARY KEY, name TEXT NOT NULL, biography TEXT, image_path TEXT);
CREATE TABLE catalog_characters (id TEXT PRIMARY KEY, name TEXT NOT NULL, biography TEXT, image_path TEXT);
CREATE TABLE catalog_character_appearances (
 item_id TEXT NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
 character_id TEXT NOT NULL REFERENCES catalog_characters(id) ON DELETE CASCADE,
 role TEXT, position INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(item_id,character_id)
);
CREATE TABLE catalog_credits (
 id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
 person_id TEXT NOT NULL REFERENCES catalog_people(id) ON DELETE RESTRICT,
 character_id TEXT REFERENCES catalog_characters(id) ON DELETE SET NULL,
 category TEXT NOT NULL CHECK(category IN ('cast','crew','voice','author','illustrator','narrator')),
 role TEXT NOT NULL, language TEXT, position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX catalog_credits_item ON catalog_credits(item_id,category,position);
CREATE TABLE catalog_metadata_fields (
 item_id TEXT NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE, field TEXT NOT NULL,
 value_json TEXT NOT NULL CHECK(json_valid(value_json)), source TEXT NOT NULL,
 locked INTEGER NOT NULL DEFAULT 0 CHECK(locked IN (0,1)), revision INTEGER NOT NULL DEFAULT 1,
 updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(item_id,field)
);
CREATE TABLE catalog_files (
 id TEXT PRIMARY KEY, relative_path TEXT NOT NULL UNIQUE, size_bytes INTEGER, modified_at TEXT,
 available INTEGER NOT NULL DEFAULT 1 CHECK(available IN (0,1))
);
CREATE TABLE catalog_item_files (
 item_id TEXT NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
 file_id TEXT NOT NULL REFERENCES catalog_files(id) ON DELETE CASCADE,
 PRIMARY KEY(item_id,file_id)
);
CREATE TABLE catalog_media_streams (
 file_id TEXT NOT NULL REFERENCES catalog_files(id) ON DELETE CASCADE, stream_index INTEGER NOT NULL,
 stream_type TEXT NOT NULL CHECK(stream_type IN ('video','audio','subtitle')),
 info_json TEXT NOT NULL CHECK(json_valid(info_json)), PRIMARY KEY(file_id,stream_index)
);
CREATE TABLE catalog_episode_numbers (
 item_id TEXT NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE, scheme TEXT NOT NULL,
 season_number INTEGER, episode_number INTEGER NOT NULL, episode_end INTEGER,
 PRIMARY KEY(item_id,scheme,episode_number)
);
CREATE TABLE catalog_nfo_documents (
 id TEXT PRIMARY KEY, relative_path TEXT NOT NULL UNIQUE, profile TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1, content_hash TEXT, parse_status TEXT NOT NULL DEFAULT 'unread'
);
CREATE TABLE catalog_item_nfo (
 item_id TEXT NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
 document_id TEXT NOT NULL REFERENCES catalog_nfo_documents(id) ON DELETE CASCADE,
 PRIMARY KEY(item_id,document_id)
);
"#;

pub(crate) fn migrate(db: &Connection) -> Result<(), StoreError> {
    let tx = db.unchecked_transaction()?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')));")?;
    let applied: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=1)",
        [],
        |r| r.get(0),
    )?;
    if !applied {
        tx.execute_batch(SCHEMA)?;
        tx.execute("INSERT INTO schema_migrations(version,name) VALUES(1,'native_library_and_metadata_foundation')", [])?;
    }
    let catalog_applied: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=2)",
        [],
        |r| r.get(0),
    )?;
    if !catalog_applied {
        tx.execute_batch(
            r#"
ALTER TABLE native_libraries ADD COLUMN options_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE catalog_nfo_documents ADD COLUMN content_xml TEXT;
CREATE TABLE native_catalog_sources (
 library_id TEXT NOT NULL REFERENCES native_libraries(id) ON DELETE CASCADE,
 relative_path TEXT NOT NULL, item_id TEXT NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), available INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(library_id,relative_path), UNIQUE(library_id,item_id)
);
CREATE TABLE catalog_artwork (
 item_id TEXT NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE, kind TEXT NOT NULL,
 path TEXT NOT NULL, source TEXT NOT NULL, locked INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(item_id,kind)
);
CREATE TABLE native_library_scans (
 library_id TEXT PRIMARY KEY REFERENCES native_libraries(id) ON DELETE CASCADE,
 status_json TEXT NOT NULL CHECK(json_valid(status_json))
);
INSERT INTO schema_migrations(version,name) VALUES(2,'native_scan_options_and_artwork');
"#,
        )?;
    }
    // Reverse foreign-key lookups must not scan whole tables during library deletion.
    tx.execute_batch("CREATE INDEX IF NOT EXISTS native_library_item_reverse ON native_library_items(item_id);
        CREATE INDEX IF NOT EXISTS native_source_item_reverse ON native_catalog_sources(item_id);
        CREATE INDEX IF NOT EXISTS catalog_item_file_reverse ON catalog_item_files(file_id);
        CREATE INDEX IF NOT EXISTS catalog_item_nfo_reverse ON catalog_item_nfo(document_id);")?;
    tx.commit()?;
    Ok(())
}

fn provider_supported(
    provider: &str,
    kind: &str,
    library: posterview_contracts::native::NativeLibraryType,
    images: bool,
) -> bool {
    use posterview_contracts::native::NativeLibraryType;
    let anime = library == NativeLibraryType::Anime;
    match provider {
        "comicvine" | "mangadex" => library == NativeLibraryType::Books && kind == "book_series",
        "anilist" => kind == "book_series" || (anime && ["movie", "series"].contains(&kind)),
        "mal" => kind == "book_series" || (anime && ["movie", "series"].contains(&kind)),
        "anidb" => {
            anime
                && ["movie", "series", "episode"].contains(&kind)
                && (!images || kind != "episode")
        }
        "tmdb" | "tvdb" => kind != "book_series",
        "omdb" => ["movie", "series", "episode"].contains(&kind),
        "fanart" => images && ["movie", "series", "season"].contains(&kind),
        _ => false,
    }
}
fn validate(input: &NativeLibraryInput) -> Result<(), StoreError> {
    let invalid = |m: &str| StoreError::Validation(m.into());
    if input.name.trim().is_empty() || input.name.trim().chars().count() > 120 {
        return Err(invalid("Choose a library name of 1–120 characters."));
    }
    if input.paths.is_empty() || input.paths.len() > 32 {
        return Err(invalid("Select between 1 and 32 media folders."));
    }
    let options = &input.options;
    if !["en", "ja", "fr", "de", "es", "it", "pt", "ko", "zh"]
        .contains(&options.metadata_language.as_str())
        || !["en", "ja", "fr", "de", "es", "it", "pt", "ko", "zh"]
            .contains(&options.image_language.as_str())
        || ![
            "US", "GB", "JP", "CA", "AU", "FR", "DE", "ES", "IT", "BR", "KR", "CN",
        ]
        .contains(&options.certification_country.as_str())
        || options.sample_ignore_mb > 10000
    {
        return Err(invalid(
            "Invalid library language, country, or sample size.",
        ));
    }
    for (images, providers) in [
        (false, &options.metadata_providers),
        (true, &options.image_providers),
    ] {
        for (kind, list) in providers {
            if !["movie", "series", "season", "episode", "book_series"].contains(&kind.as_str())
                || list.len() > 7
                || list.iter().enumerate().any(|(i, p)| list[..i].contains(p))
                || list
                    .iter()
                    .any(|p| !provider_supported(p, kind, input.library_type, images))
            {
                return Err(invalid("Invalid metadata or image provider order."));
            }
        }
    }
    if options
        .image_types
        .iter()
        .any(|v| !["poster", "backdrop", "thumb", "logo", "banner"].contains(&v.as_str()))
    {
        return Err(invalid("Invalid image type."));
    }
    for (i, path) in input.paths.iter().enumerate() {
        if !path.is_empty()
            && path
                .split('/')
                .any(|p| p.is_empty() || p == "." || p == ".." || p.contains(['\\', ':', '\0']))
        {
            return Err(invalid("Folders must be relative to /media."));
        }
        for other in &input.paths[..i] {
            if path == other
                || path.is_empty()
                || other.is_empty()
                || path.starts_with(&format!("{other}/"))
                || other.starts_with(&format!("{path}/"))
            {
                return Err(invalid(
                    "Selected folders overlap. Choose the parent folder or its children.",
                ));
            }
        }
    }
    Ok(())
}

impl ServerStore {
    /// Create an independently owned root catalog item. Hierarchical ingestion follows later.
    pub fn create_native_catalog_item(
        &self,
        library: &str,
        kind: &str,
        title: &str,
    ) -> Result<String, StoreError> {
        if title.trim().is_empty() {
            return Err(StoreError::Validation("A title is required.".into()));
        }
        let mut db = self.connection()?;
        let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let (library_type, content): (String, String) = tx.query_row(
            "SELECT library_type,anime_content FROM native_libraries WHERE id=?1",
            [library],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let permitted = match library_type.as_str() {
            "movies" => kind == "movie",
            "shows" => kind == "series",
            "anime" => {
                (kind == "movie" && content != "shows") || (kind == "series" && content != "movies")
            }
            "books" => matches!(kind, "book" | "book_series" | "folder"),
            _ => false,
        };
        if !permitted {
            return Err(StoreError::Validation(
                "This item type is not allowed in the library.".into(),
            ));
        }
        let id = uuid::Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO catalog_items(id,kind,title) VALUES(?1,?2,?3)",
            params![id, kind, title.trim()],
        )?;
        tx.execute(
            "INSERT INTO native_library_items(library_id,item_id) VALUES(?1,?2)",
            params![library, id],
        )?;
        tx.commit()?;
        Ok(id)
    }

    /// Add a provider/local observation only if it does not replace a locked or manual field.
    /// Returns false when the selected value was preserved.
    pub fn observe_native_metadata(
        &self,
        item: &str,
        field: &str,
        value: &serde_json::Value,
        source: &str,
    ) -> Result<bool, StoreError> {
        if field.trim().is_empty() || source.trim().is_empty() || source == "manual" {
            return Err(StoreError::Validation(
                "An observation needs a field and a non-manual source.".into(),
            ));
        }
        let db = self.connection()?;
        let changed=db.execute("INSERT INTO catalog_metadata_fields(item_id,field,value_json,source) VALUES(?1,?2,?3,?4) ON CONFLICT(item_id,field) DO UPDATE SET value_json=excluded.value_json,source=excluded.source,revision=catalog_metadata_fields.revision+1,updated_at=datetime('now') WHERE catalog_metadata_fields.locked=0 AND catalog_metadata_fields.source<>'manual'",params![item,field,value.to_string(),source])?;
        Ok(changed > 0)
    }

    /// Manual edits require the previous field revision and are locked by default.
    pub fn edit_native_metadata(
        &self,
        item: &str,
        field: &str,
        value: &serde_json::Value,
        previous_revision: Option<i64>,
    ) -> Result<(), StoreError> {
        if field.trim().is_empty() {
            return Err(StoreError::Validation(
                "A metadata field is required.".into(),
            ));
        }
        let mut db = self.connection()?;
        let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let revision: Option<i64> = tx
            .query_row(
                "SELECT revision FROM catalog_metadata_fields WHERE item_id=?1 AND field=?2",
                params![item, field],
                |r| r.get(0),
            )
            .optional()?;
        if revision != previous_revision {
            return Err(StoreError::RevisionConflict);
        }
        tx.execute("INSERT INTO catalog_metadata_fields(item_id,field,value_json,source,locked) VALUES(?1,?2,?3,'manual',1) ON CONFLICT(item_id,field) DO UPDATE SET value_json=excluded.value_json,source='manual',locked=1,revision=catalog_metadata_fields.revision+1,updated_at=datetime('now')",params![item,field,value.to_string()])?;
        tx.commit()?;
        Ok(())
    }

    pub fn native_libraries(&self) -> Result<Vec<NativeLibrary>, StoreError> {
        let mut connection = self.connection()?;
        // Keep library revisions and their selected roots in one read snapshot.
        let db = connection.transaction()?;
        let mut statement = db.prepare("SELECT id,name,library_type,anime_content,revision,created_at,updated_at,options_json FROM native_libraries ORDER BY name COLLATE NOCASE")?;
        let rows = statement
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, String>(6)?,
                    r.get::<_, String>(7)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter().map(|(id,name,kind,content,revision,created_at,updated_at,options_json)| {
            let paths = db.prepare("SELECT relative_path FROM native_library_roots WHERE library_id=?1 ORDER BY position")?.query_map([&id], |r| r.get(0))?.collect::<Result<Vec<String>,_>>()?;
            Ok(NativeLibrary { id,name,library_type: serde_json::from_value(serde_json::Value::String(kind)).map_err(|e| StoreError::Validation(e.to_string()))?,anime_content: serde_json::from_value(serde_json::Value::String(content)).map_err(|e| StoreError::Validation(e.to_string()))?,paths,revision,created_at,updated_at,options: serde_json::from_str(&options_json).map_err(|e| StoreError::Validation(e.to_string()))? })
        }).collect()
    }

    pub fn save_native_library(
        &self,
        id: Option<&str>,
        input: &NativeLibraryInput,
    ) -> Result<NativeLibrary, StoreError> {
        validate(input)?;
        let mut db = self.connection()?;
        let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let id = id
            .map(str::to_owned)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let previous: Option<i64> = tx
            .query_row(
                "SELECT revision FROM native_libraries WHERE id=?1",
                [&id],
                |r| r.get(0),
            )
            .optional()?;
        if previous != input.revision {
            return Err(StoreError::RevisionConflict);
        }
        if previous.is_some() {
            let running:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM native_library_scans WHERE library_id=?1 AND json_extract(status_json,'$.status')='scanning')",[&id],|r|r.get(0))?;
            if running {
                return Err(StoreError::Validation(
                    "Wait for the scan to finish before editing the library.".into(),
                ));
            }
            let (kind, content): (String, String) = tx.query_row(
                "SELECT library_type,anime_content FROM native_libraries WHERE id=?1",
                [&id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            let populated: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM native_library_items WHERE library_id=?1)",
                [&id],
                |r| r.get(0),
            )?;
            if populated
                && (kind != input.library_type.as_str()
                    || (kind == "anime" && content != input.anime_content.as_str()))
            {
                return Err(StoreError::Validation("A populated library needs a catalog review before changing its type or content scope.".into()));
            }
        }
        let duplicate: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM native_libraries WHERE name=?1 COLLATE NOCASE AND id<>?2)",
            params![input.name.trim(), id],
            |r| r.get(0),
        )?;
        if duplicate {
            return Err(StoreError::Validation(
                "A library with that name already exists.".into(),
            ));
        }
        tx.execute("INSERT INTO native_libraries(id,name,library_type,anime_content) VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET name=excluded.name,library_type=excluded.library_type,anime_content=excluded.anime_content,revision=native_libraries.revision+1,updated_at=datetime('now')",params![id,input.name.trim(),input.library_type.as_str(),input.anime_content.as_str()])?;
        tx.execute(
            "UPDATE native_libraries SET options_json=?1 WHERE id=?2",
            params![
                serde_json::to_string(&input.options)
                    .map_err(|e| StoreError::Validation(e.to_string()))?,
                id
            ],
        )?;
        tx.execute(
            "DELETE FROM native_library_roots WHERE library_id=?1",
            [&id],
        )?;
        for (position, path) in input.paths.iter().enumerate() {
            tx.execute("INSERT INTO native_library_roots(library_id,relative_path,position) VALUES(?1,?2,?3)",params![id,path,position as i64])?;
        }
        let (revision, created_at, updated_at) = tx.query_row(
            "SELECT revision,created_at,updated_at FROM native_libraries WHERE id=?1",
            [&id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        let result = NativeLibrary {
            id,
            name: input.name.trim().to_owned(),
            library_type: input.library_type,
            anime_content: input.anime_content,
            paths: input.paths.clone(),
            options: input.options.clone(),
            revision,
            created_at,
            updated_at,
        };
        tx.commit()?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use posterview_contracts::native::{AnimeContent, NativeLibraryType};
    #[test]
    fn catalog_reads_remain_available_during_library_deletion() {
        let dir=tempfile::tempdir().unwrap();let store=ServerStore::new(dir.path());store.initialize().unwrap();
        let input=NativeLibraryInput {name:"Books".into(),library_type:NativeLibraryType::Books,anime_content:AnimeContent::Both,paths:vec!["Books".into()],revision:None,options:Default::default()};
        let saved=store.save_native_library(None,&input).unwrap();
        let mut writer=store.connection().unwrap();let tx=writer.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).unwrap();
        tx.execute("DELETE FROM native_libraries WHERE id=?1",[&saved.id]).unwrap();
        assert_eq!(store.native_libraries().unwrap().len(),1);
        tx.commit().unwrap();assert!(store.native_libraries().unwrap().is_empty());
    }
    #[test]
    fn book_libraries_accept_comicvine_metadata_and_image_orders() {
        let dir = tempfile::tempdir().unwrap();
        let store = ServerStore::new(dir.path());
        store.initialize().unwrap();
        let mut input = NativeLibraryInput {name:"Books".into(),library_type:NativeLibraryType::Books,anime_content:AnimeContent::Both,paths:vec!["Books".into()],revision:None,options:Default::default()};
        input.options.metadata_providers.insert("book_series".into(),vec!["comicvine".into(),"anilist".into(),"mal".into(),"mangadex".into()]);
        input.options.image_providers.insert("book_series".into(),vec!["comicvine".into(),"mal".into()]);
        let saved = store.save_native_library(None,&input).unwrap();
        assert_eq!(saved.options,input.options);
        input.revision = Some(saved.revision);
        input.options.metadata_providers.insert("book_series".into(),vec!["comicvine".into()]);
        let updated = store.save_native_library(Some(&saved.id),&input).unwrap();
        assert_eq!(updated.options.metadata_providers["book_series"],vec!["comicvine"]);
        input.revision = Some(updated.revision);
        input.options.image_providers.insert("book_series".into(),vec!["comicvine".into(),"comicvine".into()]);
        assert!(store.save_native_library(Some(&saved.id),&input).is_err());
    }
    #[test]
    fn library_options_roundtrip_and_reject_invalid_provider_orders() {
        let dir = tempfile::tempdir().unwrap();
        let store = ServerStore::new(dir.path());
        store.initialize().unwrap();
        let mut input = NativeLibraryInput {
            name: "Anime".into(),
            library_type: NativeLibraryType::Anime,
            anime_content: AnimeContent::Both,
            paths: vec!["Anime".into()],
            revision: None,
            options: Default::default(),
        };
        input.options.metadata_language = "ja".into();
        input.options.certification_country = "JP".into();
        input
            .options
            .metadata_providers
            .insert("series".into(), vec!["tmdb".into(), "anilist".into()]);
        input
            .options
            .image_providers
            .insert("series".into(), vec![]);
        let saved = store.save_native_library(None, &input).unwrap();
        assert_eq!(store.native_libraries().unwrap()[0].options, saved.options);
        input
            .options
            .metadata_providers
            .insert("series".into(), vec!["tmdb".into(), "tmdb".into()]);
        assert!(store.save_native_library(None, &input).is_err());
        input.options.metadata_providers.clear();
        input.options.sample_ignore_mb = 10001;
        assert!(store.save_native_library(None, &input).is_err());
        let old: posterview_contracts::native::NativeLibraryOptions =
            serde_json::from_str(r#"{"read_nfo":false}"#).unwrap();
        assert!(!old.read_nfo);
        assert_eq!(old.metadata_language, "en");
    }
    #[test]
    fn upgrade_preserves_settings_and_library_edits_are_atomic() {
        let dir = tempfile::tempdir().unwrap();
        let store = ServerStore::new(dir.path());
        store.initialize().unwrap();
        store.set_setting("existing", "keep").unwrap();
        store.initialize().unwrap();
        let mut input = NativeLibraryInput {
            name: "Anime".into(),
            library_type: NativeLibraryType::Anime,
            anime_content: AnimeContent::Both,
            paths: vec!["Anime/Shows".into(), "Anime/Movies".into()],
            revision: None,
            options: Default::default(),
        };
        let saved = store.save_native_library(None, &input).unwrap();
        assert_eq!(store.get_setting("existing").unwrap(), "keep");
        assert_eq!(store.native_libraries().unwrap()[0], saved);
        assert!(matches!(
            store.save_native_library(Some(&saved.id), &input),
            Err(StoreError::RevisionConflict)
        ));
        input.revision = Some(saved.revision);
        input.paths = vec!["Anime".into(), "Anime/Movies".into()];
        assert!(store.save_native_library(Some(&saved.id), &input).is_err());
        assert_eq!(store.native_libraries().unwrap()[0], saved);
        input.paths = vec!["../outside".into()];
        assert!(store.save_native_library(None, &input).is_err());
        let db = store.connection().unwrap();
        assert!(
            db.execute(
                "INSERT INTO native_library_roots VALUES('missing','path',0)",
                []
            )
            .is_err()
        );
        db.execute(
            "INSERT INTO catalog_items(id,kind,title) VALUES('book','book','Book')",
            [],
        )
        .unwrap();
        db.execute("INSERT INTO catalog_metadata_fields(item_id,field,value_json,source,locked) VALUES('book','title','\"My title\"','manual',1)",[]).unwrap();
        assert!(db.execute("INSERT INTO catalog_metadata_fields(item_id,field,value_json,source) VALUES('book','bad','invalid','manual')",[]).is_err());
        let item = store
            .create_native_catalog_item(&saved.id, "movie", "Movie")
            .unwrap();
        assert!(
            store
                .create_native_catalog_item(&saved.id, "book", "Wrong type")
                .is_err()
        );
        assert!(
            store
                .observe_native_metadata(
                    &item,
                    "synopsis",
                    &serde_json::json!("Provider summary"),
                    "provider:test"
                )
                .unwrap()
        );
        store
            .edit_native_metadata(&item, "synopsis", &serde_json::json!("My summary"), Some(1))
            .unwrap();
        assert!(
            !store
                .observe_native_metadata(
                    &item,
                    "synopsis",
                    &serde_json::json!("Overwrite"),
                    "provider:test"
                )
                .unwrap()
        );
        assert!(matches!(
            store.edit_native_metadata(&item, "synopsis", &serde_json::json!("Stale"), Some(1)),
            Err(StoreError::RevisionConflict)
        ));
        assert_eq!(db.query_row("SELECT value_json FROM catalog_metadata_fields WHERE item_id=?1 AND field='synopsis'",[&item],|r|r.get::<_,String>(0)).unwrap(),"\"My summary\"");
    }
}
