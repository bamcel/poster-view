use crate::{AppState, HttpError};
use axum::{
    Json,
    extract::{Path, State},
};
use posterview_infra_sqlite::ServerStore;
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Search {
    title: String,
    year: Option<i64>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Apply {
    revision: i64,
    title: String,
    year: Option<i64>,
    identifiers: std::collections::BTreeMap<String, String>,
}
fn db(state: &AppState) -> ServerStore {
    ServerStore::new(state.runtime.data_dir())
}
fn key(state: &AppState, name: &str) -> String {
    db(state).get_setting(name).unwrap_or_default()
}
fn book_providers(lib: &posterview_contracts::native::NativeLibrary) -> Vec<&str> {
    lib.options.metadata_providers.get("book_series")
        .map(|providers| providers.iter().map(String::as_str).filter(|p| ["comicvine", "anilist", "mal", "mangadex"].contains(p)).collect())
        .unwrap_or_else(|| vec!["comicvine", "anilist", "mal"])
}
fn numeric(v: &Value) -> Option<String> {
    v.as_str()
        .map(str::to_owned)
        .or_else(|| v.as_u64().map(|v| v.to_string()))
        .filter(|s| s.parse::<u64>().is_ok_and(|id| id > 0))
}
fn comicvine_id(value: &str) -> Option<String> {
    let value = value.trim();
    if let Some(id) = numeric(&json!(value)) { return Some(id); }
    if let Some(id) = value.strip_prefix("4050-") { return numeric(&json!(id)); }
    let url = reqwest::Url::parse(value).ok()?;
    if !["https", "http"].contains(&url.scheme()) || !["comicvine.gamespot.com", "www.comicvine.gamespot.com"].contains(&url.host_str()?) { return None; }
    url.path_segments()?.find_map(|part| part.strip_prefix("4050-").and_then(|id| numeric(&json!(id))))
}
fn identification_id(provider: &str, value: &Value) -> bool {
    if provider=="mangadex" { value.as_str().is_some_and(posterview_infra_artwork::valid_manga_id) } else { numeric(value).is_some() }
}
fn year(v: &Value) -> Value {
    v.as_i64()
        .or_else(|| v.as_str()?.get(..4)?.parse().ok())
        .map_or(Value::Null, |y| json!(y))
}
fn candidate(provider: &str, v: &Value, movie: bool) -> Option<Value> {
    let (id, title, date, overview, format) = match provider {
        "anilist" => (
            numeric(&v["id"]),
            v["title"]["english"]
                .as_str()
                .or(v["title"]["romaji"].as_str()),
            v["startDate"]["year"].clone(),
            v["description"].clone(),
            v["format"].clone(),
        ),
        "tmdb" => (
            numeric(&v["id"]),
            v["title"].as_str().or(v["name"].as_str()),
            v[if movie {
                "release_date"
            } else {
                "first_air_date"
            }]
            .clone(),
            v["overview"].clone(),
            json!(if movie { "Movie" } else { "Series" }),
        ),
        "tvdb" => (
            numeric(&v["tvdb_id"]).or_else(|| numeric(&v["id"])),
            v["name"].as_str(),
            v["year"].as_i64().map(|v| json!(v)).unwrap_or_else(|| {
                v["firstAired"]
                    .as_str()
                    .map(|v| json!(v))
                    .unwrap_or_else(|| v["year"].clone())
            }),
            v["overview"].clone(),
            json!(if movie { "Movie" } else { "Series" }),
        ),
        "comicvine" => (numeric(&v["id"]), v["name"].as_str(), v["start_year"].clone(), v["description"].clone(), json!("Book series")),
        "mal" => (
            numeric(&v["id"]),
            v["title"].as_str(),
            v["start_date"].clone(),
            v["synopsis"].clone(),
            v["media_type"].clone(),
        ),
        _ => return None,
    };
    let id = id?;
    let title = title?;
    let mut ids = json!({});
    ids[provider] = json!(id);
    if provider == "anilist" {
        if let Some(mal) = numeric(&v["idMal"]) {
            ids["mal"] = json!(mal);
        }
    }
    if provider == "tmdb" {
        for field in ["tvdb", "imdb"] {
            let value = &v["external_ids"][format!("{field}_id")];
            if numeric(value).is_some()
                || (field == "imdb"
                    && value
                        .as_str()
                        .is_some_and(|s| s.starts_with("tt") && numeric(&json!(&s[2..])).is_some()))
            {
                ids[field] = json!(
                    value
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| value.to_string())
                );
            }
        }
    }
    if provider == "tvdb" {
        for remote in v["remoteIds"]
            .as_array()
            .into_iter()
            .flatten()
            .chain(v["remote_ids"].as_array().into_iter().flatten())
        {
            let source = remote["sourceName"]
                .as_str()
                .or(remote["source_name"].as_str())
                .unwrap_or("")
                .to_lowercase();
            let field = if source.contains("imdb") {
                "imdb"
            } else if source.contains("themoviedb") || source == "tmdb" {
                "tmdb"
            } else if source.contains("anilist") {
                "anilist"
            } else if source.contains("myanimelist") {
                "mal"
            } else if source.contains("anidb") {
                "anidb"
            } else {
                continue;
            };
            if let Some(value) = remote["id"]
                .as_str()
                .map(str::to_owned)
                .or_else(|| numeric(&remote["id"]))
            {
                ids[field] = json!(value);
            }
        }
    }
    let poster = match provider {
        "anilist" => v["coverImage"]["large"]
            .as_str()
            .or(v["coverImage"]["extraLarge"].as_str())
            .map(str::to_owned),
        "tmdb" => v["poster_path"]
            .as_str()
            .map(|p| format!("https://image.tmdb.org/t/p/w342{p}")),
        "tvdb" => v["image_url"]
            .as_str()
            .or(v["image"].as_str())
            .map(str::to_owned),
        "comicvine" => v["image"]["small_url"].as_str().or(v["image"]["original_url"].as_str()).map(str::to_owned),
        "mal" => v["main_picture"]["large"]
            .as_str()
            .or(v["main_picture"]["medium"].as_str())
            .map(str::to_owned),
        _ => None,
    }
    .filter(|url| {
        reqwest::Url::parse(url).is_ok_and(|u| {
            u.scheme() == "https" && u.username().is_empty() && u.password().is_none()
        })
    });
    Some(
        json!({"provider":provider,"id":id,"title":title,"year":year(&date),"overview":overview,"format":format,"identifiers":ids,"poster":poster,"publisher":if provider == "comicvine" {v["publisher"]["name"].clone()} else {Value::Null},"volume_count":if provider == "comicvine" {v["count_of_issues"].clone()} else {Value::Null}}),
    )
}

