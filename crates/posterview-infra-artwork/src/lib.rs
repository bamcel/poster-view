mod posterdb;

use posterview_contracts::{
    ArtworkItem, ArtworkProviderInfo, ArtworkSearchResult, ItemDetail, ItemType,
};
use posterview_url_security::provider_https;
use reqwest::{Client, StatusCode};
use serde_json::{Value, json};
use std::{collections::HashMap, time::Duration};
use tokio::sync::Mutex;

pub use posterdb::PosterDbClient;

const USER_AGENT: &str = "PosterView/0.1 (+https://github.com/bamcel/poster-view)";
const FANART_BASE: &str = "https://webservice.fanart.tv/v3";
const ANILIST_URL: &str = "https://graphql.anilist.co";
const TVDB_BASE: &str = "https://api4.thetvdb.com/v4";
const TVDB_ART: &str = "https://artworks.thetvdb.com/";
const MEDIUX_BASE: &str = "https://mediux.pro";

#[derive(Debug)]
pub struct ArtworkService {
    client: Client,
    tvdb_token: Mutex<Option<String>>,
    tvdb_login_lock: Mutex<()>,
    tvdb_types: Mutex<Option<HashMap<i64, String>>>,
    posterdb: PosterDbClient,
}

impl Default for ArtworkService {
    fn default() -> Self {
        Self {
            client: http_client().expect("the shared artwork HTTP client should build"),
            tvdb_token: Mutex::new(None),
            tvdb_login_lock: Mutex::new(()),
            tvdb_types: Mutex::new(None),
            posterdb: PosterDbClient::default(),
        }
    }
}

impl ArtworkService {
    pub async fn test_fanart(&self, key: &str) -> Result<(), String> {
        if key.is_empty() {
            return Err("Fanart.tv API key is not configured (add it in Settings).".to_owned());
        }
        let response = self
            .client
            .get(format!("{FANART_BASE}/movies/550"))
            .query(&[("api_key", key)])
            .send()
            .await
            .map_err(network_error)?;
        if matches!(
            response.status(),
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
        ) {
            return Err("Fanart.tv rejected the API key — double-check it in Settings.".to_owned());
        }
        if !response.status().is_success() && response.status() != StatusCode::NOT_FOUND {
            return Err(format!("Fanart.tv error ({}).", response.status().as_u16()));
        }
        Ok(())
    }

    pub async fn test_tvdb(&self, key: &str, pin: &str) -> Result<(), String> {
        self.tvdb_login_request(key, pin).await.map(|_| ())
    }

    pub async fn reset_tvdb_cache(&self) {
        *self.tvdb_token.lock().await = None;
        *self.tvdb_types.lock().await = None;
    }

    pub fn provider_infos(
        &self,
        fanart_key: &str,
        tvdb_key: &str,
        enabled: &std::collections::HashSet<String>,
    ) -> Vec<ArtworkProviderInfo> {
        vec![
            provider("fanart", "Fanart.tv", !fanart_key.is_empty(), true, enabled),
            provider("tvdb", "TheTVDB", !tvdb_key.is_empty(), true, enabled),
            provider("anilist", "AniList", true, false, enabled),
            provider("mediux", "MediUX", true, false, enabled),
        ]
    }

    pub async fn fetch(
        &self,
        provider: &str,
        item: &ItemDetail,
        id_override: Option<&str>,
        fanart_key: &str,
        tvdb_key: &str,
        tvdb_pin: &str,
    ) -> Result<Vec<ArtworkItem>, String> {
        match provider {
            "fanart" => fetch_fanart(item, id_override, fanart_key).await,
            "anilist" => fetch_anilist(item, id_override).await,
            "tvdb" => self.fetch_tvdb(item, id_override, tvdb_key, tvdb_pin).await,
            "mediux" => fetch_mediux(item, id_override).await,
            _ => Err(format!("Unknown provider: {provider}")),
        }
    }

