use crate::{Runtime, RuntimeError};
use posterview_contracts::{ItemDetail, ItemType, Season};

// Namespace shared artwork requests separately from connected media servers.
pub fn native_artwork_target(value: &str) -> Option<(&str, &str)> {
    let (library, item) = value.strip_prefix("native:")?.split_once(':')?;
    (!library.is_empty() && !item.is_empty() && !item.contains(':')).then_some((library, item))
}

impl Runtime {
    pub(crate) fn native_artwork_detail(
        &self,
        target: &str,
    ) -> Result<Option<ItemDetail>, RuntimeError> {
        let Some((library, item)) = native_artwork_target(target) else {
            return Ok(None);
        };
        let entries = self.server_store()?.native_catalog(library)?;
        let Some(entry) = entries
            .iter()
            .find(|entry| entry.id == item && entry.available)
        else {
            return Ok(None);
        };
        let parent = entries
            .iter()
            .find(|e| Some(e.path.as_str()) == entry.parent_path.as_deref());
        let series = if entry.kind == "episode" {
            parent.and_then(|p| {
                entries
                    .iter()
                    .find(|e| Some(e.path.as_str()) == p.parent_path.as_deref())
            })
        } else {
            parent
        };
        let mut identifiers = series
            .and_then(|e| e.metadata["identifiers"].as_object())
            .cloned()
            .unwrap_or_default();
        if let Some(own) = entry.metadata["identifiers"].as_object() {
            identifiers.extend(own.clone());
        }
        let text = |key: &str| entry.metadata[key].as_str().map(str::to_owned);
        let list = |key: &str| {
            entry.metadata[key]
                .as_array()
                .map(|values| {
                    values
                        .iter()
                        .filter_map(|v| v.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default()
        };
        let image = |kind: &str| {
            entry.artwork.iter().find(|a| a.kind == kind).map(|art| {
                format!(
                    "/api/native/libraries/{library}/items/{item}/artwork/{kind}?v={}&format={}",
                    entry.revision, art.path.rsplit_once('.').map(|(_,ext)|ext).unwrap_or("")
                )
            })
        };
        Ok(Some(ItemDetail {
            source_path: None,
            file_name: std::path::Path::new(&entry.path).file_name().map(|name| name.to_string_lossy().into_owned()),
            volume: text("volume"),
            id: target.into(),
            title: entry.title.clone(),
            year: entry.metadata["year"].as_i64(),
            item_type: match entry.kind.as_str() {
                "series" | "season" | "episode" => ItemType::Show,
                "book_series" => ItemType::Folder,
                "book" => ItemType::Book,
                _ => ItemType::Movie,
            },
            poster: image("poster"),
            background: image("backdrop"),
            logo: image("logo"),
            added_at: None,
            summary: text("plot"),
            season_count: None,
            seasons: entries
                .iter()
                .filter(|e| {
                    e.kind == "season"
                        && e.parent_path.as_deref() == Some(entry.path.as_str())
                        && e.available
                })
                .map(|e| Season {
                    id: format!("native:{library}:{}", e.id),
                    title: e.title.clone(),
                    index: e.metadata["season"].as_i64(),
                    episode_count: None,
                    poster: None,
                })
                .collect(),
            rating: entry.metadata["rating"].as_f64(),
            content_rating: text("mpaa"),
            genres: list("genres"),
            tags: list("tags"),
            studios: list("studios"),
            external_urls: vec![],
            external_ids: identifiers
                .iter()
                .filter_map(|(key, value)| {
                    let value = value
                        .as_str()
                        .map(str::to_owned)
                        .or_else(|| value.as_i64().map(|v| v.to_string()))?;
                    Some((key.to_lowercase(), value))
                })
                .collect(),
            members: entries.iter().filter(|e| e.kind == "book" && e.available && e.parent_path.as_deref() == Some(entry.path.as_str())).map(|e| posterview_contracts::MediaItem {
                id: format!("native:{library}:{}", e.id), title: e.metadata["volume"].as_str().map(str::to_owned).or_else(|| e.metadata["volume"].as_u64().map(|v| v.to_string())).map(|v| format!("{} — Volume {v}", e.title)).unwrap_or_else(|| e.title.clone()), year: e.metadata["year"].as_i64(), item_type: ItemType::Book, poster: None, background: None, added_at: None,
            }).collect(),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn native_lookup_uses_the_shared_provider_cache_without_a_server_connection() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = Runtime::new(temp.path());
        runtime.initialize().unwrap();
        let cache = runtime.server_artwork_cache(0).unwrap();
        let result = posterview_contracts::ArtworkResults {
            provider: "anilist".into(),
            item_title: Some("Native series".into()),
            items: vec![],
            message: None,
        };
        cache
            .put_json("artwork:anilist:0:native:library:item:", &result, 250, 30)
            .unwrap();
        let fetched = runtime
            .get_artwork("anilist", 0, "native:library:item", None)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(fetched.item_title, result.item_title);
        let search = posterview_contracts::ArtworkSearchResults {
            provider: "anilist".into(),
            results: vec![],
            message: None,
        };
        cache
            .put_json(
                "artwork-search:anilist:0:native:library:item:v2:example",
                &search,
                250,
                30,
            )
            .unwrap();
        assert!(
            runtime
                .search_artwork("anilist", 0, "native:library:item", "Example")
                .await
                .unwrap()
                .unwrap()
                .is_ok()
        );
        assert!(native_artwork_target("native::item").is_none());
        assert!(native_artwork_target("native:library:item:extra").is_none());
        assert!(native_artwork_target("server-item").is_none());
    }
}
