use super::{ArtworkService, network_error};
use posterview_contracts::{ArtworkItem, ArtworkSearchResult, ItemDetail, MangaCoverMetadata};
use serde_json::Value;

const BASE: &str = "https://api.mangadex.org";

pub fn valid_manga_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}

fn image_url(id: &str, filename: &str) -> Option<String> {
    if !valid_manga_id(id)
        || filename.is_empty()
        || !filename
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-._".contains(&c))
    {
        return None;
    }
    Some(format!(
        "https://uploads.mangadex.org/covers/{id}/{filename}"
    ))
}

fn proxy(url: &str) -> String {
    // URL is constructed solely from validated MangaDex identifiers/filenames.
    format!("/api/artwork/mangadex/image?url={url}")
}

fn text(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .map(str::to_owned)
}

fn series(value: &Value) -> Option<ArtworkSearchResult> {
    let id = value["id"].as_str()?.to_owned();
    if !valid_manga_id(&id) {
        return None;
    }
    let attr = &value["attributes"];
    let titles = attr["title"].as_object()?;
    let mut alternate_titles: Vec<String> = titles.values().filter_map(text).collect();
    let mut english = None;
    for alternate in attr["altTitles"].as_array().into_iter().flatten() {
        if english.is_none() {
            english = text(&alternate["en"]);
        }
        if let Some(map) = alternate.as_object() {
            alternate_titles.extend(map.values().filter_map(text));
        }
    }
    let name = text(&attr["title"]["en"])
        .or(english)
        .or_else(|| alternate_titles.first().cloned())?;
    alternate_titles.retain(|title| title != &name);
    alternate_titles.sort();
    alternate_titles.dedup();
    let thumb_url = value["relationships"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|r| r["type"] == "cover_art")
        .and_then(|r| image_url(&id, r["attributes"]["fileName"].as_str()?))
        .map(|url| proxy(&format!("{url}.256.jpg")));
    Some(ArtworkSearchResult {
        id,
        name,
        alternate_titles,
        thumb_url,
        year: attr["year"].as_i64().map(|v| v.to_string()),
        status: text(&attr["status"]),
        volume_count: None,
        publisher: None,
    })
}

fn cover(value: &Value, id: &str, title: &str) -> Option<ArtworkItem> {
    let attr = &value["attributes"];
    let url = image_url(id, attr["fileName"].as_str()?)?;
    Some(ArtworkItem {
        id: value["id"].as_str()?.to_owned(),
        provider: "mangadex".to_owned(),
        artwork_type: "poster".to_owned(),
        kind: "book".to_owned(),
        season_number: None,
        title: Some(title.to_owned()),
        lang: text(&attr["locale"]),
        likes: None,
        thumb_url: proxy(&format!("{url}.256.jpg")),
        download_url: url,
        applyable: true,
        source_url: Some(format!("https://mangadex.org/title/{id}?tab=art")),
        manga: Some(MangaCoverMetadata {
            mangadex_id: id.to_owned(),
            volume: text(&attr["volume"]),
            locale: text(&attr["locale"]),
            description: text(&attr["description"]),
        }),
    })
}

impl ArtworkService {
    async fn mangadex_get(&self, path: &str, query: &[(&str, &str)]) -> Result<Value, String> {
        let response = self
            .client
            .get(format!("{BASE}{path}"))
            .query(query)
            .send()
            .await
            .map_err(|_| "Unable to reach MangaDex. Please retry.".to_owned())?;
        if response.status().as_u16() == 429 {
            return Err("MangaDex is rate limiting requests. Wait a moment and retry.".to_owned());
        }
        if !response.status().is_success() {
            return Err(format!(
                "MangaDex request failed ({}). Please retry.",
                response.status().as_u16()
            ));
        }
        let data: Value = response.json().await.map_err(network_error)?;
        if data["result"] != "ok" {
            return Err("MangaDex returned an invalid response.".to_owned());
        }
        Ok(data)
    }

    pub async fn search_mangadex(&self, query: &str) -> Result<Vec<ArtworkSearchResult>, String> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(Vec::new());
        }
        // A pasted ID gives an exact lookup; free text matches alternate titles too.
        if valid_manga_id(query) {
            let data = self
                .mangadex_get(&format!("/manga/{query}"), &[("includes[]", "cover_art")])
                .await?;
            return Ok(series(&data["data"]).into_iter().collect());
        }
        let data = self
            .mangadex_get(
                "/manga",
                &[
                    ("title", query),
                    ("limit", "100"),
                    ("includes[]", "cover_art"),
                    ("order[relevance]", "desc"),
                ],
            )
            .await?;
        let records = data["data"]
            .as_array()
            .ok_or("MangaDex returned invalid search results.")?;
        Ok(records.iter().filter_map(series).collect())
    }

    pub async fn fetch_mangadex(
        &self,
        item: &ItemDetail,
        id: Option<&str>,
    ) -> Result<Vec<ArtworkItem>, String> {
        let id = id
            .or_else(|| item.external_ids.get("mangadex").map(String::as_str))
            .filter(|id| valid_manga_id(id))
            .ok_or("Search MangaDex and select a series to browse its covers.")?;
        let data = self.mangadex_get(&format!("/manga/{id}"), &[]).await?;
        let title = series(&data["data"])
            .ok_or("MangaDex returned an invalid series.")?
            .name;
        let mut items = Vec::new();
        let mut offset = 0;
        loop {
            let offset_string = offset.to_string();
            let data = self
                .mangadex_get(
                    "/cover",
                    &[
                        ("manga[]", id),
                        ("limit", "100"),
                        ("offset", &offset_string),
                        ("order[volume]", "asc"),
                    ],
                )
                .await?;
            let records = data["data"]
                .as_array()
                .ok_or("MangaDex returned invalid cover records.")?;
            items.extend(records.iter().filter_map(|value| cover(value, id, &title)));
            offset += records.len();
            let total = data["total"]
                .as_u64()
                .ok_or("MangaDex returned an invalid cover count.")?
                as usize;
            if offset >= total {
                break;
            }
            if records.is_empty() || offset >= 10_000 {
                return Err(
                    "MangaDex could not return the complete cover gallery. Please retry."
                        .to_owned(),
                );
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
        Ok(items)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    const ID: &str = "5f20891f-0136-4fa8-afb7-d72f2af23c65";
    #[test]
    fn alternate_titles_and_missing_cover_metadata_are_preserved() {
        let result = series(&json!({"id": ID, "attributes": {"title": {"ja-ro": "Shokugeki no Souma"}, "altTitles": [{"ja": "食戟のソーマ"}, {"en": "Food Wars!"}]}})).unwrap();
        assert_eq!(result.name, "Food Wars!");
        assert!(result.alternate_titles.contains(&"食戟のソーマ".to_owned()));
        assert!(result.thumb_url.is_none());
        let art = cover(&json!({"id":"cover", "attributes":{"fileName":"cover.jpg", "volume":null, "locale":null}}), ID, "Food Wars!").unwrap();
        assert!(art.manga.unwrap().volume.is_none());
        assert!(art.thumb_url.starts_with("/api/artwork/mangadex/image"));
    }
    #[test]
    fn invalid_ids_and_paths_are_rejected() {
        assert!(valid_manga_id(ID));
        assert!(!valid_manga_id("../manga"));
        assert!(image_url(ID, "../../private").is_none());
        assert!(image_url(ID, "file.jpg?redirect=evil").is_none());
    }
}
