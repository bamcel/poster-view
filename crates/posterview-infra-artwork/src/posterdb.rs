use posterview_contracts::{
    PosterAsset, PosterCategory, PosterDbStatus, PosterSearchResults, PosterSet, PosterTitleResult,
};
use regex::Regex;
use reqwest::{Client, Method, StatusCode};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::{
    sync::{Mutex, Semaphore},
    task::JoinSet,
};

use crate::percent_encode;

const BASE: &str = "https://theposterdb.com";
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/127 Safari/537.36 PosterView/0.1";

#[derive(Debug)]
struct State {
    client: Client,
    cookie: String,
    logged_in: bool,
    email: String,
    title_counts: HashMap<String, i64>,
}

#[derive(Debug, Clone)]
pub struct PosterDbClient {
    state: Arc<Mutex<State>>,
    login_lock: Arc<Mutex<()>>,
}

impl Default for PosterDbClient {
    fn default() -> Self {
        let client = Client::builder()
            .user_agent(USER_AGENT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("PosterDB HTTP client configuration is valid");
        Self {
            state: Arc::new(Mutex::new(State {
                client,
                cookie: String::new(),
                logged_in: false,
                email: String::new(),
                title_counts: HashMap::new(),
            })),
            login_lock: Arc::new(Mutex::new(())),
        }
    }
}

struct WebResponse {
    status: StatusCode,
    url: String,
    content_type: String,
    body: Vec<u8>,
}

impl PosterDbClient {
    pub async fn reset(&self) {
        let mut state = self.state.lock().await;
        state.logged_in = false;
        state.email.clear();
        state.cookie.clear();
    }

    pub async fn status(&self, email: &str, password: &str, message: &str) -> PosterDbStatus {
        let state = self.state.lock().await;
        PosterDbStatus {
            configured: !email.is_empty() && !password.is_empty(),
            email: email.to_owned(),
            logged_in: state.logged_in && state.email == email,
            message: message.to_owned(),
        }
    }

    pub async fn login(&self, email: &str, password: &str) -> Result<(), String> {
        if email.is_empty() || password.is_empty() {
            return Err("ThePosterDB credentials are not configured.".to_owned());
        }
        self.reset().await;
        let page = self.request(Method::GET, "/login", None, None).await?;
        let html = String::from_utf8_lossy(&page.body);
        if is_blocked(&html) {
            return Err("ThePosterDB blocked the login with a bot challenge (Cloudflare). Try again shortly; a browser mode may be needed if it persists.".to_owned());
        }
        let token = csrf(&html).unwrap_or_default();
        let form = [
            ("_token", token.as_str()),
            ("email", email),
            ("login", email),
            ("password", password),
            ("remember", "on"),
        ]
        .iter()
        .map(|(key, value)| format!("{}={}", percent_encode(key), percent_encode(value)))
        .collect::<Vec<_>>()
        .join("&");
        let response = self
            .request(
                Method::POST,
                "/login",
                Some(form.into_bytes()),
                Some("application/x-www-form-urlencoded"),
            )
            .await?;
        let body = String::from_utf8_lossy(&response.body).to_lowercase();
        let landed_on_login = response.url.trim_end_matches('/').ends_with("/login");
        if (landed_on_login && body.contains("password"))
            || [
                "these credentials do not match",
                "the provided credentials",
                "do not match our records",
            ]
            .iter()
            .any(|phrase| body.contains(phrase))
        {
            return Err("Login failed — check the email and password.".to_owned());
        }
        let mut state = self.state.lock().await;
        state.logged_in = true;
        state.email = email.to_owned();
        Ok(())
    }

    async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<Vec<u8>>,
        content_type: Option<&str>,
    ) -> Result<WebResponse, String> {
        let mut url = absolute_url(path);
        let mut current_method = method;
        let mut current_body = body;
        for _ in 0..10 {
            // Never hold the session lock while waiting on the network. Search and
            // title verification intentionally issue independent GETs concurrently.
            let (client, cookie) = {
                let state = self.state.lock().await;
                (state.client.clone(), state.cookie.clone())
            };
            let mut request = client.request(current_method.clone(), &url);
            if !cookie.is_empty() {
                request = request.header(reqwest::header::COOKIE, cookie);
            }
            if let Some(value) = content_type {
                request = request.header(reqwest::header::CONTENT_TYPE, value);
            }
            if let Some(bytes) = current_body.clone() {
                request = request.body(bytes);
            }
            let response = request.send().await.map_err(|error| error.to_string())?;
            {
                let mut state = self.state.lock().await;
                merge_cookies(&mut state.cookie, response.headers());
            }
            if response.status().is_redirection() {
                let location = response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .ok_or_else(|| "ThePosterDB returned an invalid redirect.".to_owned())?;
                url = absolute_url(location);
                if matches!(
                    response.status(),
                    StatusCode::MOVED_PERMANENTLY | StatusCode::FOUND | StatusCode::SEE_OTHER
                ) {
                    current_method = Method::GET;
                    current_body = None;
                }
                continue;
            }
            let status = response.status();
            let final_url = response.url().to_string();
            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .unwrap_or("")
                .to_owned();
            let bytes = response.bytes().await.map_err(|error| error.to_string())?;
            return Ok(WebResponse {
                status,
                url: final_url,
                content_type,
                body: bytes.to_vec(),
            });
        }
        Err("ThePosterDB redirected too many times.".to_owned())
    }

