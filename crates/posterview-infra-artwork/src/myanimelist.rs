use super::*;

fn kind(provider: &str) -> &'static str {
    if provider == "myanimelist-manga" {
        "manga"
    } else {
        "anime"
    }
}

async fn request(
    client: &Client,
    key: &str,
    path: &str,
    query: &[(&str, &str)],
) -> Result<Value, String> {
    if key.trim().is_empty() {
        return Err("Configure a MyAnimeList client ID in Search Providers.".into());
    }
    let response = client
        .get(format!("https://api.myanimelist.net/v2/{path}"))
        .header("X-MAL-CLIENT-ID", key)
        .query(query)
        .send()
        .await
        .map_err(network_error)?;
    if !response.status().is_success() {
        return Err(provider_status_error("MyAnimeList", response.status()));
    }
    response.json().await.map_err(network_error)
}

fn picture(raw: &Value) -> Option<&str> {
    ["large", "medium"].into_iter().find_map(|size| {
        raw["main_picture"][size]
            .as_str()
            .filter(|url| !url.trim().is_empty())
    })
}

pub(super) async fn search(
    client: &Client,
    key: &str,
    provider: &str,
    query: &str,
) -> Result<Vec<ArtworkSearchResult>, String> {
    let query = query.trim();
    if query.chars().count() < 2 {
        return Err("Enter at least two characters to search MyAnimeList.".into());
    }
    let raw = request(
        client,
        key,
        kind(provider),
        &[
            ("q", query),
            ("limit", "20"),
            ("fields", "id,title,main_picture,start_date"),
        ],
    )
    .await?;
    Ok(raw["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let node = &entry["node"];
            Some(ArtworkSearchResult {
                id: node["id"].as_u64()?.to_string(),
                name: node["title"].as_str()?.into(),
                year: node["start_date"]
                    .as_str()
                    .map(|date| date.chars().take(4).collect()),
                thumb_url: picture(node).map(str::to_owned),
                alternate_titles: vec![],
                status: None,
                volume_count: None,
                publisher: None,
            })
        })
        .collect())
}

pub(super) async fn fetch(
    client: &Client,
    key: &str,
    provider: &str,
    item: &ItemDetail,
    override_id: Option<&str>,
) -> Result<Vec<ArtworkItem>, String> {
    if key.trim().is_empty() {
        return Err("Configure a MyAnimeList client ID in Search Providers.".into());
    }
    let id = override_id
        .or_else(|| {
            item.external_ids
                .get("mal")
                .or_else(|| item.external_ids.get("myanimelist"))
                .map(String::as_str)
        })
        .and_then(|id| id.trim().parse::<u64>().ok())
        .filter(|id| *id > 0)
        .ok_or("Enter a MyAnimeList ID or search by title and choose a result.")?;
    let raw = request(
        client,
        key,
        &format!("{}/{id}", kind(provider)),
        &[("fields", "id,title,main_picture")],
    )
    .await?;
    Ok(map_cover(provider, item, &raw))
}

fn map_cover(provider: &str, item: &ItemDetail, raw: &Value) -> Vec<ArtworkItem> {
    let Some(url) =
        picture(raw).filter(|url| provider_https(url, &["cdn.myanimelist.net"]).is_ok())
    else {
        return vec![];
    };
    let Some(id) = raw["id"].as_u64() else {
        return vec![];
    };
    vec![ArtworkItem {
        manga: None,
        id: format!("{provider}-{id}-poster"),
        provider: provider.into(),
        artwork_type: "poster".into(),
        kind: item_kind(item),
        season_number: None,
        title: raw["title"].as_str().map(str::to_owned),
        lang: None,
        likes: None,
        thumb_url: url.into(),
        download_url: url.into(),
        applyable: true,
        source_url: Some(format!("https://myanimelist.net/{}/{id}", kind(provider))),
    }]
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn covers_use_the_large_image_and_only_trusted_mal_images() {
        let item = ItemDetail {
            source_path: None,
            file_name: None,
            volume: None,
            id: "item".into(),
            title: "Example".into(),
            year: None,
            item_type: ItemType::Show,
            poster: None,
            background: None,
            added_at: None,
            summary: None,
            season_count: None,
            seasons: vec![],
            rating: None,
            content_rating: None,
            genres: vec![],
            tags: vec![],
            studios: vec![],
            external_urls: vec![],
            external_ids: Default::default(),
            logo: None,
            members: vec![],
        };
        let mut raw = json!({"id":1,"title":"Example","main_picture":{"large":"https://cdn.myanimelist.net/images/anime/large.jpg","medium":"https://cdn.myanimelist.net/images/anime/medium.jpg"}});
        let cover = map_cover("myanimelist", &item, &raw);
        assert_eq!(cover[0].artwork_type, "poster");
        assert!(cover[0].download_url.ends_with("large.jpg"));
        raw["main_picture"]["large"] = json!("");
        assert!(
            map_cover("myanimelist-manga", &item, &raw)[0]
                .source_url
                .as_ref()
                .unwrap()
                .contains("/manga/1")
        );
        raw["main_picture"]["medium"] = json!("https://untrusted.example/cover.jpg");
        assert!(map_cover("myanimelist", &item, &raw).is_empty());
    }
}
