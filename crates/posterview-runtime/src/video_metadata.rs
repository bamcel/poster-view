use crate::{Runtime, RuntimeError};
use posterview_contracts::{ItemDetail, ItemType};
use posterview_infra_artwork::{FetchedVideoMetadata, valid_credit_id};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};

fn error(e: impl std::fmt::Display) -> RuntimeError {
    RuntimeError::Watchdog(e.to_string())
}
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct VideoMetadataDocument {
    pub fields: BTreeMap<String, Value>,
    pub sources: BTreeMap<String, String>,
    pub ids: BTreeMap<String, String>,
    pub matches: BTreeMap<String, String>,
}
#[derive(Default, Serialize)]
pub struct MetadataFetchResult {
    pub filled: Vec<String>,
    pub credits_added: usize,
    pub issues: Vec<String>,
    pub needs_matching: bool,
}
fn empty(v: &Value) -> bool {
    v.is_null()
        || v.as_str().is_some_and(|s| s.trim().is_empty())
        || v.as_array().is_some_and(Vec::is_empty)
}

#[cfg(test)]
#[allow(clippy::items_after_test_module, clippy::field_reassign_with_default)]
mod tests {
    use super::*;
    fn item() -> ItemDetail {
        ItemDetail {
        anime: false,
            source_path: None,
            file_name: None,
            volume: None,
            id: "movie".into(),
            title: "My edited title".into(),
            year: Some(2020),
            item_type: ItemType::Movie,
            poster: None,
            background: None,
            added_at: None,
            summary: Some("My edited summary".into()),
            season_count: None,
            seasons: vec![],
            rating: Some(9.0),
            content_rating: None,
            genres: vec!["My genre".into()],
            tags: vec![],
            studios: vec![],
            external_urls: vec![],
            external_ids: BTreeMap::from([("Tmdb".into(), "1".into())]),
            logo: None,
            members: vec![],
        }
    }
    #[test]
    fn fills_only_empty_fields_with_source_tracking_and_normalized_links() {
        let mut item = item();
        let mut doc = VideoMetadataDocument::default();
        let mut result = MetadataFetchResult::default();
        let mut source = FetchedVideoMetadata::default();
        source.fields = BTreeMap::from([
            ("summary".into(), json!("Provider summary")),
            ("year".into(), json!(2024)),
            ("genres".into(), json!(["Other"])),
            ("tags".into(), json!(["Mystery"])),
            ("runtime_minutes".into(), json!(100)),
            ("content_rating".into(), json!("PG")),
            ("rating".into(), json!(5.0)),
        ]);
        source.ids = BTreeMap::from([
            ("tmdb".into(), "2".into()),
            ("imdb".into(), "tt0000001".into()),
        ]);
        doc.fill(&item, source, "tmdb:1", &mut result);
        doc.apply(&mut item);
        assert_eq!(item.summary.as_deref(), Some("My edited summary"));
        assert_eq!(item.year, Some(2020));
        assert_eq!(item.rating, Some(9.0));
        assert_eq!(item.genres, vec!["My genre"]);
        assert_eq!(item.tags, vec!["Mystery"]);
        assert_eq!(item.content_rating.as_deref(), Some("PG"));
        assert_eq!(item.external_ids["tmdb"], "1");
        assert_eq!(item.external_ids["imdb"], "tt0000001");
        assert_eq!(doc.sources["tags"], "tmdb:1");
        assert_eq!(result.filled.len(), 4);
        let mut next = FetchedVideoMetadata::default();
        next.fields.insert("tags".into(), json!(["Changed"]));
        doc.fill(&item, next, "mal:2", &mut result);
        assert_eq!(doc.fields["tags"], json!(["Mystery"]));
    }
    #[test]
    fn metadata_persists_and_credit_merge_is_additive_and_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = Runtime::new(dir.path());
        runtime.initialize().unwrap();
        let server = runtime
            .create_server(&posterview_contracts::ServerCreate {
                name: "test".into(),
                server_type: posterview_contracts::ServerType::Emby,
                base_url: "http://localhost:1".into(),
                token: "".into(),
                is_default: false,
                nfo_metadata_enabled: false,
            })
            .unwrap();
        let mut doc = VideoMetadataDocument::default();
        doc.fields.insert("tags".into(), json!(["Saved"]));
        runtime
            .store_video_document(server.id, "movie", &doc)
            .unwrap();
        let c = posterview_contracts::Credit {
            person_id: "1".into(),
            name: "Existing name".into(),
            category: "cast".into(),
            role: "Actor".into(),
            ..Default::default()
        };
        let mut source = posterview_contracts::CreditSource {
            provider: "tmdb".into(),
            external_id: "1".into(),
            credits: vec![c.clone()],
            ..Default::default()
        };
        let store = runtime.server_store().unwrap();
        assert_eq!(
            store
                .merge_credit_source(server.id, "movie", &source)
                .unwrap(),
            1
        );
        source.credits[0].name = "Replacement name".into();
        source.credits.push(posterview_contracts::Credit {
            person_id: "2".into(),
            name: "Director".into(),
            category: "crew".into(),
            role: "Director".into(),
            ..Default::default()
        });
        assert_eq!(
            store
                .merge_credit_source(server.id, "movie", &source)
                .unwrap(),
            1
        );
        assert_eq!(
            store
                .merge_credit_source(server.id, "movie", &source)
                .unwrap(),
            0
        );
        assert_eq!(
            store.series_credits(server.id, "movie").unwrap().sources[0].credits[0].name,
            "Existing name"
        );
        let mut alternate = c.clone();
        alternate.dub_group = Some("Alternate recording".into());
        source.credits.push(alternate);
        assert_eq!(store.merge_credit_source(server.id, "movie", &source).unwrap(), 1);
        assert_eq!(store.merge_credit_source(server.id, "movie", &source).unwrap(), 0);
        source.credits[0].image = Some("https://example.com/actor.jpg".into());
        source.credits[0].character_image = Some("https://example.com/character.jpg".into());
        source.credits[0].character_bio = Some("Saved biography".into());
        store.merge_credit_source(server.id, "movie", &source).unwrap();
        let merged = store.series_credits(server.id, "movie").unwrap();
        assert_eq!(merged.sources[0].credits[0].image.as_deref(), Some("https://example.com/actor.jpg"));
        assert_eq!(merged.sources[0].credits[0].character_image.as_deref(), Some("https://example.com/character.jpg"));
        source.credits[0].image = Some("https://example.com/replacement.jpg".into());
        source.credits[0].character_bio = Some("Replacement biography".into());
        store.merge_credit_source(server.id, "movie", &source).unwrap();
        assert_eq!(store.series_credits(server.id, "movie").unwrap().sources[0].credits[0].image.as_deref(), Some("https://example.com/actor.jpg"));
        assert_eq!(store.series_credits(server.id, "movie").unwrap().sources[0].credits[0].character_bio.as_deref(), Some("Saved biography"));
        drop(runtime);
        let runtime = Runtime::new(dir.path());
        runtime.initialize().unwrap();
        assert_eq!(runtime.server_store().unwrap().series_credits(server.id, "movie").unwrap().sources[0].credits[0].character_bio.as_deref(), Some("Saved biography"));