    async fn ensure_login(&self, email: &str, password: &str) -> Result<(), String> {
        let is_logged_in = || async {
            let state = self.state.lock().await;
            state.logged_in && state.email == email
        };
        if is_logged_in().await {
            return Ok(());
        }

        // A cold search starts three section requests together. Only the initial
        // login handshake is serialized; the section GETs proceed concurrently.
        let _login_guard = self.login_lock.lock().await;
        if is_logged_in().await {
            return Ok(());
        }
        self.login(email, password).await
    }

    async fn html(&self, path: &str, email: &str, password: &str) -> Result<String, String> {
        self.ensure_login(email, password).await?;
        let mut response = self.request(Method::GET, path, None, None).await?;
        if response.status == StatusCode::UNAUTHORIZED
            || response.status.as_u16() == 419
            || response.url.trim_end_matches('/').ends_with("/login")
        {
            self.reset().await;
            self.ensure_login(email, password).await?;
            response = self.request(Method::GET, path, None, None).await?;
        }
        let body = String::from_utf8_lossy(&response.body).into_owned();
        if is_blocked(&body) || response.status == StatusCode::SERVICE_UNAVAILABLE {
            return Err("ThePosterDB blocked the request with a bot challenge (Cloudflare). Wait a moment and retry.".to_owned());
        }
        if !response.status.is_success() {
            return Err(format!(
                "ThePosterDB request failed ({}).",
                response.status.as_u16()
            ));
        }
        Ok(body)
    }

    pub async fn search(
        &self,
        term: &str,
        email: &str,
        password: &str,
    ) -> Result<PosterSearchResults, String> {
        let movies_path = format!("/search?term={}&section=movies", percent_encode(term));
        let shows_path = format!("/search?term={}&section=shows", percent_encode(term));
        let collections_path = format!("/search?term={}&section=collections", percent_encode(term));
        let (movies, shows, collections) = tokio::join!(
            self.html(&movies_path, email, password),
            self.html(&shows_path, email, password),
            self.html(&collections_path, email, password),
        );

        let mut categories = Vec::new();
        let mut errors = Vec::new();
        for (section, page) in [
            ("movies", movies),
            ("shows", shows),
            ("collections", collections),
        ] {
            match page {
                Ok(html) => {
                    let results = parse_title_results(&html)?;
                    let count = tab_count(&html, section).unwrap_or(results.len());
                    categories.push(PosterCategory {
                        name: capitalize(section),
                        count,
                        results,
                    });
                }
                Err(error) => errors.push(format!("{section}: {error}")),
            }
        }
        if categories.is_empty() {
            return Err(format!("ThePosterDB search failed: {}", errors.join("; ")));
        }
        Ok(PosterSearchResults {
            term: term.to_owned(),
            categories,
        })
    }

    pub async fn get_set(
        &self,
        url_or_id: &str,
        email: &str,
        password: &str,
    ) -> Result<PosterSet, String> {
        let mut path = normalize_path(url_or_id);
        let mut html = self.html(&path, email, password).await?;
        if path.starts_with("/poster/")
            && let Some(link) = set_link(&html)
        {
            path = normalize_path(&link);
            html = self.html(&path, email, password).await?;
        }
        let mut posters = parse_grid(&html)?;
        if posters.is_empty() && path.starts_with("/poster/") {
            let id = path.rsplit('/').next().unwrap_or_default();
            posters.push(single_asset(id));
        }
        Ok(PosterSet {
            set_url: absolute_url(&path),
            title: first_text_tag(&html, "h1").or_else(|| first_text_tag(&html, "h2")),
            posters,
        })
    }

