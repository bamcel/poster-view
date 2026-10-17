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
fn endpoint_gaps(entry: &NativeCatalogEntry, library: &NativeLibrary) -> (bool, bool) {
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
            || credits
                .iter()
                .any(|c| c["category"] == "crew" && missing(&c["image"])));
    let characters = rows(&metadata["characters"]);
    let character_gap = !manual(metadata, "characters")
        && (characters.is_empty() || characters.iter().any(|c| missing(&c["image"])));
    let credit_voice_gap = !manual(metadata, "credits")
        && credits
            .iter()
            .any(|c| c["category"] != "crew" && missing(&c["image"]));
    (voice_gap || character_gap || credit_voice_gap, crew_gap)
}
fn mal_id(entry: &NativeCatalogEntry, library: &NativeLibrary) -> Option<u64> {
    if !library.options.fetch_missing
        || library.library_type != NativeLibraryType::Anime
        || !["series", "movie"].contains(&entry.kind.as_str())
    {
        return None;
    }
    entry.metadata["identifiers"]["mal"]
        .as_str()
        .or(entry.metadata["identifiers"]["myanimelist"].as_str())
        .and_then(|id| id.parse::<u64>().ok())
        .or(entry.metadata["anilist_data"]["idMal"].as_u64())
        .filter(|id| *id > 0)
}
fn signature(entry: &NativeCatalogEntry, library: &NativeLibrary, endpoint: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let metadata = &entry.metadata;
    let fields = if endpoint == "staff" {
        vec!["credits"]
    } else {
        vec!["characters", "voice_cast", "credits"]
    };
    let values: Vec<_> = fields
        .into_iter()
        .map(|field| {
            let value = if field == "credits" {
                json!(
                    rows(&metadata[field])
                        .into_iter()
                        .filter(|credit| if endpoint == "staff" {
                            credit["category"] == "crew"
                        } else {
                            credit["category"] != "crew"
                        })
                        .collect::<Vec<_>>()
                )
            } else {
                metadata[field].clone()
            };
            json!([field, value, metadata["_sources"][field]])
        })
        .collect();
    let value = json!([
        values,
        metadata["original_language"],
        metadata["country_of_origin"],
        metadata["anilist_data"]["countryOfOrigin"],
        metadata["tmdb_data"]["original_language"],
        library.options.metadata_language
    ]);
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    value.to_string().hash(&mut hash);
    hash.finish()
}
fn checked(entry: &NativeCatalogEntry, library: &NativeLibrary, id: u64, endpoint: &str) -> bool {
    let checked = &entry.metadata["jikan_checked"];
    if checked["mal_id"] != id {
        return false;
    }
    let endpoint_check = &checked["endpoints"][endpoint];
    if checked["endpoints"].is_object() {
        endpoint_check["signature"].as_u64() == Some(signature(entry, library, endpoint))
            && endpoint_check["at"]
                .as_u64()
                .is_some_and(|at| now().saturating_sub(at) < 30 * DAY)
    } else {
        checked["at"]
            .as_u64()
            .is_some_and(|at| now().saturating_sub(at) < 30 * DAY)
    }
}
fn requested_endpoints(
    entry: &NativeCatalogEntry,
    library: &NativeLibrary,
    id: u64,
) -> Vec<&'static str> {
    let (characters, staff) = endpoint_gaps(entry, library);
    [("characters", characters), ("staff", staff)]
        .into_iter()
        .filter_map(|(endpoint, needed)| {
            (needed && !checked(entry, library, id, endpoint)).then_some(endpoint)
        })
        .collect()
}
fn deferred(entry: &NativeCatalogEntry, id: u64) -> bool {
    let same_identity = entry.metadata["jikan_retry_mal_id"] == id
        || entry.metadata["jikan_retry_mal_id"].is_null()
            && (entry.metadata["jikan_data"]["mal_id"] == id
                || entry.metadata["jikan_data"]["mal_id"].is_null());
    same_identity
        && entry.metadata["jikan_retry_after"]
            .as_u64()
            .is_some_and(|at| at > now())
        || COOLDOWN.load(Ordering::Relaxed) > now()
}
/// Cached data can still fill a gap while provider requests are deferred.
pub(crate) fn needs_enrichment(entry: &NativeCatalogEntry, library: &NativeLibrary) -> bool {
    let Some(id) = mal_id(entry, library) else {
        return false;
    };
    let mut merged = entry.clone();
    if entry.metadata["jikan_data"]["mal_id"] == id {
        merge(&mut merged, &entry.metadata["jikan_data"]);
        if merged.metadata != entry.metadata {
            return true;
        }
    }
    !deferred(&merged, id) && !requested_endpoints(&merged, library, id).is_empty()
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
                if missing(&character["image"])
                    && let Some(other) = characters
                        .iter()
                        .find(|c| name(&c["name"]) == name(&character["name"]))
                {
                    character["image"] = other["image"].clone();
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
    let Some(id) = mal_id(entry, library) else {
        return;
    };
    if entry.metadata["jikan_data"]["mal_id"] == id {
        let data = entry.metadata["jikan_data"].clone();
        merge(entry, &data);
    }
    let endpoints = requested_endpoints(entry, library, id);
    if endpoints.is_empty() || deferred(entry, id) {
        return;
    }
    let mut data = if entry.metadata["jikan_data"]["mal_id"] == id {
        entry.metadata["jikan_data"].clone()
    } else {
        json!({"mal_id":id})
    };
    let mut successful = vec![];
    let mut failed = false;
    for endpoint in endpoints {
        match fetch(state, client, id, endpoint).await {
            Ok(body) => {
                data[endpoint] = body;
                successful.push(endpoint);
            }
            Err(error) => {
                warnings.push(format!("{}: {error}", entry.title));
                failed = true;
            }
        }
    }
    merge(entry, &data);
    entry.metadata["jikan_data"] = data;
    entry.metadata["_sources"]["jikan_data"] = json!("jikan");
    let mut endpoint_checks = if entry.metadata["jikan_checked"]["mal_id"] == id {
        entry.metadata["jikan_checked"]["endpoints"]
            .as_object()
            .cloned()
            .unwrap_or_default()
    } else {
        Default::default()
    };
    for endpoint in successful {
        endpoint_checks.insert(
            endpoint.into(),
            json!({"at":now(),"signature":signature(entry, library, endpoint)}),
        );
    }
    entry.metadata["jikan_checked"] = json!({"mal_id":id,"endpoints":endpoint_checks});
    if failed {
        entry.metadata["jikan_retry_after"] = json!(now() + 3600);
        entry.metadata["jikan_retry_mal_id"] = json!(id);
    } else {
        entry
            .metadata
            .as_object_mut()
            .unwrap()
            .remove("jikan_retry_after");
        entry
            .metadata
            .as_object_mut()
            .unwrap()
            .remove("jikan_retry_mal_id");
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
        let state = crate::test_support::state(temp.path());
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
        let state = crate::test_support::state(temp.path());
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
    fn library() -> NativeLibrary {
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
        library.options.fetch_missing = true;
        library
    }
    #[test]
    fn endpoint_needs_are_independent_and_manual_fields_are_protected() {
        let library = library();
        let staff_only = entry(
            json!({"identifiers":{"mal":"123"},"_sources":{"voice_cast":"manual","characters":"manual"}}),
        );
        assert_eq!(
            requested_endpoints(&staff_only, &library, 123),
            vec!["staff"]
        );
        assert!(needs_enrichment(&staff_only, &library));
        let characters_only =
            entry(json!({"identifiers":{"mal":"123"},"_sources":{"credits":"manual"}}));
        assert_eq!(
            requested_endpoints(&characters_only, &library, 123),
            vec!["characters"]
        );
        let protected = entry(
            json!({"identifiers":{"mal":"123"},"_sources":{"credits":"manual","characters":"manual","voice_cast":"manual"}}),
        );
        assert!(!needs_enrichment(&protected, &library));
        let mut disabled = library.clone();
        disabled.options.fetch_missing = false;
        assert!(!needs_enrichment(&characters_only, &disabled));
        assert!(!needs_enrichment(&entry(json!({})), &library));
        let retrying = entry(json!({"identifiers":{"mal":"123"},"jikan_retry_after":now()+3600}));
        assert!(!needs_enrichment(&retrying, &library));
    }
    #[test]
    fn endpoint_checks_do_not_invalidate_each_other_on_unrelated_portrait_changes() {
        let library = library();
        let mut item = entry(
            json!({"identifiers":{"mal":"123"},"_sources":{"voice_cast":"manual","characters":"manual"},"credits":[{"name":"Director","category":"crew","image":null},{"name":"Actor","category":"cast","image":null}]}),
        );
        item.metadata["jikan_checked"] = json!({"mal_id":123,"endpoints":{"staff":{"at":now(),"signature":signature(&item,&library,"staff")}}});
        assert_eq!(
            requested_endpoints(&item, &library, 123),
            vec!["characters"]
        );
        let character_signature = signature(&item, &library, "characters");
        item.metadata["credits"][0]["image"] = json!("https://cdn.myanimelist.net/director.jpg");
        assert_eq!(
            signature(&item, &library, "characters"),
            character_signature
        );
        item.metadata["jikan_checked"]["endpoints"]["staff"]["signature"] =
            json!(signature(&item, &library, "staff"));
        item.metadata["credits"][1]["image"] = json!("https://cdn.myanimelist.net/actor.jpg");
        assert!(checked(&item, &library, 123, "staff"));
        assert!(requested_endpoints(&item, &library, 123).is_empty());
    }

    #[test]
    fn endpoint_checks_expire_and_changed_fields_or_identity_invalidate_them() {
        let library = library();
        let mut item = entry(
            json!({"identifiers":{"mal":"123"},"_sources":{"voice_cast":"manual","characters":"manual"}}),
        );
        item.metadata["jikan_checked"] = json!({"mal_id":123,"endpoints":{"staff":{"at":now(),"signature":signature(&item,&library,"staff")}}});
        assert!(!needs_enrichment(&item, &library));
        item.metadata["credits"] = json!([{"name":"New crew","category":"crew","image":null}]);
        assert!(needs_enrichment(&item, &library));
        item.metadata["jikan_checked"]["endpoints"]["staff"] =
            json!({"at":now()-31*DAY,"signature":signature(&item,&library,"staff")});
        assert!(needs_enrichment(&item, &library));
        item.metadata["jikan_checked"]["endpoints"]["staff"]["at"] = json!(now());
        item.metadata["identifiers"]["mal"] = json!("456");
        item.metadata["credits"][0]["image"] = Value::Null;
        assert!(needs_enrichment(&item, &library));
    }
    #[tokio::test]
    async fn cached_data_fills_gaps_even_during_retry_without_changing_manual_values() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        let library = library();
        let mut cached = data();
        cached["mal_id"] = json!(123);
        let mut item = entry(
            json!({"identifiers":{"mal":"123"},"jikan_data":cached,"jikan_retry_after":now()+3600,"jikan_retry_mal_id":123,"_sources":{"characters":"manual"},"characters":[]}),
        );
        assert!(needs_enrichment(&item, &library));
        enrich(
            &state,
            &library,
            &mut item,
            &reqwest::Client::new(),
            &mut vec![],
        )
        .await;
        assert_eq!(item.metadata["characters"], json!([]));
        assert_eq!(item.metadata["credits"][0]["name"], "Director");
        assert!(!needs_enrichment(&item, &library));
        item.metadata["identifiers"]["mal"] = json!("456");
        item.metadata["credits"][0]["image"] = Value::Null;
        assert!(needs_enrichment(&item, &library));
    }
    #[tokio::test]
    async fn staff_only_successful_empty_response_is_checked_without_character_request() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        let directory = state.runtime.data_dir().join("jikan-cache");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            directory.join("123-staff.json"),
            serde_json::to_vec(&json!({"fetched":now(),"body":{"data":[]}})).unwrap(),
        )
        .unwrap();
        let library = library();
        let mut item = entry(
            json!({"identifiers":{"mal":"123"},"_sources":{"voice_cast":"manual","characters":"manual"}}),
        );
        assert_eq!(requested_endpoints(&item, &library, 123), vec!["staff"]);
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
        assert!(item.metadata["jikan_data"]["characters"].is_null());
        assert_eq!(item.metadata["jikan_data"]["staff"]["data"], json!([]));
        assert!(!needs_enrichment(&item, &library));
    }
}
