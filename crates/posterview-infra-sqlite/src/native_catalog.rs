use crate::{ServerStore, StoreError};
use posterview_contracts::native::{NativeArtwork, NativeCatalogEntry, NativeScanStatus};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};

fn invalid(message: &str) -> StoreError {
    StoreError::Validation(message.into())
}
impl ServerStore {
    pub fn refresh_local_artwork(&self,library:&str,path:&str)->Result<bool,StoreError> {
        let mut db=self.connection()?;let tx=db.transaction()?;
        let changed=tx.execute("UPDATE catalog_items SET revision=revision+1 WHERE id IN (SELECT a.item_id FROM catalog_artwork a JOIN native_catalog_sources s ON s.item_id=a.item_id WHERE s.library_id=?1 AND s.available=1 AND a.path=?2 AND a.source='local' AND a.locked=0)",params![library,path])?;
        tx.commit()?;
        if changed>0 {self.set_setting(&format!("native-artwork-revision:{library}"),&uuid::Uuid::new_v4().to_string())?;}
        Ok(changed>0)
    }
    pub fn native_nfo_content(&self, path: &str) -> Result<Option<String>, StoreError> {
        Ok(self
            .connection()?
            .query_row(
                "SELECT content_xml FROM catalog_nfo_documents WHERE relative_path=?1",
                [path],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten())
    }

    pub fn record_native_nfo(
        &self,
        library: &str,
        item: &str,
        path: &str,
        xml: &str,
    ) -> Result<(), StoreError> {
        let mut db = self.connection()?;
        let tx = db.transaction()?;
        tx.execute("INSERT INTO catalog_nfo_documents(id,relative_path,profile,parse_status,content_xml) VALUES(?1,?2,'local','parsed',?3) ON CONFLICT(relative_path) DO UPDATE SET content_xml=excluded.content_xml,revision=revision+1,parse_status='parsed'",params![uuid::Uuid::new_v4().to_string(),path,xml])?;
        tx.execute("INSERT OR IGNORE INTO catalog_item_nfo SELECT ?1,id FROM catalog_nfo_documents WHERE relative_path=?2",params![item,path])?;
        tx.execute("UPDATE native_catalog_sources SET snapshot_json=json_set(snapshot_json,'$.nfo_path',?1) WHERE library_id=?2 AND item_id=?3",params![path,library,item])?;
        tx.commit()?;
        Ok(())
    }
    pub fn native_scan_status(&self, library: &str) -> Result<NativeScanStatus, StoreError> {
        let db = self.connection()?;
        let text: Option<String> = db
            .query_row(
                "SELECT status_json FROM native_library_scans WHERE library_id=?1",
                [library],
                |r| r.get(0),
            )
            .optional()?;
        text.map(|v| serde_json::from_str(&v).map_err(|_| invalid("Invalid scan status.")))
            .unwrap_or(Ok(NativeScanStatus {
                status: "not_scanned".into(),
                ..Default::default()
            }))
    }
    pub fn begin_native_scan(&self, library: &str) -> Result<(), StoreError> {self.request_native_scan(library,false).map(|_|())}
    pub fn request_native_scan(&self, library: &str, manual:bool) -> Result<bool, StoreError> {
        let mut db = self.connection()?;
        let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM native_libraries WHERE id=?1)",
            [library],
            |r| r.get(0),
        )?;
        if !exists {
            return Err(invalid("Library not found."));
        }
        let running: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM native_library_scans WHERE library_id=?1 AND json_extract(status_json,'$.status')='scanning')",[library],|r|r.get(0))?;
        if running {
            if manual {tx.execute("UPDATE native_library_scans SET status_json=json_set(status_json,'$.manual_queued',1) WHERE library_id=?1",[library])?;tx.commit()?;return Ok(false);}
            return Err(invalid("This library is already scanning."));
        }
        tx.execute("INSERT INTO native_library_scans VALUES(?1,?2) ON CONFLICT(library_id) DO UPDATE SET status_json=excluded.status_json",params![library,json!({"status":"scanning","count":0,"warnings":[]}).to_string()])?;
        tx.commit()?;
        Ok(true)
    }
    pub fn update_native_scan_progress(
        &self,
        library: &str,
        status: &NativeScanStatus,
    ) -> Result<(), StoreError> {
        self.connection()?.execute("UPDATE native_library_scans SET status_json=json_set(?1,'$.manual_queued',COALESCE(json_extract(status_json,'$.manual_queued'),0)) WHERE library_id=?2 AND json_extract(status_json,'$.status')='scanning'", params![serde_json::to_string(status).map_err(|_| invalid("Invalid status."))?, library])?;
        Ok(())
    }
    pub fn finish_native_scan(
        &self,
        library: &str,
        status: &NativeScanStatus,
    ) -> Result<(), StoreError> {
        self.connection()?.execute(
            "UPDATE native_library_scans SET status_json=json_set(?1,'$.manual_queued',COALESCE(json_extract(status_json,'$.manual_queued'),0)) WHERE library_id=?2",
            params![
                serde_json::to_string(status).map_err(|_| invalid("Invalid status."))?,
                library
            ],
        )?;
        Ok(())
    }
    pub fn manual_scan_queued(&self,library:&str)->Result<bool,StoreError>{self.connection()?.query_row("SELECT COALESCE(json_extract(status_json,'$.manual_queued'),0) FROM native_library_scans WHERE library_id=?1",[library],|r|r.get(0)).optional().map(|v|v.unwrap_or(false)).map_err(Into::into)}
    pub fn finish_or_restart_native_scan(&self,library:&str,status:&NativeScanStatus)->Result<bool,StoreError>{
        let mut db=self.connection()?;let tx=db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let queued=tx.query_row("SELECT COALESCE(json_extract(status_json,'$.manual_queued'),0) FROM native_library_scans WHERE library_id=?1",[library],|r|r.get::<_,bool>(0)).optional()?.unwrap_or(false);
        let value=if queued {json!({"status":"scanning","count":0,"warnings":[],"manual_queued":0}).to_string()}else{serde_json::to_string(status).map_err(|_|invalid("Invalid status."))?};
        tx.execute("UPDATE native_library_scans SET status_json=?1 WHERE library_id=?2",params![value,library])?;tx.commit()?;Ok(queued)
    }
    pub fn recover_native_scans(&self) -> Result<(), StoreError> {
        self.connection()?.execute("UPDATE native_library_scans SET status_json=?1 WHERE json_extract(status_json,'$.status')='scanning'",[json!({"status":"interrupted","count":0,"warnings":["Scan interrupted by a restart. Scan again to continue."]}).to_string()])?;
        Ok(())
    }
    pub fn delete_native_library(&self, library: &str, revision: i64) -> Result<(), StoreError> {
        let mut db = self.connection()?;
        let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let current: Option<i64> = tx
            .query_row(
                "SELECT revision FROM native_libraries WHERE id=?1",
                [library],
                |r| r.get(0),
            )
            .optional()?;
        if current != Some(revision) {
            return Err(StoreError::RevisionConflict);
        }
        let running: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM native_library_scans WHERE library_id=?1 AND json_extract(status_json,'$.status')='scanning')",[library],|r|r.get(0))?;
        if running {
            return Err(invalid(
                "Wait for the scan to finish before deleting the library.",
            ));
        }
        // Children first because catalog hierarchy uses RESTRICT, not cascade.
        tx.execute("UPDATE catalog_items SET parent_id=NULL WHERE id IN (SELECT item_id FROM native_catalog_sources WHERE library_id=?1)",[library])?;
        tx.execute("DELETE FROM catalog_items WHERE id IN (SELECT item_id FROM native_catalog_sources WHERE library_id=?1)",[library])?;
        tx.execute("DELETE FROM native_libraries WHERE id=?1", [library])?;
        tx.execute(
            "DELETE FROM catalog_files WHERE id NOT IN (SELECT file_id FROM catalog_item_files)",
            [],
        )?;
        tx.execute("DELETE FROM catalog_nfo_documents WHERE id NOT IN (SELECT document_id FROM catalog_item_nfo)",[])?;
        tx.commit()?;
        Ok(())
    }
    /// Fetch one artwork record without deserializing the library's metadata or files.
    pub fn native_artwork(
        &self,
        library: &str,
        item: &str,
        kind: &str,
    ) -> Result<Option<NativeArtwork>, StoreError> {
        self.connection()?.query_row(
            "SELECT a.kind,a.path,a.source FROM catalog_artwork a JOIN native_catalog_sources s ON s.item_id=a.item_id WHERE s.library_id=?1 AND s.item_id=?2 AND a.kind=?3 AND s.available=1",
            params![library,item,kind],
            |r| Ok(NativeArtwork { kind:r.get(0)?, path:r.get(1)?, source:r.get(2)? }),
        ).optional().map_err(Into::into)
    }

    pub fn native_catalog(&self, library: &str) -> Result<Vec<NativeCatalogEntry>, StoreError> {
        self.native_catalog_scoped(library, None)
    }
    pub fn native_available_count(&self, library: &str) -> Result<usize, StoreError> {
        self.connection()?.query_row("SELECT COUNT(*) FROM native_catalog_sources WHERE library_id=?1 AND available=1", [library], |r|r.get(0)).map_err(Into::into)
    }
    pub fn native_catalog_scoped(&self, library: &str, scopes: Option<&[String]>) -> Result<Vec<NativeCatalogEntry>, StoreError> {
        let scopes = scopes.map(serde_json::to_string).transpose().map_err(|_|invalid("Invalid scan scope."))?;
        let mut db = self.connection()?;
        let tx = db.transaction()?;
        let mut stmt = tx.prepare("SELECT s.snapshot_json,s.item_id,s.available,i.revision FROM native_catalog_sources s JOIN catalog_items i ON i.id=s.item_id WHERE s.library_id=?1 AND (?2 IS NULL OR EXISTS(SELECT 1 FROM json_each(?2) scope WHERE scope.value='' OR s.relative_path=scope.value OR substr(s.relative_path,1,length(scope.value)+1)=scope.value||'/')) ORDER BY i.sort_title,i.title")?;
        let rows = stmt
            .query_map(params![library,scopes], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, bool>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut result = Vec::new();
        let mut metadata = std::collections::HashMap::<String, Vec<(String, String, bool)>>::new();
        let mut images = std::collections::HashMap::<String, Vec<NativeArtwork>>::new();
        // Read related records in batches instead of executing three queries per item.
        let mut fields = tx.prepare("SELECT f.item_id,f.field,f.value_json,f.locked FROM catalog_metadata_fields f JOIN native_catalog_sources s ON s.item_id=f.item_id WHERE s.library_id=?1 AND (?2 IS NULL OR EXISTS(SELECT 1 FROM json_each(?2) scope WHERE scope.value='' OR s.relative_path=scope.value OR substr(s.relative_path,1,length(scope.value)+1)=scope.value||'/'))")?;
        for row in fields.query_map(params![library,scopes], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,bool>(3)?)))? {
            let (id, field, value, locked) = row?;
            metadata.entry(id).or_default().push((field, value, locked));
        }
        let mut artwork = tx.prepare("SELECT a.item_id,a.kind,a.path,a.source FROM catalog_artwork a JOIN native_catalog_sources s ON s.item_id=a.item_id WHERE s.library_id=?1 AND (?2 IS NULL OR EXISTS(SELECT 1 FROM json_each(?2) scope WHERE scope.value='' OR s.relative_path=scope.value OR substr(s.relative_path,1,length(scope.value)+1)=scope.value||'/')) ORDER BY a.kind")?;
        for row in artwork.query_map(params![library,scopes], |r| Ok((r.get::<_,String>(0)?, NativeArtwork {kind:r.get(1)?,path:r.get(2)?,source:r.get(3)?})))? {
            let (id, image) = row?;
            images.entry(id).or_default().push(image);
        }
        for (snapshot, id, available, revision) in rows {
            let mut entry: NativeCatalogEntry =
                serde_json::from_str(&snapshot).map_err(|_| invalid("Invalid catalog record."))?;
            entry.id = id.clone();
            entry.available = available;
            entry.revision = revision;
            entry.metadata = json!({});
            entry.metadata["_title_locked"] = json!(false);
            for (field, value, locked) in metadata.remove(&id).unwrap_or_default() {
                if field == "title" { entry.metadata["_title_locked"] = json!(locked); }
                entry.metadata[&field] = serde_json::from_str(&value).map_err(|_| invalid("Invalid metadata value."))?;
            }
            entry.title = entry.metadata["title"]
                .as_str()
                .unwrap_or(&entry.title)
                .into();
            entry.artwork = images.remove(&id).unwrap_or_default();
            result.push(entry);
        }
        Ok(result)
    }
    pub fn ingest_native_catalog(
        &self,
        library: &str,
        revision: i64,
        entries: &[NativeCatalogEntry],
    ) -> Result<(), StoreError> {
        self.ingest_native_catalog_scoped(library, revision, entries, None)
    }
    /// Reconcile only these media-relative subtrees; unrelated records are untouched.
    pub fn ingest_native_catalog_scoped(
        &self, library: &str, revision: i64, entries: &[NativeCatalogEntry], scopes: Option<&[String]>,
    ) -> Result<(), StoreError> {
        if let Some(scopes) = scopes {
            if entries.iter().any(|e| !scopes.iter().any(|scope| scope.is_empty() || e.path == *scope || e.path.starts_with(&format!("{scope}/")))) {
                return Err(invalid("Catalog entry is outside the scan scope."));
            }
        }
        let mut db = self.connection()?;
        let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let current: i64 = tx.query_row(
            "SELECT revision FROM native_libraries WHERE id=?1",
            [library],
            |r| r.get(0),
        )?;
        if current != revision {
            return Err(StoreError::RevisionConflict);
        }
        if let Some(scopes) = scopes {
            for scope in scopes {
                tx.execute("UPDATE native_catalog_sources SET available=0 WHERE library_id=?1 AND (?2='' OR relative_path=?2 OR substr(relative_path,1,length(?2)+1)=?2||'/')", params![library,scope])?;
            }
        } else {
            tx.execute("UPDATE native_catalog_sources SET available=0 WHERE library_id=?1", [library])?;
        }
        for entry in entries {
            let existing:Option<String>=tx.query_row("SELECT item_id FROM native_catalog_sources WHERE library_id=?1 AND relative_path=?2",params![library,entry.path],|r|r.get(0)).optional()?;
            // Promote a numbered placeholder into the real file while retaining its artwork and ID.
            let existing = if existing.is_none() && entry.kind == "book" && entry.metadata["missing"] != true {
                let key = if !entry.metadata["chapter"].is_null() && entry.metadata["volume"].is_null() {"chapter"} else {"volume"};
                let n = entry.metadata[key].as_u64().or_else(||entry.metadata[key].as_str().and_then(|v|v.parse().ok()));
                if let (Some(parent),Some(n)) = (&entry.parent_path,n) {
                    let path = format!("{parent}/@missing-{key}-{n}");
                    let id:Option<String> = tx.query_row("SELECT item_id FROM native_catalog_sources WHERE library_id=?1 AND relative_path=?2",params![library,path],|r|r.get(0)).optional()?;
                    if let Some(id) = &id {
                        tx.execute("DELETE FROM native_catalog_sources WHERE library_id=?1 AND relative_path=?2",params![library,path])?;
                        tx.execute("DELETE FROM catalog_metadata_fields WHERE item_id=?1 AND field IN ('missing','title') AND locked=0",[id])?;
                    }
                    id
                } else {None}
            } else {existing};
            let id = existing.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let mut snapshot = entry.clone();
            snapshot.id = id.clone();
            snapshot.nfo_xml = None;
            tx.execute("INSERT INTO catalog_items(id,kind,title) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET revision=revision+1",params![id,entry.kind,entry.title])?;
            tx.execute(
                "INSERT OR IGNORE INTO native_library_items VALUES(?1,?2)",
                params![library, id],
            )?;
            tx.execute("INSERT INTO native_catalog_sources VALUES(?1,?2,?3,?4,1) ON CONFLICT(library_id,relative_path) DO UPDATE SET snapshot_json=excluded.snapshot_json,available=1",params![library,entry.path,id,serde_json::to_string(&snapshot).map_err(|_|invalid("Invalid snapshot."))?])?;
            if let Some(fields) = entry.metadata.as_object() {
                for (field, value) in fields {
                    if field.starts_with('_') || value.is_null() {
                        continue;
                    }
                    let source = entry.metadata["_sources"][field]
                        .as_str()
                        .unwrap_or("filename");
                    tx.execute("INSERT INTO catalog_metadata_fields(item_id,field,value_json,source) VALUES(?1,?2,?3,?4) ON CONFLICT(item_id,field) DO UPDATE SET value_json=excluded.value_json,source=excluded.source,revision=revision+1 WHERE locked=0 AND source<>'server' AND (source<>'manual' OR field='title') AND (excluded.source='nfo' OR source<>'nfo' OR json_type(value_json)='null' OR value_json IN ('[]','{}') OR (json_type(value_json)='text' AND trim(json_extract(value_json,'$'))=''))",params![id,field,value.to_string(),source])?;
                }
            }
            let effective: Value = {
                let mut fields = tx.prepare(
                    "SELECT field,value_json FROM catalog_metadata_fields WHERE item_id=?1",
                )?;
                let mut values = json!({});
                for row in fields.query_map([&id], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })? {
                    let (field, value) = row?;
                    values[&field] =
                        serde_json::from_str(&value).map_err(|_| invalid("Invalid metadata."))?;
                }
                values
            };
            tx.execute("UPDATE catalog_items SET title=?1,original_title=?2,sort_title=?3,synopsis=?4,year=?5 WHERE id=?6",params![effective["title"].as_str().unwrap_or(&entry.title),effective["originaltitle"].as_str(),effective["sorttitle"].as_str(),effective["plot"].as_str(),effective["year"].as_i64(),id])?;
            project_metadata(&tx, &id, &effective)?;
            tx.execute("DELETE FROM catalog_artwork WHERE item_id=?1 AND locked=0 AND NOT EXISTS(SELECT 1 FROM json_each(?2) a WHERE json_extract(a.value,'$.kind')=catalog_artwork.kind AND json_extract(a.value,'$.path')=catalog_artwork.path)",params![id,serde_json::to_string(&entry.artwork).map_err(|_|invalid("Invalid artwork records."))?])?;
            for art in &entry.artwork {
                tx.execute("INSERT INTO catalog_artwork VALUES(?1,?2,?3,?4,0) ON CONFLICT(item_id,kind) DO UPDATE SET path=excluded.path,source=excluded.source WHERE locked=0 AND (excluded.source='local' OR source<>'local')",params![id,art.kind,art.path,art.source])?;
            }
            tx.execute("DELETE FROM catalog_item_files WHERE item_id=?1", [&id])?;
            for file in &entry.files {
                let path = file["path"]
                    .as_str()
                    .ok_or_else(|| invalid("Missing file path."))?;
                tx.execute("INSERT INTO catalog_files(id,relative_path,size_bytes,modified_at) VALUES(?1,?2,?3,?4) ON CONFLICT(relative_path) DO UPDATE SET size_bytes=excluded.size_bytes,modified_at=excluded.modified_at,available=1",params![uuid::Uuid::new_v4().to_string(),path,file["size"].as_i64(),file["modified"].as_str()])?;
                tx.execute("INSERT INTO catalog_item_files SELECT ?1,id FROM catalog_files WHERE relative_path=?2",params![id,path])?;
                if let Some(streams) = file["media_info"]["streams"].as_array() {
                    tx.execute("DELETE FROM catalog_media_streams WHERE file_id=(SELECT id FROM catalog_files WHERE relative_path=?1)",[path])?;
                    for stream in streams {
                        if let (Some(index), Some(kind)) =
                            (stream["index"].as_i64(), stream["codec_type"].as_str())
                        {
                            if ["video", "audio", "subtitle"].contains(&kind) {
                                tx.execute("INSERT INTO catalog_media_streams SELECT id,?1,?2,?3 FROM catalog_files WHERE relative_path=?4",params![index,kind,stream.to_string(),path])?;
                            }
                        }
                    }
                }
            }
            if let Some(path) = &entry.nfo_path {
                tx.execute("INSERT INTO catalog_nfo_documents(id,relative_path,profile,parse_status) VALUES(?1,?2,?3,'parsed') ON CONFLICT(relative_path) DO UPDATE SET revision=revision+1,parse_status='parsed'",params![uuid::Uuid::new_v4().to_string(),path,if entry.kind.starts_with("book") {"posterview-book"} else {"video"}])?;
                tx.execute(
                    "UPDATE catalog_nfo_documents SET content_xml=?1 WHERE relative_path=?2",
                    params![entry.nfo_xml, path],
                )?;
                tx.execute("INSERT OR IGNORE INTO catalog_item_nfo SELECT ?1,id FROM catalog_nfo_documents WHERE relative_path=?2",params![id,path])?;
            }
        }
        for entry in entries {
            tx.execute("UPDATE catalog_items SET parent_id=(SELECT item_id FROM native_catalog_sources WHERE library_id=?1 AND relative_path=?2) WHERE id=(SELECT item_id FROM native_catalog_sources WHERE library_id=?1 AND relative_path=?3)",params![library,entry.parent_path,entry.path])?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn edit_native_entry(
        &self,
        library: &str,
        item: &str,
        revision: i64,
        fields: &Value,
    ) -> Result<(), StoreError> {
        let fields = fields
            .as_object()
            .ok_or_else(|| invalid("Metadata must be an object."))?;
        if fields.get("title").is_some_and(|v| {
            v.as_str()
                .is_none_or(|v| v.trim().is_empty() || v.len() > 512)
        }) {
            return Err(invalid("Choose a title of 1–512 characters."));
        }
        for field in ["genres", "tags", "studios", "publishers"] {
            if let Some(value) = fields.get(field) {
                if !value
                    .as_array()
                    .is_some_and(|v| v.iter().all(|v| v.as_str().is_some()))
                {
                    return Err(invalid(
                        "Genres, tags, studios, and publishers must be lists of names.",
                    ));
                }
            }
        }
        if let Some(credits) = fields.get("credits") {
            if !credits.as_array().is_some_and(|v| {
                v.iter().all(|c| {
                    c["name"].as_str().is_some_and(|v| !v.trim().is_empty())
                        && ["cast", "crew", "voice", "author", "illustrator", "narrator"]
                            .contains(&c["category"].as_str().unwrap_or("cast"))
                })
            }) {
                return Err(invalid(
                    "Each credit needs a name and a supported category.",
                ));
            }
        }
        if fields.len() > 100 || fields.contains_key("_sources") {
            return Err(invalid("Invalid metadata fields."));
        }
        let mut db = self.connection()?;
        let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let current:Option<i64>=tx.query_row("SELECT i.revision FROM catalog_items i JOIN native_catalog_sources s ON s.item_id=i.id WHERE s.library_id=?1 AND i.id=?2",params![library,item],|r|r.get(0)).optional()?;
        if current != Some(revision) {
            return Err(StoreError::RevisionConflict);
        }
        let title_lock=fields.get("_title_locked").map(|v|v.as_bool().ok_or_else(||invalid("Title lock must be true or false."))).transpose()?;
        if let Some(locked)=title_lock {tx.execute("UPDATE catalog_metadata_fields SET locked=?2,source=CASE WHEN ?2=1 THEN 'manual' WHEN source='manual' THEN 'filename' ELSE source END WHERE item_id=?1 AND field='title'",params![item,i64::from(locked)])?;}
        for (field, value) in fields {
            if field=="_title_locked" {continue;}
            let previous: Option<String> = tx
                .query_row(
                    "SELECT value_json FROM catalog_metadata_fields WHERE item_id=?1 AND field=?2",
                    params![item, field],
                    |r| r.get(0),
                )
                .optional()?;
            if previous.as_deref() == Some(value.to_string().as_str()) {
                continue;
            }
            if field.starts_with('_') || field.len() > 80 || value.to_string().len() > 200_000 {
                return Err(invalid("Invalid metadata field."));
            }
            tx.execute("INSERT INTO catalog_metadata_fields(item_id,field,value_json,source,locked) VALUES(?1,?2,?3,'manual',1) ON CONFLICT(item_id,field) DO UPDATE SET value_json=excluded.value_json,source='manual',locked=1,revision=revision+1",params![item,field,value.to_string()])?;
        }
        if let Some(locked)=title_lock {tx.execute("UPDATE catalog_metadata_fields SET locked=?2 WHERE item_id=?1 AND field='title'",params![item,i64::from(locked)])?;}
        let mut effective = json!({});
        {
            let mut stmt = tx
                .prepare("SELECT field,value_json FROM catalog_metadata_fields WHERE item_id=?1")?;
            for row in stmt.query_map([item], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })? {
                let (field, value) = row?;
                effective[&field] =
                    serde_json::from_str(&value).map_err(|_| invalid("Invalid metadata."))?;
            }
        }
        project_metadata(&tx, item, &effective)?;
        tx.execute("UPDATE catalog_items SET title=COALESCE(?1,title),sort_title=?2,synopsis=?3,year=?4,revision=revision+1 WHERE id=?5",params![effective["title"].as_str(),effective["sorttitle"].as_str(),effective["plot"].as_str(),effective["year"].as_i64(),item])?;
        tx.commit()?;
        Ok(())
    }
    /// Apply only selected shared fields, respecting field locks and optimistic revisions.
    pub fn sync_native_metadata(&self, library:&str, item:&str, revision:i64, fields:&Value, override_locked:bool) -> Result<(),StoreError> {
        let mut db=self.connection()?;
        let tx=db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let current:Option<i64>=tx.query_row("SELECT i.revision FROM catalog_items i JOIN native_catalog_sources s ON s.item_id=i.id WHERE s.library_id=?1 AND i.id=?2 AND s.available=1",params![library,item],|r|r.get(0)).optional()?;
        if current!=Some(revision) {return Err(StoreError::RevisionConflict);}
        let mut changed=false;
        for (field,value) in fields.as_object().ok_or_else(||invalid("Invalid shared metadata."))? {
            if field.starts_with('_') || field.len()>80 || value.to_string().len()>200_000 {return Err(invalid("Invalid shared metadata field."));}
            if field=="title" && value.as_str().is_none_or(|v|v.trim().is_empty()) {continue;}
            let previous:Option<(String,bool)>=tx.query_row("SELECT value_json,locked FROM catalog_metadata_fields WHERE item_id=?1 AND field=?2",params![item,field],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
            if previous.as_ref().is_some_and(|(_,locked)|*locked && !override_locked) {continue;}
            if previous.as_ref().is_some_and(|(v,_)|v==&value.to_string()) {
                tx.execute("UPDATE catalog_metadata_fields SET source='server' WHERE item_id=?1 AND field=?2",params![item,field])?;
                continue;
            }
            tx.execute("INSERT INTO catalog_metadata_fields(item_id,field,value_json,source,locked) VALUES(?1,?2,?3,'server',0) ON CONFLICT(item_id,field) DO UPDATE SET value_json=excluded.value_json,source='server',revision=revision+1",params![item,field,value.to_string()])?;
            changed=true;
        }
        if changed {
            let mut effective=json!({});
            {let mut stmt=tx.prepare("SELECT field,value_json FROM catalog_metadata_fields WHERE item_id=?1")?;
            for row in stmt.query_map([item],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))? {let (field,value)=row?;effective[&field]=serde_json::from_str(&value).map_err(|_|invalid("Invalid metadata."))?;}}
            project_metadata(&tx,item,&effective)?;
            tx.execute("UPDATE catalog_items SET title=COALESCE(?1,title),sort_title=?2,synopsis=?3,year=?4,revision=revision+1 WHERE id=?5",params![effective["title"].as_str(),effective["sorttitle"].as_str(),effective["plot"].as_str(),effective["year"].as_i64(),item])?;
        }
        tx.commit()?;Ok(())
    }
    pub fn remove_native_artwork(&self, library: &str, item: &str, kind: &str) -> Result<(), StoreError> {
        let mut db = self.connection()?;
        let tx = db.transaction()?;
        let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM native_catalog_sources WHERE library_id=?1 AND item_id=?2)",params![library,item],|r|r.get(0))?;
        if !exists { return Err(invalid("Catalog item not found.")); }
        tx.execute("DELETE FROM catalog_artwork WHERE item_id=?1 AND kind=?2",params![item,kind])?;
        tx.execute("UPDATE catalog_items SET revision=revision+1 WHERE id=?1",[item])?;
        tx.commit()?;
        Ok(())
    }
    pub fn save_native_artwork(
        &self,
        library: &str,
        item: &str,
        art: &NativeArtwork,
    ) -> Result<(), StoreError> {
        let mut db = self.connection()?;
        let tx = db.transaction()?;
        let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM native_catalog_sources WHERE library_id=?1 AND item_id=?2)",params![library,item],|r|r.get(0))?;
        if !exists {
            return Err(invalid("Catalog item not found."));
        }
        tx.execute("INSERT INTO catalog_artwork VALUES(?1,?2,?3,'manual',1) ON CONFLICT(item_id,kind) DO UPDATE SET path=excluded.path,source='manual',locked=1",params![item,art.kind,art.path])?;
        // A deliberate poster/logo replacement must not inherit an old logo layer.
        // Backups and server imports leave PosterView's visual preferences intact.
        if art.source == "manual" && ["poster", "poster-animated", "logo", "logo-animated"].contains(&art.kind.as_str()) {
            tx.execute("UPDATE catalog_metadata_fields SET value_json='null',source='manual',locked=1,revision=revision+1 WHERE item_id=?1 AND field IN ('posteredit','poseredit')", [item])?;
        }

        tx.execute(
            "UPDATE catalog_items SET revision=revision+1 WHERE id=?1",
            [item],
        )?;
        tx.commit()?;
        Ok(())
    }
    /// Explicit identification replaces old provider IDs and invalidates derived data atomically.
    pub fn identify_native_entry(&self, library:&str, item:&str, revision:i64, title:&str, year:Option<i64>, identifiers:&Value) -> Result<(),StoreError> {
        let mut db=self.connection()?;let tx=db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let current:Option<i64>=tx.query_row("SELECT i.revision FROM catalog_items i JOIN native_catalog_sources s ON s.item_id=i.id WHERE s.library_id=?1 AND i.id=?2 AND s.available=1",params![library,item],|r|r.get(0)).optional()?;
        if current!=Some(revision){return Err(StoreError::RevisionConflict);}
        let scanning:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM native_library_scans WHERE library_id=?1 AND json_extract(status_json,'$.status')='scanning')",[library],|r|r.get(0))?;
        if scanning{return Err(invalid("Wait for the library scan to finish before identifying an item."));}
        // A corrected root invalidates automatically identified seasons and episodes too.
        let mut stmt=tx.prepare("WITH RECURSIVE children(id) AS (SELECT ?1 UNION SELECT i.id FROM catalog_items i JOIN children c ON i.parent_id=c.id) SELECT id FROM children")?;
        let affected=stmt.query_map([item],|r|r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;drop(stmt);
        for id in &affected {
            tx.execute("DELETE FROM catalog_metadata_fields WHERE item_id=?1 AND (source IN ('anilist','tmdb','tvdb','mal','anidb','jikan','omdb','fanart') OR field IN ('anilist_data','tmdb_data','tvdb_data','mal_data','anidb_data','jikan_data','jikan_checked','jikan_retry_after','voice_cast_schema'))",[id])?;
            tx.execute("DELETE FROM catalog_artwork WHERE item_id=?1 AND source NOT IN ('manual','local')",[id])?;
        }
        tx.execute("INSERT INTO catalog_metadata_fields(item_id,field,value_json,source,locked) VALUES(?1,'identifiers',?2,'manual',1) ON CONFLICT(item_id,field) DO UPDATE SET value_json=excluded.value_json,source='manual',locked=1,revision=revision+1",params![item,identifiers.to_string()])?;
        for (field,value) in [("title",json!(title))].into_iter().chain(year.map(|y|("year",json!(y)))) {
            tx.execute("INSERT INTO catalog_metadata_fields(item_id,field,value_json,source,locked) VALUES(?1,?2,?3,'filename',0) ON CONFLICT(item_id,field) DO UPDATE SET value_json=excluded.value_json,source=CASE WHEN locked=1 THEN source ELSE 'filename' END,revision=revision+1",params![item,field,value.to_string()])?;
        }
        tx.execute("UPDATE catalog_items SET title=?2,sort_title=lower(?2) WHERE id=?1",params![item,title])?;
        for id in affected {
            let mut effective=json!({});let mut fields=tx.prepare("SELECT field,value_json FROM catalog_metadata_fields WHERE item_id=?1")?;
            for row in fields.query_map([&id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))? {let(field,value)=row?;effective[field]=serde_json::from_str(&value).map_err(|_|invalid("Invalid metadata."))?;}
            drop(fields);project_metadata(&tx,&id,&effective)?;
            tx.execute("UPDATE catalog_items SET revision=revision+1 WHERE id=?1",[id])?;
        }
        tx.commit()?;Ok(())
    }

}
fn project_metadata(
    tx: &rusqlite::Transaction<'_>,
    id: &str,
    fields: &Value,
) -> Result<(), StoreError> {
    tx.execute("DELETE FROM catalog_item_terms WHERE item_id=?1", [id])?;
    for (field, kind) in [
        ("genres", "genre"),
        ("tags", "tag"),
        ("studios", "studio"),
        ("publishers", "publisher"),
    ] {
        if let Some(values) = fields[field].as_array() {
            for name in values.iter().filter_map(Value::as_str) {
                tx.execute(
                    "INSERT OR IGNORE INTO catalog_terms VALUES(?1,?2,?3)",
                    params![uuid::Uuid::new_v4().to_string(), kind, name],
                )?;
                tx.execute("INSERT OR IGNORE INTO catalog_item_terms SELECT ?1,id FROM catalog_terms WHERE kind=?2 AND name=?3",params![id,kind,name])?;
            }
        }
    }
    tx.execute("DELETE FROM catalog_identifiers WHERE item_id=?1", [id])?;
    if let Some(ids) = fields["identifiers"].as_object() {
        for (provider, value) in ids {
            let value = value
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| value.to_string());
            tx.execute(
                "INSERT OR IGNORE INTO catalog_identifiers VALUES(?1,?2,'media',?3)",
                params![id, provider, value],
            )?;
        }
    }
    tx.execute("DELETE FROM catalog_credits WHERE item_id=?1", [id])?;
    if let Some(credits) = fields["credits"].as_array() {
        for (position, credit) in credits.iter().enumerate() {
            let Some(name) = credit["name"].as_str() else {
                continue;
            };
            let person = if let (Some(provider), Some(provider_id)) =
                (credit["provider"].as_str(), credit.get("provider_id"))
            {
                format!(
                    "{provider}:{}",
                    provider_id
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| provider_id.to_string())
                )
            } else {
                let existing:Option<String>=tx.query_row("SELECT id FROM catalog_people WHERE name=?1 AND id NOT LIKE 'anilist:%' AND id NOT LIKE 'tmdb:%'",[name],|r|r.get(0)).optional()?;
                existing.unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
            };
            tx.execute("INSERT INTO catalog_people(id,name,image_path) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET name=excluded.name,image_path=COALESCE(excluded.image_path,image_path)",params![person,name,credit["image"].as_str()])?;
            tx.execute("INSERT INTO catalog_credits(id,item_id,person_id,category,role,position) VALUES(?1,?2,?3,?4,?5,?6)",params![uuid::Uuid::new_v4().to_string(),id,person,credit["category"].as_str().unwrap_or("cast"),credit["role"].as_str().unwrap_or(""),position as i64])?;
        }
    }
    tx.execute(
        "DELETE FROM catalog_character_appearances WHERE item_id=?1",
        [id],
    )?;
    if let Some(characters) = fields["characters"].as_array() {
        for character in characters {
            let Some(name) = character["name"].as_str() else {
                continue;
            };
            let char_id = character["id"]
                .as_str()
                .map(|v| format!("{}:{v}", if character["provider"] == "jikan" { "mal" } else { "anilist" }))
                .unwrap_or_else(|| format!("name:{name}"));
            tx.execute("INSERT INTO catalog_characters VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET name=excluded.name,biography=excluded.biography,image_path=excluded.image_path",params![char_id,name,character["biography"].as_str(),character["image"].as_str()])?;
            tx.execute("INSERT OR IGNORE INTO catalog_character_appearances(item_id,character_id,role) VALUES(?1,?2,?3)",params![id,char_id,character["role"].as_str().unwrap_or("")])?;
            tx.execute("UPDATE catalog_credits SET character_id=?1 WHERE item_id=?2 AND category='voice' AND role=?3",params![char_id,id,name])?;
        }
    }
    if let Some(episode) = fields["episode"].as_i64() {
        tx.execute("INSERT OR REPLACE INTO catalog_episode_numbers(item_id,scheme,season_number,episode_number) VALUES(?1,'aired',?2,?3)",params![id,fields["season"].as_i64(),episode])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests{
    use super::*;
    use posterview_contracts::native::{NativeLibraryInput,NativeLibraryType,AnimeContent};
    #[test]
    fn manual_scan_requests_queue_once_and_survive_progress_updates() {
        let temp=tempfile::tempdir().unwrap();let db=ServerStore::new(temp.path());db.initialize().unwrap();
        let library=db.save_native_library(None,&NativeLibraryInput{name:"Anime".into(),library_type:NativeLibraryType::Anime,anime_content:AnimeContent::Both,paths:vec!["Anime".into()],revision:None,options:Default::default()}).unwrap();
        assert!(db.request_native_scan(&library.id,false).unwrap());
        assert!(!db.request_native_scan(&library.id,true).unwrap());assert!(!db.request_native_scan(&library.id,true).unwrap());
        let progress=NativeScanStatus{status:"scanning".into(),count:12,warnings:vec![],progress:None};db.update_native_scan_progress(&library.id,&progress).unwrap();db.finish_native_scan(&library.id,&progress).unwrap();assert!(db.manual_scan_queued(&library.id).unwrap());
        let complete=NativeScanStatus{status:"complete".into(),..progress};assert!(db.finish_or_restart_native_scan(&library.id,&complete).unwrap());assert!(!db.manual_scan_queued(&library.id).unwrap());assert_eq!(db.native_scan_status(&library.id).unwrap().status,"scanning");
        assert!(!db.finish_or_restart_native_scan(&library.id,&complete).unwrap());assert_eq!(db.native_scan_status(&library.id).unwrap().status,"complete");
    }
    #[test]
    fn replacing_poster_artwork_clears_overlays_but_backups_and_server_imports_preserve_them() {
        let temp=tempfile::tempdir().unwrap();let db=ServerStore::new(temp.path());db.initialize().unwrap();
        let library=db.save_native_library(None,&NativeLibraryInput{name:"Anime".into(),library_type:NativeLibraryType::Anime,anime_content:AnimeContent::Both,paths:vec!["Anime".into()],revision:None,options:Default::default()}).unwrap();
        let entry=NativeCatalogEntry{id:String::new(),path:"Anime/Test".into(),kind:"series".into(),parent_path:None,title:"Test".into(),metadata:json!({"title":"Test","plot":"Keep this"}),artwork:vec![],files:vec![],nfo_path:None,nfo_xml:None,available:true,revision:1};
        db.ingest_native_catalog(&library.id,library.revision,&[entry]).unwrap();
        for (kind,source,cleared) in [("poster-edit-original","manual",false),("backdrop","manual",false),("poster","server",false),("poster","manual",true),("poster-animated","manual",true),("logo","manual",true)] {
            let entry=db.native_catalog(&library.id).unwrap().remove(0);
            db.edit_native_entry(&library.id,&entry.id,entry.revision,&json!({"posteredit":{"enabled":true,"mode":"overlay"},"poseredit":{"enabled":true}})).unwrap();
            db.save_native_artwork(&library.id,&entry.id,&NativeArtwork{kind:kind.into(),path:format!("{kind}.png"),source:source.into()}).unwrap();
            let after=db.native_catalog(&library.id).unwrap().remove(0);
            assert_eq!(after.metadata["posteredit"].is_null(),cleared,"{kind}/{source}");
            assert_eq!(after.metadata["poseredit"].is_null(),cleared);
            assert_eq!(after.metadata["plot"],"Keep this");
        }
    }
    #[test]
    fn identify_resets_provider_data_and_preserves_local_values_atomically(){
        let temp=tempfile::tempdir().unwrap();let db=ServerStore::new(temp.path());db.initialize().unwrap();
        let library=db.save_native_library(None,&NativeLibraryInput{name:"Anime".into(),library_type:NativeLibraryType::Anime,anime_content:AnimeContent::Both,paths:vec!["Anime".into()],revision:None,options:Default::default()}).unwrap();
        let entry=NativeCatalogEntry{id:String::new(),path:"Anime/Test".into(),kind:"series".into(),parent_path:None,title:"Wrong".into(),metadata:json!({"title":"Wrong","plot":"Local synopsis","year":2024,"identifiers":{"tvdb":"99"},"credits":[{"name":"Wrong actor","category":"cast"}],"_sources":{"title":"tvdb","plot":"nfo","year":"tvdb","identifiers":"tvdb","credits":"tvdb"}}),artwork:vec![NativeArtwork{kind:"poster".into(),path:"Anime/Test/poster.jpg".into(),source:"local".into()},NativeArtwork{kind:"banner".into(),path:"wrong.jpg".into(),source:"tvdb".into()}],files:vec![],nfo_path:None,nfo_xml:None,available:true,revision:1};
        db.ingest_native_catalog(&library.id,library.revision,&[entry]).unwrap();let before=db.native_catalog(&library.id).unwrap().remove(0);
        assert!(db.identify_native_entry(&library.id,&before.id,before.revision+1,"Correct",Some(2014),&json!({"anilist":"20464"})).is_err());
        assert_eq!(db.native_catalog(&library.id).unwrap()[0].title,"Wrong");
        db.identify_native_entry(&library.id,&before.id,before.revision,"Correct",Some(2014),&json!({"anilist":"20464"})).unwrap();
        let after=db.native_catalog(&library.id).unwrap().remove(0);assert_eq!(after.title,"Correct");assert_eq!(after.metadata["_title_locked"],false);db.edit_native_entry(&library.id,&after.id,after.revision,&json!({"_title_locked":true})).unwrap();let locked=db.native_catalog(&library.id).unwrap().remove(0);assert_eq!(locked.metadata["_title_locked"],true);db.edit_native_entry(&library.id,&locked.id,locked.revision,&json!({"_title_locked":false})).unwrap();assert_eq!(db.native_catalog(&library.id).unwrap()[0].metadata["_title_locked"],false);assert_eq!(after.metadata["plot"],"Local synopsis");assert_eq!(after.metadata["identifiers"],json!({"anilist":"20464"}));assert!(after.metadata["credits"].is_null());assert_eq!(after.artwork.len(),1);assert_eq!(after.artwork[0].source,"local");assert!(after.revision>before.revision);
    }
    #[test]
    fn fills_empty_local_values_without_overwriting_populated_or_manual_fields(){
        let temp=tempfile::tempdir().unwrap();let db=ServerStore::new(temp.path());db.initialize().unwrap();
        let library=db.save_native_library(None,&NativeLibraryInput{name:"Movies".into(),library_type:NativeLibraryType::Movies,anime_content:AnimeContent::Both,paths:vec!["Movies".into()],revision:None,options:Default::default()}).unwrap();
        let mut entry=NativeCatalogEntry{id:String::new(),path:"Movies/Test.mp4".into(),kind:"movie".into(),parent_path:None,title:"Test".into(),metadata:json!({"title":"Test","plot":"","_sources":{"title":"nfo","plot":"nfo"}}),artwork:vec![],files:vec![],nfo_path:None,nfo_xml:None,available:true,revision:1};
        db.ingest_native_catalog(&library.id,library.revision,&[entry.clone()]).unwrap();
        entry.metadata["plot"]=json!("Provider filled the gap");entry.metadata["_sources"]["plot"]=json!("tmdb");
        db.ingest_native_catalog(&library.id,library.revision,&[entry.clone()]).unwrap();
        let first=db.native_catalog(&library.id).unwrap().remove(0);assert_eq!(first.metadata["plot"],"Provider filled the gap");
        entry.metadata["plot"]=json!("Local plot");entry.metadata["_sources"]["plot"]=json!("nfo");db.ingest_native_catalog(&library.id,library.revision,&[entry.clone()]).unwrap();
        entry.metadata["plot"]=json!("Provider replacement");entry.metadata["_sources"]["plot"]=json!("tmdb");db.ingest_native_catalog(&library.id,library.revision,&[entry.clone()]).unwrap();
        let current=db.native_catalog(&library.id).unwrap().remove(0);assert_eq!(current.id,first.id);assert_eq!(current.metadata["plot"],"Local plot");
        db.edit_native_entry(&library.id,&current.id,current.revision,&json!({"plot":"Manual plot"})).unwrap();
        db.ingest_native_catalog(&library.id,library.revision,&[entry.clone()]).unwrap();assert_eq!(db.native_catalog(&library.id).unwrap()[0].metadata["plot"],"Manual plot");
        assert!(db.ingest_native_catalog(&library.id,library.revision+1,&[]).is_err());assert!(db.native_catalog(&library.id).unwrap()[0].available);
    }
    #[test]
    fn artwork_lookup_is_scoped_and_does_not_load_catalog_snapshots() {
        let temp = tempfile::tempdir().unwrap();
        let db = ServerStore::new(temp.path());
        db.initialize().unwrap();
        let library = db
            .save_native_library(
                None,
                &NativeLibraryInput {
                    name: "Movies".into(),
                    library_type: NativeLibraryType::Movies,
                    anime_content: AnimeContent::Both,
                    paths: vec!["Movies".into()],
                    revision: None,
                    options: Default::default(),
                },
            )
            .unwrap();
        let entry = NativeCatalogEntry {
            id: String::new(),
            path: "Movies/Test.mp4".into(),
            kind: "movie".into(),
            parent_path: None,
            title: "Test".into(),
            metadata: json!({"title":"Test"}),
            artwork: vec![NativeArtwork {
                kind: "poster".into(),
                path: "Movies/poster.jpg".into(),
                source: "local".into(),
            }],
            files: vec![],
            nfo_path: None,
            nfo_xml: None,
            available: true,
            revision: 1,
        };
        db.ingest_native_catalog(&library.id, library.revision, &[entry])
            .unwrap();
        let item = db.native_catalog(&library.id).unwrap().remove(0).id;
        db.connection()
            .unwrap()
            .execute(
                "UPDATE native_catalog_sources SET snapshot_json='{}' WHERE library_id=?1",
                [&library.id],
            )
            .unwrap();
        assert_eq!(
            db.native_artwork(&library.id, &item, "poster")
                .unwrap()
                .unwrap()
                .path,
            "Movies/poster.jpg"
        );
        assert!(
            db.native_artwork("other-library", &item, "poster")
                .unwrap()
                .is_none()
        );
        assert!(
            db.native_artwork(&library.id, &item, "backdrop")
                .unwrap()
                .is_none()
        );
        db.connection()
            .unwrap()
            .execute(
                "UPDATE native_catalog_sources SET available=0 WHERE library_id=?1",
                [&library.id],
            )
            .unwrap();
        assert!(
            db.native_artwork(&library.id, &item, "poster")
                .unwrap()
                .is_none()
        );
    }
}