    pub async fn search(
        &self,
        provider: &str,
        query: &str,
        kind: &str,
        tvdb_key: &str,
        tvdb_pin: &str,
    ) -> Result<Vec<ArtworkSearchResult>, String> {
        if !matches!(provider, "tvdb" | "fanart" | "mediux") {
            return Err(format!("Title search isn't available for {provider}."));
        }
        let raw = self.tvdb_search(query, kind, tvdb_key, tvdb_pin).await?;
        Ok(raw
            .into_iter()
            .filter_map(|candidate| {
                let id = match provider {
                    "tvdb" => value_string(candidate.get("tvdb_id")),
                    "mediux" => remote_id(&candidate, "TheMovieDB.com"),
                    _ if kind == "series" => value_string(candidate.get("tvdb_id")),
                    _ => remote_id(&candidate, "TheMovieDB.com")
                        .or_else(|| remote_id(&candidate, "IMDB")),
                }?;
                Some(ArtworkSearchResult {
                    id,
                    name: candidate
                        .get("name")
                        .or_else(|| candidate.get("extended_title"))
                        .and_then(Value::as_str)
                        .unwrap_or(query)
                        .to_owned(),
                    year: value_string(candidate.get("year")),
                    thumb_url: candidate
                        .get("image_url")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                })
            })
            .collect())
    }

    async fn tvdb_login_request(&self, key: &str, pin: &str) -> Result<String, String> {
        if key.is_empty() {
            return Err("TheTVDB API key is not configured (add it in Settings).".to_owned());
        }
        let mut body = json!({"apikey": key});
        if !pin.is_empty() {
            body["pin"] = Value::String(pin.to_owned());
        }
        let response = self
            .client
            .post(format!("{TVDB_BASE}/login"))
            .json(&body)
            .send()
            .await
            .map_err(network_error)?;
        if !response.status().is_success() {
            return Err("TheTVDB rejected the API key/PIN — check them in Settings.".to_owned());
        }
        let data: Value = response.json().await.map_err(network_error)?;
        let token = data
            .pointer("/data/token")
            .and_then(Value::as_str)
            .ok_or_else(|| "TheTVDB login returned no token.".to_owned())?
            .to_owned();
        Ok(token)
    }

    async fn tvdb_token(&self, key: &str, pin: &str) -> Result<String, String> {
        if let Some(token) = { self.tvdb_token.lock().await.clone() } {
            return Ok(token);
        }
        let _login_guard = self.tvdb_login_lock.lock().await;
        if let Some(token) = { self.tvdb_token.lock().await.clone() } {
            return Ok(token);
        }
        let token = self.tvdb_login_request(key, pin).await?;
        *self.tvdb_token.lock().await = Some(token.clone());
        Ok(token)
    }

    async fn tvdb_get(
        &self,
        path: &str,
        query: &[(&str, &str)],
        key: &str,
        pin: &str,
    ) -> Result<reqwest::Response, String> {
        let token = self.tvdb_token(key, pin).await?;
        let mut response = self
            .client
            .get(format!("{TVDB_BASE}{path}"))
            .bearer_auth(&token)
            .query(query)
            .send()
            .await
            .map_err(network_error)?;
        if response.status() == StatusCode::UNAUTHORIZED {
            *self.tvdb_token.lock().await = None;
            let token = self.tvdb_token(key, pin).await?;
            response = self
                .client
                .get(format!("{TVDB_BASE}{path}"))
                .bearer_auth(token)
                .query(query)
                .send()
                .await
                .map_err(network_error)?;
        }
        Ok(response)
    }

