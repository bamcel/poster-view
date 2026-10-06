use super::*;
use std::time::Instant;

#[derive(Default)]
pub(super) struct DeviantArt {
    token: Mutex<Option<(String, String, String, Instant)>>,
}
impl std::fmt::Debug for DeviantArt {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("DeviantArt { credentials: [redacted] }")
    }
}
impl DeviantArt {
    pub(super) async fn token(
        &self,
        client: &Client,
        id: &str,
        secret: &str,
    ) -> Result<String, String> {
        if id.trim().is_empty() || secret.trim().is_empty() {
            return Err(
                "Configure a DeviantArt client ID and client secret in Search Providers.".into(),
            );
        }
        let mut cached = self.token.lock().await;
        if let Some((old_id, old_secret, token, expires)) = cached.as_ref()
            && old_id == id
            && old_secret == secret
            && *expires > Instant::now()
        {
            return Ok(token.clone());
        }
        let response = client
            .post("https://www.deviantart.com/oauth2/token")
            .form(&[
                ("grant_type", "client_credentials"),
                ("client_id", id),
                ("client_secret", secret),
            ])
            .send()
            .await
            .map_err(network_error)?;
        if !response.status().is_success() {
            return Err(provider_status_error("DeviantArt", response.status()));
        }
        let raw: Value = response.json().await.map_err(network_error)?;
        let token = raw["access_token"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("DeviantArt did not return an access token.")?
            .to_owned();
        let lifetime = raw["expires_in"]
            .as_u64()
            .unwrap_or(300)
            .min(86400)
            .saturating_sub(30);
        *cached = Some((
            id.into(),
            secret.into(),
            token.clone(),
            Instant::now() + Duration::from_secs(lifetime),
        ));
        Ok(token)
    }
    pub(super) async fn fetch(
        &self,
        client: &Client,
        id: &str,
        secret: &str,
        item: &ItemDetail,
        lookup: Option<&str>,
    ) -> Result<Vec<ArtworkItem>, String> {
        let input = lookup.unwrap_or(&item.title);
        let (text, offset) = input
            .rsplit_once('|')
            .map(|(tag, offset)| (tag, offset.parse::<u32>().unwrap_or(0).min(50000)))
            .unwrap_or((input, 0));
        let tag = tag(text)?;
        let token = self.token(client, id, secret).await?;
        let response = client
            .get("https://www.deviantart.com/api/v1/oauth2/browse/tags")
            .bearer_auth(token)
            .query(&[
                ("tag", tag.as_str()),
                ("limit", "50"),
                ("offset", &offset.to_string()),
                ("mature_content", "false"),
            ])
            .send()
            .await
            .map_err(network_error)?;
        if !response.status().is_success() {
            if response.status() == StatusCode::UNAUTHORIZED {
                *self.token.lock().await = None;
            }
            return Err(provider_status_error("DeviantArt", response.status()));
        }
        let raw: Value = response.json().await.map_err(network_error)?;
        Ok(raw["results"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|row| map_art(row, item))
            .collect())
    }
}
fn tag(value: &str) -> Result<String, String> {
    let tag: String = value
        .trim()
        .trim_start_matches('#')
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '_')
        .flat_map(char::to_lowercase)
        .collect();
    if tag.is_empty() || tag.chars().count() > 100 {
        return Err("Enter a DeviantArt tag of up to 100 characters.".into());
    }
    Ok(tag)
}
fn image_url(value: &Value) -> Option<&str> {
    value["src"].as_str().filter(|url| {
        provider_https(url, &["wixmp.com", "deviantart.net", "deviantart.com"]).is_ok()
    })
}
fn animated_url(url: &str) -> bool {
    let path = url.split(['?', '#']).next().unwrap_or(url).to_ascii_lowercase();
    [".gif", ".webm"].iter().any(|extension| path.ends_with(extension))
}
fn map_art(row: &Value, item: &ItemDetail) -> Option<ArtworkItem> {
    if row["is_mature"].as_bool().unwrap_or(false) {
        return None;
    }
    let content = &row["content"];
    let url = image_url(content)?;
    let thumb = row["thumbs"]
        .as_array()
        .and_then(|a| a.last())
        .and_then(image_url)
        .unwrap_or(url);
    let width = content["width"].as_u64().unwrap_or(0);
    let height = content["height"].as_u64().unwrap_or(0);
    let source = row["url"]
        .as_str()
        .filter(|url| provider_https(url, &["deviantart.com"]).is_ok());
    Some(ArtworkItem {
        manga: None,
        id: format!("deviantart-{}", row["deviationid"].as_str()?),
        provider: "deviantart".into(),
        artwork_type: if animated_url(url) {
            "animated"
        } else if width > height {
            "background"
        } else {
            "poster"
        }
        .into(),
        kind: item_kind(item),
        season_number: None,
        title: row["title"].as_str().map(|title| {
            row["author"]["username"]
                .as_str()
                .map(|author| format!("{title} — {author}"))
                .unwrap_or_else(|| title.into())
        }),
        lang: None,
        likes: row["stats"]["favourites"]
            .as_u64()
            .and_then(|n| n.try_into().ok()),
        thumb_url: thumb.into(),
        download_url: url.into(),
        applyable: true,
        source_url: source.map(str::to_owned),
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn title_tags_remove_spaces_and_punctuation() {
        assert_eq!(tag("Akame ga Kill!"), Ok("akamegakill".into()));
        assert_eq!(tag("#Angel_Beats"), Ok("angel_beats".into()));
        assert!(tag("!!!").is_err());
    }
    #[test]
    fn images_reject_untrusted_hosts() {
        assert!(image_url(&json!({"src":"https://images-wixmp.example.com/image.jpg"})).is_none());
        assert!(
            image_url(&json!({"src":"https://images-wixmp-123.wixmp.com/image.jpg"})).is_some()
        );
        assert!(image_url(&json!({"src":"http://deviantart.net/image.jpg"})).is_none());
    }
    #[test]
    fn maps_images_and_credits_artist_without_using_untrusted_or_mature_images() {
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

        let mut raw = json!({"deviationid":"abc", "title":"Artwork", "author":{"username":"artist"}, "url":"https://www.deviantart.com/artist/art/example", "content":{"src":"https://images.wixmp.com/art.jpg","width":1920,"height":1080}, "thumbs":[{"src":"https://images.wixmp.com/thumb.jpg"}], "stats":{"favourites":42}});
        let art = map_art(&raw, &item).unwrap();
        assert_eq!(art.artwork_type, "background");
        assert_eq!(art.title.as_deref(), Some("Artwork — artist"));
        assert_eq!(art.thumb_url, "https://images.wixmp.com/thumb.jpg");
        raw["content"]["width"] = json!(500);
        assert_eq!(map_art(&raw, &item).unwrap().artwork_type, "poster");
        raw["content"]["src"] = json!("https://images.wixmp.com/art.GIF?token=example");
        assert_eq!(map_art(&raw, &item).unwrap().artwork_type, "animated");
        raw["content"]["src"] = json!("https://images.wixmp.com/art.webm");
        assert_eq!(map_art(&raw, &item).unwrap().artwork_type, "animated");
        raw["is_mature"] = json!(true);
        assert!(map_art(&raw, &item).is_none());
        raw["is_mature"] = json!(false);
        raw["content"]["src"] = json!("https://example.com/image.jpg");
        assert!(map_art(&raw, &item).is_none());
    }
}
