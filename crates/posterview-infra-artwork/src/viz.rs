use posterview_contracts::{ArtworkItem, ItemDetail, ItemType, MangaCoverMetadata};
use posterview_url_security::provider_https;
use regex::Regex;
use reqwest::Client;

const VIZ_DOMAINS: &[&str] = &["viz.com", "www.viz.com"];

pub async fn fetch_viz(
    client: &Client,
    item: &ItemDetail,
    catalog_url: Option<&str>,
) -> Result<Vec<ArtworkItem>, String> {
    let catalog_url = catalog_url
        .ok_or("Paste a VIZ series catalog URL ending in /all to browse its volume covers.")?;
    let parsed = provider_https(catalog_url, VIZ_DOMAINS)?;
    if !parsed.path().starts_with("/manga-books/manga/") || !parsed.path().ends_with("/all") {
        return Err("Use a VIZ manga catalog URL ending in /all.".to_owned());
    }
    let response = client
        .get(parsed)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "VIZ request failed ({}).",
            response.status().as_u16()
        ));
    }
    parse_viz_catalog(
        &response.text().await.map_err(|error| error.to_string())?,
        item,
    )
}

fn parse_viz_catalog(html: &str, item: &ItemDetail) -> Result<Vec<ArtworkItem>, String> {
    let cards = Regex::new(r#"(?s)<article\b.*?<img[^>]+data-original=["'](https://dw9to29mmj727\.cloudfront\.net/products/[^"']+)["'][^>]*>.*?<a[^>]+href=["']([^"']+/product/[^"']+)["'][^>]*>([^<]+)</a>.*?</article>"#).map_err(|error| error.to_string())?;
    let volume = Regex::new(r"(?i)\bVol(?:ume)?\.?\s*([0-9]+(?:\.[0-9]+)?)")
        .map_err(|error| error.to_string())?;
    let kind = match item.item_type {
        ItemType::Book => "book",
        ItemType::Audiobook => "audiobook",
        ItemType::Folder => "folder",
        _ => return Err("VIZ covers are available for manga books and series folders.".to_owned()),
    };
    let mut results = Vec::new();
    for card in cards.captures_iter(html) {
        let title = decode_html(card[3].trim());
        let Some(number) = volume
            .captures(&title)
            .and_then(|c| c.get(1))
            .map(|v| v.as_str().to_owned())
        else {
            continue;
        };
        let image = card[1].to_owned();
        let product = format!("https://www.viz.com{}", &card[2]);
        results.push(ArtworkItem {
            manga: Some(MangaCoverMetadata {
                mangadex_id: String::new(),
                volume: Some(number),
                locale: Some("en".to_owned()),
                description: None,
            }),
            id: product.clone(),
            provider: "viz".to_owned(),
            artwork_type: "poster".to_owned(),
            kind: kind.to_owned(),
            season_number: None,
            title: Some(title),
            lang: Some("en".to_owned()),
            likes: None,
            thumb_url: image.clone(),
            download_url: image,
            applyable: true,
            source_url: Some(product),
        });
    }
    if results.is_empty() {
        return Err("VIZ did not return any numbered volume covers for this catalog.".to_owned());
    }
    Ok(results)
}

fn decode_html(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&#39;", "'")
        .replace("&quot;", "\"")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn parses_numbered_viz_volume_cards() {
        let html = r#"<article><img data-original="https://dw9to29mmj727.cloudfront.net/products/one.jpg" /><a href="/manga-books/manga/food-wars-volume-1/product/1">Food Wars!: Shokugeki no Soma, Vol. 1</a></article>"#;
        let item = ItemDetail {
            id: "series".to_owned(),
            title: "Food Wars!".to_owned(),
            year: None,
            item_type: ItemType::Folder,
            poster: None,
            background: None,
            added_at: None,
            summary: None,
            season_count: None,
            seasons: Vec::new(),
            external_ids: BTreeMap::new(),
            logo: None,
            members: Vec::new(),
            file_name: None,
            source_path: None,
            volume: None,
        };
        let covers = parse_viz_catalog(html, &item).unwrap();
        assert_eq!(covers.len(), 1);
        assert_eq!(
            covers[0].manga.as_ref().unwrap().volume.as_deref(),
            Some("1")
        );
    }

    #[tokio::test]
    #[ignore = "requires live VIZ access"]
    async fn live_food_wars_catalog_contains_all_volumes() {
        let item = ItemDetail {
            id: "series".to_owned(),
            title: "Food Wars!".to_owned(),
            year: None,
            item_type: ItemType::Folder,
            poster: None,
            background: None,
            added_at: None,
            summary: None,
            season_count: None,
            seasons: Vec::new(),
            external_ids: BTreeMap::new(),
            logo: None,
            members: Vec::new(),
            file_name: None,
            source_path: None,
            volume: None,
        };
        let client = Client::builder()
            .user_agent("PosterView/0.1")
            .build()
            .unwrap();
        let covers = fetch_viz(
            &client,
            &item,
            Some("https://www.viz.com/manga-books/manga/food-wars-shokugeki-no-soma/all"),
        )
        .await
        .unwrap();
        assert_eq!(covers.len(), 36);
        assert_eq!(
            covers
                .last()
                .unwrap()
                .manga
                .as_ref()
                .unwrap()
                .volume
                .as_deref(),
            Some("36")
        );
    }
}