    async fn tvdb_search(
        &self,
        query: &str,
        kind: &str,
        key: &str,
        pin: &str,
    ) -> Result<Vec<Value>, String> {
        if key.is_empty() {
            return Err("Title search needs a TheTVDB API key (Settings) — it's the only title search available (Fanart.tv itself has no search API).".to_owned());
        }
        let response = self
            .tvdb_get("/search", &[("query", query), ("type", kind)], key, pin)
            .await?;
        if !response.status().is_success() {
            return Err(format!("TheTVDB error ({}).", response.status().as_u16()));
        }
        let body: Value = response.json().await.map_err(network_error)?;
        Ok(body
            .get("data")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }

    async fn fetch_tvdb(
        &self,
        item: &ItemDetail,
        id_override: Option<&str>,
        key: &str,
        pin: &str,
    ) -> Result<Vec<ArtworkItem>, String> {
        if key.is_empty() {
            return Err("TheTVDB API key is not configured (add it in Settings).".to_owned());
        }
        let id = id_override
            .filter(|value| !value.is_empty())
            .or_else(|| item.external_ids.get("tvdb").map(String::as_str))
            .ok_or_else(|| "This item has no TheTVDB id (TVDB works best for shows).".to_owned())?;
        if self.tvdb_types.lock().await.is_none() {
            let response = self.tvdb_get("/artwork/types", &[], key, pin).await?;
            let body: Value = response.json().await.map_err(network_error)?;
            let types = body
                .get("data")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|entry| {
                    Some((
                        entry.get("id")?.as_i64()?,
                        entry
                            .get("slug")
                            .or_else(|| entry.get("name"))
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_lowercase(),
                    ))
                })
                .collect();
            *self.tvdb_types.lock().await = Some(types);
        }
        let record = if item.item_type == ItemType::Movie {
            "movies"
        } else {
            "series"
        };
        let response = self
            .tvdb_get(&format!("/{record}/{id}/extended"), &[], key, pin)
            .await?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(Vec::new());
        }
        if !response.status().is_success() {
            return Err(format!("TheTVDB error ({}).", response.status().as_u16()));
        }
        let body: Value = response.json().await.map_err(network_error)?;
        let types = self.tvdb_types.lock().await.clone().unwrap_or_default();
        let mut items = body
            .pointer("/data/artworks")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|art| {
                let slug = types.get(&art.get("type")?.as_i64()?)?;
                let artwork_type = slug_type(slug)?;
                let url = absolute_tvdb(art.get("image")?.as_str()?);
                Some(ArtworkItem {
                    id: value_string(art.get("id")).unwrap_or_else(|| url.clone()),
                    provider: "tvdb".to_owned(),
                    artwork_type: artwork_type.to_owned(),
                    kind: item_kind(item),
                    season_number: None,
                    title: Some(item.title.clone()),
                    lang: art
                        .get("language")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    likes: art.get("score").and_then(value_i64),
                    thumb_url: absolute_tvdb(
                        art.get("thumbnail")
                            .or_else(|| art.get("image"))
                            .and_then(Value::as_str)
                            .unwrap_or(""),
                    ),
                    download_url: url,
                    applyable: matches!(artwork_type, "poster" | "background" | "logo"),
                    source_url: None,
                })
            })
            .collect::<Vec<_>>();
        sort_artwork(&mut items);
        Ok(items)
    }

    pub const fn posterdb(&self) -> &PosterDbClient {
        &self.posterdb
    }
}

