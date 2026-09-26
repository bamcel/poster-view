//! Series credits use provider-confirmed IDs; title searches never auto-match.
use crate::ArtworkService;
use posterview_contracts::{Credit, CreditSearchResult, CreditSource};
use reqwest::RequestBuilder;
use serde_json::{Value, json};
use std::time::Duration;
use tokio::sync::Mutex;

// Shared pacing also covers parallel clients. Do not hammer Jikan or AniList.
static REQUEST_GATE: Mutex<Option<tokio::time::Instant>> = Mutex::const_new(None);
async fn pace() {
    let mut previous = REQUEST_GATE.lock().await;
    if let Some(last) = *previous {
        tokio::time::sleep_until(last + Duration::from_millis(1100)).await;
    }
    *previous = Some(tokio::time::Instant::now());
}

pub fn valid_credit_provider(provider: &str) -> bool {
    matches!(provider, "anilist" | "mal" | "tvdb" | "tmdb")
}
pub fn valid_credit_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 12
        && id.bytes().all(|v| v.is_ascii_digit())
        && id.parse::<u64>().is_ok_and(|v| v > 0)
}

async fn response(mut response: reqwest::Response) -> Result<Value, String> {
    if !response.status().is_success() {
        return Err(format!(
            "Provider returned HTTP {}. Existing credits were kept; retry later or check the provider credentials.",
            response.status().as_u16()
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Could not read provider response.")?
    {
        if bytes.len() + chunk.len() > 12 * 1024 * 1024 {
            return Err("Provider response exceeds the metadata size limit.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| "Provider returned invalid JSON.")?;
    if value
        .get("errors")
        .is_some_and(|v| !v.as_array().is_some_and(Vec::is_empty))
    {
        return Err(
            "Provider could not complete the metadata query. Existing credits were kept.".into(),
        );
    }
    Ok(value)
}
async fn request(builder: RequestBuilder) -> Result<Value, String> {
    pace().await;
    response(
        builder
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|_| "Metadata provider is unavailable or timed out.")?,
    )
    .await
}
fn text(v: &Value) -> Option<String> {
    v.as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}
fn id(v: &Value) -> String {
    v.as_u64()
        .map(|n| n.to_string())
        .or_else(|| text(v))
        .unwrap_or_default()
}
fn array(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn required_array<'a>(v: &'a Value, label: &str) -> Result<&'a [Value], String> {
    v.as_array()
        .map(Vec::as_slice)
        .ok_or_else(|| format!("Provider returned incomplete {label}; existing credits were kept."))
}
fn url(v: &Value) -> Option<String> {
    text(v).filter(|v| v.starts_with("https://"))
}
fn tmdb_image(v: &Value) -> Option<String> {
    text(v)
        .filter(|s| s.starts_with('/') && !s.starts_with("//"))
        .map(|s| format!("https://image.tmdb.org/t/p/w185{s}"))
}
fn tvdb_image(v: &Value) -> Option<String> {
    text(v).map(|s| {
        if s.starts_with("https://") {
            s
        } else {
            format!("https://artworks.thetvdb.com/{}", s.trim_start_matches('/'))
        }
    })
}

/// Unknown language names stay explicit rather than being guessed as English.
pub fn credit_language(value: &str) -> Option<String> {
    let value = value.trim().to_lowercase();
    if value.is_empty() {
        return None;
    }
    Some(
        match value.as_str() {
            "japanese" | "jpn" => "ja",
            "english" | "eng" => "en",
            "french" | "fra" | "fre" => "fr",
            "german" | "deu" | "ger" => "de",
            "spanish" | "spa" => "es",
            "italian" | "ita" => "it",
            "portuguese" | "por" => "pt",
            "portuguese (brazil)" | "brazilian" => "pt-BR",
            "korean" | "kor" => "ko",
            "chinese" | "zho" | "chi" | "mandarin" => "zh",
            "cantonese" => "yue",
            "russian" | "rus" => "ru",
            "arabic" | "ara" => "ar",
            "hindi" | "hin" => "hi",
            "thai" | "tha" => "th",
            "vietnamese" | "vie" => "vi",
            "indonesian" | "ind" => "id",
            "turkish" | "tur" => "tr",
            "polish" | "pol" => "pl",
            "dutch" | "nld" | "dut" => "nl",
            "swedish" | "swe" => "sv",
            "finnish" | "fin" => "fi",
            "danish" | "dan" => "da",
            "norwegian" | "nor" => "no",
            "hebrew" | "heb" => "he",
            "hungarian" | "hun" => "hu",
            "czech" | "ces" | "cze" => "cs",
            "greek" | "ell" | "gre" => "el",
            _ => &value,
        }
        .to_owned(),
    )
}

impl ArtworkService {
    pub async fn search_credits(
        &self,
        provider: &str,
        query: &str,
        tmdb: &str,
        tvdb: &str,
        pin: &str,
    ) -> Result<Vec<CreditSearchResult>, String> {
        let (value, key)=match provider {
            "anilist"=>(request(self.client.post(crate::ANILIST_URL).json(&json!({"query":"query($q:String!){Page(perPage:20){media(search:$q,type:ANIME){id title{romaji english} startDate{year} coverImage{medium}}}}","variables":{"q":query}}))).await?,"anilist"),
            "mal"=>(request(self.client.get("https://api.jikan.moe/v4/anime").query(&[("q",query),("limit","20")])).await?,"mal"),
            "tmdb"=>{if tmdb.is_empty(){return Err("Add your TMDb API Read Access Token in Cast & crew → Sources.".into());}(request(self.client.get("https://api.themoviedb.org/3/search/tv").bearer_auth(tmdb).query(&[("query",query)])).await?,"tmdb")},
            "tvdb"=>{if tvdb.is_empty(){return Err("Configure TheTVDB in Settings → Providers first.".into());} pace().await;(response(self.tvdb_get("/search",&[("query",query),("type","series"),("limit","20")],tvdb,pin).await?).await?,"tvdb")},
            _=>return Err("Unknown credits provider.".into()),
        };
        let rows = match key {
            "anilist" => &value["data"]["Page"]["media"],
            "tmdb" => &value["results"],
            _ => &value["data"],
        };
        Ok(required_array(rows, "search results")?
            .iter()
            .filter_map(|r| {
                let (external_id, title, year, image) = match key {
                    "anilist" => (
                        id(&r["id"]),
                        text(&r["title"]["english"]).or_else(|| text(&r["title"]["romaji"])),
                        r["startDate"]["year"].as_i64(),
                        url(&r["coverImage"]["medium"]),
                    ),
                    "mal" => (
                        id(&r["mal_id"]),
                        text(&r["title"]),
                        r["year"]
                            .as_i64()
                            .or_else(|| r["aired"]["prop"]["from"]["year"].as_i64()),
                        url(&r["images"]["jpg"]["image_url"]),
                    ),
                    "tmdb" => (
                        id(&r["id"]),
                        text(&r["name"]),
                        text(&r["first_air_date"]).and_then(|s| s.get(..4)?.parse().ok()),
                        tmdb_image(&r["poster_path"]),
                    ),
                    _ => (
                        id(&r["tvdb_id"]),
                        text(&r["name"]),
                        text(&r["year"]).and_then(|s| s.parse().ok()),
                        tvdb_image(&r["image_url"]),
                    ),
                };
                valid_credit_id(&external_id).then_some(CreditSearchResult {
                    id: external_id,
                    title: title?,
                    year,
                    image,
                })
            })
            .collect())
    }

    pub async fn fetch_credits(
        &self,
        provider: &str,
        external_id: &str,
        tmdb: &str,
        tvdb: &str,
        pin: &str,
    ) -> Result<CreditSource, String> {
        if !valid_credit_id(external_id) {
            return Err("Choose a valid provider series ID.".into());
        }
        let mut result = match provider {
            "anilist" => self.anilist_credits(external_id).await?,
            "mal" => {
                let root = format!("https://api.jikan.moe/v4/anime/{external_id}");
                let details = request(self.client.get(&root)).await?;
                let cast = request(self.client.get(format!("{root}/characters"))).await?;
                let crew = request(self.client.get(format!("{root}/staff"))).await?;
                parse_mal(external_id, &details["data"], &cast["data"], &crew["data"])?
            }
            "tmdb" => {
                if tmdb.is_empty() {
                    return Err(
                        "Add your TMDb API Read Access Token in Cast & crew → Sources.".into(),
                    );
                }
                let data = request(
                    self.client
                        .get(format!("https://api.themoviedb.org/3/tv/{external_id}"))
                        .bearer_auth(tmdb)
                        .query(&[("append_to_response", "aggregate_credits")]),
                )
                .await?;
                parse_tmdb(external_id, &data)?
            }
            "tvdb" => {
                if tvdb.is_empty() {
                    return Err("Configure TheTVDB in Settings → Providers first.".into());
                }
                pace().await;
                let data = response(
                    self.tvdb_get(&format!("/series/{external_id}/extended"), &[], tvdb, pin)
                        .await?,
                )
                .await?;
                parse_tvdb(external_id, &data["data"])?
            }
            _ => return Err("Unknown credits provider.".into()),
        };
        result
            .credits
            .retain(|c| !c.name.is_empty() && !c.person_id.is_empty());
        Ok(result)
    }

    async fn anilist_credits(&self, external_id: &str) -> Result<CreditSource, String> {
        let mut result = CreditSource {
            provider: "anilist".into(),
            external_id: external_id.into(),
            source_url: format!("https://anilist.co/anime/{external_id}"),
            ..Default::default()
        };
        for page in 1..=100 {
            let data=request(self.client.post(crate::ANILIST_URL).json(&json!({"query":ANILIST_QUERY,"variables":{"id":external_id.parse::<i64>().map_err(|_|"Invalid AniList ID")?,"page":page}}))).await?;
            let media = &data["data"]["Media"];
            result.title = text(&media["title"]["english"])
                .or_else(|| text(&media["title"]["romaji"]))
                .ok_or("AniList series was not found.")?;
            parse_anilist_page(media, &mut result.credits)?;
            let chars = media["characters"]["pageInfo"]["hasNextPage"]
                .as_bool()
                .ok_or("Incomplete AniList character pagination.")?;
            let staff = media["staff"]["pageInfo"]["hasNextPage"]
                .as_bool()
                .ok_or("Incomplete AniList staff pagination.")?;
            if !chars && !staff {
                return Ok(result);
            }
        }
        Err("AniList pagination limit reached. Existing credits were kept.".into())
    }
}

const ANILIST_QUERY: &str = r#"query($id:Int!,$page:Int!){Media(id:$id,type:ANIME){title{romaji english}
characters(page:$page,perPage:25,sort:[ROLE,ID]){pageInfo{hasNextPage} edges{role name node{id name{full} image{medium}}
voiceActorRoles{roleNotes dubGroup voiceActor{id name{full} image{medium} languageV2 siteUrl}}}}
staff(page:$page,perPage:25,sort:[ID]){pageInfo{hasNextPage} edges{role node{id name{full} image{medium} siteUrl}}}}}"#;

fn parse_anilist_page(media: &Value, credits: &mut Vec<Credit>) -> Result<(), String> {
    for edge in required_array(&media["characters"]["edges"], "AniList characters")? {
        for actor in array(&edge["voiceActorRoles"]) {
            let p = &actor["voiceActor"];
            credits.push(Credit {
                person_id: id(&p["id"]),
                name: text(&p["name"]["full"]).unwrap_or_default(),
                image: url(&p["image"]["medium"]),
                person_url: url(&p["siteUrl"]),
                character_id: Some(id(&edge["node"]["id"])),
                character: text(&edge["name"]).or_else(|| text(&edge["node"]["name"]["full"])),
                character_image: url(&edge["node"]["image"]["medium"]),
                category: "cast".into(),
                role: match edge["role"].as_str() {
                    Some("MAIN") => "Main voice",
                    Some("SUPPORTING") => "Supporting voice",
                    _ => "Voice",
                }
                .into(),
                language: p["languageV2"].as_str().and_then(credit_language),
                dub_group: text(&actor["dubGroup"]),
                notes: text(&actor["roleNotes"]),
                order: credits.len() as i64,
            });
        }
    }
    for edge in required_array(&media["staff"]["edges"], "AniList crew")? {
        let p = &edge["node"];
        credits.push(Credit {
            person_id: id(&p["id"]),
            name: text(&p["name"]["full"]).unwrap_or_default(),
            image: url(&p["image"]["medium"]),
            person_url: url(&p["siteUrl"]),
            category: "crew".into(),
            role: text(&edge["role"]).unwrap_or_else(|| "Staff".into()),
            order: credits.len() as i64,
            ..Default::default()
        });
    }
    Ok(())
}

fn parse_mal(
    external_id: &str,
    details: &Value,
    cast: &Value,
    crew: &Value,
) -> Result<CreditSource, String> {
    let mut result = CreditSource {
        provider: "mal".into(),
        external_id: external_id.into(),
        title: text(&details["title"]).ok_or("MyAnimeList series was not found.")?,
        source_url: format!("https://myanimelist.net/anime/{external_id}"),
        ..Default::default()
    };
    for edge in required_array(cast, "MyAnimeList cast")? {
        for actor in array(&edge["voice_actors"]) {
            let p = &actor["person"];
            let ch = &edge["character"];
            result.credits.push(Credit {
                person_id: id(&p["mal_id"]),
                name: text(&p["name"]).unwrap_or_default(),
                image: url(&p["images"]["jpg"]["image_url"]),
                person_url: url(&p["url"]),
                character_id: Some(id(&ch["mal_id"])),
                character: text(&ch["name"]),
                character_image: url(&ch["images"]["jpg"]["image_url"]),
                category: "cast".into(),
                role: format!("{} voice", text(&edge["role"]).unwrap_or_default())
                    .trim()
                    .into(),
                language: actor["language"].as_str().and_then(credit_language),
                order: result.credits.len() as i64,
                ..Default::default()
            });
        }
    }
    for edge in required_array(crew, "MyAnimeList crew")? {
        let p = &edge["person"];
        for position in array(&edge["positions"]) {
            result.credits.push(Credit {
                person_id: id(&p["mal_id"]),
                name: text(&p["name"]).unwrap_or_default(),
                image: url(&p["images"]["jpg"]["image_url"]),
                person_url: url(&p["url"]),
                category: "crew".into(),
                role: text(position).unwrap_or_else(|| "Staff".into()),
                order: result.credits.len() as i64,
                ..Default::default()
            });
        }
    }
    Ok(result)
}

fn parse_tmdb(external_id: &str, data: &Value) -> Result<CreditSource, String> {
    let mut result = CreditSource {
        provider: "tmdb".into(),
        external_id: external_id.into(),
        title: text(&data["name"]).ok_or("TMDb series was not found.")?,
        source_url: format!("https://www.themoviedb.org/tv/{external_id}"),
        original_language: data["original_language"].as_str().and_then(credit_language),
        ..Default::default()
    };
    for category in ["cast", "crew"] {
        for p in required_array(&data["aggregate_credits"][category], "TMDb credits")? {
            for role in required_array(
                &p[if category == "cast" { "roles" } else { "jobs" }],
                "TMDb roles",
            )? {
                result.credits.push(Credit {
                    person_id: id(&p["id"]),
                    name: text(&p["name"]).unwrap_or_default(),
                    image: tmdb_image(&p["profile_path"]),
                    person_url: Some(format!(
                        "https://www.themoviedb.org/person/{}",
                        id(&p["id"])
                    )),
                    category: category.into(),
                    character: if category == "cast" {
                        text(&role["character"])
                    } else {
                        None
                    },
                    role: if category == "cast" {
                        "Actor".into()
                    } else {
                        text(&role["job"]).unwrap_or_else(|| "Crew".into())
                    },
                    // TMDb's response language localizes text. It does not identify dub performances.
                    notes: role["episode_count"]
                        .as_u64()
                        .map(|n| format!("{n} episodes")),
                    order: p["order"].as_i64().unwrap_or(result.credits.len() as i64),
                    ..Default::default()
                });
            }
        }
    }
    Ok(result)
}

fn parse_tvdb(external_id: &str, data: &Value) -> Result<CreditSource, String> {
    let mut result = CreditSource {
        provider: "tvdb".into(),
        external_id: external_id.into(),
        title: text(&data["name"]).ok_or("TheTVDB series was not found.")?,
        source_url: format!("https://thetvdb.com/dereferrer/series/{external_id}"),
        original_language: data["originalLanguage"].as_str().and_then(credit_language),
        ..Default::default()
    };
    for p in required_array(&data["characters"], "TheTVDB credits")? {
        let role = text(&p["peopleType"]).unwrap_or_else(|| "Unknown role".into());
        let cast = matches!(
            role.to_lowercase().as_str(),
            "actor" | "voice actor" | "guest star" | "guest actor"
        );
        result.credits.push(Credit {
            person_id: id(&p["peopleId"]),
            name: text(&p["personName"]).unwrap_or_default(),
            image: tvdb_image(&p["personImgURL"]),
            person_url: Some(format!("https://thetvdb.com/people/{}", id(&p["peopleId"]))),
            character_id: if cast { Some(id(&p["id"])) } else { None },
            character: if cast { text(&p["name"]) } else { None },
            character_image: if cast { tvdb_image(&p["image"]) } else { None },
            category: if cast { "cast" } else { "crew" }.into(),
            role,
            order: p["sort"].as_i64().unwrap_or(result.credits.len() as i64),
            ..Default::default()
        });
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "requires live AniList and Jikan access"]
    async fn live_anime_credits_include_japanese_english_and_crew() {
        let service = ArtworkService::default();
        for provider in ["anilist", "mal"] {
            let found = service
                .search_credits(provider, "Cowboy Bebop", "", "", "")
                .await
                .unwrap();
            assert!(found.iter().any(|item| item.id == "1"));
            let result = service
                .fetch_credits(provider, "1", "", "", "")
                .await
                .unwrap();
            assert!(
                result
                    .credits
                    .iter()
                    .any(|c| c.language.as_deref() == Some("ja")),
                "{provider}: Japanese cast"
            );
            assert!(
                result
                    .credits
                    .iter()
                    .any(|c| c.language.as_deref() == Some("en")),
                "{provider}: English cast"
            );
            assert!(
                result.credits.iter().any(|c| c.category == "crew"),
                "{provider}: crew"
            );
            eprintln!("{provider}: {} credits", result.credits.len());
        }
    }
    #[test]
    fn mal_keeps_all_voice_languages_and_staff_jobs() {
        let result=parse_mal("1",&json!({"title":"Series"}),&json!([{"character":{"mal_id":10,"name":"Hero"},"role":"Main","voice_actors":[{"person":{"mal_id":1,"name":"Actor JP"},"language":"Japanese"},{"person":{"mal_id":2,"name":"Actor EN"},"language":"English"}]}]),&json!([{"person":{"mal_id":3,"name":"Staff"},"positions":["Director","Script"]}])).unwrap();
        assert_eq!(result.credits.len(), 4);
        assert_eq!(result.credits[1].language.as_deref(), Some("en"));
        assert_eq!(result.credits[2].role, "Director");
        assert_eq!(result.credits[3].role, "Script");
    }
    #[test]
    fn tvdb_separates_crew_without_guessing_voice_languages() {
        let result=parse_tvdb("1",&json!({"name":"Series","originalLanguage":"jpn","characters":[{"id":1,"peopleId":2,"personName":"Actor","peopleType":"Actor","name":"Hero"},{"id":3,"peopleId":4,"personName":"Director","peopleType":"Director","name":"Director"}]})).unwrap();
        assert_eq!(result.credits[0].category, "cast");
        assert_eq!(result.credits[1].category, "crew");
        assert!(result.credits[0].language.is_none());
    }
    #[test]
    fn anilist_preserves_dubs_and_multiple_roles() {
        let value = json!({"characters":{"edges":[{"role":"MAIN","node":{"id":10,"name":{"full":"Hero"}},"voiceActorRoles":[{"voiceActor":{"id":1,"name":{"full":"Japanese actor"},"languageV2":"Japanese"}},{"dubGroup":"New dub","roleNotes":"Season 2","voiceActor":{"id":2,"name":{"full":"English actor"},"languageV2":"English"}}]}]},"staff":{"edges":[{"role":"Director","node":{"id":1,"name":{"full":"Japanese actor"}}}]}});
        let mut credits = Vec::new();
        parse_anilist_page(&value, &mut credits).unwrap();
        assert_eq!(credits.len(), 3);
        assert_eq!(credits[0].language.as_deref(), Some("ja"));
        assert_eq!(credits[1].language.as_deref(), Some("en"));
        assert_eq!(credits[1].dub_group.as_deref(), Some("New dub"));
        assert!(credits[2].language.is_none());
    }
    #[test]
    fn tmdb_localized_response_never_becomes_an_english_dub() {
        let source=parse_tmdb("1",&json!({"name":"Show","original_language":"ja","aggregate_credits":{"cast":[{"id":1,"name":"Actor","roles":[{"character":"Hero","episode_count":20},{"character":"Narrator","episode_count":2}]}],"crew":[]}})).unwrap();
        assert_eq!(source.credits.len(), 2);
        assert!(source.credits.iter().all(|c| c.language.is_none()));
        assert_eq!(source.original_language.as_deref(), Some("ja"));
    }
    #[test]
    fn malformed_payload_is_not_a_successful_empty_refresh() {
        assert!(parse_mal("1", &json!({"title":"Series"}), &Value::Null, &json!([])).is_err());
        assert!(parse_tmdb("1", &json!({"name":"Series"})).is_err());
        assert!(!valid_credit_id("../1"));
        assert!(!valid_credit_id("0"));
    }
}
