use crate::AppState;
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
fn fill(entry: &mut NativeCatalogEntry, field: &str, value: Value, source: &str) {
    if missing(&value) {
        return;
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
    let mut response = response
        .error_for_status()
        .map_err(|_| "Metadata provider request failed.")?;
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
    let re = regex::Regex::new(r"\s*[\[(](?:19|20)\d{2}[\])]\s*$").unwrap();
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
async fn anilist(
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
    response(client.post("https://graphql.anilist.co").json(&json!({"query":"query($id:Int,$type:MediaType){Media(id:$id,type:$type){id idMal isAdult format title{english romaji native} startDate{year month day} description(asHtml:false) status genres tags{name isAdult} studios{nodes{id name}} episodes chapters volumes duration averageScore siteUrl coverImage{extraLarge} bannerImage characters(perPage:100){pageInfo{hasNextPage} edges{role node{id name{full} description image{large}} voiceActors(language:JAPANESE){id name{full} image{large}}}} staff(perPage:100){pageInfo{hasNextPage} edges{role node{id name{full} image{large}}}}}}","variables":{"id":selected,"type":media_type}})).send().await.map_err(|_|"AniList connection failed.")?).await
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
        let series = series_id
            .ok_or("Series must have a TMDB ID before episode metadata can be fetched.")?;
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
async fn download(state: &AppState, client: &reqwest::Client, url: &str) -> Result<String, String> {
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
    store_image(state, &bytes)
}
pub(crate) fn store_image(state: &AppState, bytes: &[u8]) -> Result<String, String> {
    if bytes.len() > 20 * 1024 * 1024 {
        return Err("Artwork exceeds 20 MB.".into());
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
pub(crate) async fn enrich(
    state: &AppState,
    library: &NativeLibrary,
    entries: &mut [NativeCatalogEntry],
    warnings: &mut Vec<String>,
) {
    if !library.options.fetch_missing {
        return;
    }
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(v) => v,
        Err(_) => {
            warnings.push("Unable to create metadata client.".into());
            return;
        }
    };
    let token = ServerStore::new(state.runtime.data_dir())
        .get_setting("tmdb_access_token")
        .unwrap_or_default();
    let mut series_ids = BTreeMap::new();
    let mut series_metadata = BTreeMap::<String, Value>::new();
    let service = posterview_infra_artwork::ArtworkService::default();
    // Identify parents first so episode enrichment can use their stable provider IDs.
    entries.sort_by_key(|e| match e.kind.as_str() {
        "series" | "book_series" => 0,
        "movie" => 1,
        "season" => 2,
        _ => 3,
    });
    let mut limited = false;
    for entry in entries.iter_mut() {
        if entry.kind == "book" {
            continue;
        }
        if entry.kind == "series" {
            series_metadata.insert(entry.path.clone(), entry.metadata.clone());
            if let Some(id) = entry.metadata["identifiers"]["tmdb"].as_str() {
                series_ids.insert(entry.path.clone(), id.to_owned());
            }
        }
        if limited {
            continue;
        }
        let metadata_complete = ["plot", "genres", "credits"]
            .iter()
            .all(|field| !missing(&entry.metadata[*field]));
        if metadata_complete
            && library
                .options
                .image_types
                .iter()
                .all(|kind| entry.artwork.iter().any(|a| &a.kind == kind))
        {
            continue;
        }
        let default = if (library.library_type == NativeLibraryType::Anime
            || library.library_type == NativeLibraryType::Books)
            && !["episode", "season"].contains(&entry.kind.as_str())
        {
            vec!["anilist".to_owned()]
        } else {
            vec!["tmdb".to_owned()]
        };
        let metadata_order = library
            .options
            .metadata_providers
            .get(&entry.kind)
            .unwrap_or(&default);
        let image_order = library
            .options
            .image_providers
            .get(&entry.kind)
            .unwrap_or(&default);
        // Fetch each provider once; metadata and artwork have independent priorities.
        let mut providers = metadata_order.clone();
        for provider in image_order {
            if !providers.contains(provider) {
                providers.push(provider.clone());
            }
        }
        let mut image_candidates = BTreeMap::<String, Vec<(String, String)>>::new();
        for provider_name in providers {
            if limited {
                break;
            }
            if !["tmdb", "anilist"].contains(&provider_name.as_str()) {
                let parent_path = entry
                    .parent_path
                    .as_deref()
                    .map(|v| v.split("/@season-").next().unwrap_or(v));
                let parent = parent_path
                    .and_then(|v| series_metadata.get(v))
                    .cloned()
                    .unwrap_or(Value::Null);
                match super::native_provider_extra::fetch(
                    state,
                    &client,
                    &service,
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
                                if field != "identifiers" {
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
                        if entry.kind == "series" {
                            series_metadata.insert(entry.path.clone(), entry.metadata.clone());
                            if let Some(id) =
                                super::native_provider_extra::id(&entry.metadata, "tmdb")
                            {
                                series_ids.insert(entry.path.clone(), id);
                            }
                        }
                    }
                    Err(e) => warnings.push(format!("{} ({provider_name}): {e}", entry.title)),
                }
                tokio::time::sleep(Duration::from_millis(300)).await;
                continue;
            }
            let use_anilist = provider_name == "anilist";
            let result = if use_anilist && entry.kind != "episode" {
                anilist(
                    &client,
                    entry,
                    library.library_type == NativeLibraryType::Books,
                    library.options.allow_adult_metadata,
                )
                .await
            } else if !token.is_empty() {
                let series = entry
                    .parent_path
                    .as_ref()
                    .map(|v| v.split("/@season-").next().unwrap_or(v));
                tmdb(
                    &client,
                    entry,
                    &token,
                    series.and_then(|v| series_ids.get(v)).map(String::as_str),
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
                    limited = e.contains("rate limit");
                    warnings.push(format!("{}: {e}", entry.title));
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
            if !library.options.allow_adult_metadata
                && (data["isAdult"] == true || data["adult"] == true)
            {
                warnings.push(format!(
                    "{}: adult metadata matching is disabled.",
                    entry.title
                ));
                continue;
            }
            let mut fields = json!({});
            let mut artwork = Vec::new();
            if ani {
                if data["characters"]["pageInfo"]["hasNextPage"] == true
                    || data["staff"]["pageInfo"]["hasNextPage"] == true
                {
                    warnings.push(format!("{}: character/staff lists contain more than 100 entries; the initial scan stores the first 100 per list.",entry.title));
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
                        credits.push(json!({"name":actor["name"]["full"],"provider_id":actor["id"],"role":node["name"]["full"],"category":"voice","image":actor["image"]["large"]}));
                    }
                }
                for edge in data["staff"]["edges"].as_array().unwrap_or(&Vec::new()) {
                    credits.push(json!({"name":edge["node"]["name"]["full"],"role":edge["role"],"provider_id":edge["node"]["id"],"category":"crew","image":edge["node"]["image"]["large"]}));
                }
                fields["characters"] = json!(characters);
                fields["credits"] = json!(credits);
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
                                v.iter().find_map(|r| {
                                    r["certification"].as_str().filter(|s| !s.is_empty())
                                })
                            })
                            .map(|v| json!(v))
                            .unwrap_or(Value::Null)
                    } else {
                        rating["rating"].clone()
                    };
                }
                for (field, value) in fields.as_object().unwrap() {
                    fill(entry, field, value.clone(), provider);
                }
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
            if entry.kind == "series" {
                if let Some(id) = entry.metadata["identifiers"]["tmdb"].as_str() {
                    series_ids.insert(entry.path.clone(), id.to_owned());
                }
            }
            if entry.kind == "series" {
                series_metadata.insert(entry.path.clone(), entry.metadata.clone());
            }
            fill(entry, &format!("{provider}_data"), data, provider);
            image_candidates.insert(
                provider.into(),
                artwork
                    .into_iter()
                    .map(|(kind, url)| (kind.to_owned(), url))
                    .collect(),
            );
            tokio::time::sleep(Duration::from_millis(if ani { 1200 } else { 250 })).await;
        }
        for provider in image_order {
            for (kind, url) in image_candidates.get(provider).into_iter().flatten() {
                if !library.options.image_types.contains(kind)
                    || entry.artwork.iter().any(|a| a.kind == *kind)
                {
                    continue;
                }
                match download(state, &client, url).await {
                    Ok(path) => entry.artwork.push(NativeArtwork {
                        kind: kind.clone(),
                        path,
                        source: provider.clone(),
                    }),
                    Err(e) => warnings.push(format!("{} ({kind}): {e}", entry.title)),
                }
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
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
