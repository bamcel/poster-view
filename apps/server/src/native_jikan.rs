//! Cached supplementary anime people data. AniList and local/manual values win.
use crate::AppState;
use posterview_contracts::native::{NativeCatalogEntry, NativeLibrary, NativeLibraryType};
use serde_json::{Value, json};
use std::{
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static COOLDOWN: AtomicU64 = AtomicU64::new(0);
const DAY: u64 = 86400;
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn rows(value: &Value) -> Vec<Value> {
    value.as_array().cloned().unwrap_or_default()
}
fn name(value: &Value) -> String {
    let mut parts = value
        .as_str()
        .unwrap_or("")
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .map(str::to_lowercase)
        .collect::<Vec<_>>();
    parts.sort();
    parts.join(" ")
}
fn missing(value: &Value) -> bool {
    value.as_str().is_none_or(|s| s.trim().is_empty())
}
fn manual(metadata: &Value, field: &str) -> bool {
    metadata["_sources"][field] == "manual"
}
fn language(code: &str) -> &str {
    match code.split(['-', '_']).next().unwrap_or(code) {
        "ja" => "Japanese",
        "en" => "English",
        "ko" => "Korean",
        "zh" => "Chinese",
        "es" => "Spanish",
        "pt" => "Portuguese",
        "fr" => "French",
        "de" => "German",
        "it" => "Italian",
        "ru" => "Russian",
        "ar" => "Arabic",
        _ => code,
    }
}
fn gaps(entry: &NativeCatalogEntry, library: &NativeLibrary) -> bool {
    let metadata = &entry.metadata;
    let voices = rows(&metadata["voice_cast"]);
    let country = metadata["country_of_origin"]
        .as_str()
        .or(metadata["anilist_data"]["countryOfOrigin"].as_str())
        .unwrap_or("");
    let original = metadata["original_language"]
        .as_str()
        .or(metadata["tmdb_data"]["original_language"].as_str())
        .unwrap_or(match country {
            "JP" => "ja",
            "KR" => "ko",
            "CN" | "TW" => "zh",
            "US" | "GB" => "en",
            _ => "",
        });
    let voice_gap = !manual(metadata, "voice_cast")
        && ([
            language(original),
            language(&library.options.metadata_language),
        ]
        .into_iter()
        .filter(|s| !s.is_empty())
        .any(|lang| {
            !voices
                .iter()
                .any(|v| name(&v["language"]) == name(&json!(lang)))
        }) || voices.iter().any(|v| missing(&v["image"])));
    let credits = rows(&metadata["credits"]);
    let crew_gap = !manual(metadata, "credits")
        && (!credits.iter().any(|c| c["category"] == "crew")
            || credits.iter().any(|c| missing(&c["image"])));
    let characters = rows(&metadata["characters"]);
    let character_gap = !manual(metadata, "characters")
        && (characters.is_empty() || characters.iter().any(|c| missing(&c["image"])));
    voice_gap || crew_gap || character_gap
}

async fn fetch(
    state: &AppState,
    client: &reqwest::Client,
    id: u64,
    endpoint: &str,
) -> Result<Value, String> {
    let path = state
        .runtime
        .data_dir()
        .join("jikan-cache")
        .join(format!("{id}-{endpoint}.json"));
    let read = || {
        std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .filter(|v| {
                v["fetched"]
                    .as_u64()
                    .is_some_and(|t| now().saturating_sub(t) < DAY)
            })
            .map(|v| v["body"].clone())
    };
    if let Some(body) = crate::workers::blocking(read) {
        return Ok(body);
    }
    let _gate = crate::workers::provider("jikan").await;
    if let Some(body) = crate::workers::blocking(read) {
        return Ok(body);
    }
    if COOLDOWN.load(Ordering::Relaxed) > now() {
        return Err("Jikan requests are temporarily deferred.".into());
    }
    let _network = crate::workers::network().await;
    let response = client
        .get(format!("https://api.jikan.moe/v4/anime/{id}/{endpoint}"))
        .send()
        .await
        .map_err(|_| "Jikan connection failed.")?;
    if !response.status().is_success() {
        let delay = if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            response
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(1800)
                .clamp(60, 3600)
        } else {
            60
        };
        COOLDOWN.store(now() + delay, Ordering::Relaxed);
        return Err(format!(
            "Jikan returned HTTP {}; requests are deferred.",
            response.status().as_u16()
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "Unable to read Jikan response.")?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("Jikan response exceeded the cache limit.".into());
    }
    let body: Value = serde_json::from_slice(&bytes).map_err(|_| "Invalid Jikan response.")?;
    if !body["data"].is_array() {
        return Err("Jikan returned an unexpected people response.".into());
    }
    crate::workers::blocking(|| {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(bytes) = serde_json::to_vec(&json!({"fetched":now(),"body":body})) {
            let _ = std::fs::write(&path, bytes);
        }
    });
    Ok(body)
}

fn portrait(person: &Value) -> Value {
    person["images"]["jpg"]["image_url"]
        .as_str()
        .or(person["images"]["webp"]["image_url"].as_str())
        .filter(|url| {
            posterview_url_security::provider_https(url, &["cdn.myanimelist.net"]).is_ok()
        })
        .map(|url| json!(url))
        .unwrap_or(Value::Null)
}
fn merge_rows(existing: &mut Vec<Value>, incoming: Vec<Value>, voice: bool) {
    for candidate in incoming {
        let key = name(&candidate["name"]);
        if key.is_empty() {
            continue;
        }
        if let Some(current) = existing.iter_mut().find(|v| {
            name(&v["name"]) == key
                && if voice {
                    name(&v["language"]) == name(&candidate["language"])
                } else {
                    v["category"] == candidate["category"]
                }
        }) {
            if missing(&current["image"]) && !missing(&candidate["image"]) {
                current["image"] = candidate["image"].clone();
            }
            let role = candidate["role"].as_str().unwrap_or("");
            let current_role = current["role"].as_str().unwrap_or("");
            if !role.is_empty() && !current_role.split(" · ").any(|r| r == role) {
                current["role"] = json!(
                    [current_role, role]
                        .into_iter()
                        .filter(|r| !r.is_empty())
                        .collect::<Vec<_>>()
                        .join(" · ")
                );
            }
        } else {
            existing.push(candidate);
        }
    }
}
fn merge(entry: &mut NativeCatalogEntry, data: &Value) {
    let mut voices = Vec::new();
    let mut characters = Vec::new();
    let mut crew = Vec::new();
    for row in rows(&data["characters"]["data"]) {
        let character = &row["character"];
        characters.push(json!({"id":character["mal_id"].as_u64().map(|id|id.to_string()),"provider":"jikan","name":character["name"],"role":row["role"],"image":portrait(character)}));
        for actor in rows(&row["voice_actors"]) {
            let person = &actor["person"];
            voices.push(json!({"provider":"jikan","provider_id":person["mal_id"],"name":person["name"],"role":character["name"],"category":"voice","language":actor["language"],"image":portrait(person)}));
        }
    }
    for row in rows(&data["staff"]["data"]) {
        let person = &row["person"];
        for position in rows(&row["positions"]) {
            crew.push(json!({"provider":"jikan","provider_id":person["mal_id"],"name":person["name"],"category":"crew","role":position,"image":portrait(person)}));
        }
    }
    if !manual(&entry.metadata, "voice_cast") {
        let mut existing = rows(&entry.metadata["voice_cast"]);
        merge_rows(&mut existing, voices.clone(), true);
        entry.metadata["voice_cast"] = json!(existing);
    }
    if !manual(&entry.metadata, "credits") {
        let mut portraits = crew.clone();
        portraits.extend(voices);
        crate::native_provider::merge_credit_portraits(&mut entry.metadata, &json!(portraits));
        let mut existing = rows(&entry.metadata["credits"]);
        merge_rows(&mut existing, crew, false);
        entry.metadata["credits"] = json!(existing);
    }
    if !manual(&entry.metadata, "characters") {
        let mut existing = rows(&entry.metadata["characters"]);
        if existing.is_empty() {
            existing = characters;
        } else {
            for character in &mut existing {
                if missing(&character["image"]) {
                    if let Some(other) = characters
                        .iter()
                        .find(|c| name(&c["name"]) == name(&character["name"]))
                    {
                        character["image"] = other["image"].clone();
                    }
                }
            }
        }
        entry.metadata["characters"] = json!(existing);
    }
}

pub(crate) async fn enrich(
    state: &AppState,
    library: &NativeLibrary,
    entry: &mut NativeCatalogEntry,
    client: &reqwest::Client,
    warnings: &mut Vec<String>,
) {
    if !library.options.fetch_missing
        || library.library_type != NativeLibraryType::Anime
        || !["series", "movie"].contains(&entry.kind.as_str())
    {
        return;
    }
    let id = entry.metadata["identifiers"]["mal"]
        .as_str()
        .or(entry.metadata["identifiers"]["myanimelist"].as_str())
        .and_then(|id| id.parse::<u64>().ok())
        .or(entry.metadata["anilist_data"]["idMal"].as_u64())
        .filter(|id| *id > 0);
    let Some(id) = id else {
        return;
    };
    if entry.metadata["jikan_data"]["mal_id"] == id {
        let data = entry.metadata["jikan_data"].clone();
        merge(entry, &data);
    }
    if !gaps(entry, library)
        || entry.metadata["jikan_checked"]["mal_id"] == id
            && entry.metadata["jikan_checked"]["at"]
                .as_u64()
                .is_some_and(|t| now().saturating_sub(t) < 30 * DAY)
        || entry.metadata["jikan_retry_after"]
            .as_u64()
            .is_some_and(|t| t > now())
        || COOLDOWN.load(Ordering::Relaxed) > now()
    {
        return;
    }
    let characters = fetch(state, client, id, "characters").await;
    let staff = fetch(state, client, id, "staff").await;
    let mut data = if entry.metadata["jikan_data"]["mal_id"] == id {
        entry.metadata["jikan_data"].clone()
    } else {
        json!({"mal_id":id})
    };
    let complete = characters.is_ok() && staff.is_ok();
    for (endpoint, result) in [("characters", characters), ("staff", staff)] {
        match result {
            Ok(body) => data[endpoint] = body,
            Err(e) => warnings.push(format!("{}: {e}", entry.title)),
        }
    }
    merge(entry, &data);
    entry.metadata["jikan_data"] = data;
    entry.metadata["_sources"]["jikan_data"] = json!("jikan");
    if complete {
        entry.metadata["jikan_checked"] = json!({"mal_id":id,"at":now()});
    } else {
        entry.metadata["jikan_retry_after"] = json!(now() + 3600);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn entry(metadata: Value) -> NativeCatalogEntry {
        NativeCatalogEntry {
            id: "test".into(),
            path: "test".into(),
            kind: "series".into(),
            parent_path: None,
            title: "Test".into(),
            metadata,
            artwork: vec![],
            files: vec![],
            nfo_path: None,
            nfo_xml: None,
            available: true,
            revision: 1,
        }
    }
    fn data() -> Value {
        json!({"characters":{"data":[{"character":{"mal_id":12,"name":"Hero","images":{"jpg":{"image_url":"https://cdn.myanimelist.net/hero.jpg"}}},"role":"Main","voice_actors":[{"person":{"mal_id":42,"name":"Smith, Jane","images":{"jpg":{"image_url":"https://cdn.myanimelist.net/actor.jpg"}}},"language":"English"}]}]},"staff":{"data":[{"person":{"mal_id":43,"name":"Director","images":{"jpg":{"image_url":"https://cdn.myanimelist.net/director.jpg"}}},"positions":["Director"]}]}})
    }
    #[test]
    fn fallback_preserves_primary_and_separates_people() {
        let mut item = entry(
            json!({"voice_cast":[{"name":"Jane Smith","provider":"anilist","language":"English","role":"Hero","image":"https://primary.example/portrait.jpg"}],"characters":[{"id":"99","name":"Hero","image":null}]}),
        );
        merge(&mut item, &data());
        merge(&mut item, &data());
        assert_eq!(item.metadata["voice_cast"].as_array().unwrap().len(), 1);
        assert_eq!(
            item.metadata["voice_cast"][0]["image"],
            "https://primary.example/portrait.jpg"
        );
        assert_eq!(item.metadata["credits"].as_array().unwrap().len(), 1);
        assert_eq!(item.metadata["credits"][0]["category"], "crew");
        assert_eq!(item.metadata["characters"][0]["id"], "99");
        assert_eq!(
            item.metadata["characters"][0]["image"],
            "https://cdn.myanimelist.net/hero.jpg"
        );
    }
    #[test]
    fn manual_fields_are_untouched_and_untrusted_portraits_rejected() {
        let metadata = json!({"_sources":{"voice_cast":"manual","credits":"manual","characters":"manual"},"voice_cast":[],"credits":[],"characters":[]});
        let mut item = entry(metadata.clone());
        merge(&mut item, &data());
        assert_eq!(item.metadata, metadata);
        assert!(
            portrait(&json!({"images":{"jpg":{"image_url":"http://localhost/private"}}})).is_null()
        );
    }
    #[tokio::test]
    async fn fresh_cached_people_are_reused_without_network() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::native::scan_tests::state(temp.path());
        let dir = state.runtime.data_dir().join("jikan-cache");
        std::fs::create_dir_all(&dir).unwrap();
        let body = json!({"data":[]});
        std::fs::write(
            dir.join("123-staff.json"),
            serde_json::to_vec(&json!({"fetched":now(),"body":body})).unwrap(),
        )
        .unwrap();
        assert_eq!(
            fetch(&state, &reqwest::Client::new(), 123, "staff")
                .await
                .unwrap(),
            body
        );
    }
    #[tokio::test]
    async fn successful_empty_check_does_not_fetch_again() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::native::scan_tests::state(temp.path());
        let mut library = NativeLibrary {
            id: "library".into(),
            name: "Anime".into(),
            library_type: NativeLibraryType::Anime,
            anime_content: posterview_contracts::native::AnimeContent::Both,
            paths: vec![],
            options: Default::default(),
            revision: 1,
            created_at: "".into(),
            updated_at: "".into(),
        };
        library.library_type = NativeLibraryType::Anime;
        library.options.fetch_missing = true;
        let mut item =
            entry(json!({"identifiers":{"mal":"123"},"jikan_checked":{"mal_id":123,"at":now()}}));
        let mut warnings = vec![];
        enrich(
            &state,
            &library,
            &mut item,
            &reqwest::Client::new(),
            &mut warnings,
        )
        .await;
        assert!(warnings.is_empty());
        assert!(item.metadata["jikan_data"].is_null());
    }
}