pub async fn download_public_image(provider: &str, url: &str) -> Result<(Vec<u8>, String), String> {
    let domains: &[&str] = match provider {
        "fanart" => &["fanart.tv"],
        "tvdb" => &["thetvdb.com"],
        "anilist" => &["anilist.co"],
        "mediux" => &["mediux.pro"],
        _ => return Err(format!("Unknown artwork provider: {provider}")),
    };
    let url = provider_https(url, domains)?;
    let response = provider_client(domains)?
        .get(url)
        .send()
        .await
        .map_err(network_error)?;
    if !response.status().is_success() {
        return Err(format!(
            "Image download failed ({}).",
            response.status().as_u16()
        ));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_owned();
    if !content_type.contains("image") {
        return Err("The artwork URL did not return an image.".to_owned());
    }
    let bytes = response.bytes().await.map_err(network_error)?;
    Ok((bytes.to_vec(), content_type))
}

async fn fetch_fanart(
    item: &ItemDetail,
    id_override: Option<&str>,
    key: &str,
) -> Result<Vec<ArtworkItem>, String> {
    if key.is_empty() {
        return Err("Fanart.tv API key is not configured (add it in Settings).".to_owned());
    }
    let (path, fields, kind): (_, &[(&str, &str, bool)], _) = if item.item_type == ItemType::Movie {
        let id = id_override
            .or_else(|| item.external_ids.get("tmdb").map(String::as_str))
            .or_else(|| item.external_ids.get("imdb").map(String::as_str))
            .ok_or_else(|| "This movie has no TMDB/IMDb id, which Fanart.tv needs.".to_owned())?;
        (
            format!("movies/{id}"),
            &[
                ("movieposter", "poster", false),
                ("moviebackground", "background", false),
                ("moviebanner", "banner", false),
                ("hdmovielogo", "logo", false),
                ("movielogo", "logo", false),
            ],
            "movie",
        )
    } else {
        let id = id_override
            .or_else(|| item.external_ids.get("tvdb").map(String::as_str))
            .ok_or_else(|| "This show has no TheTVDB id, which Fanart.tv needs.".to_owned())?;
        (
            format!("tv/{id}"),
            &[
                ("tvposter", "poster", false),
                ("showbackground", "background", false),
                ("tvbanner", "banner", false),
                ("hdtvlogo", "logo", false),
                ("clearlogo", "logo", false),
                ("seasonposter", "poster", true),
                ("seasonbanner", "banner", true),
            ],
            "show",
        )
    };
    let response = http_client()?
        .get(format!("{FANART_BASE}/{path}"))
        .query(&[("api_key", key)])
        .send()
        .await
        .map_err(network_error)?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(Vec::new());
    }
    if matches!(
        response.status(),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
    ) {
        return Err("Fanart.tv rejected the API key — double-check it in Settings.".to_owned());
    }
    if !response.status().is_success() {
        return Err(format!("Fanart.tv error ({}).", response.status().as_u16()));
    }
    let body: Value = response.json().await.map_err(network_error)?;
    let mut items = Vec::new();
    for (field, artwork_type, seasonal) in fields {
        for entry in body
            .get(field)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(url) = entry.get("url").and_then(Value::as_str) else {
                continue;
            };
            let url = url.replace("http://", "https://");
            let season_number = seasonal
                .then(|| {
                    let raw = value_string(entry.get("season")).unwrap_or_default();
                    if matches!(raw.to_lowercase().as_str(), "specials" | "0") {
                        Some(0)
                    } else {
                        raw.parse().ok()
                    }
                })
                .flatten();
            items.push(ArtworkItem {
                id: value_string(entry.get("id")).unwrap_or_else(|| url.clone()),
                provider: "fanart".to_owned(),
                artwork_type: (*artwork_type).to_owned(),
                kind: if *seasonal { "season" } else { kind }.to_owned(),
                season_number,
                title: Some(item.title.clone()),
                lang: entry
                    .get("lang")
                    .and_then(Value::as_str)
                    .filter(|v| !v.is_empty())
                    .map(str::to_owned),
                likes: entry.get("likes").and_then(value_i64),
                thumb_url: url.clone(),
                download_url: url,
                applyable: matches!(*artwork_type, "poster" | "background" | "logo"),
                source_url: None,
            });
        }
    }
    sort_artwork(&mut items);
    Ok(items)
}

async fn fetch_anilist(
    item: &ItemDetail,
    id_override: Option<&str>,
) -> Result<Vec<ArtworkItem>, String> {
    const QUERY: &str = "query ($search: String, $id: Int) { Media(search: $search, id: $id, type: ANIME, sort: SEARCH_MATCH) { id title { romaji english } coverImage { extraLarge large } bannerImage } }";
    let raw = id_override
        .or_else(|| item.external_ids.get("anilist").map(String::as_str))
        .unwrap_or("")
        .trim();
    let variables = if let Ok(id) = raw.parse::<i64>() {
        json!({"id": id})
    } else {
        json!({"search": if raw.is_empty() { strip_year(&item.title) } else { raw.to_owned() }})
    };
    let response = http_client()?
        .post(ANILIST_URL)
        .json(&json!({"query": QUERY, "variables": variables}))
        .send()
        .await
        .map_err(network_error)?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(Vec::new());
    }
    if !response.status().is_success() {
        return Err(format!("AniList error ({}).", response.status().as_u16()));
    }
    let body: Value = response.json().await.map_err(network_error)?;
    let Some(media) = body.pointer("/data/Media") else {
        return Ok(Vec::new());
    };
    let id = value_string(media.get("id")).unwrap_or_default();
    let mut items = Vec::new();
    if let Some(url) = media
        .pointer("/coverImage/extraLarge")
        .or_else(|| media.pointer("/coverImage/large"))
        .and_then(Value::as_str)
    {
        items.push(ArtworkItem {
            id: format!("anilist-{id}-poster"),
            provider: "anilist".to_owned(),
            artwork_type: "poster".to_owned(),
            kind: item_kind(item),
            season_number: None,
            title: Some(item.title.clone()),
            lang: None,
            likes: None,
            thumb_url: url.to_owned(),
            download_url: url.to_owned(),
            applyable: true,
            source_url: Some(format!("https://anilist.co/anime/{id}")),
        });
    }
    if let Some(url) = media.get("bannerImage").and_then(Value::as_str) {
        items.push(ArtworkItem {
            id: format!("anilist-{id}-banner"),
            provider: "anilist".to_owned(),
            artwork_type: "banner".to_owned(),
            kind: item_kind(item),
            season_number: None,
            title: Some(item.title.clone()),
            lang: None,
            likes: None,
            thumb_url: url.to_owned(),
            download_url: url.to_owned(),
            applyable: false,
            source_url: Some(format!("https://anilist.co/anime/{id}")),
        });
    }
    Ok(items)
}

