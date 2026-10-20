use crate::{AppState, HttpError};
use posterview_contracts::native::{
    NativeArtwork, NativeCatalogEntry, NativeLibrary, NativeLibraryType,
};
use posterview_infra_sqlite::ServerStore;
use serde_json::{Value, json};
use std::{collections::BTreeMap, time::Duration};
fn normalized(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}
fn missing(value: &Value) -> bool {
    value.is_null()
        || value.as_str().is_some_and(|v| v.trim().is_empty())
        || value.as_array().is_some_and(Vec::is_empty)
        || value.as_object().is_some_and(|v| v.is_empty())
}
fn metadata_complete(entry: &NativeCatalogEntry) -> bool {
    let fields: &[&str] = if entry.kind == "season" {
        &["title"]
    } else {
        &["title", "plot"]
    };
    fields.iter().all(|field| !missing(&entry.metadata[*field]))
}
const SPECIAL_PLACEMENT_FIELDS: [&str; 3] = [
    "airs_before_season",
    "airs_before_episode",
    "airs_after_season",
];
fn needs_special_placement(entry: &NativeCatalogEntry, library: &NativeLibrary) -> bool {
    entry.kind == "episode"
        && entry.metadata["season"].as_u64() == Some(0)
        && (entry.metadata["_identify_source"] == "tvdb"
            || library
                .options
                .metadata_providers
                .get("episode")
                .is_some_and(|providers| providers.iter().any(|p| p == "tvdb")))
        && !SPECIAL_PLACEMENT_FIELDS.iter().any(|field| {
            !missing(&entry.metadata[*field])
                || matches!(
                    entry.metadata["_sources"][*field].as_str(),
                    Some("manual" | "nfo")
                )
        })
}
fn needs_voice_cast(entry: &NativeCatalogEntry, library: &NativeLibrary) -> bool {
    library.library_type == NativeLibraryType::Anime
        && ["series", "movie"].contains(&entry.kind.as_str())
        && library
            .options
            .metadata_providers
            .get(&entry.kind)
            .is_none_or(|providers| providers.iter().any(|p| p == "anilist"))
        && !matches!(
            entry.metadata["_sources"]["voice_cast"].as_str(),
            Some("manual" | "nfo")
        )
        && (entry.metadata["voice_cast_schema"] != 3
            || !entry.metadata["voice_cast"].is_array()
            || incomplete_anilist_lists(&entry.metadata["anilist_data"]))
}
fn incomplete_anilist_lists(data: &Value) -> bool {
    ["characters", "staff"]
        .iter()
        .any(|field| data[field]["pageInfo"]["hasNextPage"] == true)
}
fn anilist_voice_cast(data: &Value) -> Value {
    let mut cast = Vec::new();
    for edge in data["characters"]["edges"].as_array().into_iter().flatten() {
        if let Some(roles) = edge["voiceActorRoles"].as_array() {
            for role in roles {
                let actor = &role["voiceActor"];
                cast.push(json!({"name":actor["name"]["full"],"provider":"anilist","provider_id":actor["id"],"role":edge["node"]["name"]["full"],"category":"voice","image":actor["image"]["large"],"language":actor["languageV2"],"dub_group":role["dubGroup"],"role_notes":role["roleNotes"]}));
            }
        } else {
            for actor in edge["voiceActors"].as_array().into_iter().flatten() {
                cast.push(json!({"name":actor["name"]["full"],"provider":"anilist","provider_id":actor["id"],"role":edge["node"]["name"]["full"],"category":"voice","image":actor["image"]["large"],"language":actor["languageV2"]}));
            }
        }
    }
    json!(cast)
}
fn missing_images(entry: &NativeCatalogEntry, library: &NativeLibrary) -> Vec<String> {
    if entry.metadata["_identify_replace_artwork"] == true {
        return library.options.image_types.clone();
    }
    library
        .options
        .image_types
        .iter()
        .filter(|kind| {
            let supported = match entry.kind.as_str() {
                "episode" => kind.as_str() == "thumb",
                "season" => kind.as_str() == "poster",
                "book_series" => ["poster", "backdrop"].contains(&kind.as_str()),
                "book" => kind.as_str() == "poster",
                _ => true,
            };
            supported
                && !entry.artwork.iter().any(|art| {
                    art.kind == **kind || (kind.as_str() == "thumb" && art.kind == "landscape")
                })
        })
        .cloned()
        .collect()
}
fn needs_credit_portraits(entry: &NativeCatalogEntry) -> bool {
    if !matches!(entry.kind.as_str(), "series" | "movie")
        || entry.metadata["_sources"]["credits"] == "manual"
    {
        return false;
    }
    entry.metadata["credits"].as_array().is_some_and(|credits| {
        credits.iter().any(|credit| {
            credit["category"] == "cast"
                && credit["name"]
                    .as_str()
                    .is_some_and(|name| !name.trim().is_empty())
                && missing(&credit["image"])
        })
    })
}
pub(crate) fn merge_credit_portraits(metadata: &mut Value, incoming: &Value) {
    if metadata["_sources"]["credits"] == "manual" {
        return;
    }
    let Some(candidates) = incoming.as_array() else {
        return;
    };
    let Some(credits) = metadata["credits"].as_array_mut() else {
        return;
    };
    let mut portraits = BTreeMap::new();
    for candidate in candidates {
        if let (Some(name), Some(image)) = (
            candidate["name"].as_str(),
            candidate["image"].as_str().filter(|v| !v.trim().is_empty()),
        ) {
            portraits.entry(normalized(name)).or_insert(image);
        }
    }
    for credit in credits {
        if !missing(&credit["image"]) {
            continue;
        }
        let Some(name) = credit["name"]
            .as_str()
            .map(normalized)
            .filter(|v| !v.is_empty())
        else {
            continue;
        };
        if let Some(image) = portraits.get(&name) {
            credit["image"] = json!(image);
        }
    }
}
fn fill(entry: &mut NativeCatalogEntry, field: &str, value: Value, source: &str) {
    if missing(&value)
        || (field == "voice_cast"
            && matches!(
                entry.metadata["_sources"][field].as_str(),
                Some("manual" | "nfo")
            ))
        || (SPECIAL_PLACEMENT_FIELDS.contains(&field)
            && SPECIAL_PLACEMENT_FIELDS.iter().any(|key| {
                matches!(
                    entry.metadata["_sources"][*key].as_str(),
                    Some("manual" | "nfo")
                )
            }))
    {
        return;
    }
    if field == "credits" {
        merge_credit_portraits(&mut entry.metadata, &value);
    }
    let from_filename = matches!(
        entry.metadata["_sources"][field].as_str(),
        Some("filename" | "embedded")
    );
    if missing(&entry.metadata[field]) || (field == "title" && from_filename) {
        entry.metadata[field] = value;
        entry.metadata["_sources"][field] = json!(source);
    }
}
fn extend_anilist_lists(entry: &mut NativeCatalogEntry, fields: &Value, data: &Value) {
    let previous = &entry.metadata["anilist_data"];
    let partial = previous["characters"]["pageInfo"]["hasNextPage"] == true
        || previous["staff"]["pageInfo"]["hasNextPage"] == true;
    if !partial || previous["id"] != data["id"] {
        return;
    }
    for field in ["characters", "credits"] {
        if !matches!(
            entry.metadata["_sources"][field].as_str(),
            Some("anilist" | "database")
        ) {
            continue;
        }
        let Some(incoming) = fields[field].as_array() else {
            continue;
        };
        let Some(existing) = entry.metadata[field].as_array_mut() else {
            continue;
        };
        for value in incoming {
            let duplicate = existing.iter().any(|old| {
                if field == "characters" {
                    old["id"] == value["id"]
                } else {
                    old["name"] == value["name"]
                        && old["role"] == value["role"]
                        && old["category"] == value["category"]
                }
            });
            if !duplicate {
                existing.push(value.clone());
            }
        }
    }
    entry.metadata["anilist_data"] = data.clone();
}

