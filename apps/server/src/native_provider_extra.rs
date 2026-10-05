//! Manual-library providers return common fields without changing local/manual values.
use crate::{AppState, HttpError};
use axum::{
    Json,
    extract::{Path, State},
};
use posterview_contracts::native::{NativeCatalogEntry, NativeLibrary};
use posterview_infra_artwork::ArtworkService;
use posterview_infra_sqlite::ServerStore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    sync::OnceLock,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SettingsInput {
    mal_client_id: Option<String>,
    omdb_api_key: Option<String>,
    anidb_client: Option<String>,
    anidb_client_version: Option<String>,
}
#[derive(Serialize)]
pub(crate) struct Settings {
    mal_configured: bool,
    omdb_configured: bool,
    anidb_client: String,
    anidb_client_version: String,
}
fn store(state: &AppState) -> ServerStore {
    ServerStore::new(state.runtime.data_dir())
}
fn setting(state: &AppState, name: &str) -> String {
    store(state).get_setting(name).unwrap_or_default()
}
fn settings_value(state: &AppState) -> Settings {
    Settings {
        mal_configured: !setting(state, "mal_client_id").is_empty(),
        omdb_configured: !setting(state, "omdb_api_key").is_empty(),
        anidb_client: setting(state, "anidb_client"),
        anidb_client_version: setting(state, "anidb_client_version"),
    }
}
pub(crate) async fn settings(State(state): State<AppState>) -> Json<Settings> {
    Json(settings_value(&state))
}
pub(crate) async fn save_settings(
    State(state): State<AppState>,
    Json(input): Json<SettingsInput>,
) -> Result<Json<Settings>, HttpError> {
    let values = [
        ("mal_client_id", input.mal_client_id),
        ("omdb_api_key", input.omdb_api_key),
        ("anidb_client", input.anidb_client),
        ("anidb_client_version", input.anidb_client_version),
    ];
    for (key, value) in &values {
        if let Some(value) = value {
            let v = value.trim();
            if v.len() > 256
                || v.chars().any(char::is_control)
                || (*key == "anidb_client"
                    && !v
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'))
                || (*key == "anidb_client_version" && !v.is_empty() && v.parse::<u32>().is_err())
            {
                return Err(HttpError::bad_request(
                    "Invalid provider credential or AniDB client version.",
                ));
            }
        }
    }
    for (key, value) in values {
        if let Some(value) = value {
            store(&state)
                .set_setting(key, value.trim())
                .map_err(|_| HttpError::bad_request("Unable to save provider settings."))?;
        }
    }
    Ok(Json(settings_value(&state)))
}
pub(crate) async fn test_provider(
    State(state): State<AppState>,
    Path(provider): Path<String>,
) -> Json<Value> {
    let client = match client() {
        Ok(v) => v,
        Err(e) => return Json(json!({"ok":false,"message":e})),
    };
    let result = match provider.as_str() {
        "mal" => {
            let key = setting(&state, "mal_client_id");
            if key.is_empty() {
                Err("Configure a MyAnimeList client ID first.".into())
            } else {
                match client
                    .get("https://api.myanimelist.net/v2/anime/1")
                    .header("X-MAL-CLIENT-ID", key)
                    .send()
                    .await
                {
                    Ok(v) => super::native_provider::response(v).await.map(|_| ()),
                    Err(_) => Err("MyAnimeList connection failed.".into()),
                }
            }
        }
        "omdb" => {
            let key = setting(&state, "omdb_api_key");
            if key.is_empty() {
                Err("Configure an OMDb API key first.".into())
            } else {
                match client
                    .get("https://www.omdbapi.com/")
                    .query(&[("apikey", key.as_str()), ("i", "tt0111161")])
                    .send()
                    .await
                {
                    Ok(v) => super::native_provider::response(v).await.and_then(|v| {
                        if v["Response"] == "True" {
                            Ok(())
                        } else {
                            Err("OMDb rejected the key or returned no record.".into())
                        }
                    }),
                    Err(_) => Err("OMDb connection failed.".into()),
                }
            }
        }
        "anidb" => anidb_document(&state, &client, "1").await.map(|_| ()),
        _ => Err("Unknown native provider.".into()),
    };
    Json(match result {
        Ok(()) => json!({"ok":true,"message":"Provider connection succeeded."}),
        Err(e) => json!({"ok":false,"message":e}),
    })
}
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(25))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Unable to create provider client.".into())
}
pub(crate) struct Data {
    pub id: Option<String>,
    pub fields: Value,
    pub artwork: Vec<(String, String)>,
    pub raw: Value,
}
pub(crate) fn id(metadata: &Value, provider: &str) -> Option<String> {
    metadata["identifiers"][provider]
        .as_str()
        .map(str::to_owned)
        .or_else(|| {
            metadata["identifiers"][provider]
                .as_u64()
                .map(|v| v.to_string())
        })
}
fn numeric(value: String) -> Result<String, String> {
    if value.is_empty() || !value.chars().all(|c| c.is_ascii_digit()) {
        Err("Invalid provider ID.".into())
    } else {
        Ok(value)
    }
}
fn normalized(v: &str) -> String {
    v.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}