fn localized_tvdb(value: &Value, language: &str) -> Value {
    let mut result = value.clone();
    let code = crate::native_provider_extra::lang(language);
    for (field, map, translated) in [
        ("name", "translations", "name_translated"),
        ("overview", "overviews", "overview_translated"),
    ] {
        let mapped = value[map][code]
            .as_str()
            .or_else(|| value[map][language].as_str())
            .filter(|s| !s.trim().is_empty());
        let translated_value = value[translated].as_str().filter(|s| !s.trim().is_empty());
        // Some API versions encode translated maps as JSON strings.
        let encoded = translated_value.and_then(|s| serde_json::from_str::<Value>(s).ok());
        let selected = mapped
            .map(str::to_owned)
            .or_else(|| {
                encoded
                    .as_ref()
                    .and_then(|v| v[code].as_str().or_else(|| v[language].as_str()))
                    .filter(|s| !s.trim().is_empty())
                    .map(str::to_owned)
            })
            .or_else(|| {
                translated_value
                    .filter(|s| !s.trim_start().starts_with('{'))
                    .map(str::to_owned)
            });
        if let Some(text) = selected {
            result[field] = json!(text);
        }
    }
    result
}

async fn lookup(
    state: &AppState,
    client: &reqwest::Client,
    provider: &str,
    title: &str,
    id: Option<&str>,
    movie: bool,
    preferences: (bool, &str, bool),
) -> Result<Vec<Value>, String> {
    let (adult, language, books) = preferences;
    if provider == "anidb" {
        return anidb_lookup(state, client, title, id, movie).await;
    }
    let _gate = crate::workers::provider(provider).await;
    let _network = crate::workers::network().await;
    let response = crate::native_provider::response;
    let values: Vec<Value> = match provider {
        "anilist" => {
            let query = if id.is_some() {
                "query($id:Int){Media(id:$id,type:ANIME){id idMal format coverImage{large} title{english romaji native} startDate{year} description(asHtml:false)}}"
            } else {
                "query($search:String,$adult:Boolean){Page(perPage:15){media(search:$search,type:ANIME,isAdult:$adult){id idMal format coverImage{large} title{english romaji native} startDate{year} description(asHtml:false)}}}"
            };
            let query = query.replace("type:ANIME", if books { "type:MANGA" } else { "type:ANIME" });
            let body=response(client.post("https://graphql.anilist.co").json(&json!({"query":query,"variables":{"search":title,"id":id.and_then(|s|s.parse::<u64>().ok()),"adult":if adult {Value::Null}else{json!(false)}}})).send().await.map_err(|_|"AniList connection failed.")?).await?;
            if id.is_some() {
                vec![body["data"]["Media"].clone()]
            } else {
                body["data"]["Page"]["media"]
                    .as_array()
                    .cloned()
                    .ok_or("AniList search failed.")?
            }
        }
        "tmdb" => {
            let token = key(state, "tmdb_access_token");
            if token.is_empty() {
                return Err("Configure TMDB credentials in Search Providers.".into());
            }
            let kind = if movie { "movie" } else { "tv" };
            let mut request = client.get(format!(
                "https://api.themoviedb.org/3/{}",
                id.map(|id| format!("{kind}/{id}"))
                    .unwrap_or_else(|| format!("search/{kind}"))
            ));
            request = if token.len() == 32 {
                request.query(&[("api_key", &token)])
            } else {
                request.bearer_auth(&token)
            };
            request = if id.is_some() {
                request.query(&[("append_to_response", "external_ids")])
            } else {
                request.query(&[
                    ("query", title),
                    ("include_adult", if adult { "true" } else { "false" }),
                ])
            };
            let body = response(
                request
                    .send()
                    .await
                    .map_err(|_| "TMDB connection failed.")?,
            )
            .await?;
            if id.is_some() {
                vec![body]
            } else {
                body["results"]
                    .as_array()
                    .cloned()
                    .ok_or("TMDB search failed.")?
            }
        }
        "tvdb" => {
            let token = key(state, "tvdb_api_key");
            if token.is_empty() {
                return Err("Configure TheTVDB credentials in Search Providers.".into());
            }
            let service = posterview_infra_artwork::ArtworkService::default();
            let kind = if movie { "movies" } else { "series" };
            let path = id
                .map(|id| format!("/{kind}/{id}/extended"))
                .unwrap_or("/search".into());
            let q = if id.is_some() {
                vec![]
            } else {
                vec![
                    ("query", title),
                    ("type", if movie { "movie" } else { "series" }),
                    ("language", crate::native_provider_extra::lang(language)),
                ]
            };
            let body = response(
                service
                    .native_tvdb_get(&path, &q, &token, &key(state, "tvdb_pin"))
                    .await?,
            )
            .await?;
            if let Some(id) = id {
                let mut record = body["data"].clone();
                if let Ok(res) = service
                    .native_tvdb_get(
                        &format!(
                            "/{kind}/{id}/translations/{}",
                            crate::native_provider_extra::lang(language)
                        ),
                        &[],
                        &token,
                        &key(state, "tvdb_pin"),
                    )
                    .await
                {
                    if let Ok(translated) = response(res).await {
                        for field in ["name", "overview"] {
                            if translated["data"][field]
                                .as_str()
                                .is_some_and(|s| !s.trim().is_empty())
                            {
                                record[field] = translated["data"][field].clone();
                            }
                        }
                    }
                }
                vec![record]
            } else {
                body["data"]
                    .as_array()
                    .map(|values| {
                        values
                            .iter()
                            .map(|value| localized_tvdb(value, language))
                            .collect()
                    })
                    .ok_or("TheTVDB search failed.")?
            }
        }
        "mal" => {
            let token = key(state, "mal_client_id");
            if token.is_empty() {
                return Err("Configure a MyAnimeList client ID in Search Providers.".into());
            }
            let request = client
                .get(format!(
                    "https://api.myanimelist.net/v2/{}{}",
                    if books { "manga" } else { "anime" },
                    id.map(|id| format!("/{id}")).unwrap_or_default()
                ))
                .header("X-MAL-CLIENT-ID", token)
                .query(&[
                    (
                        "fields",
                        "id,title,start_date,synopsis,media_type,main_picture",
                    ),
                    ("nsfw", if adult { "true" } else { "false" }),
                ]);
            let request = if id.is_some() {
                request
            } else {
                request.query(&[("q", title), ("limit", "15")])
            };
            let body = response(
                request
                    .send()
                    .await
                    .map_err(|_| "MyAnimeList connection failed.")?,
            )
            .await?;
            if id.is_some() {
                vec![body]
            } else {
                body["data"]
                    .as_array()
                    .ok_or("MyAnimeList search failed.")?
                    .iter()
                    .map(|v| v["node"].clone())
                    .collect()
            }
        }
        "mangadex" if books => {
            let request=client.get(id.map(|id|format!("https://api.mangadex.org/manga/{id}")).unwrap_or_else(||"https://api.mangadex.org/manga".into())).query(&[("includes[]","cover_art")]);
            let request=if id.is_some(){request}else{request.query(&[("title",title),("limit","15")])};
            let request=if adult{request.query(&[("contentRating[]","safe"),("contentRating[]","suggestive"),("contentRating[]","erotica"),("contentRating[]","pornographic")])}else{request.query(&[("contentRating[]","safe"),("contentRating[]","suggestive")])};
            let body=response(request.send().await.map_err(|_|"MangaDex connection failed.")?).await?;
            let records=if id.is_some(){vec![body["data"].clone()]}else{body["data"].as_array().cloned().ok_or("MangaDex search failed.")?};
            return Ok(records.iter().filter(|data| adult || !["erotica","pornographic"].contains(&data["attributes"]["contentRating"].as_str().unwrap_or(""))).filter_map(|data|{
                let id=data["id"].as_str().filter(|id|posterview_infra_artwork::valid_manga_id(id))?;
                let fields=crate::native_provider_extra::mangadex_fields(data,language);
                let poster=data["relationships"].as_array().into_iter().flatten().find(|r|r["type"]=="cover_art").and_then(|r|r["attributes"]["fileName"].as_str()).filter(|name|name.bytes().all(|c|c.is_ascii_alphanumeric()||b"-._".contains(&c))).map(|name|format!("https://uploads.mangadex.org/covers/{id}/{name}.256.jpg"));
                Some(json!({"provider":"mangadex","id":id,"title":fields["title"],"year":fields["year"],"overview":fields["plot"],"format":"Manga","poster":poster,"identifiers":fields["identifiers"]}))
            }).collect());
        }
        "comicvine" if books => {
            let token = key(state, "comicvine_api_key");
            if token.is_empty() { return Err("Configure a ComicVine API key in Search Providers.".into()); }
            if id.is_none() {
                // The search endpoint sometimes omits these fields; shared search fills them from volume details.
                let service = posterview_infra_artwork::ArtworkService::default();
                let results = service.search("comicvine", title, "book", "", "", &token).await?;
                return Ok(results.into_iter().take(15).filter_map(|record| candidate("comicvine", &json!({"id":record.id,"name":record.name,"start_year":record.year,"publisher":{"name":record.publisher},"count_of_issues":record.volume_count,"image":{"small_url":record.thumb_url}}), false)).collect());
            }
            let path = id.map(|id| format!("volume/4050-{id}/")).unwrap_or_else(|| "search/".into());
            let request = client.get(format!("https://comicvine.gamespot.com/api/{path}"))
                .query(&[("api_key", token.as_str()), ("format", "json"), ("field_list", "id,name,start_year,description,image,publisher,count_of_issues")]);
            let request = if id.is_some() { request } else { request.query(&[("query", title), ("resources", "volume"), ("limit", "15")]) };
            let body = response(request.send().await.map_err(|_| "ComicVine connection failed.")?).await?;
            if body["status_code"].as_i64() != Some(1) { return Err("ComicVine could not retrieve volume records. Check your API key.".into()); }
            if id.is_some() { vec![body["results"].clone()] } else { body["results"].as_array().cloned().ok_or("ComicVine search failed.")? }
        }
        _ => return Err("Unsupported identification provider.".into()),
    };
    Ok(values
        .iter()
        .filter(|v| match provider {
            "anilist" => {
                if movie {
                    v["format"] == "MOVIE"
                } else {
                    v["format"] != "MOVIE"
                }
            }
            "mal" => {
                if movie {
                    v["media_type"] == "movie"
                } else {
                    v["media_type"] != "movie"
                }
            }
            _ => true,
        })
        .filter_map(|v| candidate(provider, v, movie))
        .take(15)
        .collect())
}
async fn context(
    state: &AppState,
    library: &str,
    item: &str,
) -> Result<
    (
        posterview_contracts::native::NativeLibrary,
        posterview_contracts::native::NativeCatalogEntry,
    ),
    HttpError,