fn merge_identifiers(entry: &mut NativeCatalogEntry, ids: &Value, source: &str) {
    if entry.metadata["identifiers"].is_null() {
        entry.metadata["identifiers"] = json!({});
    }
    for (name, value) in ids.as_object().into_iter().flatten() {
        if !missing(value) && missing(&entry.metadata["identifiers"][name]) {
            entry.metadata["identifiers"][name] = value.clone();
            entry.metadata["_sources"]["identifiers"] = json!(source);
        }
    }
}
pub(super) async fn response(response: reqwest::Response) -> Result<Value, String> {
    if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err("Provider rate limit reached. Retry the scan later.".into());
    }
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "Metadata provider returned HTTP {} ({}).",
            status.as_u16(),
            status.canonical_reason().unwrap_or("request failed")
        ));
    }
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Metadata response interrupted.")?
    {
        if bytes.len() + chunk.len() > 8 * 1024 * 1024 {
            return Err("Metadata response exceeds 8 MB.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "Invalid metadata response.".into())
}
pub(super) fn search_title(entry: &NativeCatalogEntry) -> String {
    static RE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"\s*[\[(](?:19|20)\d{2}[\])]\s*$").unwrap());
    let re = &*RE;
    re.replace(&entry.title, "").trim().into()
}
fn select<'a>(
    items: &'a [Value],
    entry: &NativeCatalogEntry,
    anilist: bool,
) -> Result<&'a Value, String> {
    let target = normalized(&search_title(entry));
    let year = entry.metadata["year"].as_i64();
    let matches: Vec<_> = items
        .iter()
        .filter(|v| {
            let names = if anilist {
                vec![
                    v["title"]["english"].as_str(),
                    v["title"]["romaji"].as_str(),
                    v["title"]["native"].as_str(),
                ]
            } else {
                vec![
                    v["title"].as_str(),
                    v["name"].as_str(),
                    v["original_title"].as_str(),
                    v["original_name"].as_str(),
                ]
            };
            let item_year = if anilist {
                v["startDate"]["year"].as_i64()
            } else {
                v["release_date"]
                    .as_str()
                    .or(v["first_air_date"].as_str())
                    .and_then(|v| v.get(..4)?.parse().ok())
            };
            names.into_iter().flatten().any(|n| normalized(n) == target)
                && year.is_none_or(|y| item_year == Some(y))
                && (if anilist && entry.kind == "movie" {
                    v["format"] == "MOVIE"
                } else if anilist && entry.kind == "series" {
                    v["format"] != "MOVIE"
                } else {
                    true
                })
        })
        .collect();
    if matches.len() != 1 {
        return Err("Identification needs review: no unique exact title/year match. Add a provider ID in Metadata, then scan again.".into());
    }
    Ok(matches[0])
}
pub(super) async fn anilist(
    client: &reqwest::Client,
    entry: &NativeCatalogEntry,
    manga: bool,
    allow_adult: bool,
) -> Result<Value, String> {
    let id = entry.metadata["identifiers"]["anilist"]
        .as_str()
        .and_then(|v| v.parse::<i64>().ok())
        .or(entry.metadata["identifiers"]["anilist"].as_i64());
    let media_type = if manga { "MANGA" } else { "ANIME" };
    let selected = if let Some(id) = id {
        id
    } else {
        let body=response(client.post("https://graphql.anilist.co").json(&json!({"query":"query($search:String,$type:MediaType,$adult:Boolean){Page(perPage:10){media(search:$search,type:$type,isAdult:$adult){id format title{english romaji native} startDate{year}}}}","variables":{"search":search_title(entry),"type":media_type,"adult":if allow_adult {Value::Null} else {json!(false)}}})).send().await.map_err(|_|"AniList connection failed.")?).await?;
        let candidates = body["data"]["Page"]["media"]
            .as_array()
            .ok_or("AniList search failed.")?;
        select(candidates, entry, true)?["id"]
            .as_i64()
            .ok_or("Invalid AniList ID.")?
    };
    let query = if manga {
        "query($id:Int,$type:MediaType){Media(id:$id,type:$type){id idMal countryOfOrigin isAdult format title{english romaji native} startDate{year month day} description(asHtml:false) status genres tags{name isAdult} studios{nodes{id name}} episodes chapters volumes duration averageScore siteUrl coverImage{extraLarge} bannerImage characters(perPage:100){pageInfo{hasNextPage} edges{role node{id name{full} description image{large}}}}}}"
    } else {
        "query($id:Int,$type:MediaType){Media(id:$id,type:$type){id idMal countryOfOrigin isAdult format title{english romaji native} startDate{year month day} description(asHtml:false) status genres tags{name isAdult} studios{nodes{id name}} episodes chapters volumes duration averageScore siteUrl coverImage{extraLarge} bannerImage characters(perPage:100){pageInfo{hasNextPage} edges{role node{id name{full} description image{large}} voiceActors{id languageV2 name{full} image{large}} voiceActorRoles{dubGroup roleNotes voiceActor{id languageV2 name{full} image{large}}}}} staff(perPage:100){pageInfo{hasNextPage} edges{role node{id name{full} image{large}}}}}}"
    };
    let mut body = response(
        client
            .post("https://graphql.anilist.co")
            .json(&json!({"query":query,"variables":{"id":selected,"type":media_type}}))
            .send()
            .await
            .map_err(|_| "AniList connection failed.")?,
    )
    .await?;
    // Fetch remaining connection pages without discarding the usable first page
    // if a later request fails. Each request shares the provider rate gate.
    for page in 2..=50 {
        let media = &body["data"]["Media"];
        if !["characters", "staff"]
            .iter()
            .any(|field| media[field]["pageInfo"]["hasNextPage"] == true)
        {
            break;
        }
        let gate = crate::workers::provider("anilist").await;
        drop(gate);
        let query = anilist_connection_query(media, manga);
        let result = match client
            .post("https://graphql.anilist.co")
            .json(&json!({"query":query,"variables":{"id":selected,"type":media_type,"page":page}}))
            .send()
            .await
        {
            Ok(result) => response(result).await,
            Err(_) => {
                Err("AniList connection failed while loading additional cast/crew pages.".into())
            }
        };
        match result {
            Ok(next) if next["data"]["Media"].is_object() => {
                if let Err(error) =
                    merge_anilist_page(&mut body["data"]["Media"], &next["data"]["Media"])
                {
                    body["data"]["Media"]["_pagination_warning"] = json!(error);
                    break;
                }
            }
            Ok(_) => {
                body["data"]["Media"]["_pagination_warning"] = json!(
                    "AniList returned no additional cast/crew data; the imported lists are incomplete."
                );
                break;
            }
            Err(error) => {
                body["data"]["Media"]["_pagination_warning"] = json!(format!(
                    "Additional cast/crew pages could not be loaded: {error}"
                ));
                break;
            }
        }
    }
    Ok(body)
}
fn anilist_connection_query(media: &Value, manga: bool) -> String {
    let mut connections = String::new();
    if media["characters"]["pageInfo"]["hasNextPage"] == true {
        connections.push_str("characters(page:$page,perPage:100){pageInfo{hasNextPage} edges{role node{id name{full} description image{large}}");
        if !manga {
            connections.push_str(" voiceActors{id languageV2 name{full} image{large}} voiceActorRoles{dubGroup roleNotes voiceActor{id languageV2 name{full} image{large}}}");
        }
        connections.push_str("}}");
    }
    if !manga && media["staff"]["pageInfo"]["hasNextPage"] == true {
        connections.push_str(" staff(page:$page,perPage:100){pageInfo{hasNextPage} edges{role node{id name{full} image{large}}}}");
    }
    format!("query($id:Int,$type:MediaType,$page:Int){{Media(id:$id,type:$type){{{connections}}}}}")
}
fn merge_anilist_page(media: &mut Value, next: &Value) -> Result<(), String> {
    for field in ["characters", "staff"] {
        if media[field]["pageInfo"]["hasNextPage"] != true {
            continue;
        }
        if !next[field]["pageInfo"]["hasNextPage"].is_boolean() || !next[field]["edges"].is_array()
        {
            return Err(
                "AniList returned an incomplete cast/crew page; earlier pages were retained."
                    .into(),
            );
        }
        if let Some(edges) = next[field]["edges"].as_array() {
            if let Some(existing) = media[field]["edges"].as_array_mut() {
                for edge in edges {
                    if !existing.contains(edge) {
                        existing.push(edge.clone());
                    }
                }
            }
            media[field]["pageInfo"] = next[field]["pageInfo"].clone();
        }
    }
    Ok(())
}