fn split(v: &Value) -> Value {
    json!(
        v.as_str()
            .unwrap_or("")
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty() && *s != "N/A")
            .collect::<Vec<_>>()
    )
}
fn year(v: &Value) -> Option<i64> {
    v.as_str()
        .and_then(|s| s.get(..4))
        .and_then(|s| s.parse().ok())
        .or(v.as_i64())
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
pub(crate) async fn fetch(
    state: &AppState,
    client: &reqwest::Client,
    service: &ArtworkService,
    provider: &str,
    library: &NativeLibrary,
    entry: &NativeCatalogEntry,
    parent: &Value,
) -> Result<Data, String> {
    match provider {
        "comicvine" if entry.kind == "book_series" => {
            let selected = numeric(id(&entry.metadata, "comicvine").ok_or("Select a ComicVine series with Identify first.")?)?;
            let data = state.runtime.comicvine_metadata(&selected).await.map_err(|e| e.to_string())?;
            let artwork = data.cover_url.clone().map(|url| vec![("poster".to_owned(), url)]).unwrap_or_default();
            let fields = json!({"plot":data.plot,"year":data.year.parse::<i64>().ok(),"publisher":data.publisher,"volumes":data.volumes,"source_url":data.source_url});
            Ok(Data { id: Some(selected), raw: fields.clone(), fields, artwork })
        }

        "mal" => mal(state, client, library, entry).await,
        "omdb" => omdb(state, client, entry, parent).await,
        "tvdb" => tvdb(state, service, library, entry, parent).await,
        "fanart" => {
            fanart(
                state,
                client,
                entry,
                parent,
                &library.options.image_language,
            )
            .await
        }
        "anidb" => anidb(state, client, library, entry, parent).await,
        _ => Err("Unsupported native provider.".into()),
    }
}
async fn mal(
    state: &AppState,
    client: &reqwest::Client,
    library: &NativeLibrary,
    entry: &NativeCatalogEntry,
) -> Result<Data, String> {
    let key = setting(state, "mal_client_id");
    if key.is_empty() {
        return Err("Configure a MyAnimeList client ID in Search Providers.".into());
    }
    let manga = entry.kind == "book_series";
    let kind = if manga { "manga" } else { "anime" };
    let fields = if manga {
        "id,title,main_picture,alternative_titles,start_date,synopsis,mean,genres,num_volumes,num_chapters,status,nsfw"
    } else {
        "id,title,main_picture,alternative_titles,start_date,synopsis,mean,genres,num_episodes,average_episode_duration,status,studios,media_type,nsfw"
    };
    let known = id(&entry.metadata, "mal").or_else(|| id(&entry.metadata, "myanimelist"));
    let selected = if let Some(id) = known {
        numeric(id)?
    } else {
        let body = super::native_provider::response(
            client
                .get(format!("https://api.myanimelist.net/v2/{kind}"))
                .header("X-MAL-CLIENT-ID", &key)
                .query(&[
                    ("q", super::native_provider::search_title(entry)),
                    ("limit", "20".into()),
                    ("fields", fields.into()),
                    ("nsfw", library.options.allow_adult_metadata.to_string()),
                ])
                .send()
                .await
                .map_err(|_| "MyAnimeList connection failed.")?,
        )
        .await?;
        let matches = body["data"]
            .as_array()
            .ok_or("MyAnimeList returned no candidates.")?
            .iter()
            .filter_map(|v| v.get("node"))
            .filter(|v| mal_matches(v, entry))
            .collect::<Vec<_>>();
        if matches.len() != 1 {
            return Err("MyAnimeList identification needs review; add a MAL ID in the NFO.".into());
        }
        matches[0]["id"]
            .as_u64()
            .ok_or("Invalid MAL ID.")?
            .to_string()
    };
    let raw = super::native_provider::response(
        client
            .get(format!("https://api.myanimelist.net/v2/{kind}/{selected}"))
            .header("X-MAL-CLIENT-ID", &key)
            .query(&[("fields", fields)])
            .send()
            .await
            .map_err(|_| "MyAnimeList connection failed.")?,
    )
    .await?;
    if !library.options.allow_adult_metadata && raw["nsfw"].as_str().is_some_and(|v| v != "white") {
        return Err("Adult metadata matching is disabled.".into());
    }
    let preferred = raw["alternative_titles"][if library.options.metadata_language == "ja" {
        "ja"
    } else {
        "en"
    }]
    .as_str()
    .filter(|v| !v.trim().is_empty())
    .map(str::to_owned);
    let mut data = map_mal(raw, selected);
    if let Some(title) = preferred {
        data.fields["title"] = json!(title);
    }
    Ok(data)
}
fn mal_matches(v: &Value, entry: &NativeCatalogEntry) -> bool {
    let names = [
        v["title"].as_str(),
        v["alternative_titles"]["en"].as_str(),
        v["alternative_titles"]["ja"].as_str(),
    ];
    let title = normalized(&super::native_provider::search_title(entry));
    names.into_iter().flatten().any(|n| normalized(n) == title)
        && entry.metadata["year"]
            .as_i64()
            .is_none_or(|y| year(&v["start_date"]) == Some(y))
        && (entry.kind != "movie" || v["media_type"] == "movie")
        && (entry.kind != "series" || v["media_type"] != "movie")
}
fn map_mal(raw: Value, selected: String) -> Data {
    let credits=raw["authors"].as_array().into_iter().flatten().map(|a|json!({"name":format!("{} {}",a["node"]["first_name"].as_str().unwrap_or(""),a["node"]["last_name"].as_str().unwrap_or("")),"category":"author","role":a["role"],"provider_id":a["node"]["id"]})).collect::<Vec<_>>();
    let fields = json!({"title":raw["title"],"originaltitle":raw["alternative_titles"]["ja"],"plot":raw["synopsis"],"year":year(&raw["start_date"]),"rating":raw["mean"],"genres":raw["genres"].as_array().into_iter().flatten().filter_map(|v|v["name"].as_str()).collect::<Vec<_>>(),"studios":raw["studios"].as_array().into_iter().flatten().filter_map(|v|v["name"].as_str()).collect::<Vec<_>>(),"runtime":raw["average_episode_duration"].as_u64().map(|v|v/60),"episodes":raw["num_episodes"],"volumes":raw["num_volumes"],"chapters":raw["num_chapters"],"status":raw["status"],"credits":credits});
    let artwork = raw["main_picture"]["large"]
        .as_str()
        .or(raw["main_picture"]["medium"].as_str())
        .map(|v| vec![("poster".into(), v.into())])
        .unwrap_or_default();
    Data {
        id: Some(selected),
        fields,
        artwork,
        raw,
    }
}
async fn omdb(
    state: &AppState,
    client: &reqwest::Client,
    entry: &NativeCatalogEntry,
    parent: &Value,
) -> Result<Data, String> {
    let key = setting(state, "omdb_api_key");
    if key.is_empty() {
        return Err("Configure an OMDb API key in Search Providers.".into());
    }
    let known = if entry.kind == "episode" {
        id(parent, "imdb")
    } else {
        id(&entry.metadata, "imdb")
    };
    let mut query: Vec<(String, String)> =
        vec![("apikey".into(), key), ("plot".into(), "full".into())];
    if let Some(id) = known {
        if !id.starts_with("tt") || id.len() <= 2 || !id[2..].chars().all(|c| c.is_ascii_digit()) {
            return Err("Invalid IMDb ID.".into());
        }
        query.push(("i".into(), id));
    } else if entry.kind == "episode" {
        return Err("OMDb episode lookup needs the parent series IMDb ID.".into());
    } else {
        query.push(("t".into(), super::native_provider::search_title(entry)));
        query.push((
            "type".into(),
            if entry.kind == "movie" {
                "movie"
            } else {
                "series"
            }
            .into(),
        ));
        if let Some(y) = entry.metadata["year"].as_i64() {
            query.push(("y".into(), y.to_string()));
        }
    }
    if entry.kind == "episode" {
        for (param, field) in [("Season", "season"), ("Episode", "episode")] {
            query.push((
                param.into(),
                entry.metadata[field]
                    .as_u64()
                    .ok_or("Missing episode numbers.")?
                    .to_string(),
            ));
        }
    }
    let raw = super::native_provider::response(
        client
            .get("https://www.omdbapi.com/")
            .query(&query)
            .send()
            .await
            .map_err(|_| "OMDb connection failed.")?,
    )
    .await?;
    if raw["Response"] != "True" {
        return Err("OMDb returned no record or rejected the API key.".into());
    }
    if entry.kind != "episode"
        && id(&entry.metadata, "imdb").is_none()
        && (normalized(raw["Title"].as_str().unwrap_or(""))
            != normalized(&super::native_provider::search_title(entry))
            || entry.metadata["year"]
                .as_i64()
                .is_some_and(|y| year(&raw["Year"]) != Some(y)))
    {
        return Err("OMDb identification needs review; add an IMDb ID in the NFO.".into());
    }
    Ok(map_omdb(raw))
}
fn map_omdb(raw: Value) -> Data {
    let mut credits = Vec::new();
    for (key, category, role) in [
        ("Actors", "cast", ""),
        ("Director", "crew", "Director"),
        ("Writer", "crew", "Writer"),
    ] {
        for name in split(&raw[key]).as_array().into_iter().flatten() {
            credits.push(json!({"name":name,"category":category,"role":role}));
        }
    }
    let fields = json!({"title":raw["Title"],"plot":raw["Plot"],"year":year(&raw["Year"]),"genres":split(&raw["Genre"]),"runtime":raw["Runtime"].as_str().and_then(|v|v.split_whitespace().next()?.parse::<u64>().ok()),"rating":raw["imdbRating"].as_str().and_then(|v|v.parse::<f64>().ok()),"mpaa":raw["Rated"],"credits":credits,"identifiers":{"imdb":raw["imdbID"]}});
    let artwork = raw["Poster"]
        .as_str()
        .filter(|v| *v != "N/A")
        .map(|v| vec![("poster".into(), v.into())])
        .unwrap_or_default();
    Data {
        id: None,
        fields,
        artwork,
        raw,
    }
}
pub(crate) fn lang(code: &str) -> &str {
    match code {
        "ja" => "jpn",
        "fr" => "fra",
        "de" => "deu",
        "es" => "spa",
        "it" => "ita",
        "pt" => "por",
        "ko" => "kor",
        "zh" => "zho",
        _ => "eng",
    }
}
async fn tvdb(
    state: &AppState,
    service: &ArtworkService,
    library: &NativeLibrary,
    entry: &NativeCatalogEntry,
    parent: &Value,
) -> Result<Data, String> {
    let key = setting(state, "tvdb_api_key");
    let pin = setting(state, "tvdb_pin");
    if key.is_empty() {
        return Err("Configure TheTVDB credentials in Search Providers.".into());
    }
    let get = |path: String, query: Vec<(String, String)>| {
        let key = key.clone();
        let pin = pin.clone();
        async move {
            let q = query
                .iter()
                .map(|(k, v)| (k.as_str(), v.as_str()))
                .collect::<Vec<_>>();
            super::native_provider::response(service.native_tvdb_get(&path, &q, &key, &pin).await?)
                .await
        }
    };
    let record = if entry.kind == "movie" {
        "movies"
    } else if entry.kind == "season" {
        "seasons"
    } else if entry.kind == "episode" {
        "episodes"
    } else {
        "series"
    };
    let selected = if let Some(id) = id(&entry.metadata, "tvdb") {
        numeric(id)?
    } else if entry.kind == "season" || entry.kind == "episode" {
        let series = numeric(
            id(parent, "tvdb")
                .ok_or("TheTVDB needs a parent series ID before scanning seasons or episodes.")?,
        )?;
        let season = entry.metadata["season"]
            .as_u64()
            .ok_or("Missing season number.")?;
        if entry.kind == "season" {
            let raw = get(format!("/series/{series}/extended"), vec![]).await?;
            let matches = raw["data"]["seasons"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|v| v["number"].as_u64() == Some(season) && v["type"]["type"] == "official")
                .collect::<Vec<_>>();
            if matches.len() != 1 {
                return Err("TheTVDB season identity needs review.".into());
            }
            matches[0]["id"]
                .as_u64()
                .ok_or("Invalid season ID.")?
                .to_string()
        } else {
            let episode = entry.metadata["episode"]
                .as_u64()
                .ok_or("Missing episode number.")?;
            let raw = get(
                format!("/series/{series}/episodes/official"),
                vec![
                    ("page".into(), "0".into()),
                    ("season".into(), season.to_string()),
                    ("episodeNumber".into(), episode.to_string()),
                ],
            )
            .await?;
            let matches = raw["data"]["episodes"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|v| {
                    v["seasonNumber"].as_u64() == Some(season)
                        && v["number"].as_u64() == Some(episode)
                })
                .collect::<Vec<_>>();
            if matches.len() != 1 {
                return Err("TheTVDB episode identity needs review.".into());
            }
            matches[0]["id"]
                .as_u64()
                .ok_or("Invalid episode ID.")?
                .to_string()
        }
    } else {
        let raw = get(
            "/search".into(),
            vec![
                ("query".into(), super::native_provider::search_title(entry)),
                (
                    "type".into(),
                    if record == "movies" {
                        "movie"
                    } else {
                        "series"
                    }
                    .into(),
                ),
            ],
        )
        .await?;
        let matches = raw["data"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|v| {
                normalized(v["name"].as_str().unwrap_or(""))
                    == normalized(&super::native_provider::search_title(entry))
                    && entry.metadata["year"]
                        .as_i64()
                        .is_none_or(|y| year(&v["year"]) == Some(y))
            })
            .collect::<Vec<_>>();
        if matches.len() != 1 {
            return Err("TheTVDB identification needs review; add a TVDB ID in the NFO.".into());
        }
        numeric(
            matches[0]["tvdb_id"]
                .as_str()
                .map(str::to_owned)
                .or_else(|| matches[0]["tvdb_id"].as_u64().map(|v| v.to_string()))
                .ok_or("Invalid TVDB ID.")?,
        )?
    };
    let mut raw = get(
        format!("/{record}/{selected}/extended"),
        vec![("meta".into(), "translations".into())],
    )
    .await?["data"]
        .clone();
    if let Ok(translation) = get(
        format!(
            "/{record}/{selected}/translations/{}",
            lang(&library.options.metadata_language)
        ),
        vec![],
    )
    .await
    {
        for (key, field) in [("name", "name"), ("overview", "overview")] {
            if translation["data"][key]
                .as_str()
                .is_some_and(|v| !v.is_empty())
            {
                raw[field] = translation["data"][key].clone();
            }
        }
    }
    let types = Value::Array(
        service
            .native_tvdb_types(&key, &pin)
            .await?
            .into_iter()
            .map(|(id, name)| json!({"id":id,"name":name}))
            .collect(),
    );
    Ok(map_tvdb(
        raw,
        selected,
        &types,
        &library.options.image_language,
        &library.options.certification_country,
        entry.kind.as_str(),
    ))
}
fn map_tvdb(
    raw: Value,
    selected: String,
    types: &Value,
    language: &str,
    country: &str,
    kind: &str,
) -> Data {
    let credits=raw["characters"].as_array().into_iter().flatten().filter_map(|v|Some(json!({"name":v["personName"].as_str()?,"role":v["name"],"category":if v["type"]==3{"crew"}else{"cast"},"provider_id":v["peopleId"],"image":v["personImgURL"]}))).collect::<Vec<_>>();
    let mut identifiers = json!({});
    for v in raw["remoteIds"].as_array().into_iter().flatten() {
        let name = v["sourceName"].as_str().unwrap_or("").to_lowercase();
        let key = if name.contains("imdb") {
            "imdb"
        } else if name.contains("themoviedb") || name.contains("the movie db") {
            "tmdb"
        } else {
            continue;
        };
        identifiers[key] = v["id"].clone();
    }
    let rating = raw["contentRatings"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|v| {
            v["country"] == country
                || v["country"]
                    == match country {
                        "US" => "usa",
                        "GB" => "gbr",
                        "JP" => "jpn",
                        "CA" => "can",
                        "AU" => "aus",
                        "FR" => "fra",
                        "DE" => "deu",
                        "ES" => "spa",
                        "IT" => "ita",
                        "BR" => "bra",
                        "KR" => "kor",
                        "CN" => "chn",
                        _ => country,
                    }
        })
        .map(|v| v["name"].clone())
        .unwrap_or(Value::Null);
    let fields = json!({"title":raw["name"],"plot":raw["overview"],"year":year(&raw["year"]).or(year(&raw["firstAired"])),"runtime":raw["runtime"],"genres":raw["genres"].as_array().into_iter().flatten().filter_map(|v|v["name"].as_str()).collect::<Vec<_>>(),"studios":raw["companies"]["production"].as_array().into_iter().flatten().filter_map(|v|v["name"].as_str()).collect::<Vec<_>>(),"status":raw["status"]["name"],"mpaa":rating,"credits":credits,"identifiers":identifiers});
    let mut artwork = Vec::new();
    let mut arts = raw["artworks"].as_array().cloned().unwrap_or_default();
    arts.sort_by_key(|v| {
        if v["language"] == language || v["language"] == lang(language) {
            0
        } else if v["language"].is_null() {
            1
        } else {
            2
        }
    });
    for v in arts {
        let name = types
            .as_array()
            .into_iter()
            .flatten()
            .find(|t| t["id"] == v["type"])
            .and_then(|t| t["name"].as_str())
            .unwrap_or("")
            .to_lowercase();
        let target = if name.contains("poster") {
            "poster"
        } else if name.contains("background") {
            "backdrop"
        } else if name.contains("banner") {
            "banner"
        } else if name.contains("clearlogo") || name.contains("logo") {
            "logo"
        } else if name.contains("screencap") {
            "thumb"
        } else {
            continue;
        };
        if let Some(url) = v["image"].as_str() {
            artwork.push((target.into(), tvdb_image(url)));
        }
    }
    if let Some(url) = raw["image"].as_str() {
        artwork.push((
            if kind == "episode" { "thumb" } else { "poster" }.into(),
            tvdb_image(url),
        ));
    }
    Data {
        id: Some(selected),
        fields,
        artwork,
        raw,
    }
}
fn tvdb_image(v: &str) -> String {
    if v.starts_with("/") {
        format!("https://artworks.thetvdb.com{v}")
    } else {
        v.into()
    }
}
async fn fanart(
    state: &AppState,
    client: &reqwest::Client,
    entry: &NativeCatalogEntry,
    parent: &Value,
    language: &str,
) -> Result<Data, String> {
    let key = setting(state, "fanart_api_key");
    if key.is_empty() {
        return Err("Configure a FanArt API key in Search Providers.".into());
    }
    let metadata = if entry.kind == "season" {
        parent
    } else {
        &entry.metadata
    };
    let movie = entry.kind == "movie";
    let selected=if movie{id(metadata,"tmdb").or_else(||id(metadata,"imdb"))}else{id(metadata,"tvdb")}.ok_or("FanArt needs a TMDB/IMDb movie ID or TVDB series ID from an earlier metadata provider or local NFO.")?;
    if !(selected.chars().all(|v| v.is_ascii_digit())
        || (selected.starts_with("tt")
            && selected.len() > 2
            && selected[2..].chars().all(|v| v.is_ascii_digit())))
    {
        return Err("Invalid FanArt record ID.".into());
    }
    let raw = super::native_provider::response(
        client
            .get(format!(
                "https://webservice.fanart.tv/v3/{}/{selected}",
                if movie { "movies" } else { "tv" }
            ))
            .query(&[("api_key", key)])
            .send()
            .await
            .map_err(|_| "FanArt connection failed.")?,
    )
    .await?;
    let mut artwork = Vec::new();
    for (key, kind) in [
        ("movieposter", "poster"),
        ("tvposter", "poster"),
        ("seasonposter", "poster"),
        ("moviebackground", "backdrop"),
        ("showbackground", "backdrop"),
        ("hdtvlogo", "logo"),
        ("hdmovielogo", "logo"),
        ("tvbanner", "banner"),
        ("seasonbanner", "banner"),
        ("moviethumb", "thumb"),
        ("tvthumb", "thumb"),
    ] {
        if key.starts_with("season") && entry.kind != "season" {
            continue;
        }
        let mut images = raw[key].as_array().cloned().unwrap_or_default();
        images.sort_by_key(|v| {
            if v["lang"] == language {
                0
            } else if v["lang"] == "00" || v["lang"] == "" {
                1
            } else {
                2
            }
        });
        for v in images {
            if entry.kind == "season"
                && v["season"].as_str().and_then(|s| s.parse::<u64>().ok())
                    != entry.metadata["season"].as_u64()
            {
                continue;
            }
            if let Some(url) = v["url"].as_str() {
                artwork.push((kind.into(), url.into()));
            }
        }
    }
    Ok(Data {
        id: None,
        fields: json!({}),
        artwork,
        raw,
    })
}
static ANIDB_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
pub(crate) async fn anidb_document(
    state: &AppState,
    client: &reqwest::Client,
    aid: &str,
) -> Result<String, String> {
    let aid = numeric(aid.into())?;
    let client_name = setting(state, "anidb_client");
    let version = setting(state, "anidb_client_version");
    if client_name.is_empty() || version.is_empty() {
        return Err(
            "Configure your registered AniDB HTTP client name and version in Search Providers."
                .into(),
        );
    }
    let _guard = ANIDB_LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    let db = store(state);
    let blocked = db
        .get_setting("native_anidb_blocked_until")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    if blocked > now() {
        return Err("AniDB requests are temporarily paused after a rejected request; check registered client settings and retry later.".into());
    }
    let cache_key = format!("native_anidb_{aid}");
    let cached = db.get_setting(&cache_key).unwrap_or_default();
    if let Ok(v) = serde_json::from_str::<Value>(&cached) {
        if now().saturating_sub(v["at"].as_u64().unwrap_or(0)) < 86400 {
            if let Some(xml) = v["xml"].as_str() {
                return Ok(xml.into());
            }
        }
    }
    let gate = db
        .get_setting("native_anidb_gate")
        .ok()
        .and_then(|v| serde_json::from_str::<Value>(&v).ok())
        .unwrap_or(json!({}));
    let day = now() / 86400;
    let count = if gate["day"] == day {
        gate["count"].as_u64().unwrap_or(0)
    } else {
        0
    };
    if count >= 200 {
        return Err("AniDB daily request limit reached; retry tomorrow.".into());
    }
    let wait = gate["next"].as_u64().unwrap_or(0).saturating_sub(now());
    if wait > 0 {
        tokio::time::sleep(Duration::from_secs(wait.min(3))).await;
    }
    db.set_setting(
        "native_anidb_gate",
        &json!({"day":day,"count":count+1,"next":now()+3}).to_string(),
    )
    .map_err(|_| "Unable to persist AniDB request limits.")?;
    let mut response = client
        .get("http://api.anidb.net:9001/httpapi")
        .query(&[
            ("request", "anime"),
            ("client", client_name.as_str()),
            ("clientver", version.as_str()),
            ("protover", "1"),
            ("aid", aid.as_str()),
        ])
        .send()
        .await
        .map_err(|_| "AniDB connection failed.")?
        .error_for_status()
        .map_err(|_| "AniDB rejected the request.")?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "AniDB response interrupted.")?
    {
        if bytes.len() + chunk.len() > 4 * 1024 * 1024 {
            return Err("AniDB response exceeds 4 MB.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let xml = String::from_utf8(bytes).map_err(|_| "Invalid AniDB XML encoding.")?;
    if let Err(error) = parse_anidb(&xml) {
        let _ = db.set_setting("native_anidb_blocked_until", &(now() + 900).to_string());
        return Err(error);
    }
    db.set_setting(&cache_key, &json!({"at":now(),"xml":xml}).to_string())
        .map_err(|_| "Unable to cache AniDB metadata.")?;
    Ok(xml)
}
fn parse_anidb(xml: &str) -> Result<xmltree::Element, String> {
    if xml.to_ascii_uppercase().contains("<!DOCTYPE")
        || xml.to_ascii_uppercase().contains("<!ENTITY")
    {
        return Err("Unsafe AniDB XML.".into());
    }
    let root = xmltree::Element::parse(xml.as_bytes()).map_err(|_| "Invalid AniDB XML.")?;
    if root.name == "error" {
        return Err("AniDB rejected the registered client, ID, or request rate; review configuration before retrying.".into());
    }
    if root.name != "anime" {
        return Err("AniDB returned no anime record.".into());
    }
    Ok(root)
}
fn text(root: &xmltree::Element, name: &str) -> Value {
    root.get_child(name)
        .and_then(|e| e.get_text())
        .map(|v| json!(v))
        .unwrap_or(Value::Null)
}
async fn anidb(
    state: &AppState,
    client: &reqwest::Client,
    library: &NativeLibrary,
    entry: &NativeCatalogEntry,
    parent: &Value,
) -> Result<Data, String> {
    let aid = if entry.kind == "episode" {
        id(parent, "anidb")
    } else {
        id(&entry.metadata, "anidb")
    }
    .ok_or(
        "AniDB requires an anime ID in local NFO metadata; automatic title guessing is not used.",
    )?;
    let xml = anidb_document(state, client, &aid).await?;
    let root = parse_anidb(&xml)?;
    let restricted = root
        .attributes
        .get("restricted")
        .is_some_and(|v| v == "true" || v == "1");
    if restricted && !library.options.allow_adult_metadata {
        return Err("Adult metadata matching is disabled.".into());
    }
    if entry.kind == "episode" {
        let season = entry.metadata["season"]
            .as_u64()
            .ok_or("Missing season number.")?;
        let number = entry.metadata["episode"]
            .as_u64()
            .ok_or("Missing episode number.")?;
        if season > 1 {
            return Err("AniDB uses separate anime IDs for sequel seasons; identify that season separately instead of guessing episode numbering.".into());
        }
        let matches = root
            .get_child("episodes")
            .into_iter()
            .flat_map(|e| e.children.iter())
            .filter_map(|n| n.as_element())
            .filter(|e| {
                e.get_child("epno").is_some_and(|n| {
                    n.attributes.get("type").map(String::as_str)
                        == Some(if season == 0 { "2" } else { "1" })
                        && n.get_text().is_some_and(|v| {
                            v.trim_start_matches('S').parse::<u64>().ok() == Some(number)
                        })
                })
            })
            .collect::<Vec<_>>();
        if matches.len() != 1 {
            return Err("AniDB episode numbering needs review.".into());
        }
        let ep = matches[0];
        let title = ep
            .children
            .iter()
            .filter_map(|n| n.as_element())
            .find(|e| {
                e.name == "title"
                    && e.attributes.get("lang").map(String::as_str)
                        == Some(library.options.metadata_language.as_str())
            })
            .or_else(|| ep.get_child("title"));
        return Ok(Data {
            id: None,
            fields: json!({"title":title.and_then(|e|e.get_text()).map(|v|v.into_owned()),"plot":text(ep,"summary"),"runtime":text(ep,"length").as_str().and_then(|v|v.parse::<u64>().ok()),"premiered":text(ep,"airdate")}),
            artwork: vec![],
            raw: json!({"anime_id":aid,"xml":xml}),
        });
    }
    let title = root
        .get_child("titles")
        .and_then(|titles| {
            titles
                .children
                .iter()
                .filter_map(|n| n.as_element())
                .find(|e| {
                    e.attributes.get("lang").map(String::as_str)
                        == Some(library.options.metadata_language.as_str())
                })
                .or_else(|| {
                    titles
                        .children
                        .iter()
                        .filter_map(|n| n.as_element())
                        .find(|e| e.attributes.get("type").map(String::as_str) == Some("main"))
                })
        })
        .and_then(|e| e.get_text())
        .map(|v| v.into_owned());
    let tags = root
        .get_child("tags")
        .into_iter()
        .flat_map(|e| e.children.iter())
        .filter_map(|n| n.as_element())
        .filter_map(|e| e.get_child("name"))
        .filter_map(|e| e.get_text())
        .map(|v| v.into_owned())
        .collect::<Vec<_>>();
    let credits=root.get_child("creators").into_iter().flat_map(|e|e.children.iter()).filter_map(|n|n.as_element()).filter_map(|e|Some(json!({"name":e.get_text()?.into_owned(),"role":e.attributes.get("type"),"category":"crew","provider_id":e.attributes.get("id")}))).collect::<Vec<_>>();
    let characters=root.get_child("characters").into_iter().flat_map(|e|e.children.iter()).filter_map(|n|n.as_element()).map(|e|json!({"id":e.attributes.get("id"),"name":text(e,"name"),"biography":text(e,"description"),"role":text(e,"charactertype"),"image":text(e,"picture")})).collect::<Vec<_>>();
    let fields = json!({"title":title,"plot":text(&root,"description"),"year":year(&text(&root,"startdate")),"premiered":text(&root,"startdate"),"tags":tags,"characters":characters,"episodes":text(&root,"episodecount").as_str().and_then(|v|v.parse::<u64>().ok()),"credits":credits});
    let artwork = text(&root, "picture")
        .as_str()
        .filter(|s| !s.contains('/') && !s.contains("..") && !s.contains('?'))
        .map(|p| {
            vec![(
                "poster".into(),
                format!("https://cdn-eu.anidb.net/images/main/{p}"),
            )]
        })
        .unwrap_or_default();
    Ok(Data {
        id: Some(aid),
        fields,
        artwork,
        raw: json!({"xml":xml}),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn maps_omdb_metadata_and_ignores_missing_artwork() {
        let data = map_omdb(
            json!({"Title":"Example","Plot":"Story","Year":"2020","Genre":"Action, Drama","Actors":"One, Two","Director":"Director","Runtime":"24 min","Poster":"N/A","imdbID":"tt123"}),
        );
        assert_eq!(data.fields["genres"], json!(["Action", "Drama"]));
        assert_eq!(data.fields["runtime"], 24);
        assert_eq!(data.fields["credits"].as_array().unwrap().len(), 3);
        assert!(data.artwork.is_empty());
    }
    #[test]
    fn maps_mal_series_details() {
        let data = map_mal(
            json!({"title":"Example","start_date":"2020-01-01","num_episodes":12,"genres":[{"name":"Action"}],"main_picture":{"large":"https://cdn.myanimelist.net/test.jpg"}}),
            "1".into(),
        );
        assert_eq!(data.fields["episodes"], 12);
        assert_eq!(data.fields["year"], 2020);
        assert_eq!(data.artwork.len(), 1);
    }
    #[test]
    fn maps_tvdb_identity_rating_and_preferred_artwork() {
        let data = map_tvdb(
            json!({"name":"Example","firstAired":"2020-01-01","genres":[{"name":"Action"}],"remoteIds":[{"sourceName":"IMDB","id":"tt123"}],"contentRatings":[{"country":"usa","name":"TV-14"}],"artworks":[{"type":2,"language":"jpn","image":"/jp.jpg"},{"type":2,"language":"eng","image":"/en.jpg"}]}),
            "1".into(),
            &json!([{"id":2,"name":"Series Posters"}]),
            "en",
            "US",
            "series",
        );
        assert_eq!(data.fields["year"], 2020);
        assert_eq!(data.fields["identifiers"]["imdb"], "tt123");
        assert_eq!(data.fields["mpaa"], "TV-14");
        assert_eq!(data.artwork[0].0, "poster");
        assert!(data.artwork[0].1.ends_with("/en.jpg"));
    }
    #[test]
    fn rejects_unsafe_and_error_anidb_xml() {
        assert!(parse_anidb("<!DOCTYPE anime><anime />").is_err());
        assert!(parse_anidb("<error code='500'>banned</error>").is_err());
        assert!(parse_anidb("<anime id='1'><titles /></anime>").is_ok());
    }
}