> {
    let db = db(state);
    let library = library.to_string();
    let item = item.to_string();
    tokio::task::spawn_blocking(move || {
        let lib = db
            .native_libraries()
            .map_err(|e| HttpError::bad_request(e.to_string()))?
            .into_iter()
            .find(|l| l.id == library)
            .ok_or_else(HttpError::not_found)?;
        let entry = db
            .native_catalog(&library)
            .map_err(|e| HttpError::bad_request(e.to_string()))?
            .into_iter()
            .find(|e| e.id == item && e.available)
            .ok_or_else(HttpError::not_found)?;
        if !["series", "movie", "book_series"].contains(&entry.kind.as_str()) {
            return Err(HttpError::bad_request("Identify a series, movie, or book series."));
        }
        Ok((lib, entry))
    })
    .await
    .map_err(|_| HttpError::bad_request("Identification interrupted."))?
}
fn client() -> Result<reqwest::Client, HttpError> {
    reqwest::Client::builder()
        .user_agent("PosterView/0.1 (+https://github.com/bamcel/poster-view)")
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| HttpError::bad_gateway("Unable to start identification."))
}
pub(crate) async fn search(
    State(state): State<AppState>,
    Path((library, item)): Path<(String, String)>,
    Json(input): Json<Search>,
) -> Result<Json<Value>, HttpError> {
    let (lib, entry) = context(&state, &library, &item).await?;
    if input.title.trim().len() < 2
        || input.title.len() > 200
        || input.year.is_some_and(|y| !(1800..=2200).contains(&y))
    {
        return Err(HttpError::bad_request(
            "Enter a title of 2–200 characters and a valid optional year.",
        ));
    }
    let client = client()?;
    let providers = if entry.kind == "book_series" {
        book_providers(&lib)
    } else if lib.library_type == posterview_contracts::native::NativeLibraryType::Anime {
        vec!["anilist", "tmdb", "tvdb", "mal", "anidb"]
    } else {
        vec!["tmdb", "tvdb"]
    };
    let mut jobs = tokio::task::JoinSet::new();
    for selected_provider in providers.iter().copied() {
        let provider = match selected_provider {"comicvine"=>"comicvine", "anilist"=>"anilist", "mal"=>"mal", "mangadex"=>"mangadex", "tmdb"=>"tmdb", "tvdb"=>"tvdb", _=>"anidb"};
        let state = state.clone();
        let client = client.clone();
        let title = input.title.clone();
        let movie = entry.kind == "movie";
        let books = entry.kind == "book_series";
        let adult = lib.allows_adult_metadata();
        let language = lib.options.metadata_language.clone();
        jobs.spawn(async move {
            (
                provider,
                lookup(
                    &state,
                    &client,
                    provider,
                    &title,
                    None,
                    movie,
                    (adult, &language, books),
                )
                .await,
            )
        });
    }
    let mut groups = Vec::new();
    while let Some(result) = jobs.join_next().await {
        let (provider, result) =
            result.map_err(|_| HttpError::bad_gateway("Identification provider interrupted."))?;
        groups.push(match result {Ok(results)=>json!({"provider":provider,"results":results.into_iter().filter(|v|input.year.is_none_or(|y|v["year"].is_null() || v["year"]==y)).collect::<Vec<_>>()}),Err(error)=>json!({"provider":provider,"results":[],"error":error})});
    }
    groups.sort_by_key(|g| providers.iter().position(|p| Some(*p) == g["provider"].as_str()).unwrap_or(usize::MAX));
    Ok(Json(json!({"groups":groups})))
}
pub(crate) async fn apply(
    State(state): State<AppState>,
    Path((library, item)): Path<(String, String)>,
    Json(mut input): Json<Apply>,
) -> Result<Json<Value>, HttpError> {
    let (lib, entry) = context(&state, &library, &item).await?;
    if input.title.trim().is_empty()
        || input.title.len() > 512
        || input.year.is_some_and(|y| !(1800..=2200).contains(&y))
        || input.identifiers.is_empty()
    {
        return Err(HttpError::bad_request(
            "Choose a title and at least one provider ID.",
        ));
    }
    if let Some(id) = input.identifiers.get_mut("comicvine") {
        *id = comicvine_id(id).ok_or_else(|| HttpError::bad_request("Enter a ComicVine volume ID or series URL (4050), not an issue URL."))?;
    }
    for (provider, id) in &input.identifiers {
        if (entry.kind == "book_series" && !book_providers(&lib).contains(&provider.as_str()))
            || !["comicvine", "anilist", "tmdb", "tvdb", "mal", "imdb", "anidb", "mangadex"].contains(&provider.as_str())
            || if provider == "imdb" {
                !id.starts_with("tt") || numeric(&json!(&id[2..])).is_none()
            } else {
                !identification_id(provider, &json!(id))
            }
        {
            return Err(HttpError::bad_request("Invalid provider ID."));
        }
    }
    let client = client()?;
    let mut ids = input.identifiers.clone();
    // Fetch explicit selections by ID and use only provider-declared cross references.
    for (provider, id) in &input.identifiers {
        if ["imdb"].contains(&provider.as_str()) {
            continue;
        }
        let records = lookup(
            &state,
            &client,
            provider,
            &input.title,
            Some(id),
            entry.kind == "movie",
            (
                lib.allows_adult_metadata(),
                &lib.options.metadata_language,
                entry.kind == "book_series",
            ),
        )
        .await
        .map_err(HttpError::bad_gateway)?;
        let record = records.first().ok_or_else(|| {
            HttpError::bad_request("That provider ID does not match the library's media type.")
        })?;
        for (name, value) in record["identifiers"].as_object().into_iter().flatten() {
            if entry.kind == "book_series" && !book_providers(&lib).contains(&name.as_str()) { continue; }
            let Some(value) = value.as_str() else {
                continue;
            };
            if let Some(selected) = ids.get(name) {
                if selected != value {
                    return Err(HttpError::bad_request(format!(
                        "Provider cross references disagree for {name}. Review the selected records."
                    )));
                }
            } else {
                ids.insert(name.clone(), value.to_string());
            }
        }
    }
    for (provider, id) in &ids {
        if provider == "imdb" {
            if !id.starts_with("tt") || numeric(&json!(&id[2..])).is_none() {
                return Err(HttpError::bad_request("Invalid linked IMDb ID."));
            }
        } else if !identification_id(provider, &json!(id)) {
            return Err(HttpError::bad_request("Invalid linked provider ID."));
        }
    }
    let store = db(&state);
    let id = library.clone();
    let item_id = item.clone();
    let title = input.title.trim().to_string();
    let year = input.year;
    tokio::task::spawn_blocking(move || {
        store.identify_native_entry(&id, &item_id, input.revision, &title, year, &json!(ids))
    })
    .await
    .map_err(|_| HttpError::bad_request("Identification save interrupted."))?
    .map_err(|e| HttpError::bad_request(e.to_string()))?;
    let (_, updated) = context(&state, &library, &item).await?;
    if updated.kind=="series" {db(&state).set_setting(&format!("expected-episodes:{library}:{}",updated.path),"").map_err(|e|HttpError::bad_request(e.to_string()))?;}
    let mut warnings = Vec::<String>::new();
    if lib.options.save_nfo {
        let state = state.clone();
        let entry = updated.clone();
        let library = library.clone();
        let result = tokio::task::spawn_blocking(move || {
            let (path, xml) = crate::native_scan::write_identification_nfo(&state, &entry)?;
            db(&state)
                .record_native_nfo(&library, &entry.id, &path, &xml)
                .map_err(|e| e.to_string())
        })
        .await;
        if let Err(error) = result.unwrap_or_else(|_| Err("NFO write interrupted.".into())) {
            warnings.push(format!(
                "IDs saved in the database; NFO write failed: {error}"
            ));
        }
    }
    crate::native_sync::changed(&state,&library,&item,json!({"title":updated.title,"year":updated.metadata["year"],"identifiers":updated.metadata["identifiers"]}),None).await;
    Ok(Json(
        json!({"entry":updated,"warnings":warnings,"message":"Identification saved. Scan files to fetch missing metadata using the corrected IDs."}),
    ))
}