async fn fetch_mediux(
    item: &ItemDetail,
    id_override: Option<&str>,
) -> Result<Vec<ArtworkItem>, String> {
    let id = id_override
        .or_else(|| item.external_ids.get("tmdb").map(String::as_str))
        .ok_or_else(|| "This item has no TMDB id, which MediUX needs.".to_owned())?;
    let path = match item.item_type {
        ItemType::Show => "shows",
        ItemType::Collection => "collections",
        ItemType::Movie => "movies",
    };
    let response = http_client()?
        .get(format!("{MEDIUX_BASE}/{path}/{id}"))
        .header(
            reqwest::header::ACCEPT,
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )
        .send()
        .await
        .map_err(network_error)?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(Vec::new());
    }
    if !response.status().is_success() {
        return Err(format!("MediUX error ({}).", response.status().as_u16()));
    }
    parse_mediux(&response.text().await.map_err(network_error)?, item)
}

pub async fn fetch_mediux_thumb(url: &str) -> Result<(Vec<u8>, String), String> {
    let parsed = provider_https(url, &["mediux.pro"])?;
    if parsed.host_str() != Some("mediux.pro") || parsed.path() != "/_next/image" {
        return Err("Refusing to proxy a non-MediUX URL.".to_owned());
    }
    let response = provider_client(&["mediux.pro"])?
        .get(parsed)
        .header(reqwest::header::REFERER, "https://mediux.pro/")
        .send()
        .await
        .map_err(network_error)?;
    image_response(response, "MediUX image proxy").await
}