    pub async fn verify_titles(
        &self,
        ids: &[String],
        email: &str,
        password: &str,
    ) -> Result<HashMap<String, i64>, String> {
        let mut result = HashMap::new();
        let mut missing = Vec::new();
        let mut seen = HashSet::new();
        {
            let state = self.state.lock().await;
            for id in ids.iter().take(48).filter(|id| seen.insert((*id).clone())) {
                if let Some(count) = state.title_counts.get(id).copied() {
                    result.insert(id.clone(), count);
                } else {
                    missing.push(id.clone());
                }
            }
        }

        let limit = Arc::new(Semaphore::new(12));
        let mut tasks = JoinSet::new();
        for id in missing {
            let client = self.clone();
            let email = email.to_owned();
            let password = password.to_owned();
            let limit = Arc::clone(&limit);
            tasks.spawn(async move {
                let _permit = limit.acquire_owned().await.ok();
                let count = client
                    .html(&format!("/posters/{id}"), &email, &password)
                    .await
                    .map(|html| html.matches("data-poster-id").count() as i64)
                    .unwrap_or(-1);
                (id, count)
            });
        }

        let mut fetched = Vec::new();
        while let Some(outcome) = tasks.join_next().await {
            if let Ok(value) = outcome {
                fetched.push(value);
            }
        }

        let mut state = self.state.lock().await;
        if state.title_counts.len() > 3000 {
            state.title_counts.clear();
        }
        for (id, count) in fetched {
            state.title_counts.insert(id.clone(), count);
            result.insert(id, count);
        }
        Ok(result)
    }

    pub async fn image(
        &self,
        url_or_id: &str,
        email: &str,
        password: &str,
        thumbnail: bool,
    ) -> Result<(Vec<u8>, String), String> {
        let url = if url_or_id.starts_with("http") {
            url_or_id.to_owned()
        } else {
            asset_url(url_or_id)
        };
        if thumbnail
            && !url.starts_with("https://images.theposterdb.com/")
            && !url.starts_with("https://theposterdb.com/")
        {
            return Err("Refusing to proxy a non-ThePosterDB URL.".to_owned());
        }
        self.ensure_login(email, password).await?;
        let mut response = None;
        for attempt in 1..=3 {
            let current = self.request(Method::GET, &url, None, None).await?;
            if matches!(
                current.status,
                StatusCode::TOO_MANY_REQUESTS | StatusCode::SERVICE_UNAVAILABLE
            ) {
                tokio::time::sleep(std::time::Duration::from_millis(500 * attempt)).await;
                continue;
            }
            response = Some(current);
            break;
        }
        let response = response.ok_or_else(|| "Download failed (no response).".to_owned())?;
        if !response.status.is_success() {
            return Err(format!("Download failed ({}).", response.status.as_u16()));
        }
        if !response.content_type.contains("image") {
            return Err(
                "ThePosterDB did not return an image (session may have expired).".to_owned(),
            );
        }
        Ok((response.body, response.content_type))
    }
}

fn merge_cookies(cookie: &mut String, headers: &reqwest::header::HeaderMap) {
    let mut values = cookie
        .split(';')
        .filter_map(|part| part.trim().split_once('='))
        .map(|(key, value)| (key.to_owned(), value.to_owned()))
        .collect::<HashMap<_, _>>();
    for header in headers.get_all(reqwest::header::SET_COOKIE) {
        if let Ok(raw) = header.to_str()
            && let Some((key, value)) = raw.split(';').next().and_then(|part| part.split_once('='))
        {
            values.insert(key.trim().to_owned(), value.trim().to_owned());
        }
    }
    *cookie = values
        .into_iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("; ");
}