fn anidb_titles(xml: &str, title: &str) -> Result<Vec<Value>, String> {
    if xml.to_ascii_uppercase().contains("<!DOCTYPE")
        || xml.to_ascii_uppercase().contains("<!ENTITY")
    {
        return Err("Unsafe AniDB title index.".into());
    }
    let root = xmltree::Element::parse(xml.as_bytes()).map_err(|_| "Invalid AniDB title index.")?;
    if root.name != "animetitles" {
        return Err("Invalid AniDB title index.".into());
    }
    let normalize = |s: &str| {
        s.chars()
            .filter(|c| c.is_alphanumeric())
            .flat_map(char::to_lowercase)
            .collect::<String>()
    };
    let query = normalize(title);
    if query.is_empty() {
        return Ok(vec![]);
    }
    let mut matches = Vec::new();
    for anime in root.children.iter().filter_map(|n| n.as_element()) {
        let Some(id) = anime.attributes.get("aid").and_then(|v| numeric(&json!(v))) else {
            continue;
        };
        let titles = anime
            .children
            .iter()
            .filter_map(|n| n.as_element())
            .filter(|e| e.name == "title")
            .collect::<Vec<_>>();
        let score = titles
            .iter()
            .filter_map(|e| e.get_text())
            .map(|t| normalize(&t))
            .filter(|t| t.contains(&query))
            .map(|t| if t == query { 0 } else { 1 })
            .min();
        let Some(score) = score else {
            continue;
        };
        let name = titles
            .iter()
            .find(|e| e.attributes.get("type").is_some_and(|v| v == "main"))
            .or(titles.first())
            .and_then(|e| e.get_text())
            .map(|t| t.into_owned())
            .unwrap_or_default();
        matches.push((score,json!({"provider":"anidb","id":id,"title":name,"year":null,"format":"Anime - verify type","overview":"AniDB uses separate records for many sequel seasons. Verify the record before saving.","identifiers":{"anidb":id}})));
    }
    matches.sort_by_key(|(score, v)| (*score, v["title"].as_str().unwrap_or("").to_owned()));
    Ok(matches.into_iter().take(15).map(|(_, v)| v).collect())
}
fn anidb_poster(xml:&str)->Result<Option<String>,String> {
    let root=xmltree::Element::parse(xml.as_bytes()).map_err(|_|"Invalid AniDB record.")?;
    Ok(root.get_child("picture").and_then(|e|e.get_text()).filter(|s|!s.is_empty() && s.chars().all(|c|c.is_ascii_alphanumeric()||"._-".contains(c))).map(|s|format!("https://cdn-eu.anidb.net/images/main/{s}")))
}
pub(crate) async fn anidb_preview(State(state):State<AppState>,Path(id):Path<String>)->Result<Json<Value>,HttpError> {
    if id.is_empty() || !id.bytes().all(|c|c.is_ascii_digit()) {return Err(HttpError::bad_request("Invalid AniDB ID."));}
    let client=reqwest::Client::builder().timeout(std::time::Duration::from_secs(20)).user_agent("PosterView/0.1 (+https://github.com/bamcel/poster-view)").build().map_err(|_|HttpError::bad_gateway("Could not initialize AniDB client."))?;
    let xml=crate::native_provider_extra::anidb_document(&state,&client,&id).await.map_err(HttpError::bad_request)?;
    Ok(Json(json!({"poster":anidb_poster(&xml).map_err(HttpError::bad_request)?})))
}
async fn anidb_lookup(
    state: &AppState,
    client: &reqwest::Client,
    title: &str,
    id: Option<&str>,
    movie: bool,
) -> Result<Vec<Value>, String> {
    if let Some(id) = id {
        let _network = crate::workers::network().await;
        let xml = crate::native_provider_extra::anidb_document(state, client, id).await?;
        let root = xmltree::Element::parse(xml.as_bytes()).map_err(|_| "Invalid AniDB record.")?;
        let kind = root
            .get_child("type")
            .and_then(|e| e.get_text())
            .map(|s| s.into_owned())
            .unwrap_or_default();
        if (kind.eq_ignore_ascii_case("movie")) != movie {
            return Err("AniDB record does not match the item's media type.".into());
        }
        let name = root
            .get_child("titles")
            .and_then(|e| {
                e.children
                    .iter()
                    .filter_map(|n| n.as_element())
                    .find(|e| e.attributes.get("type").is_some_and(|v| v == "main"))
            })
            .and_then(|e| e.get_text())
            .map(|s| s.into_owned())
            .unwrap_or_else(|| title.into());
        let poster = root
            .get_child("picture")
            .and_then(|e| e.get_text())
            .filter(|s| {
                s.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
            })
            .map(|s| format!("https://cdn-eu.anidb.net/images/main/{s}"));
        let date = root
            .get_child("startdate")
            .and_then(|e| e.get_text())
            .map(|s| json!(s))
            .unwrap_or(Value::Null);
        return Ok(vec![
            json!({"provider":"anidb","id":id,"title":name,"year":year(&date),"format":kind,"poster":poster,"identifiers":{"anidb":id}}),
        ]);
    }
    static LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    let _guard = LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    let store = db(state);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let cached = store
        .get_setting("native_identify_anidb_titles")
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok());
    let xml = if let Some(xml) = cached
        .as_ref()
        .filter(|v| now.saturating_sub(v["at"].as_u64().unwrap_or(0)) < 86400)
        .and_then(|v| v["xml"].as_str())
    {
        xml.to_owned()
    } else {
        let _network = crate::workers::network().await;
        let mut response = client
            .get("https://anidb.net/api/anime-titles.xml.gz")
            .send()
            .await
            .map_err(|_| "AniDB title index connection failed.")?
            .error_for_status()
            .map_err(|_| "AniDB title index unavailable.")?;
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "AniDB title index interrupted.")?
        {
            if bytes.len() + chunk.len() > 8 * 1024 * 1024 {
                return Err("AniDB title index exceeds limit.".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let xml = tokio::task::spawn_blocking(move || {
            use std::io::Read;
            let mut xml = String::new();
            let reader: Box<dyn Read> = if bytes.starts_with(&[0x1f, 0x8b]) {
                Box::new(flate2::read::GzDecoder::new(bytes.as_slice()))
            } else {
                Box::new(bytes.as_slice())
            };
            reader
                .take(32 * 1024 * 1024 + 1)
                .read_to_string(&mut xml)
                .map_err(|_| "Invalid AniDB compressed index.")?;
            if xml.len() > 32 * 1024 * 1024 {
                return Err("AniDB title index exceeds limit.");
            }
            Ok(xml)
        })
        .await
        .map_err(|_| "AniDB index interrupted.")??;
        anidb_titles(&xml, title)?;
        store
            .set_setting(
                "native_identify_anidb_titles",
                &json!({"at":now,"xml":xml}).to_string(),
            )
            .map_err(|_| "Unable to cache AniDB titles.")?;
        xml
    };
    let title = title.to_owned();
    tokio::task::spawn_blocking(move || anidb_titles(&xml, &title))
        .await
        .map_err(|_| "AniDB title search interrupted.")?
}

#[cfg(test)]
mod tests {
    #[test]
    fn anidb_preview_extracts_only_a_safe_poster_filename() {
        assert_eq!(super::anidb_poster("<anime><picture>123.jpg</picture></anime>").unwrap().as_deref(),Some("https://cdn-eu.anidb.net/images/main/123.jpg"));
        assert!(super::anidb_poster("<anime><picture>../bad.jpg</picture></anime>").unwrap().is_none());
        assert!(super::anidb_poster("<anime/>").unwrap().is_none());
    }
    use super::*;
    #[test]
    fn mangadex_identification_accepts_uuid_instead_of_numeric_ids() {
        assert!(identification_id("mangadex",&json!("11111111-1111-1111-1111-111111111111")));
        assert!(!identification_id("mangadex",&json!("123")));
        assert!(!identification_id("anilist",&json!("11111111-1111-1111-1111-111111111111")));
    }
    #[test]
    fn comicvine_urls_resolve_to_volume_ids_only() {
        assert_eq!(comicvine_id("https://comicvine.gamespot.com/food-wars/4050-72430/"), Some("72430".into()));
        assert_eq!(comicvine_id("4050-72430"), Some("72430".into()));
        assert_eq!(comicvine_id("72430"), Some("72430".into()));
        assert!(comicvine_id("https://comicvine.gamespot.com/issue/4000-72430/").is_none());
        assert!(comicvine_id("https://example.com/4050-72430/").is_none());
    }
    #[test]
    fn book_provider_choices_preserve_exclusions_and_empty_selection() {
        let mut lib: posterview_contracts::native::NativeLibrary = serde_json::from_value(json!({"id":"books","name":"Books","library_type":"books","anime_content":"both","paths":[],"revision":1,"options":{},"created_at":"","updated_at":""})).unwrap();
        assert_eq!(book_providers(&lib), vec!["comicvine", "anilist", "mal"]);
        assert!(lib.allows_adult_metadata());
        lib.library_type = posterview_contracts::native::NativeLibraryType::Shows;
        assert!(!lib.allows_adult_metadata());
        lib.library_type = posterview_contracts::native::NativeLibraryType::Books;
        lib.options.metadata_providers.insert("book_series".into(), vec!["comicvine".into()]);
        assert_eq!(book_providers(&lib), vec!["comicvine"]);
        lib.options.metadata_providers.insert("book_series".into(), vec![]);
        assert!(book_providers(&lib).is_empty());
    }
    #[test]
    fn comicvine_volume_candidate_preserves_identity_and_cover() {
        let value = candidate("comicvine", &json!({"id":123,"name":"Batman","start_year":"2016","publisher":{"name":"DC Comics"},"count_of_issues":12,"image":{"small_url":"https://comicvine.gamespot.com/test.jpg"}}), false).unwrap();
        assert_eq!(value["identifiers"]["comicvine"], "123");
        assert_eq!(value["year"], 2016);
        assert_eq!(value["format"], "Book series");
        assert_eq!(value["publisher"], "DC Comics");
        assert_eq!(value["volume_count"], 12);
        assert_eq!(value["poster"], "https://comicvine.gamespot.com/test.jpg");
    }
    #[test]
    fn anidb_alias_search_is_unique_and_rejects_entities() {
        let xml = "<animetitles><anime aid='123'><title type='main'>Haikyuu!!</title><title type='syn'>Haikyu!</title></anime><anime aid='124'><title type='main'>Haikyuu!! Second Season</title></anime></animetitles>";
        let results = anidb_titles(xml, "Haikyu!").unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0]["id"], "123");
        assert!(anidb_titles("<!DOCTYPE x><animetitles/>", "x").is_err());
    }
    #[test]
    fn tvdb_results_use_preferred_language_and_keep_ids() {
        let raw = json!({"tvdb_id":"278157","name":"Japanese title","overview":"Japanese overview","translations":{"eng":"Haikyu!!","jpn":"Japanese title"},"overviews":{"eng":"Volleyball series"}});
        let result = localized_tvdb(&raw, "en");
        assert_eq!(result["name"], "Haikyu!!");
        assert_eq!(result["overview"], "Volleyball series");
        assert_eq!(result["tvdb_id"], "278157");
        assert_eq!(localized_tvdb(&raw, "fr")["name"], "Japanese title");
        let encoded = json!({"name":"Original","name_translated":"{\"eng\":\"English\"}"});
        assert_eq!(localized_tvdb(&encoded, "en")["name"], "English");
    }
    #[test]
    fn cross_references_ignore_zero_and_include_mal() {
        let v = candidate(
            "tmdb",
            &json!({"id":1,"name":"Test","external_ids":{"tvdb_id":0,"imdb_id":""}}),
            false,
        )
        .unwrap();
        assert!(v["identifiers"]["tvdb"].is_null());
        let poster = candidate(
            "tmdb",
            &json!({"id":1,"name":"Test","poster_path":"/test.jpg"}),
            false,
        )
        .unwrap();
        assert_eq!(poster["poster"], "https://image.tmdb.org/t/p/w342/test.jpg");
        let poster = candidate(
            "tvdb",
            &json!({"id":1,"name":"Test","image_url":"javascript:alert(1)"}),
            false,
        )
        .unwrap();
        assert!(poster["poster"].is_null());
        let v = candidate(
            "anilist",
            &json!({"id":1,"idMal":2,"title":{"romaji":"Test"}}),
            false,
        )
        .unwrap();
        assert_eq!(v["identifiers"]["mal"], "2");
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Resolve {
    provider: String,
    id: String,
}
pub(crate) async fn resolve(
    State(state): State<AppState>,
    Path((library, item)): Path<(String, String)>,
    Json(mut input): Json<Resolve>,
) -> Result<Json<Value>, HttpError> {
    let (lib, entry) = context(&state, &library, &item).await?;
    if input.provider == "comicvine" {
        input.id = comicvine_id(&input.id).ok_or_else(|| HttpError::bad_request("Enter a ComicVine volume ID or series URL (4050), not an issue URL."))?;
    }
    if (entry.kind == "book_series" && !book_providers(&lib).contains(&input.provider.as_str()))
        || !["comicvine", "anilist", "tmdb", "tvdb", "mal", "anidb", "mangadex"].contains(&input.provider.as_str())
        || !identification_id(&input.provider, &json!(input.id))
    {
        return Err(HttpError::bad_request("Choose a valid provider record."));
    }
    let client = client()?;
    let mut pending =
        std::collections::VecDeque::from([(input.provider.clone(), input.id.clone())]);
    let mut seen = std::collections::BTreeSet::new();
    let mut ids = std::collections::BTreeMap::from([(input.provider, input.id)]);
    let mut records = vec![];
    let mut warnings = vec![];
    while let Some((provider, id)) = pending.pop_front() {
        if !seen.insert(provider.clone()) {
            continue;
        }
        match lookup(
            &state,
            &client,
            &provider,
            "",
            Some(&id),
            entry.kind == "movie",
            (
                lib.allows_adult_metadata(),
                &lib.options.metadata_language,
                entry.kind == "book_series",
            ),
        )
        .await
        {
            Ok(values) => {
                if let Some(record) = values.first() {
                    for (name, value) in record["identifiers"].as_object().into_iter().flatten() {
                        if entry.kind == "book_series" && !book_providers(&lib).contains(&name.as_str()) { continue; }
                        let Some(value) = value.as_str() else {
                            continue;
                        };
                        if ids.get(name).is_some_and(|previous| previous != value) {
                            warnings.push(format!("Conflicting {name} link was not selected."));
                            continue;
                        }
                        ids.insert(name.clone(), value.to_owned());
                        if name != "imdb" && !seen.contains(name) {
                            pending.push_back((name.clone(), value.to_owned()));
                        }
                    }
                    let mut record = record.clone();
                    if entry.kind == "book_series" { if let Some(values) = record["identifiers"].as_object_mut() { values.retain(|name, _| book_providers(&lib).contains(&name.as_str())); } }
                    records.push(record);
                } else {
                    warnings.push(format!("{provider}: no record for the item's media type."));
                }
            }
            Err(error) => warnings.push(format!("{provider}: {error}")),
        }
    }
    Ok(Json(
        json!({"identifiers":ids,"candidates":records,"warnings":warnings}),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct MetadataPreview { provider: String }
pub(crate) async fn metadata_preview(State(state): State<AppState>, Path((library,item)): Path<(String,String)>, Json(input): Json<MetadataPreview>) -> Result<Json<Value>,HttpError> {
    let (lib,entry)=context(&state,&library,&item).await?;
    if entry.kind != "book_series" || !book_providers(&lib).contains(&input.provider.as_str()) {return Err(HttpError::bad_request("Select an enabled book metadata provider."));}
    if !identification_id(&input.provider, &entry.metadata["identifiers"][&input.provider]) {return Err(HttpError::bad_request("Identify this series with the selected provider first."));}
    let client=client()?;
    let fields=if input.provider == "anilist" {
        let raw=crate::native_provider::anilist(&client,&entry,true,lib.allows_adult_metadata()).await.map_err(HttpError::bad_gateway)?;
        json!({"title":raw["title"][if lib.options.metadata_language=="ja" {"native"} else {"english"}].as_str().or(raw["title"]["romaji"].as_str()),"originaltitle":raw["title"]["native"],"plot":raw["description"],"year":raw["startDate"]["year"],"volumes":raw["volumes"],"chapters":raw["chapters"],"status":raw["status"],"characters":raw["characters"]["edges"].as_array().into_iter().flatten().map(|edge|json!({"id":edge["node"]["id"].to_string(),"name":edge["node"]["name"]["full"],"biography":edge["node"]["description"],"image":edge["node"]["image"]["large"],"role":edge["role"]})).collect::<Vec<_>>(),"country":raw["countryOfOrigin"],"genres":raw["genres"],"tags":raw["tags"].as_array().into_iter().flatten().filter_map(|v|v["name"].as_str()).collect::<Vec<_>>()})
    } else {
        crate::native_provider_extra::fetch(&state,&client,&posterview_infra_artwork::ArtworkService::default(),&input.provider,&lib,&entry,&Value::Null).await.map_err(HttpError::bad_gateway)?.fields
    };
    let mut fields=fields.as_object().cloned().unwrap_or_default();
    fields.retain(|key,value| ["title","originaltitle","plot","year","volumes","chapters","publisher","status","country","genres","tags","characters"].contains(&key.as_str()) && !value.is_null() && value.as_str().is_none_or(|text|!text.trim().is_empty()));
    let prefix=if input.provider=="comicvine" {"edition"} else {"original"};
    for name in ["year","volumes"] {if let Some(value)=fields.get(name).cloned() {fields.insert(format!("{prefix}_{name}"),value);}}
    Ok(Json(json!({"provider":input.provider,"fields":fields})))
}