        assert_eq!(
            runtime
                .video_metadata_document(server.id, "movie")
                .unwrap()
                .fields["tags"],
            json!(["Saved"])
        );
    }
}
fn normalized_ids(ids: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    ids.iter()
        .map(|(k, v)| {
            (
                if k.eq_ignore_ascii_case("myanimelist") {
                    "mal".into()
                } else {
                    k.to_lowercase()
                },
                v.trim().into(),
            )
        })
        .collect()
}
impl VideoMetadataDocument {
    fn effective_ids(&self, item: &ItemDetail) -> BTreeMap<String, String> {
        let mut ids = normalized_ids(&item.external_ids);
        for (p, id) in &self.ids {
            ids.entry(p.clone()).or_insert(id.clone());
        }
        ids.extend(self.matches.clone());
        ids.retain(|_, v| !v.is_empty());
        ids
    }
    pub(crate) fn apply(&self, item: &mut ItemDetail) {
        let f = &self.fields;
        if item.summary.as_ref().is_none_or(|s| s.trim().is_empty()) {
            item.summary = f.get("summary").and_then(Value::as_str).map(str::to_owned);
        }
        if item.year.is_none() {
            item.year = f.get("year").and_then(Value::as_i64);
        }
        if item.rating.is_none() {
            item.rating = f.get("rating").and_then(Value::as_f64);
        }
        if item
            .content_rating
            .as_ref()
            .is_none_or(|s| s.trim().is_empty())
        {
            item.content_rating = f
                .get("content_rating")
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
        for (key, values) in [
            ("genres", &mut item.genres),
            ("tags", &mut item.tags),
            ("studios", &mut item.studios),
        ] {
            if values.is_empty() {
                *values = f
                    .get(key)
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect();
            }
        }
        item.external_ids = self.effective_ids(item);
        // Explicit match corrections must not leave stale server-provided links ahead of the corrected ID.
        item.external_urls.retain(|link| {
            !self.matches.keys().any(|p| {
                link.name
                    .to_lowercase()
                    .replace("the", "")
                    .replace("myanimelist", "mal")
                    == *p
            })
        });
    }
    fn fill(
        &mut self,
        item: &ItemDetail,
        fetched: FetchedVideoMetadata,
        source: &str,
        result: &mut MetadataFetchResult,
    ) {
        let current = serde_json::to_value(item).expect("serializable item");
        for (key, value) in fetched.fields {
            if !empty(&value)
                && current.get(&key).is_none_or(empty)
                && self.fields.get(&key).is_none_or(empty)
            {
                self.fields.insert(key.clone(), value);
                self.sources.insert(key.clone(), source.into());
                result.filled.push(key);
            }
        }
        let ids = self.effective_ids(item);
        for (provider, id) in fetched.ids {
            if !ids.contains_key(&provider) && !self.matches.contains_key(&provider) {
                self.ids.insert(provider.clone(), id);
                self.sources.insert(format!("id:{provider}"), source.into());
                result.filled.push(format!("{provider} link"));
            }
        }
    }
}
impl Runtime {
    pub fn video_metadata_document(
        &self,
        server: i64,
        item: &str,
    ) -> Result<VideoMetadataDocument, RuntimeError> {
        self.server_store()?
            .video_metadata(server, item)?
            .map(|s| serde_json::from_str(&s).map_err(error))
            .unwrap_or_else(|| Ok(VideoMetadataDocument::default()))
    }
    fn store_video_document(
        &self,
        server: i64,
        item: &str,
        doc: &VideoMetadataDocument,
    ) -> Result<(), RuntimeError> {
        self.server_store()?.save_video_metadata(
            server,
            item,
            &serde_json::to_string(doc).map_err(error)?,
        )?;
        Ok(())
    }
    pub async fn save_video_matches(
        &self,
        server: i64,
        item: &str,
        matches: BTreeMap<String, String>,
    ) -> Result<VideoMetadataDocument, RuntimeError> {
        if matches.len() > 6
            || matches.iter().any(|(p, id)| {
                !["anilist", "mal", "tvdb", "tmdb", "imdb", "anidb"].contains(&p.as_str())
                    || (!id.is_empty()
                        && if p == "imdb" {
                            !(id.starts_with("tt")
                                && (9..=14).contains(&id.len())
                                && id[2..].bytes().all(|b| b.is_ascii_digit()))
                        } else {
                            !valid_credit_id(id)
                        })
            })
        {
            return Err(error("Enter valid numeric provider IDs, or an IMDb tt ID."));
        }
        let _guard = self.metadata_worker.lock().await;
        let detail = self
            .get_item_detail(server, item)
            .await?
            .ok_or_else(|| error("Server not found"))?
            .map_err(error)?;
        if !matches!(detail.item_type, ItemType::Movie | ItemType::Show) {
            return Err(error("Metadata matching supports movies and series."));
        }
        let mut doc = self.video_metadata_document(server, item)?;
        for (p, id) in &matches {
            if doc.effective_ids(&detail).get(p) != Some(id) {
                let prefix = format!("{p}:");
                let keys = doc
                    .sources
                    .iter()
                    .filter(|(_, s)| s.starts_with(&prefix))
                    .map(|(k, _)| k.clone())
                    .collect::<Vec<_>>();
                for key in keys {
                    doc.fields.remove(&key);
                    if let Some(provider) = key.strip_prefix("id:") {
                        doc.ids.remove(provider);
                    }
                    doc.sources.remove(&key);
                }
                for source in self
                    .series_credits(server, item)?
                    .sources
                    .into_iter()
                    .filter(|s| &s.provider == p)
                {
                    self.remove_credit_source(server, item, p, &source.external_id)
                        .await?;
                }
            }
        }
        doc.matches.extend(matches);
        self.store_video_document(server, item, &doc)?;
        Ok(doc)
    }
    pub async fn find_missing_metadata(
        &self,
        server: i64,
        item_id: &str,
        task: Option<&str>,
    ) -> Result<MetadataFetchResult, RuntimeError> {
        let _guard = self.metadata_worker.lock().await;
        let mut item = self
            .get_item_detail(server, item_id)
            .await?
            .ok_or_else(|| error("Server not found"))?
            .map_err(error)?;
        if !matches!(item.item_type, ItemType::Movie | ItemType::Show) {
            return Err(error("Find Missing Metadata supports movies and series."));
        }
        let movie = item.item_type == ItemType::Movie;
        let mut doc = self.video_metadata_document(server, item_id)?;
        let mut result = MetadataFetchResult::default();
        let store = self.server_store()?;
        let tmdb = store.get_setting("tmdb_access_token")?;
        let tvdb = store.get_setting("tvdb_api_key")?;
        let pin = store.get_setting("tvdb_pin")?;
        let mut ids = doc.effective_ids(&item);
        let saved = self.series_credits(server, item_id)?;
        // Only a single explicit saved credit match can establish the title's metadata identity.
        for p in ["anilist", "mal", "tmdb", "tvdb"] {
            let sources = saved
                .sources
                .iter()
                .filter(|s| s.provider == p)
                .collect::<Vec<_>>();
            if !ids.contains_key(p) && !doc.matches.contains_key(p) && sources.len() == 1 {
                ids.insert(p.into(), sources[0].external_id.clone());
            }
        }
        if !ids.contains_key("tmdb")
            && !doc.matches.contains_key("tmdb")
            && let Some(imdb) = ids.get("imdb")
        {
            match self.artwork.find_tmdb_id(imdb, movie, &tmdb).await {
                Ok(Some(id)) => {
                    ids.insert("tmdb".into(), id);
                }
                Ok(None) => {}
                Err(e) => result.issues.push(format!("TMDB matching: {e}")),
            }
        }
        let mut visited = HashSet::new();
        // Revisit the list when one provider discovers a reliable ID for another.
        for _ in 0..2 {
            for provider in if item.anime { vec!["anilist", "mal", "anidb", "tmdb", "tvdb", "imdb"] } else { vec!["tmdb", "tvdb", "imdb"] } {
                if let Some(task) = task
                    && self.cancelled(task)?
                {
                    return Err(error("Metadata fetch cancelled"));
                }
                let Some(id) = ids.get(provider).cloned() else {
                    continue;
                };
                if !visited.insert(provider.to_string()) {
                    continue;
                }
                if provider == "anidb" {
                    if self.anidb_settings()?.enabled {
                        match self.anidb_metadata(&id, movie).await {
                            Ok(fetched) => {
                                doc.fill(&item, fetched, &format!("anidb:{id}"), &mut result);
                                doc.apply(&mut item);
                                self.store_video_document(server, item_id, &doc)?;
                            }
                            Err(message) => result.issues.push(format!("AniDB: {message}")),
                        }
                    }
                    continue;
                }
                if provider == "imdb" {
                    if self.imdb_status()?.enabled {
                        match self.imdb_lookup(&id) {
                            Ok(titles) => {
                                if let Some(title) = titles.first()
                                    && if movie {
                                        ["movie", "tvMovie", "short", "video"]
                                            .contains(&title.title_type.as_str())
                                    } else {
                                        ["tvSeries", "tvMiniSeries"]
                                            .contains(&title.title_type.as_str())
                                    }
                                {
                                    let mut fetched = FetchedVideoMetadata::default();
                                    fetched.ids.insert("imdb".into(), id.clone());
                                    fetched.fields = BTreeMap::from([
                                        ("original_title".into(), json!(title.original_title)),
                                        ("year".into(), json!(title.year)),
                                        ("runtime_minutes".into(), json!(title.runtime_minutes)),
                                        ("genres".into(), json!(title.genres)),
                                        ("imdb_rating".into(), json!(title.rating)),
                                        ("imdb_votes".into(), json!(title.votes)),
                                    ]);
                                    doc.fill(
                                        &item,
                                        fetched,
                                        &format!("imdb:{id}"),
                                        &mut result,
                                    );
                                }
                            }
                            Err(e) => result.issues.push(format!("IMDb: {e}")),
                        }
                    }
                    continue;
                }
                if (provider == "tmdb" && tmdb.is_empty())
                    || (provider == "tvdb" && tvdb.is_empty())
                {
                    result.issues.push(format!(
                        "{provider}: configure provider credentials in Edit Metadata or Settings."
                    ));
                    continue;
                }
                let fetched = tokio::time::timeout(
                    std::time::Duration::from_secs(90),
                    self.artwork
                        .video_metadata(provider, &id, movie, &tmdb, &tvdb, &pin),
                )
                .await;
                match fetched {
                    Ok(Ok(fetched)) => {
                        for (p, id) in &fetched.ids {
                            if !doc.matches.contains_key(p) {
                                ids.entry(p.clone()).or_insert(id.clone());
                            }
                        }
                        doc.fill(&item, fetched, &format!("{provider}:{id}"), &mut result);
                        doc.apply(&mut item);
                        self.store_video_document(server, item_id, &doc)?;
                    }
                    Ok(Err(e)) => {
                        result.issues.push(format!("{provider}: {e}"));
                        continue;
                    }
                    Err(_) => {
                        result
                            .issues
                            .push(format!("{provider}: metadata request timed out"));
                        continue;
                    }
                }
                if let Some(task) = task
                    && self.cancelled(task)?
                {
                    return Err(error("Metadata fetch cancelled"));
                }
                match tokio::time::timeout(
                    std::time::Duration::from_secs(90),
                    self.artwork
                        .fetch_video_credits(provider, &id, movie, &tmdb, &tvdb, &pin),
                )
                .await
                {
                    Ok(Ok(source)) => {
                        let mut crew = FetchedVideoMetadata::default();
                        for (key, roles) in [
                            ("directors", vec!["director"]),
                            (
                                "writers",
                                vec!["writer", "screenplay", "screenwriter", "story"],
                            ),
                        ] {
                            let names = source
                                .credits
                                .iter()
                                .filter(|c| {
                                    c.category == "crew"
                                        && roles.contains(&c.role.to_lowercase().as_str())
                                })
                                .map(|c| c.name.clone())
                                .collect::<Vec<_>>();
                            crew.fields.insert(key.into(), json!(names));
                        }
                        doc.fill(&item, crew, &format!("{provider}:{id}"), &mut result);
                        result.credits_added +=
                            store.merge_credit_source(server, item_id, &source)?;
                    }
                    Ok(Err(e)) => result.issues.push(format!("{provider} credits: {e}")),
                    Err(_) => result
                        .issues
                        .push(format!("{provider}: credits request timed out")),
                }
            }
        }
        result.needs_matching = visited.is_empty();
        if result.needs_matching {
            result.issues.push("No confirmed provider IDs. Open Edit Metadata → Provider matching to identify this title.".into());
        }
        self.store_video_document(server, item_id, &doc)?;
        Ok(result)
    }
}