fn parse_title_results(html: &str) -> Result<Vec<PosterTitleResult>, String> {
    let anchors = Regex::new(r#"(?is)<a[^>]+href=["']([^"']*(?:/posters/|/set/|/collection/)\d+[^"']*)["'][^>]*>(.*?)</a>"#).map_err(|error| error.to_string())?;
    let mut seen = HashSet::new();
    let mut results = Vec::new();
    for capture in anchors.captures_iter(html) {
        let href = html_unescape(&capture[1]);
        let Some(id) = title_id(&href) else { continue };
        let title = strip_tags(&capture[2]);
        if title.is_empty() || !seen.insert(href.clone()) {
            continue;
        }
        results.push(PosterTitleResult {
            title,
            url: absolute_url(&href),
            media_id: id,
        });
        if results.len() >= 48 {
            break;
        }
    }
    Ok(results)
}

fn parse_grid(html: &str) -> Result<Vec<PosterAsset>, String> {
    let id_pattern =
        Regex::new(r#"data-poster-id=["'](\d+)["']"#).map_err(|error| error.to_string())?;
    let card_pattern = Regex::new(
        r#"(?is)<div[^>]+class=["'][^"']*\bcol-6\b[^"']*\bcol-lg-2\b[^"']*\bp-1\b[^"']*["'][^>]*>"#,
    )
    .map_err(|error| error.to_string())?;
    let card_starts = card_pattern
        .find_iter(html)
        .map(|found| found.start())
        .collect::<Vec<_>>();
    let mut seen = HashSet::new();
    let mut assets = Vec::new();
    for capture in id_pattern.captures_iter(html) {
        let id = capture[1].to_owned();
        if !seen.insert(id.clone()) {
            continue;
        }
        let capture_start = capture.get(0).map_or(0, |value| value.start());
        let start = card_starts
            .iter()
            .rev()
            .find(|start| **start <= capture_start)
            .copied()
            .unwrap_or_else(|| capture_start.saturating_sub(1500));
        let end = card_starts
            .iter()
            .find(|next| **next > capture_start)
            .copied()
            .unwrap_or_else(|| (capture_start + 2500).min(html.len()));
        let card = &html[start..end];
        let title = first_text_tag_with_class(card, "p", "text-break")
            .unwrap_or_else(|| format!("Poster {id}"));
        let media_type = capture_attribute(card, "title").unwrap_or_default();
        let (kind, season_number) = classify(&media_type, &title);
        let thumb = capture_attribute(card, "srcset")
            .and_then(|value| value.split_whitespace().next().map(str::to_owned))
            .or_else(|| capture_attribute(card, "data-src"))
            .filter(|value| value.starts_with("http"))
            .unwrap_or_else(|| asset_url(&id));
        let (set_size, set_url) = set_badge(card);
        assets.push(PosterAsset {
            id: id.clone(),
            title,
            kind,
            season_number,
            thumb_url: proxy_thumb(&thumb),
            download_url: asset_url(&id),
            set_size,
            set_url,
        });
    }
    Ok(assets)
}

fn set_badge(card: &str) -> (Option<i64>, Option<String>) {
    let Ok(anchors) = Regex::new(r#"(?is)<a\b([^>]*)>(.*?)</a>"#) else {
        return (None, None);
    };
    let Ok(digits) = Regex::new(r"[\d,]+") else {
        return (None, None);
    };
    for capture in anchors.captures_iter(card) {
        let attributes = &capture[1];
        if !attributes.contains("set_poster_count") {
            continue;
        }
        let badge_text = strip_tags(&capture[2]);
        let count = digits
            .find(&badge_text)
            .map(|value| value.as_str().to_owned())
            .and_then(|value| value.replace(',', "").parse().ok());
        let url = capture_attribute(attributes, "href").map(|href| absolute_url(&href));
        return (count, url);
    }
    (None, None)
}

fn tab_count(html: &str, section: &str) -> Option<usize> {
    let pattern = Regex::new(&format!(r"(?is)>{section}\s+([\d,]+)<")).ok()?;
    pattern
        .captures(html)?
        .get(1)?
        .as_str()
        .replace(',', "")
        .parse()
        .ok()
}

fn set_link(html: &str) -> Option<String> {
    let pattern = Regex::new(r#"(?is)<a[^>]+(?:title=["']View Set Page["']|class=["'][^"']*view_all[^"']*["'])[^>]+href=["']([^"']+)["']"#).ok()?;
    pattern
        .captures(html)
        .map(|capture| html_unescape(&capture[1]))
}

fn csrf(html: &str) -> Option<String> {
    let meta = Regex::new(r#"(?is)<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']"#)
        .ok()?;
    if let Some(capture) = meta.captures(html) {
        return Some(html_unescape(&capture[1]));
    }
    let input =
        Regex::new(r#"(?is)<input[^>]+name=["']_token["'][^>]+value=["']([^"']+)["']"#).ok()?;
    input
        .captures(html)
        .map(|capture| html_unescape(&capture[1]))
}

fn first_text_tag(html: &str, tag: &str) -> Option<String> {
    let pattern = Regex::new(&format!(r"(?is)<{tag}[^>]*>(.*?)</{tag}>")).ok()?;
    pattern
        .captures(html)
        .map(|capture| strip_tags(&capture[1]))
        .filter(|value| !value.is_empty())
}
fn first_text_tag_with_class(html: &str, tag: &str, class: &str) -> Option<String> {
    let pattern = Regex::new(&format!(
        r#"(?is)<{tag}[^>]+class=["'][^"']*{class}[^"']*["'][^>]*>(.*?)</{tag}>"#
    ))
    .ok()?;
    pattern
        .captures(html)
        .map(|capture| strip_tags(&capture[1]))
        .filter(|value| !value.is_empty())
}
fn capture_attribute(html: &str, attribute: &str) -> Option<String> {
    let pattern = Regex::new(&format!(r#"(?is){attribute}=["']([^"']+)["']"#)).ok()?;
    pattern
        .captures(html)
        .map(|capture| html_unescape(&capture[1]))
}
fn title_id(href: &str) -> Option<String> {
    for prefix in ["/posters/", "/set/", "/collection/"] {
        if let Some(rest) = href.split(prefix).nth(1) {
            return Some(rest.split(['/', '?']).next()?.to_owned());
        }
    }
    None
}
fn normalize_path(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.chars().all(|ch| ch.is_ascii_digit()) {
        return format!("/set/{trimmed}");
    }
    for prefix in ["/set/", "/poster/"] {
        if let Some(index) = trimmed.find(prefix) {
            return format!(
                "{prefix}{}",
                trimmed[index + prefix.len()..]
                    .split(['/', '?'])
                    .next()
                    .unwrap_or_default()
            );
        }
    }
    if trimmed.starts_with("http") || trimmed.starts_with('/') {
        trimmed.to_owned()
    } else {
        format!("/{trimmed}")
    }
}
fn classify(media_type: &str, title: &str) -> (String, Option<i64>) {
    match media_type.trim().to_lowercase().as_str() {
        "movie" => ("movie".to_owned(), None),
        "collection" => ("collection".to_owned(), None),
        _ => {
            let lower = title.to_lowercase();
            if lower.contains("specials") {
                return ("season".to_owned(), Some(0));
            }
            if let Some(index) = lower.find("season") {
                let number = lower[index + 6..]
                    .split(|ch: char| !ch.is_ascii_digit())
                    .find_map(|part| part.parse().ok());
                return ("season".to_owned(), number);
            }
            if lower.contains("collection") {
                ("collection".to_owned(), None)
            } else {
                ("show".to_owned(), None)
            }
        }
    }
}
fn strip_tags(value: &str) -> String {
    Regex::new(r"(?is)<[^>]+>")
        .expect("valid regex")
        .replace_all(value, " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
fn html_unescape(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#039;", "'")
}
fn is_blocked(html: &str) -> bool {
    let head = html.chars().take(4000).collect::<String>().to_lowercase();
    [
        "just a moment",
        "cf-chl",
        "challenge-platform",
        "attention required!",
    ]
    .iter()
    .any(|marker| head.contains(marker))
}
fn asset_url(id: &str) -> String {
    format!("{BASE}/api/assets/{id}")
}
fn proxy_thumb(url: &str) -> String {
    format!("/api/posterdb/image?url={}", percent_encode(url))
}
fn absolute_url(path: &str) -> String {
    if path.starts_with("http") {
        path.to_owned()
    } else {
        format!(
            "{BASE}{}",
            if path.starts_with('/') {
                path.to_owned()
            } else {
                format!("/{path}")
            }
        )
    }
}
fn single_asset(id: &str) -> PosterAsset {
    PosterAsset {
        id: id.to_owned(),
        title: format!("Poster {id}"),
        kind: "unknown".to_owned(),
        season_number: None,
        thumb_url: proxy_thumb(&asset_url(id)),
        download_url: asset_url(id),
        set_size: None,
        set_url: None,
    }
}
fn capitalize(value: &str) -> String {
    let mut chars = value.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{classify, normalize_path, parse_grid, parse_title_results};

    #[test]
    fn posterdb_parsing_matches_legacy_contract() {
        assert_eq!(normalize_path("42"), "/set/42");
        assert_eq!(
            normalize_path("https://theposterdb.com/poster/7"),
            "/poster/7"
        );
        assert_eq!(
            classify("Show", "Example - Season 2"),
            ("season".to_owned(), Some(2))
        );
        let parsed =
            parse_title_results(r#"<a class="btn-dark-lighter" href="/posters/99">Example</a>"#)
                .unwrap();
        assert_eq!(parsed[0].media_id, "99");

        let grid = parse_grid(
            r#"<div class="col-6 col-lg-2 p-1">
                <div data-poster-id="123"></div>
                <picture><source srcset="https://images.theposterdb.com/t/123.webp 1x"></picture>
                <p class="p-0 mb-1 text-break">Superstore (2015)</p>
                <a class="set_poster_count" href="/set/456">8</a>
            </div>"#,
        )
        .unwrap();
        assert_eq!(grid[0].set_size, Some(8));
        assert_eq!(
            grid[0].set_url.as_deref(),
            Some("https://theposterdb.com/set/456")
        );
    }
}