async fn tmdb(
    client: &reqwest::Client,
    entry: &NativeCatalogEntry,
    token: &str,
    series_id: Option<&str>,
    options: &posterview_contracts::native::NativeLibraryOptions,
) -> Result<Value, String> {
    let request = |path: String| {
        let r = client
            .get(format!("https://api.themoviedb.org/3/{path}"))
            .query(&[
                ("language", options.metadata_language.as_str()),
                (
                    "include_image_language",
                    &format!("{},null", options.image_language),
                ),
            ]);
        if token.len() == 32 {
            r.query(&[("api_key", token)])
        } else {
            r.bearer_auth(token)
        }
    };
    if entry.kind == "episode" || entry.kind == "season" {
        let series = series_id.ok_or(
            "Parent series needs a TMDB ID before season or episode metadata can be fetched.",
        )?;
        if series.is_empty() || !series.chars().all(|c| c.is_ascii_digit()) {
            return Err("Invalid series TMDB ID.".into());
        }
        let season = entry.metadata["season"]
            .as_i64()
            .ok_or("Missing season number.")?;
        let suffix = if entry.kind == "episode" {
            format!(
                "/episode/{}",
                entry.metadata["episode"]
                    .as_i64()
                    .ok_or("Missing episode number.")?
            )
        } else {
            String::new()
        };
        return response(
            request(format!("tv/{series}/season/{season}{suffix}"))
                .query(&[("append_to_response", "credits,images")])
                .send()
                .await
                .map_err(|_| "TMDB connection failed.")?,
        )
        .await;
    }
    let kind = if entry.kind == "movie" { "movie" } else { "tv" };
    let id = entry.metadata["identifiers"]["tmdb"]
        .as_str()
        .map(str::to_owned)
        .or_else(|| {
            entry.metadata["identifiers"]["tmdb"]
                .as_i64()
                .map(|v| v.to_string())
        });
    let id = if let Some(id) = id {
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_digit()) {
            return Err("Invalid TMDB ID.".into());
        }
        id
    } else {
        let body = response(
            request(format!("search/{kind}"))
                .query(&[
                    ("query", search_title(entry)),
                    ("include_adult", options.allow_adult_metadata.to_string()),
                ])
                .send()
                .await
                .map_err(|_| "TMDB connection failed.")?,
        )
        .await?;
        let candidates = body["results"].as_array().ok_or("TMDB search failed.")?;
        select(candidates, entry, false)?["id"]
            .as_i64()
            .ok_or("Invalid TMDB ID.")?
            .to_string()
    };
    response(
        request(format!("{kind}/{id}"))
            .query(&[(
                "append_to_response",
                if kind == "movie" {
                    "credits,external_ids,keywords,images,release_dates"
                } else {
                    "credits,external_ids,keywords,images,content_ratings"
                },
            )])
            .send()
            .await
            .map_err(|_| "TMDB connection failed.")?,
    )
    .await
}
fn image_path<'a>(data: &'a Value, list: &str, fallback: &str, language: &str) -> Option<&'a str> {
    let images = data["images"][list].as_array();
    images
        .and_then(|v| {
            v.iter()
                .find(|a| a["iso_639_1"] == language && a["file_path"].is_string())
        })
        .or_else(|| {
            images.and_then(|v| {
                v.iter()
                    .find(|a| a["iso_639_1"].is_null() && a["file_path"].is_string())
            })
        })
        .and_then(|a| a["file_path"].as_str())
        .or(data[fallback].as_str())
}
pub(crate) async fn download(
    state: &AppState,
    client: &reqwest::Client,
    url: &str,
) -> Result<String, String> {
    let url = reqwest::Url::parse(url).map_err(|_| "Invalid artwork URL.")?;
    if url.scheme() != "https"
        || !matches!(
            url.host_str(),
            Some(
                "image.tmdb.org"
                    | "s4.anilist.co"
                    | "artworks.thetvdb.com"
                    | "assets.fanart.tv"
                    | "cdn.myanimelist.net"
                    | "m.media-amazon.com"
                    | "ia.media-imdb.com"
                    | "cdn-eu.anidb.net"
                    | "cdn-us.anidb.net"
                    | "img7.anidb.net"
            )
        )
        || url.port().is_some_and(|p| p != 443)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Artwork host is not supported.".into());
    }
    let slot = crate::workers::network().await;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "Artwork download failed.")?
        .error_for_status()
        .map_err(|_| "Artwork download failed.")?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Artwork download interrupted.")?
    {
        if bytes.len() + chunk.len() > 20 * 1024 * 1024 {
            return Err("Artwork exceeds 20 MB.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    drop(slot);
    let state = state.clone();
    tokio::task::spawn_blocking(move || crate::workers::blocking(|| store_image(&state, &bytes)))
        .await
        .map_err(|_| "Artwork processing interrupted.".to_string())?
}
pub(crate) fn store_image(state: &AppState, bytes: &[u8]) -> Result<String, String> {
    if bytes.len() > 20 * 1024 * 1024 {
        return Err("Artwork exceeds 20 MB.".into());
    }
    if crate::native_animation::is_animated(bytes) {
        let (clean, still, extension) = crate::native_animation::prepare(bytes)?;
        let dir = state.runtime.data_dir().join("native-artwork");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let id = uuid::Uuid::new_v4();
        std::fs::write(dir.join(format!("{id}.still.png")), still).map_err(|e| e.to_string())?;
        let name = format!("{id}.{extension}");
        std::fs::write(dir.join(&name), clean).map_err(|e| e.to_string())?;
        return Ok(format!("@managed/{name}"));
    }
    let reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| "Invalid artwork image.")?;
    let format = reader.format().ok_or("Invalid artwork image.")?;
    let extension = match format {
        image::ImageFormat::Jpeg => "jpg",
        image::ImageFormat::Png => "png",
        image::ImageFormat::WebP => "webp",
        _ => return Err("Use JPEG, PNG, or WebP artwork.".into()),
    };
    let (width, height) = reader
        .into_dimensions()
        .map_err(|_| "Invalid artwork image.")?;
    if u64::from(width) * u64::from(height) > 64_000_000 {
        return Err("Artwork exceeds 64 megapixels.".into());
    }
    let dir = state.runtime.data_dir().join("native-artwork");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = format!("{}.{}", uuid::Uuid::new_v4(), extension);
    std::fs::write(dir.join(&name), bytes).map_err(|e| e.to_string())?;
    Ok(format!("@managed/{name}"))
}
struct EnrichmentContext {
    client: reqwest::Client,
    token: String,
    service: std::sync::Arc<posterview_infra_artwork::ArtworkService>,
    parents: BTreeMap<String, Value>,
    blocked: std::sync::Arc<std::sync::Mutex<std::collections::BTreeSet<String>>>,
}
// Persist checks so absent provider fields/images do not trigger requests on every rescan.
fn check_identity(
    entry: &NativeCatalogEntry,
    library: &NativeLibrary,
    parents: &BTreeMap<String, Value>,
) -> Value {
    let parent = entry
        .parent_path
        .as_deref()
        .map(|p| p.split("/@season-").next().unwrap_or(p));
    let mut identity = json!({"title":search_title(entry),"kind":entry.kind,"ids":entry.metadata["identifiers"],
        "year":entry.metadata["year"],"season":entry.metadata["season"],"episode":entry.metadata["episode"],
        "parent":parent.and_then(|p|parents.get(p)),"options":library.options});
    let essential = if entry.kind == "season" {
        vec!["title"]
    } else {
        vec!["title", "plot"]
    };
    let missing_fields = essential
        .into_iter()
        .filter(|field| missing(&entry.metadata[*field]))
        .collect::<Vec<_>>();
    let portraits = if needs_credit_portraits(entry) {
        entry.metadata["credits"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|credit| credit["category"] == "cast" && missing(&credit["image"]))
            .map(|credit| credit["name"].clone())
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    identity["work_schema"] = json!(2);
    identity["work"] = json!({"missing_fields":missing_fields,"images":missing_images(entry, library),
        "voice_schema":entry.metadata["voice_cast_schema"],"voice_cast":needs_voice_cast(entry, library),
        "book_characters":needs_book_characters(entry, library),"portraits":portraits,
        "special_placement":needs_special_placement(entry, library),"partial_lists":incomplete_anilist_lists(&entry.metadata["anilist_data"])});
    if entry.kind == "episode" && entry.metadata["season"].as_u64() == Some(0) {
        identity["special_placement_schema"] = json!(1);
    }
    if entry.kind == "book_series" {
        identity["book_characters_schema"] = json!(1);
    }
    identity
}
fn recently_checked(entry: &NativeCatalogEntry, identity: &Value, now: i64) -> bool {
    let checked = &entry.metadata["_provider_check"];
    checked["identity"] == *identity && checked["until"].as_i64().is_some_and(|until| until > now)
}
fn needs_primary_work(entry: &NativeCatalogEntry, library: &NativeLibrary) -> bool {
    let metadata_enabled = entry.metadata["_identify_source"] == "tvdb"
        || library
            .options
            .metadata_providers
            .get(&entry.kind)
            .is_none_or(|providers| !providers.is_empty());
    let images_enabled = entry.metadata["_identify_replace_artwork"] == true
        || library
            .options
            .image_providers
            .get(&entry.kind)
            .is_none_or(|providers| !providers.is_empty());
    (metadata_enabled
        && (!metadata_complete(entry)
            || needs_voice_cast(entry, library)
            || needs_book_characters(entry, library)
            || needs_credit_portraits(entry)
            || needs_special_placement(entry, library)))
        || (images_enabled && !missing_images(entry, library).is_empty())
}
fn eligible_entry(entry: &NativeCatalogEntry) -> bool {
    entry.available
        && entry.metadata["missing"] != true
        && matches!(
            entry.kind.as_str(),
            "series" | "book_series" | "movie" | "season" | "episode"
        )
}
fn needs_enrichment(
    entry: &NativeCatalogEntry,
    library: &NativeLibrary,
    parents: &BTreeMap<String, Value>,
    now: i64,
) -> bool {
    entry.metadata["_scan_checkpoint_restored"] != true
        && eligible_entry(entry)
        && ((needs_primary_work(entry, library)
            && !recently_checked(entry, &check_identity(entry, library, parents), now))
            || crate::native_jikan::needs_enrichment(entry, library))
}
fn enrichment_tier(entry: &NativeCatalogEntry) -> usize {
    match entry.kind.as_str() {
        "series" | "book_series" | "movie" => 0,
        "season" => 1,
        _ => 2,
    }
}
fn parent_metadata(entries: &[NativeCatalogEntry]) -> BTreeMap<String, Value> {
    entries
        .iter()
        .filter(|entry| entry.kind == "series")
        .map(|entry| {
            (
                entry.path.clone(),
                json!({"identifiers":entry.metadata["identifiers"]}),
            )
        })
        .collect()
}

fn checkpoint_signature(
    entry: &NativeCatalogEntry,
    library: &NativeLibrary,
    parents: &BTreeMap<String, Value>,
) -> String {
    let input = json!([
        crate::native::scan_checkpoint_signature(entry, library),
        check_identity(entry, library, parents)["parent"]
    ])
    .to_string();
    let mut digest = std::collections::hash_map::DefaultHasher::new();
    std::hash::Hasher::write(&mut digest, input.as_bytes());
    format!("v2:{:016x}", std::hash::Hasher::finish(&digest))
}

pub(crate) async fn enrich(
    state: &AppState,
    library: &NativeLibrary,
    entries: &mut [NativeCatalogEntry],
    warnings: &mut Vec<String>,
) -> Result<(), HttpError> {
    let job_context = crate::jobs::native_context(state, &library.id);
    if let Some(context) = &job_context {
        context.check()?;
    }
    if !library.options.fetch_missing {
        return Ok(());
    }
    let signature_library = library.clone();
    let checkpoints = if let Some(context) = &job_context {
        context
            .checkpoints(state)
            .await?
            .into_iter()
            .map(|checkpoint| (checkpoint.key.clone(), checkpoint))
            .collect::<BTreeMap<_, _>>()
    } else {
        BTreeMap::new()
    };
    let mut configured = library.clone();
    if !crate::artwork_preferences::artwork_enabled(state) {
        configured.options.image_types.clear();
    }
    let library = &configured;
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(client) => client,
        Err(_) => {
            warnings.push("Unable to create metadata client.".into());
            return Ok(());
        }
    };
    let token = match ServerStore::new(state.runtime.data_dir()).get_setting("tmdb_access_token") {
        Ok(token) => token,
        Err(error) => {
            warnings.push(error.to_string());
            return Ok(());
        }
    };
    let service = std::sync::Arc::new(posterview_infra_artwork::ArtworkService::default());
    let blocked = std::sync::Arc::new(std::sync::Mutex::new(std::collections::BTreeSet::new()));
    let mut completed = 0;
    let mut progress = crate::native_progress::Reporter::new(state, &library.id);
    let mut failure = None;
    progress.report("metadata", 0, None, entries.len(), "", true);
    for tier in 0..3 {
        let context = std::sync::Arc::new(EnrichmentContext {
            client: client.clone(),
            token: token.clone(),
            service: service.clone(),
            parents: parent_metadata(entries),
            blocked: blocked.clone(),
        });
        // Validate children only after their resolved parents are available.
        // A parent's identification can change without changing a child's file.
        let signatures = entries
            .iter()
            .map(|entry| checkpoint_signature(entry, &signature_library, &context.parents))
            .collect::<Vec<_>>();
        for (index, entry) in entries
            .iter_mut()
            .enumerate()
            .filter(|(_, entry)| enrichment_tier(entry) == tier)
        {
            if let Some(saved) = checkpoints.get(&entry.path) {
                crate::native::restore_scan_checkpoint_with_signature(
                    entry,
                    saved,
                    &signatures[index],
                );
            }
        }
        // A newly identified parent can make child work eligible. Count only
        // remaining real work after each dependency tier, including cache hits
        // that the supplementary provider can apply without a network request.
        let now = chrono::Utc::now().timestamp();
        let total = completed
            + entries
                .iter()
                .filter(|entry| {
                    enrichment_tier(entry) >= tier
                        && needs_enrichment(entry, library, &context.parents, now)
                })
                .count();
        // Child cache identities depend on their resolved parent IDs. Until the
        // parent tiers finish, an honest final denominator is not yet known.
        let reported_total = (tier == 2).then_some(total);
        progress.report(
            "metadata",
            completed,
            reported_total,
            entries.len(),
            "",
            true,
        );
        let mut pending = entries
            .iter()
            .enumerate()
            .filter(|(_, e)| {
                enrichment_tier(e) == tier && needs_enrichment(e, library, &context.parents, now)
            })
            .map(|(i, e)| (i, e.clone()))
            .collect::<Vec<_>>()
            .into_iter();
        let mut jobs = tokio::task::JoinSet::new();
        loop {
            while jobs.len() < crate::workers::network_limit() {
                if failure.is_some()
                    || job_context
                        .as_ref()
                        .is_some_and(|context| context.check().is_err())
                {
                    break;
                }
                let Some((index, entry)) = pending.next() else {
                    break;
                };
                let state = state.clone();
                let library = library.clone();
                let context = context.clone();
                let durable_context = job_context.clone();
                jobs.spawn(async move {
                    let mut entry = entry;
                    let before = entry.clone();
                    let mut warnings = Vec::new();
                    let identity = check_identity(&entry, &library, &context.parents);
                    let mut primary_delay = None;
                    if durable_context.as_ref().is_none_or(|context|context.check().is_ok()) && needs_primary_work(&entry, &library) && !recently_checked(&entry, &identity, chrono::Utc::now().timestamp()) {
                        enrich_one(&state, &library, &mut entry, &mut warnings, &context).await;
                        // Retry errors after one hour; successful checks with unavailable fields after one day.
                        let blocked = !context.blocked.lock().unwrap_or_else(|e| e.into_inner()).is_empty();
                        let delay = if warnings.is_empty() && !blocked { 86_400 } else { 3_600 };
                        primary_delay = Some(delay);
                    }
                    if durable_context.as_ref().is_none_or(|context|context.check().is_ok()) && crate::native_jikan::needs_enrichment(&entry, &library) {
                        crate::native_jikan::enrich(&state, &library, &mut entry, &context.client, &mut warnings).await;
                    }
                    if let Some(delay) = primary_delay {
                        entry.metadata["_provider_check"] = json!({"identity":check_identity(&entry, &library, &context.parents),"until":chrono::Utc::now().timestamp()+delay});
                    }
                    crate::native_operations::preserve_locked_metadata(&before, &mut entry);
                    // Sidecar persistence must include enrichment of unchanged
                    // media files, not only entries whose file stat changed.
                    entry.metadata["_scan_unchanged"] = json!(false);
                    (index, entry, warnings)
                });
            }
            let Some(result) = jobs.join_next().await else {
                break;
            };
            completed += 1;
            match result {
                Ok((index, entry, notices)) => {
                    if let Some(context) = &job_context {
                        match serde_json::to_value(&entry) {
                            Ok(value) => {
                                if let Err(error) = context
                                    .checkpoint(
                                        state,
                                        posterview_contracts::jobs::JobCheckpoint {
                                            key: entry.path.clone(),
                                            signature: signatures[index].clone(),
                                            value,
                                        },
                                    )
                                    .await
                                {
                                    if failure.is_none() {
                                        failure = Some(error);
                                    }
                                }
                            }
                            Err(_) => {
                                if failure.is_none() {
                                    failure = Some(HttpError::bad_gateway(
                                        "Unable to save metadata checkpoint.",
                                    ));
                                }
                            }
                        }
                    }
                    let current = entry.path.clone();
                    entries[index] = entry;
                    warnings.extend(notices);
                    progress.report(
                        "metadata",
                        completed,
                        reported_total,
                        entries.len(),
                        &current,
                        completed == total,
                    );
                }
                Err(error) => {
                    warnings.push(format!("Metadata worker interrupted: {error}"));
                    if job_context.is_some() && failure.is_none() {
                        failure = Some(HttpError::bad_gateway(
                            "Metadata worker interrupted. Saved work will be resumed.",
                        ));
                    }
                }
            }
        }
        if let Some(error) = failure {
            return Err(error);
        }
        if let Some(context) = &job_context {
            context.check()?;
        }
    }
    progress.report(
        "metadata",
        completed,
        Some(completed),
        entries.len(),
        "",
        true,
    );
    let mut seen = std::collections::BTreeSet::new();
    warnings.retain(|warning| seen.insert(warning.clone()));
    Ok(())
}
fn needs_book_characters(entry: &NativeCatalogEntry, library: &NativeLibrary) -> bool {
    entry.kind == "book_series"
        && !entry.metadata["characters"].is_array()
        && library
            .options
            .metadata_providers
            .get("book_series")
            .is_none_or(|providers| providers.iter().any(|p| p == "anilist"))
}
async fn enrich_one(
    state: &AppState,
    library: &NativeLibrary,
    entry: &mut NativeCatalogEntry,
    warnings: &mut Vec<String>,
    context: &EnrichmentContext,
) {
    let client = &context.client;
    let token = &context.token;
    let service = context.service.as_ref();
    if entry.kind == "book" {
        return;
    }
    if !needs_primary_work(entry, library) {
        return;
    }
    let default = if (library.library_type == NativeLibraryType::Anime
        || library.library_type == NativeLibraryType::Books)
        && !["episode", "season"].contains(&entry.kind.as_str())
    {
        vec!["anilist".to_owned()]
    } else {
        vec!["tmdb".to_owned()]
    };
    let book_default = vec![
        "comicvine".to_owned(),
        "anilist".to_owned(),
        "mal".to_owned(),
    ];
    let metadata_default = if entry.kind == "book_series" {
        &book_default
    } else {
        &default
    };
    let selected_order = entry.metadata["_identify_source"]
        .as_str()
        .filter(|p| *p == "tvdb")
        .map(|p| vec![p.to_string()]);
    let metadata_order = library
        .options
        .metadata_providers
        .get(&entry.kind)
        .unwrap_or(metadata_default);
    let metadata_order = selected_order.as_ref().unwrap_or(metadata_order);
    let image_order = library
        .options
        .image_providers
        .get(&entry.kind)
        .unwrap_or(&default);
    let replacement_images = vec!["tvdb".to_string()];
    let image_order = if entry.metadata["_identify_replace_artwork"] == true
        && library.library_type != NativeLibraryType::Books
    {
        &replacement_images
    } else {
        image_order
    };
    // Complete essential metadata first, then try image sources in their independent priority.
    // Cache responses so a provider selected for both purposes is fetched only once.
    let mut image_candidates = BTreeMap::<String, Vec<(String, String)>>::new();
    let mut attempted = std::collections::BTreeSet::new();
    for (provider_name, image_phase) in metadata_order
        .iter()
        .map(|p| (p.clone(), false))
        .chain(image_order.iter().map(|p| (p.clone(), true)))
    {
        if crate::jobs::native_context(state, &library.id)
            .is_some_and(|context| context.check().is_err())
        {
            return;
        }
        if provider_name == "omdb" && !crate::native_provider_extra::omdb_enabled(state) {
            continue;
        }
        if provider_name == "anidb" && !crate::native_provider_extra::anidb_enabled(state) {
            continue;
        }
        if provider_name == "comicvine" && missing(&entry.metadata["identifiers"]["comicvine"]) {
            continue;
        }
        if !image_phase
            && metadata_complete(entry)
            && !(provider_name == "anilist"
                && (needs_voice_cast(entry, library) || needs_book_characters(entry, library)))
            && !(matches!(provider_name.as_str(), "tmdb" | "tvdb") && needs_credit_portraits(entry))
            && !(provider_name == "tvdb" && needs_special_placement(entry, library))
        {
            continue;
        }
        if image_phase && provider_name == "capture" {
            if let Err(error) = crate::native_capture::capture(state, library, entry).await {
                warnings.push(format!("{} (Image Capture): {error}", entry.title));
            }
            continue;
        }
        if image_phase {
            if missing_images(entry, library).is_empty() {
                break;
            }
            if let Some(artwork) = image_candidates.get(&provider_name) {
                download_candidates(
                    state,
                    client,
                    library,
                    entry,
                    &provider_name,
                    artwork,
                    warnings,
                )
                .await;
                continue;
            }
            if attempted.contains(&provider_name) {
                continue;
            }
        }
        if context
            .blocked
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(&provider_name)
        {
            continue;
        }
        let _slot = if provider_name == "anidb" {
            None
        } else {
            Some(crate::workers::network().await)
        };
        let gate = crate::workers::provider(&provider_name).await;
        drop(gate);
        if context
            .blocked
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(&provider_name)
        {
            continue;
        }
        attempted.insert(provider_name.clone());
        if !["tmdb", "anilist"].contains(&provider_name.as_str()) {
            let parent_path = entry
                .parent_path
                .as_deref()
                .map(|v| v.split("/@season-").next().unwrap_or(v));
            let parent = parent_path
                .and_then(|v| context.parents.get(v))
                .cloned()
                .unwrap_or(Value::Null);
            match super::native_provider_extra::fetch(
                state,
                client,
                service,
                &provider_name,
                library,
                entry,
                &parent,
            )
            .await
            {
                Ok(data) => {
                    let mut fields = data.fields;
                    if let Some(credits) = fields["credits"].as_array_mut() {
                        for credit in credits {
                            credit["provider"] = json!(provider_name);
                        }
                    }
                    if metadata_order.contains(&provider_name) {
                        for (field, value) in fields.as_object().unwrap() {
                            if field != "identifiers"
                                && !(library.library_type == NativeLibraryType::Books
                                    && ["credits", "characters", "voice_cast"]
                                        .contains(&field.as_str()))
                            {
                                fill(entry, field, value.clone(), &provider_name);
                            }
                        }
                    }
                    merge_identifiers(entry, &fields["identifiers"], &provider_name);
                    if let Some(id) = data.id {
                        merge_identifiers(
                            entry,
                            &json!({provider_name.clone():id}),
                            &provider_name,
                        );
                    }
                    fill(
                        entry,
                        &format!("{provider_name}_data"),
                        data.raw,
                        &provider_name,
                    );
                    image_candidates.insert(provider_name.clone(), data.artwork);
                }
                Err(e) => {
                    if e.contains("rate limit") || e.starts_with("Configure ") {
                        context
                            .blocked
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .insert(provider_name.clone());
                    }
                    warnings.push(format!("{} ({provider_name}): {e}", entry.title));
                }
            }
            drop(_slot);
            if image_phase && let Some(artwork) = image_candidates.get(&provider_name) {
                download_candidates(
                    state,
                    client,
                    library,
                    entry,
                    &provider_name,
                    artwork,
                    warnings,
                )
                .await;
            }
            continue;
        }
        let use_anilist = provider_name == "anilist";
        let result = if use_anilist && entry.kind != "episode" {
            anilist(
                client,
                entry,
                library.library_type == NativeLibraryType::Books,
                library.allows_adult_metadata(),
            )
            .await
        } else if !token.is_empty() {
            let series = entry
                .parent_path
                .as_ref()
                .map(|v| v.split("/@season-").next().unwrap_or(v));
            tmdb(
                client,
                entry,
                token,
                series
                    .and_then(|v| context.parents.get(v))
                    .and_then(|m| m["identifiers"]["tmdb"].as_str()),
                &library.options,
            )
            .await
        } else {
            if !warnings.iter().any(|v| {
                v == "TMDB credentials are not configured; video metadata fetching was skipped."
            }) {
                warnings.push(
                    "TMDB credentials are not configured; video metadata fetching was skipped."
                        .into(),
                );
            }
            continue;
        };
        let data = match result {
            Ok(v) => v,
            Err(e) => {
                if e.contains("rate limit") || e.starts_with("Configure ") {
                    context
                        .blocked
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .insert(provider_name.clone());
                }
                warnings.push(format!("{} ({provider_name}): {e}", entry.title));
                continue;
            }
        };
        let ani = use_anilist && entry.kind != "episode";
        let provider = if ani { "anilist" } else { "tmdb" };
        let data = if ani {
            data["data"]["Media"].clone()
        } else {
            data
        };
        if data.is_null() {
            warnings.push(format!("{}: provider returned no metadata.", entry.title));
            continue;
        }
        if !library.allows_adult_metadata() && (data["isAdult"] == true || data["adult"] == true) {
            warnings.push(format!(
                "{}: adult metadata matching is disabled.",
                entry.title
            ));
            continue;
        }
        let mut fields = json!({});
        let mut artwork = Vec::new();
        if ani {
            if let Some(message) = data["_pagination_warning"].as_str() {
                if message.contains("rate limit") {
                    context
                        .blocked
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .insert("anilist".into());
                }
                warnings.push(format!("{} (anilist): {message}", entry.title));
            } else if data["characters"]["pageInfo"]["hasNextPage"] == true
                || data["staff"]["pageInfo"]["hasNextPage"] == true
            {
                warnings.push(format!("{} (anilist): character/staff lists exceed the 5,000-entry scan safety limit and are incomplete.", entry.title));
            }
            fields["title"] = data["title"][if library.options.metadata_language == "ja" {
                "native"
            } else {
                "english"
            }]
            .as_str()
            .or(data["title"]["romaji"].as_str())
            .map(|v| json!(v))
            .unwrap_or(Value::Null);
            fields["originaltitle"] = data["title"]["native"].clone();
            fields["plot"] = data["description"].clone();
            fields["year"] = data["startDate"]["year"].clone();
            fields["genres"] = data["genres"].clone();
            fields["status"] = data["status"].clone();
            fields["runtime"] = data["duration"].clone();
            fields["volumes"] = data["volumes"].clone();
            fields["episodes"] = data["episodes"].clone();
            fields["tags"] = json!(
                data["tags"]
                    .as_array()
                    .unwrap_or(&Vec::new())
                    .iter()
                    .filter_map(|v| v["name"].as_str())
                    .collect::<Vec<_>>()
            );
            fields["studios"] = json!(
                data["studios"]["nodes"]
                    .as_array()
                    .unwrap_or(&Vec::new())
                    .iter()
                    .filter_map(|v| v["name"].as_str())
                    .collect::<Vec<_>>()
            );
            let mut characters = Vec::new();
            let mut credits = Vec::new();
            for edge in data["characters"]["edges"]
                .as_array()
                .unwrap_or(&Vec::new())
            {
                let node = &edge["node"];
                characters.push(json!({"id":node["id"].to_string(),"name":node["name"]["full"],"biography":node["description"],"image":node["image"]["large"],"role":edge["role"]}));
                for actor in edge["voiceActors"].as_array().unwrap_or(&Vec::new()) {
                    credits.push(json!({"name":actor["name"]["full"],"provider_id":actor["id"],"role":node["name"]["full"],"category":"voice","image":actor["image"]["large"],"language":actor["languageV2"]}));
                }
            }
            for edge in data["staff"]["edges"].as_array().unwrap_or(&Vec::new()) {
                credits.push(json!({"name":edge["node"]["name"]["full"],"role":edge["role"],"provider_id":edge["node"]["id"],"category":"crew","image":edge["node"]["image"]["large"]}));
            }
            fields["country_of_origin"] = data["countryOfOrigin"].clone();
            fields["characters"] = json!(characters);
            if library.library_type != NativeLibraryType::Books {
                fields["voice_cast"] = anilist_voice_cast(&data);
                if !matches!(
                    entry.metadata["_sources"]["voice_cast"].as_str(),
                    Some("manual" | "nfo")
                ) {
                    entry.metadata["voice_cast"] = fields["voice_cast"].clone();
                    entry.metadata["_sources"]["voice_cast"] = json!("anilist");
                }
                fields["country_of_origin"] = data["countryOfOrigin"].clone();
                // A successful empty cast is a known result, not a reason to fetch every scan.
                entry.metadata["voice_cast_schema"] = json!(3);
                entry.metadata["_sources"]["voice_cast_schema"] = json!("anilist");
                fields["credits"] = json!(credits);
            }
            for (kind, value) in [
                ("poster", &data["coverImage"]["extraLarge"]),
                ("backdrop", &data["bannerImage"]),
            ] {
                if let Some(url) = value.as_str() {
                    artwork.push((kind, url.to_owned()));
                }
            }
        } else {
            fields["title"] = data["title"]
                .as_str()
                .or(data["name"].as_str())
                .map(|v| json!(v))
                .unwrap_or(Value::Null);
            fields["originaltitle"] = data["original_title"]
                .as_str()
                .or(data["original_name"].as_str())
                .map(|v| json!(v))
                .unwrap_or(Value::Null);
            fields["plot"] = data["overview"].clone();
            let date = data["release_date"]
                .as_str()
                .or(data["first_air_date"].as_str())
                .or(data["air_date"].as_str());
            fields["year"] = date
                .and_then(|v| v.get(..4)?.parse::<i64>().ok())
                .map(|v| json!(v))
                .unwrap_or(Value::Null);
            fields["premiered"] = date.map(|v| json!(v)).unwrap_or(Value::Null);
            fields["runtime"] = data["runtime"].clone();
            fields["status"] = data["status"].clone();
            fields["rating"] = data["vote_average"].clone();
            for (field, key) in [("genres", "genres"), ("studios", "production_companies")] {
                fields[field] = json!(
                    data[key]
                        .as_array()
                        .unwrap_or(&Vec::new())
                        .iter()
                        .filter_map(|v| v["name"].as_str())
                        .collect::<Vec<_>>()
                );
            }
            let tags = data["keywords"]["keywords"]
                .as_array()
                .or(data["keywords"]["results"].as_array());
            fields["tags"] = json!(
                tags.unwrap_or(&Vec::new())
                    .iter()
                    .filter_map(|v| v["name"].as_str())
                    .collect::<Vec<_>>()
            );
            let mut credits = Vec::new();
            for (key, category) in [("cast", "cast"), ("crew", "crew")] {
                for v in data["credits"][key].as_array().unwrap_or(&Vec::new()) {
                    credits.push(json!({"name":v["name"],"role":v["character"].as_str().or(v["job"].as_str()),"category":category,"provider_id":v["id"],"image":v["profile_path"]}));
                }
            }
            fields["credits"] = json!(credits);
            for (kind, list, fallback) in [
                ("poster", "posters", "poster_path"),
                ("backdrop", "backdrops", "backdrop_path"),
                ("thumb", "stills", "still_path"),
                ("logo", "logos", "logo_path"),
                ("banner", "banners", "banner_path"),
            ] {
                if let Some(path) =
                    image_path(&data, list, fallback, &library.options.image_language)
                {
                    artwork.push((kind, format!("https://image.tmdb.org/t/p/original{path}")));
                }
            }
        }
        if let Some(credits) = fields["credits"].as_array_mut() {
            for credit in credits {
                credit["provider"] = json!(provider);
            }
        }
        if metadata_order.iter().any(|p| p == provider) {
            let ratings = if entry.kind == "movie" {
                data["release_dates"]["results"].as_array()
            } else {
                data["content_ratings"]["results"].as_array()
            };
            if let Some(rating) = ratings.and_then(|v| {
                v.iter()
                    .find(|r| r["iso_3166_1"] == library.options.certification_country)
            }) {
                fields["mpaa"] = if entry.kind == "movie" {
                    rating["release_dates"]
                        .as_array()
                        .and_then(|v| {
                            v.iter()
                                .find_map(|r| r["certification"].as_str().filter(|s| !s.is_empty()))
                        })
                        .map(|v| json!(v))
                        .unwrap_or(Value::Null)
                } else {
                    rating["rating"].clone()
                };
            }
        }
        if ani {
            extend_anilist_lists(entry, &fields, &data);
        }
        for (field, value) in fields.as_object().unwrap() {
            fill(entry, field, value.clone(), provider);
        }
        if ani {
            if let Some(mal) = data["idMal"].as_u64() {
                merge_identifiers(entry, &json!({"mal":mal.to_string()}), provider);
            }
        } else {
            let ids = json!({"imdb":data["imdb_id"].as_str().or(data["external_ids"]["imdb_id"].as_str()),"tvdb":data["external_ids"]["tvdb_id"].as_u64().map(|v|v.to_string())});
            merge_identifiers(entry, &ids, provider);
        }
        let provider_id = data["id"].to_string();
        if entry.metadata["identifiers"].is_null() {
            entry.metadata["identifiers"] = json!({});
        }
        if entry.metadata["identifiers"][provider].is_null() {
            entry.metadata["identifiers"][provider] = json!(provider_id);
            entry.metadata["_sources"]["identifiers"] = json!(provider);
        }
        fill(entry, &format!("{provider}_data"), data, provider);
        image_candidates.insert(
            provider.into(),
            artwork
                .into_iter()
                .map(|(kind, url)| (kind.to_owned(), url))
                .collect(),
        );
        drop(_slot);
        if image_phase && let Some(artwork) = image_candidates.get(&provider_name) {
            download_candidates(
                state,
                client,
                library,
                entry,
                &provider_name,
                artwork,
                warnings,
            )
            .await;
        }
    }
}
async fn download_candidates(
    state: &AppState,
    client: &reqwest::Client,
    library: &NativeLibrary,
    entry: &mut NativeCatalogEntry,
    provider: &str,
    artwork: &[(String, String)],
    warnings: &mut Vec<String>,
) {
    let replacing = entry.metadata["_identify_replace_artwork"] == true;
    let needed = missing_images(entry, library);
    let mut candidates = BTreeMap::<String, Vec<(String, String)>>::new();
    for (kind, url) in artwork {
        if needed.contains(kind) {
            candidates
                .entry(kind.clone())
                .or_default()
                .push((provider.to_owned(), url.clone()));
        }
    }
    let mut jobs = tokio::task::JoinSet::new();
    for (kind, candidates) in candidates {
        let state = state.clone();
        let client = client.clone();
        let title = entry.title.clone();
        jobs.spawn(async move {
            let mut warnings = Vec::new();
            for (provider, url) in candidates {
                match download(&state, &client, &url).await {
                    Ok(path) => {
                        return (
                            Some(NativeArtwork {
                                kind,
                                path,
                                source: provider,
                            }),
                            warnings,
                        );
                    }
                    Err(e) => warnings.push(format!("{title} ({kind}): {e}")),
                }
            }
            (None, warnings)
        });
    }
    while let Some(result) = jobs.join_next().await {
        match result {
            Ok((art, notices)) => {
                if let Some(mut art) = art {
                    if replacing {
                        art.source = "manual".into();
                        if let Err(e) = ServerStore::new(state.runtime.data_dir())
                            .save_native_artwork(&library.id, &entry.id, &art)
                        {
                            warnings
                                .push(format!("{}: artwork replacement failed: {e}", entry.title));
                            continue;
                        }
                        if (library.options.save_artwork
                            || crate::native_artwork::replacement_writes_local(
                                state, entry, &art.kind,
                            ))
                            && let Err(e) = crate::native_artwork::write(state, entry, &art, true)
                        {
                            warnings.push(format!(
                                "{}: artwork saved; media-folder write failed: {e}",
                                entry.title
                            ));
                        }
                        entry.artwork.retain(|existing| existing.kind != art.kind);
                    }
                    entry.artwork.push(art);
                }
                warnings.extend(notices);
            }
            Err(error) => warnings.push(format!(
                "{}: artwork worker interrupted: {error}",
                entry.title
            )),
        }
    }
    if replacing {
        if let Err(e) =
            ServerStore::new(state.runtime.data_dir()).finish_identification_artwork(&entry.id)
        {
            warnings.push(format!("Artwork refresh completion failed: {e}"));
        }
        entry.metadata["_identify_replace_artwork"] = json!(false);
    }
    entry.artwork.sort_by(|a, b| a.kind.cmp(&b.kind));
}
#[cfg(test)]
mod tests {
    #[test]
    fn special_placement_backfill_respects_local_and_manual_overrides() {
        let mut entry = local_entry("episode");
        entry.metadata["season"] = json!(0);
        let mut configured = library();
        assert!(!needs_special_placement(&entry, &configured));
        configured
            .options
            .metadata_providers
            .insert("episode".into(), vec!["tvdb".into()]);
        assert!(needs_special_placement(&entry, &configured));
        for source in ["nfo", "manual"] {
            entry.metadata["airs_before_season"] = Value::Null;
            entry.metadata["_sources"]["airs_before_season"] = json!(source);
            assert!(!needs_special_placement(&entry, &configured));
            fill(&mut entry, "airs_before_season", json!(2), "tvdb");
            assert!(entry.metadata["airs_before_season"].is_null());
            fill(&mut entry, "airs_after_season", json!(3), "tvdb");
            assert!(entry.metadata["airs_after_season"].is_null());
        }
        entry.metadata["_sources"]["airs_before_season"] = Value::Null;
        fill(&mut entry, "airs_before_season", json!(2), "tvdb");
        assert_eq!(entry.metadata["airs_before_season"], 2);
        assert!(!needs_special_placement(&entry, &configured));
        entry.metadata["season"] = json!(1);
        assert!(!needs_special_placement(&entry, &configured));
    }
    #[test]
    fn voice_cast_retains_dub_editions_and_role_notes() {
        let data = json!({"characters":{"edges":[{"node":{"name":{"full":"Satsuki"}},"voiceActorRoles":[{"dubGroup":"Animax","roleNotes":"Young","voiceActor":{"id":1,"name":{"full":"Andrea"},"languageV2":"English"}},{"dubGroup":null,"voiceActor":{"id":2,"name":{"full":"Hilary"},"languageV2":"English"}}]}]}});
        let cast = anilist_voice_cast(&data);
        assert_eq!(cast[0]["dub_group"], "Animax");
        assert_eq!(cast[0]["role_notes"], "Young");
        assert_eq!(cast[1]["dub_group"], Value::Null);
        assert_eq!(cast[1]["name"], "Hilary");
    }
    #[test]
    fn voice_cast_keeps_languages_and_only_backfills_anime_titles_once() {
        let data = json!({"characters":{"edges":[{"node":{"name":{"full":"Lead"}},"voiceActors":[{"id":1,"name":{"full":"Original Actor"},"languageV2":"Korean","image":{"large":"original.jpg"}},{"id":2,"name":{"full":"Dub Actor"},"languageV2":"English","image":{"large":"dub.jpg"}}]}]}});
        let cast = anilist_voice_cast(&data);
        assert_eq!(cast[0]["language"], "Korean");
        assert_eq!(cast[1]["language"], "English");
        assert_eq!(cast[1]["role"], "Lead");
        let mut entry = local_entry("series");
        let mut library = library();
        library.library_type = NativeLibraryType::Anime;
        assert!(needs_voice_cast(&entry, &library));
        entry.metadata["voice_cast_schema"] = json!(3);
        entry.metadata["voice_cast"] = json!([]);
        assert!(!needs_voice_cast(&entry, &library));
        entry.metadata["voice_cast_schema"] = Value::Null;
        entry.kind = "episode".into();
        assert!(!needs_voice_cast(&entry, &library));
        entry.kind = "movie".into();
        library
            .options
            .metadata_providers
            .insert("movie".into(), vec!["tmdb".into()]);
        assert!(!needs_voice_cast(&entry, &library));
    }
    #[test]
    fn missing_cast_portraits_need_enrichment_even_with_existing_credits() {
        let mut entry = local_entry("series");
        entry.metadata = json!({"credits":[{"name":"Actor","category":"cast","image":null}]});
        assert!(needs_credit_portraits(&entry));
        entry.metadata["credits"][0]["image"] = json!("https://example.com/photo.jpg");
        assert!(!needs_credit_portraits(&entry));
        entry.metadata["credits"][0]["image"] = Value::Null;
        entry.metadata["_sources"]["credits"] = json!("manual");
        assert!(!needs_credit_portraits(&entry));
    }
    #[test]
    fn fills_missing_credit_portraits_without_replacing_local_or_manual_values() {
        let mut metadata = json!({"credits":[{"name":"Actor","role":"Local role","image":null},{"name":"Other","image":"local.jpg"}],"_sources":{"credits":"nfo"}});
        merge_credit_portraits(
            &mut metadata,
            &json!([{"name":"Actor","image":"provider.jpg"},{"name":"Other","image":"replace.jpg"}]),
        );
        assert_eq!(metadata["credits"][0]["image"], "provider.jpg");
        assert_eq!(metadata["credits"][0]["role"], "Local role");
        assert_eq!(metadata["credits"][1]["image"], "local.jpg");
        metadata["credits"][0]["image"] = Value::Null;
        metadata["_sources"]["credits"] = json!("manual");
        merge_credit_portraits(
            &mut metadata,
            &json!([{"name":"Actor","image":"provider.jpg"}]),
        );
        assert!(metadata["credits"][0]["image"].is_null());
    }
    #[test]
    fn extending_old_provider_lists_preserves_local_and_manual_credits() {
        for source in ["nfo", "manual"] {
            let mut entry = local_entry("series");
            entry.metadata = json!({"anilist_data":{"id":1,"characters":{"pageInfo":{"hasNextPage":true}}},"characters":[{"id":"1"}],"credits":[{"name":"Local actor"}],"_sources":{"characters":"database","credits":source}});
            let fields =
                json!({"characters":[{"id":"1"},{"id":"2"}],"credits":[{"name":"Provider actor"}]});
            extend_anilist_lists(&mut entry, &fields, &json!({"id":1}));
            assert_eq!(entry.metadata["characters"].as_array().unwrap().len(), 2);
            assert_eq!(entry.metadata["credits"][0]["name"], "Local actor");
        }
    }

    #[tokio::test]
    async fn provider_http_failures_report_status_without_request_secrets() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                axum::Router::new().route(
                    "/",
                    axum::routing::get(|| async { axum::http::StatusCode::UNAUTHORIZED }),
                ),
            )
            .await
            .unwrap();
        });
        let result = reqwest::Client::new()
            .get(format!("http://{address}/?apikey=secret"))
            .send()
            .await
            .unwrap();
        let error = response(result).await.unwrap_err();
        assert!(error.contains("HTTP 401"));
        assert!(!error.contains("secret"));
        server.abort();
    }

    #[test]
    fn additional_anilist_pages_append_lists_without_replacing_first_page() {
        let mut media = serde_json::json!({"characters":{"pageInfo":{"hasNextPage":true},"edges":[{"node":{"id":1}}]},"staff":{"pageInfo":{"hasNextPage":false},"edges":[{"node":{"id":3}}]}});
        let next = serde_json::json!({"characters":{"pageInfo":{"hasNextPage":false},"edges":[{"node":{"id":1}},{"node":{"id":2}}]},"staff":{"pageInfo":{"hasNextPage":false},"edges":[]}});
        super::merge_anilist_page(&mut media, &next).unwrap();
        assert_eq!(media["characters"]["edges"].as_array().unwrap().len(), 2);
        assert_eq!(media["characters"]["pageInfo"]["hasNextPage"], false);
        assert_eq!(media["staff"]["edges"].as_array().unwrap().len(), 1);
    }

    use super::*;
    fn local_entry(kind: &str) -> NativeCatalogEntry {
        NativeCatalogEntry {
            id: "item".into(),
            path: "Anime/Example/Example.S01E01.mkv".into(),
            kind: kind.into(),
            parent_path: None,
            title: "Example".into(),
            metadata: json!({"title":"Example","plot":"Local overview"}),
            artwork: vec![],
            files: vec![],
            nfo_path: Some("Anime/Example/Example.S01E01.nfo".into()),
            nfo_xml: None,
            available: true,
            revision: 1,
        }
    }
    fn library() -> NativeLibrary {
        NativeLibrary {
            id: "library".into(),
            name: "Anime".into(),
            library_type: NativeLibraryType::Anime,
            anime_content: posterview_contracts::native::AnimeContent::Both,
            paths: vec!["Anime".into()],
            options: Default::default(),
            revision: 1,
            created_at: "".into(),
            updated_at: "".into(),
        }
    }
    #[test]
    fn provider_checks_expire_and_changed_ids_or_settings_bypass_cooldown() {
        let mut entry = local_entry("series");
        let mut library = library();
        let parents = BTreeMap::new();
        let identity = check_identity(&entry, &library, &parents);
        entry.metadata["_provider_check"] = json!({"identity":identity,"until":200});
        assert!(recently_checked(&entry, &identity, 100));
        assert!(!recently_checked(&entry, &identity, 200));
        entry.metadata["identifiers"] = json!({"anilist":"123"});
        assert!(!recently_checked(
            &entry,
            &check_identity(&entry, &library, &parents),
            100
        ));
        entry.metadata["identifiers"] = Value::Null;
        library.options.metadata_language = "ja".into();
        assert!(!recently_checked(
            &entry,
            &check_identity(&entry, &library, &parents),
            100
        ));
    }

    #[test]
    fn metadata_work_counts_gaps_not_catalog_size_or_scan_flags() {
        let mut configured = library();
        configured.options.image_types.clear();
        let mut gap = local_entry("episode");
        gap.metadata["plot"] = Value::Null;
        gap.metadata["_scan_unchanged"] = json!(true);
        let mut unavailable = gap.clone();
        unavailable.available = false;
        let mut missing_item = gap.clone();
        missing_item.metadata["missing"] = json!(true);
        let mut cached = gap.clone();
        let parents = BTreeMap::new();
        cached.metadata["_provider_check"] =
            json!({"identity":check_identity(&cached, &configured, &parents),"until":200});
        let entries = [
            local_entry("episode"),
            gap,
            unavailable,
            missing_item,
            cached,
            local_entry("book"),
        ];
        assert_eq!(
            entries
                .iter()
                .filter(|entry| needs_enrichment(entry, &configured, &parents, 100))
                .count(),
            1
        );
        assert!(needs_enrichment(&entries[1], &configured, &parents, 100));
        configured
            .options
            .metadata_providers
            .insert("episode".into(), vec![]);
        configured
            .options
            .image_providers
            .insert("episode".into(), vec![]);
        assert!(!needs_enrichment(&entries[1], &configured, &parents, 100));
    }

    #[test]
    fn missing_work_and_voice_schema_changes_invalidate_provider_cooldown() {
        let mut configured = library();
        configured.options.image_types.clear();
        let mut entry = local_entry("series");
        entry.metadata["voice_cast"] = json!([]);
        entry.metadata["voice_cast_schema"] = json!(3);
        let parents = BTreeMap::new();
        let identity = check_identity(&entry, &configured, &parents);
        entry.metadata["_provider_check"] = json!({"identity":identity,"until":200});
        assert!(!needs_primary_work(&entry, &configured));
        entry.metadata["plot"] = Value::Null;
        assert!(!recently_checked(
            &entry,
            &check_identity(&entry, &configured, &parents),
            100
        ));
        entry.metadata["plot"] = json!("Local overview");
        entry.metadata["voice_cast_schema"] = json!(2);
        entry.metadata["_scan_unchanged"] = json!(true);
        assert!(needs_enrichment(&entry, &configured, &parents, 100));
        entry.metadata["voice_cast_schema"] = json!(3);
        entry.metadata["voice_cast"] = Value::Null;
        assert!(needs_voice_cast(&entry, &configured));
        for source in ["manual", "nfo"] {
            entry.metadata["_sources"]["voice_cast"] = json!(source);
            assert!(!needs_voice_cast(&entry, &configured));
            entry.metadata["voice_cast"] = json!([]);
            fill(
                &mut entry,
                "voice_cast",
                json!([{"name":"Provider actor"}]),
                "anilist",
            );
            assert_eq!(entry.metadata["voice_cast"], json!([]));
        }
    }

    #[test]
    fn anilist_followup_queries_only_include_unfinished_connections() {
        let mut media = json!({"characters":{"pageInfo":{"hasNextPage":true}},"staff":{"pageInfo":{"hasNextPage":false}}});
        let query = anilist_connection_query(&media, false);
        assert!(query.contains("characters(page:"));
        assert!(!query.contains("staff(page:"));
        assert!(query.contains("voiceActorRoles"));
        let manga = anilist_connection_query(&media, true);
        assert!(!manga.contains("voiceActor"));
        media["characters"]["pageInfo"]["hasNextPage"] = json!(false);
        media["staff"]["pageInfo"]["hasNextPage"] = json!(true);
        let query = anilist_connection_query(&media, false);
        assert!(query.contains("staff(page:"));
        assert!(!query.contains("characters(page:"));
        let mut previous = json!({"characters":{"pageInfo":{"hasNextPage":false},"edges":[{"node":{"id":1}}]},"staff":{"pageInfo":{"hasNextPage":true},"edges":[]}});
        merge_anilist_page(
            &mut previous,
            &json!({"staff":{"pageInfo":{"hasNextPage":false},"edges":[{"node":{"id":2}}]}}),
        )
        .unwrap();
        assert_eq!(previous["characters"]["edges"].as_array().unwrap().len(), 1);
        assert_eq!(previous["staff"]["edges"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn optional_metadata_and_inapplicable_artwork_do_not_create_gaps() {
        let mut episode = local_entry("episode");
        episode.artwork.push(NativeArtwork {
            kind: "landscape".into(),
            path: "Anime/Example/Example.S01E01.jpg".into(),
            source: "local".into(),
        });
        assert!(metadata_complete(&episode));
        assert!(missing_images(&episode, &library()).is_empty());
        let mut season = local_entry("season");
        season.metadata["plot"] = Value::Null;
        season.artwork.push(NativeArtwork {
            kind: "poster".into(),
            path: "Anime/Example/season01-poster.jpg".into(),
            source: "local".into(),
        });
        assert!(metadata_complete(&season));
        assert!(missing_images(&season, &library()).is_empty());
        let mut movie = local_entry("movie");
        assert!(metadata_complete(&movie));
        movie.metadata["plot"] = Value::Null;
        assert!(!metadata_complete(&movie));
        fill(
            &mut movie,
            "plot",
            json!("First provider supplied overview"),
            "tmdb",
        );
        assert!(metadata_complete(&movie));
        assert!(movie.metadata["genres"].is_null());
        assert!(movie.metadata["credits"].is_null());
    }
    #[tokio::test]
    async fn enrichment_progress_counts_only_real_work_and_reuses_completed_checks() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        let mut library = library();
        library.options.fetch_missing = true;
        library.options.image_types.clear();
        library
            .options
            .metadata_providers
            .insert("series".into(), vec![]);
        let cache = state.runtime.data_dir().join("jikan-cache");
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::write(
            cache.join("123-staff.json"),
            serde_json::to_vec(
                &json!({"fetched":chrono::Utc::now().timestamp(),"body":{"data":[]}}),
            )
            .unwrap(),
        )
        .unwrap();
        let mut entries = vec![local_entry("episode"); 500];
        let mut series = local_entry("series");
        series.metadata["identifiers"] = json!({"mal":"123"});
        series.metadata["_sources"] = json!({"voice_cast":"manual","characters":"manual"});
        series.metadata["_scan_unchanged"] = json!(true);
        entries.push(series);
        let mut missing_entry = local_entry("episode");
        missing_entry.metadata["missing"] = json!(true);
        missing_entry.metadata["plot"] = Value::Null;
        entries.push(missing_entry);
        let mut warnings = Vec::new();
        tokio::time::timeout(
            Duration::from_secs(3),
            enrich(&state, &library, &mut entries, &mut warnings),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(warnings.is_empty());
        let live = crate::native_progress::current(&state, &library.id).unwrap();
        assert_eq!(live.count, 502);
        let progress = live.progress.unwrap();
        assert_eq!(progress.processed, 1);
        assert_eq!(progress.total, Some(1));
        assert_eq!(entries[500].metadata["_scan_unchanged"], false);
        enrich(&state, &library, &mut entries, &mut warnings)
            .await
            .unwrap();
        let progress = crate::native_progress::current(&state, &library.id)
            .unwrap()
            .progress
            .unwrap();
        assert_eq!(progress.processed, 0);
        assert_eq!(progress.total, Some(0));
    }

    #[tokio::test]
    async fn local_episode_does_not_call_enabled_providers() {
        let mut episode = local_entry("episode");
        episode.artwork.push(NativeArtwork {
            kind: "thumb".into(),
            path: "Anime/Example/Example.S01E01.jpg".into(),
            source: "local".into(),
        });
        let mut library = library();
        library.options.metadata_providers.insert(
            "episode".into(),
            vec!["tvdb".into(), "anidb".into(), "tmdb".into()],
        );
        library
            .options
            .image_providers
            .insert("episode".into(), vec!["tvdb".into(), "tmdb".into()]);
        let context = EnrichmentContext {
            client: reqwest::Client::new(),
            token: String::new(),
            service: std::sync::Arc::new(posterview_infra_artwork::ArtworkService::default()),
            parents: BTreeMap::new(),
            blocked: Default::default(),
        };
        // These providers would reject the deliberately absent credentials if called.
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        let mut warnings = Vec::new();
        enrich_one(&state, &library, &mut episode, &mut warnings, &context).await;
        assert!(warnings.is_empty());
        assert_eq!(episode.artwork.len(), 1);
        assert_eq!(episode.metadata["plot"], "Local overview");
    }
    #[test]
    fn image_language_uses_preferred_then_neutral_then_default() {
        let data = json!({"poster_path":"/default.jpg", "images":{"posters":[{"iso_639_1":null,"file_path":"/neutral.jpg"},{"iso_639_1":"ja","file_path":"/ja.jpg"}]}});
        assert_eq!(
            image_path(&data, "posters", "poster_path", "ja"),
            Some("/ja.jpg")
        );
        assert_eq!(
            image_path(&data, "posters", "poster_path", "en"),
            Some("/neutral.jpg")
        );
        assert_eq!(
            image_path(&data, "stills", "poster_path", "en"),
            Some("/default.jpg")
        );
    }
    #[test]
    fn ambiguous_matches_are_not_selected() {
        let entry = NativeCatalogEntry {
            id: String::new(),
            path: "a".into(),
            kind: "movie".into(),
            parent_path: None,
            title: "Test".into(),
            metadata: json!({}),
            artwork: vec![],
            files: vec![],
            nfo_path: None,
            nfo_xml: None,
            available: true,
            revision: 1,
        };
        let candidates = vec![
            json!({"id":1,"title":"Test","release_date":"2020-01-01"}),
            json!({"id":2,"title":"Test","release_date":"2021-01-01"}),
        ];
        assert!(select(&candidates, &entry, false).is_err());
        let mut dated = entry;
        dated.metadata["year"] = json!(2021);
        assert_eq!(select(&candidates, &dated, false).unwrap()["id"], 2);
    }
}

#[cfg(test)]
mod durable_checkpoint_parent_tests {
    use super::*;
    use posterview_contracts::{
        jobs::JobCheckpoint,
        native::{AnimeContent, NativeLibraryOptions, NativeLibraryType},
    };
    fn library() -> NativeLibrary {
        NativeLibrary {
            id: "library".into(),
            name: "Anime".into(),
            library_type: NativeLibraryType::Anime,
            anime_content: AnimeContent::Both,
            paths: vec![],
            options: NativeLibraryOptions::default(),
            revision: 1,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }
    fn entry(path: &str, kind: &str, parent: Option<&str>) -> NativeCatalogEntry {
        NativeCatalogEntry {
            id: path.into(),
            path: path.into(),
            kind: kind.into(),
            parent_path: parent.map(str::to_owned),
            title: "Local".into(),
            metadata: json!({"title":"Local","season":1,"episode":1}),
            artwork: vec![],
            files: vec![],
            nfo_path: None,
            nfo_xml: None,
            available: true,
            revision: 1,
        }
    }
    #[test]
    fn changed_parent_identity_invalidates_child_checkpoint() {
        let library = library();
        let child = entry("Show/episode.mkv", "episode", Some("Show"));
        let old = BTreeMap::from([("Show".into(), json!({"identifiers":{"tvdb":"1"}}))]);
        let new = BTreeMap::from([("Show".into(), json!({"identifiers":{"tvdb":"2"}}))]);
        let saved = JobCheckpoint {
            key: child.path.clone(),
            signature: checkpoint_signature(&child, &library, &old),
            value: serde_json::to_value(&child).unwrap(),
        };
        assert!(!crate::native::restore_scan_checkpoint_with_signature(
            &mut child.clone(),
            &saved,
            &checkpoint_signature(&child, &library, &new)
        ));
        assert!(crate::native::restore_scan_checkpoint_with_signature(
            &mut child.clone(),
            &saved,
            &checkpoint_signature(&child, &library, &old)
        ));
    }
    #[test]
    fn restored_parent_ids_allow_matching_child_checkpoint_replay() {
        let library = library();
        let mut parent = entry("Show", "series", None);
        let child = entry("Show/episode.mkv", "episode", Some("Show"));
        let mut resolved = parent.clone();
        resolved.metadata["identifiers"] = json!({"tvdb":"1"});
        let before = parent_metadata(&[parent.clone(), child.clone()]);
        let resolved_parents = parent_metadata(&[resolved.clone(), child.clone()]);
        let saved_parent = JobCheckpoint {
            key: parent.path.clone(),
            signature: checkpoint_signature(&parent, &library, &before),
            value: serde_json::to_value(&resolved).unwrap(),
        };
        let saved_child = JobCheckpoint {
            key: child.path.clone(),
            signature: checkpoint_signature(&child, &library, &resolved_parents),
            value: serde_json::to_value(&child).unwrap(),
        };
        let parent_signature = checkpoint_signature(&parent, &library, &before);
        assert!(crate::native::restore_scan_checkpoint_with_signature(
            &mut parent,
            &saved_parent,
            &parent_signature
        ));
        let current_parents = parent_metadata(&[parent, child.clone()]);
        assert!(crate::native::restore_scan_checkpoint_with_signature(
            &mut child.clone(),
            &saved_child,
            &checkpoint_signature(&child, &library, &current_parents)
        ));
    }
}