fn parse_mediux(html: &str, item: &ItemDetail) -> Result<Vec<ArtworkItem>, String> {
    let card_pattern =
        regex::Regex::new(r#"(?s)(aspect-(?:2/3|video)).{0,2000}?<img[^>]+src=["']([^"']+)["']"#)
            .map_err(|error| error.to_string())?;
    let mut seen = std::collections::HashSet::new();
    let mut items = Vec::new();
    for capture in card_pattern.captures_iter(html) {
        let src = &capture[2];
        let Some(encoded) = src
            .split("url=")
            .nth(1)
            .and_then(|value| value.split('&').next())
        else {
            continue;
        };
        let asset_url = percent_decode(encoded);
        if !asset_url.starts_with("http") || !seen.insert(asset_url.clone()) {
            continue;
        }
        let artwork_type = if &capture[1] == "aspect-2/3" {
            "poster"
        } else {
            "background"
        };
        let proxy = format!(
            "{MEDIUX_BASE}/_next/image?url={}&w=256&q=75",
            percent_encode(&asset_url)
        );
        items.push(ArtworkItem {
            id: asset_url.clone(),
            provider: "mediux".to_owned(),
            artwork_type: artwork_type.to_owned(),
            kind: item_kind(item),
            season_number: None,
            title: Some(item.title.clone()),
            lang: None,
            likes: None,
            thumb_url: format!("/api/artwork/mediux/image?url={}", percent_encode(&proxy)),
            download_url: asset_url,
            applyable: true,
            source_url: None,
        });
    }
    Ok(items)
}

async fn image_response(
    response: reqwest::Response,
    label: &str,
) -> Result<(Vec<u8>, String), String> {
    if !response.status().is_success() {
        return Err(format!("{label} error ({}).", response.status().as_u16()));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_owned();
    let bytes = response.bytes().await.map_err(network_error)?;
    Ok((bytes.to_vec(), content_type))
}

fn provider(
    name: &str,
    label: &str,
    configured: bool,
    needs_key: bool,
    enabled: &std::collections::HashSet<String>,
) -> ArtworkProviderInfo {
    ArtworkProviderInfo {
        name: name.to_owned(),
        label: label.to_owned(),
        configured,
        needs_key,
        enabled: enabled.contains(name),
    }
}

fn http_client() -> Result<Client, String> {
    provider_client(&["fanart.tv", "anilist.co", "thetvdb.com", "mediux.pro"])
}

fn provider_client(domains: &[&str]) -> Result<Client, String> {
    let domains = domains
        .iter()
        .map(|value| (*value).to_owned())
        .collect::<Vec<_>>();
    let redirects = reqwest::redirect::Policy::custom(move |attempt| {
        let allowed = domains.iter().map(String::as_str).collect::<Vec<_>>();
        if attempt.previous().len() >= 10
            || provider_https(attempt.url().as_str(), &allowed).is_err()
        {
            attempt.stop()
        } else {
            attempt.follow()
        }
    });
    Client::builder()
        .user_agent(USER_AGENT)
        .redirect(redirects)
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(network_error)
}

fn network_error(error: reqwest::Error) -> String {
    error.to_string()
}
fn value_string(value: Option<&Value>) -> Option<String> {
    value?
        .as_str()
        .map(str::to_owned)
        .or_else(|| value?.as_i64().map(|v| v.to_string()))
}
fn value_i64(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| value.as_str()?.parse().ok())
}
fn item_kind(item: &ItemDetail) -> String {
    match item.item_type {
        ItemType::Movie => "movie",
        ItemType::Show => "show",
        ItemType::Collection => "collection",
    }
    .to_owned()
}
fn sort_artwork(items: &mut [ArtworkItem]) {
    items.sort_by(|a, b| {
        a.artwork_type
            .cmp(&b.artwork_type)
            .then_with(|| b.likes.unwrap_or(0).cmp(&a.likes.unwrap_or(0)))
    });
}
fn slug_type(slug: &str) -> Option<&'static str> {
    let value = slug.to_lowercase();
    if value.contains("poster") {
        Some("poster")
    } else if value.contains("banner") {
        Some("banner")
    } else if value.contains("background") || value.contains("fanart") {
        Some("background")
    } else if value.contains("clearlogo") || value == "logo" {
        Some("logo")
    } else {
        None
    }
}
fn absolute_tvdb(url: &str) -> String {
    if url.starts_with("http") {
        url.to_owned()
    } else {
        format!("{TVDB_ART}{}", url.trim_start_matches('/'))
    }
}
fn remote_id(candidate: &Value, source: &str) -> Option<String> {
    candidate
        .get("remote_ids")?
        .as_array()?
        .iter()
        .find(|entry| entry.get("sourceName").and_then(Value::as_str) == Some(source))
        .and_then(|entry| value_string(entry.get("id")))
}
fn strip_year(title: &str) -> String {
    regex::Regex::new(r"\s*\(\d{4}\)\s*$")
        .expect("valid regex")
        .replace(title, "")
        .trim()
        .to_owned()
}

pub(crate) fn percent_encode(value: &str) -> String {
    value.bytes().fold(String::new(), |mut output, byte| {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            output.push(char::from(byte));
        } else {
            use std::fmt::Write as _;
            let _ = write!(output, "%{byte:02X}");
        }
        output
    })
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && let Ok(byte) = u8::from_str_radix(&value[index + 1..index + 3], 16)
        {
            output.push(byte);
            index += 3;
            continue;
        }
        output.push(if bytes[index] == b'+' {
            b' '
        } else {
            bytes[index]
        });
        index += 1;
    }
    String::from_utf8_lossy(&output).into_owned()
}

#[cfg(test)]
mod tests {
    use super::{slug_type, strip_year};

    #[test]
    fn shared_normalizers_match_python_provider_behavior() {
        assert_eq!(slug_type("series-background"), Some("background"));
        assert_eq!(slug_type("clearlogo"), Some("logo"));
        assert_eq!(strip_year("Example (2024)"), "Example");
    }
}
