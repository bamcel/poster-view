use posterview_contracts::{
    ArtworkItem, ArtworkSearchResult, ItemDetail, ItemType, MangaCoverMetadata,
};
use reqwest::Client;
use serde_json::Value;

const API: &str = "https://comicvine.gamespot.com/api";

pub async fn test(client: &Client, key: &str) -> Result<(), String> {
    if key.trim().is_empty() {
        return Err("ComicVine API key is not configured (add it in Settings).".to_owned());
    }
    request(
        client,
        "/search/",
        key,
        &[("query", "Batman"), ("resources", "volume"), ("limit", "1")],
    )
    .await
    .map(|_| ())
}

pub async fn search(
    client: &Client,
    key: &str,
    query: &str,
) -> Result<Vec<ArtworkSearchResult>, String> {
    let data = request(
        client,
        "/search/",
        key,
        &[
            ("query", query),
            ("resources", "volume"),
            (
                "field_list",
                "id,name,start_year,image,site_detail_url,count_of_issues,publisher",
            ),
            ("limit", "25"),
        ],
    )
    .await?;
    Ok(data["results"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(parse_search_result)
        .collect())
}

fn parse_search_result(value: &Value) -> Option<ArtworkSearchResult> {
    Some(ArtworkSearchResult {
        alternate_titles: Vec::new(),
        status: None,
        id: value.get("id")?.as_i64()?.to_string(),
        name: value.get("name")?.as_str()?.to_owned(),
        year: value
            .get("start_year")
            .and_then(Value::as_str)
            .map(str::to_owned),
        thumb_url: image_url(value, "small_url"),
        volume_count: value.get("count_of_issues").and_then(Value::as_u64),
        publisher: value
            .get("publisher")
            .and_then(|publisher| publisher.get("name"))
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

pub async fn fetch(
    client: &Client,
    key: &str,
    item: &ItemDetail,
    volume_id: Option<&str>,
) -> Result<Vec<ArtworkItem>, String> {
    let id = volume_id
        .filter(|id| id.chars().all(|c| c.is_ascii_digit()))
        .ok_or("Search ComicVine and select a series to browse its covers.")?;
    let kind = match item.item_type {
        ItemType::Book => "book",
        ItemType::Audiobook => "audiobook",
        ItemType::Folder => "folder",
        _ => {
            return Err("ComicVine covers are available for comic and manga libraries.".to_owned());
        }
    };
    let filter = format!("volume:{id}");
    let data = request(
        client,
        "/issues/",
        key,
        &[
            ("filter", &filter),
            ("field_list", "id,name,issue_number,image,site_detail_url"),
            ("limit", "100"),
        ],
    )
    .await?;
    Ok(data["results"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|value| {
            let number = value.get("issue_number")?.as_str()?.to_owned();
            let image =
                image_url(value, "original_url").or_else(|| image_url(value, "super_url"))?;
            Some(ArtworkItem {
                manga: Some(MangaCoverMetadata {
                    mangadex_id: String::new(),
                    volume: Some(number.clone()),
                    locale: Some("en".to_owned()),
                    description: None,
                }),
                id: value.get("id")?.as_i64()?.to_string(),
                provider: "comicvine".to_owned(),
                artwork_type: "poster".to_owned(),
                kind: kind.to_owned(),
                season_number: None,
                title: Some(
                    value
                        .get("name")
                        .and_then(Value::as_str)
                        .filter(|name| !name.is_empty())
                        .map(str::to_owned)
                        .unwrap_or_else(|| format!("Volume {number}")),
                ),
                lang: Some("en".to_owned()),
                likes: None,
                thumb_url: image.clone(),
                download_url: image,
                applyable: true,
                source_url: value
                    .get("site_detail_url")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            })
        })
        .collect())
}

async fn request(
    client: &Client,
    path: &str,
    key: &str,
    query: &[(&str, &str)],
) -> Result<Value, String> {
    if key.trim().is_empty() {
        return Err("ComicVine API key is not configured (add it in Settings).".to_owned());
    }
    let response = client
        .get(format!("{API}{path}"))
        .query(&[("api_key", key), ("format", "json")])
        .query(query)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "ComicVine request failed ({}).",
            response.status().as_u16()
        ));
    }
    let data: Value = response.json().await.map_err(|error| error.to_string())?;
    if data["status_code"].as_i64() != Some(1) {
        return Err(data["error"]
            .as_str()
            .unwrap_or("ComicVine returned an error.")
            .to_owned());
    }
    Ok(data)
}

fn image_url(value: &Value, size: &str) -> Option<String> {
    value
        .get("image")?
        .get(size)?
        .as_str()
        .filter(|url| url.starts_with("https://"))
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_comicvine_volume_search_results() {
        let data = serde_json::json!({"id":123,"name":"Plunderer","start_year":"2014","count_of_issues":24,"publisher":{"name":"Yen Press"},"image":{"small_url":"https://comicvine.gamespot.com/a/uploads/scale_small/test.jpg"}});
        assert_eq!(
            image_url(&data, "small_url").as_deref(),
            Some("https://comicvine.gamespot.com/a/uploads/scale_small/test.jpg")
        );
        let result = parse_search_result(&data).expect("valid ComicVine search result");
        assert_eq!(result.volume_count, Some(24));
        assert_eq!(result.publisher.as_deref(), Some("Yen Press"));
    }
}
