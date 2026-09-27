//! Optional AniDB HTTP metadata, using registered clients and confirmed anime IDs.
use crate::{Runtime, RuntimeError, artwork_cache::ArtworkCache};
use posterview_infra_artwork::{FetchedVideoMetadata, valid_credit_id};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{io::Read, time::Duration};
use tokio::sync::Mutex;
use xmltree::{Element, XMLNode};

static GATE: Mutex<Option<tokio::time::Instant>> = Mutex::const_new(None);
const LIMIT: usize = 4 * 1024 * 1024;
fn error(message: impl std::fmt::Display) -> RuntimeError { RuntimeError::Watchdog(message.to_string()) }
#[derive(Default, Clone, Serialize, Deserialize)]
pub struct AnidbSettings { pub enabled: bool, pub client: String, pub version: u32 }
impl Runtime {
    pub fn anidb_settings(&self) -> Result<AnidbSettings, RuntimeError> {
        let raw = self.server_store()?.get_setting("anidb_settings")?;
        Ok(serde_json::from_str(&raw).unwrap_or(AnidbSettings { version: 1, ..Default::default() }))
    }
    pub fn save_anidb_settings(&self, mut settings: AnidbSettings) -> Result<AnidbSettings, RuntimeError> {
        settings.client = settings.client.trim().to_owned();
        if settings.client.len() > 64 || (!settings.client.is_empty() && !settings.client.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())) || settings.version == 0 || (settings.enabled && settings.client.is_empty()) {
            return Err(error("Enter your registered lowercase alphanumeric AniDB client name and a positive client version."));
        }
        self.server_store()?.set_setting("anidb_settings", &serde_json::to_string(&settings).map_err(error)?)?;
        Ok(settings)
    }
    pub async fn test_anidb(&self) -> Result<(), String> {
        self.anidb_xml("1", false).await.map(|_| ())
    }
    pub async fn anidb_metadata(&self, id: &str, movie: bool) -> Result<FetchedVideoMetadata, String> {
        let xml = self.anidb_xml(id, true).await?;
        parse_metadata(&xml, id, movie)
    }
    async fn anidb_xml(&self, id: &str, cached: bool) -> Result<String, String> {
        if !valid_credit_id(id) { return Err("Invalid AniDB ID.".into()); }
        let config = self.anidb_settings().map_err(|e| e.to_string())?;
        if !config.enabled || config.client.is_empty() { return Err("Enable AniDB and register its client in Settings → Search Providers.".into()); }
        let cache = ArtworkCache::at(self.data_dir.join("anidb-cache"));
        let mut gate = GATE.lock().await;
        if cached && let Some(xml) = cache.get_json::<String>(id, 30) {
            return Ok(xml);
        }
        if let Some(next) = *gate {
            if next.saturating_duration_since(tokio::time::Instant::now()) > Duration::from_secs(6) { return Err("AniDB is cooling down after a provider error. Retry later.".into()); }
            tokio::time::sleep_until(next).await;
        }
        // AniDB documents this public HTTP endpoint. No account password or API secret is sent.
        *gate = Some(tokio::time::Instant::now() + Duration::from_secs(30));
        let result = async {
            let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(30)).build().map_err(|_| "Could not create AniDB client.")?;
            let mut reply = client.get("http://api.anidb.net:9001/httpapi")
                .query(&[("request", "anime"), ("client", config.client.as_str()), ("clientver", &config.version.to_string()), ("protover", "1"), ("aid", id)])
                .send().await.map_err(|_| "AniDB connection failed or timed out.")?;
            if !reply.status().is_success() { return Err(format!("AniDB returned HTTP {}.", reply.status().as_u16())); }
            let mut bytes = Vec::new();
            while let Some(chunk) = reply.chunk().await.map_err(|_| "Could not read AniDB response.")? {
                if bytes.len() + chunk.len() > LIMIT { return Err("AniDB response exceeds size limit.".into()); }
                bytes.extend_from_slice(&chunk);
            }
            if bytes.starts_with(&[0x1f, 0x8b]) {
                let mut decoded = Vec::new();
                flate2::read::GzDecoder::new(bytes.as_slice()).take((LIMIT + 1) as u64).read_to_end(&mut decoded).map_err(|_| "Invalid compressed AniDB response.")?;
                if decoded.len() > LIMIT { return Err("AniDB response exceeds size limit.".into()); }
                bytes = decoded;
            }
            let xml = String::from_utf8(bytes).map_err(|_| "Invalid AniDB text response.")?;
            checked_root(&xml, id)?;
            Ok::<_, String>(xml)
        }.await;
        *gate = Some(tokio::time::Instant::now() + Duration::from_secs(if result.is_ok() { 6 } else { 1800 }));
        let xml = result?;
        cache.put_json(id, &xml, 128, 30).map_err(|_| "Unable to cache AniDB response.")?;
        Ok(xml)
    }
}
fn children<'a>(root: &'a Element, name: &'a str) -> impl Iterator<Item=&'a Element> {
    root.children.iter().filter_map(move |n| match n { XMLNode::Element(e) if e.name == name => Some(e), _ => None })
}
fn text(root: &Element, name: &str) -> String { root.get_child(name).and_then(Element::get_text).map(|s| s.trim().to_owned()).unwrap_or_default() }
fn checked_root(xml: &str, id: &str) -> Result<Element, String> {
    if xml.contains("<!DOCTYPE") || xml.contains("<!ENTITY") { return Err("Unsupported AniDB XML declaration.".into()); }
    let root = Element::parse(xml.as_bytes()).map_err(|_| "Invalid AniDB XML.")?;
    if root.name == "error" { return Err(format!("AniDB error {}: {}", root.attributes.get("code").map(String::as_str).unwrap_or("unknown"), root.get_text().unwrap_or_default())); }
    if root.name != "anime" || root.attributes.get("id").map(String::as_str) != Some(id) { return Err("AniDB returned a different or incomplete anime record.".into()); }
    Ok(root)
}
fn parse_metadata(xml: &str, id: &str, movie: bool) -> Result<FetchedVideoMetadata, String> {
    let root = checked_root(xml, id)?;
    let kind = text(&root, "type");
    if kind.is_empty() || (kind.eq_ignore_ascii_case("Movie") != movie) { return Err("AniDB match has a different media type; review Provider matching.".into()); }
    let mut out = FetchedVideoMetadata::default();
    out.ids.insert("anidb".into(), id.into());
    for (field, tag) in [("summary", "description"), ("premiered", "startdate"), ("end_date", "enddate")] {
        let value = text(&root, tag);
        if !value.is_empty() && value != "0000-00-00" { out.fields.insert(field.into(), json!(value)); }
    }
    if let Some(year) = text(&root, "startdate").get(..4).and_then(|s| s.parse::<u32>().ok()).filter(|y| *y > 0) { out.fields.insert("year".into(), json!(year)); }
    if let Some(titles) = root.get_child("titles")
        && let Some(title) = children(titles, "title")
            .find(|t| t.attributes.get("type").is_some_and(|s| s == "main"))
        && let Some(value) = title.get_text()
    {
        out.fields.insert("original_title".into(), json!(value.trim()));
    }
    if let Some(tags) = root.get_child("tags") {
        let tags: Vec<_> = children(tags, "tag").filter(|t| !["spoiler", "localspoiler", "globalspoiler"].iter().any(|key| t.attributes.get(*key).is_some_and(|s| s == "true" || s.parse::<u32>().is_ok_and(|n| n > 0)))).map(|t| text(t, "name")).filter(|s| !s.is_empty()).collect();
        if !tags.is_empty() { out.fields.insert("tags".into(), json!(tags)); }
    }
    if let Some(creators) = root.get_child("creators") {
        for (field, role) in [("studios", "Animation Work"), ("directors", "Direction"), ("writers", "Original Work")] {
            let names: Vec<_> = children(creators, "name").filter(|e| e.attributes.get("type").is_some_and(|s| s == role)).filter_map(Element::get_text).map(|s| s.to_string()).collect();
            if !names.is_empty() { out.fields.insert(field.into(), json!(names)); }
        }
    }
    Ok(out)
}
#[cfg(test)]
mod tests {
    use super::*;
    const XML: &str = r#"<anime id="1"><type>TV Series</type><startdate>2001-01-01</startdate><titles><title type="main">Example</title></titles><description>Summary</description><tags><tag><name>Action</name></tag><tag spoiler="true"><name>Secret</name></tag></tags><creators><name type="Animation Work">Studio</name></creators></anime>"#;
    #[test] fn parses_metadata_and_rejects_mismatches() {
        let value = parse_metadata(XML, "1", false).unwrap();
        assert_eq!(value.fields["tags"], json!(["Action"]));
        assert_eq!(value.fields["studios"], json!(["Studio"]));
        assert_eq!(value.fields["year"], 2001);
        assert!(parse_metadata(XML, "1", true).is_err());
        assert!(parse_metadata(XML, "2", false).is_err());
        assert!(checked_root("<error code=\"500\">Banned</error>", "1").is_err());
    }
    #[tokio::test] async fn uses_cached_xml_without_network_and_respects_disabled_source() {
        let dir = tempfile::tempdir().unwrap(); let runtime = Runtime::new(dir.path()); runtime.initialize().unwrap();
        let config = AnidbSettings { enabled: true, client: "posterviewtest".into(), version: 1 };
        runtime.save_anidb_settings(config.clone()).unwrap();
        ArtworkCache::at(dir.path().join("anidb-cache")).put_json("1", &XML, 128, 30).unwrap();
        assert_eq!(runtime.anidb_metadata("1", false).await.unwrap().fields["year"], 2001);
        runtime.save_anidb_settings(AnidbSettings { enabled: false, ..config }).unwrap();
        assert!(runtime.anidb_metadata("1", false).await.is_err());
    }
    #[test] fn settings_persist_and_validate() {
        let dir = tempfile::tempdir().unwrap(); let runtime = Runtime::new(dir.path()); runtime.initialize().unwrap();
        assert!(!runtime.anidb_settings().unwrap().enabled);
        assert!(runtime.save_anidb_settings(AnidbSettings { enabled: true, client: "".into(), version: 1 }).is_err());
        runtime.save_anidb_settings(AnidbSettings { enabled: true, client: "posterviewtest".into(), version: 1 }).unwrap();
        assert_eq!(runtime.anidb_settings().unwrap().client, "posterviewtest");
    }
}
