use crate::tmdb_auth::TmdbAuth;
use crate::{
    ArtworkService,
    credits::{pace, parse_tmdb, parse_tvdb, request, response},
    valid_credit_id,
};
use posterview_contracts::CreditSource;
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Default, Debug)]
pub struct FetchedVideoMetadata {
    pub fields: BTreeMap<String, Value>,
    pub ids: BTreeMap<String, String>,
}
fn text(v: &Value) -> Option<String> {
    v.as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}
fn names(v: &Value) -> Value {
    json!(
        v.as_array()
            .into_iter()
            .flatten()
            .filter_map(|x| text(&x["name"]))
            .collect::<Vec<_>>()
    )
}
fn clean(v: &Value) -> Value {
    text(v)
        .map(|s| {
            let re = regex::Regex::new("<[^>]*>").expect("constant regex");
            json!(
                re.replace_all(&s.replace("<br>", "\n").replace("<br />", "\n"), "")
                    .replace("&amp;", "&")
                    .replace("&quot;", "\"")
                    .replace("&#39;", "'")
            )
        })
        .unwrap_or(Value::Null)
}
fn put(out: &mut FetchedVideoMetadata, key: &str, value: Value) {
    if !value.is_null()
        && value.as_str().is_none_or(|s| !s.trim().is_empty())
        && value.as_array().is_none_or(|v| !v.is_empty())
    {
        out.fields.insert(key.into(), value);
    }
}
fn year(v: &Value) -> Value {
    text(v)
        .and_then(|s| s.get(..4)?.parse::<i64>().ok())
        .map_or(Value::Null, |n| json!(n))
}
fn link_id(out: &mut FetchedVideoMetadata, provider: &str, v: &Value) {
    let id = v
        .as_str()
        .map(str::to_owned)
        .or_else(|| v.as_u64().map(|n| n.to_string()));
    if let Some(id) = id.filter(|s| {
        if provider == "imdb" {
            s.starts_with("tt")
                && s.len() <= 14
                && s.len() >= 9
                && s[2..].bytes().all(|b| b.is_ascii_digit())
        } else {
            valid_credit_id(s)
        }
    }) {
        out.ids.insert(provider.into(), id);
    }
}
impl ArtworkService {
    pub async fn find_tmdb_id(
        &self,
        imdb: &str,
        movie: bool,
        token: &str,
    ) -> Result<Option<String>, String> {
        if token.is_empty()
            || !imdb.starts_with("tt")
            || imdb.len() > 14
            || !imdb[2..].bytes().all(|b| b.is_ascii_digit())
        {
            return Ok(None);
        }
        let data = request(
            self.client
                .get(format!("https://api.themoviedb.org/3/find/{imdb}"))
                .tmdb_auth(token)
                .query(&[("external_source", "imdb_id")]),
        )
        .await?;
        let rows = data[if movie { "movie_results" } else { "tv_results" }].as_array();
        Ok(rows
            .filter(|r| r.len() == 1)
            .and_then(|r| r[0]["id"].as_u64())
            .map(|n| n.to_string()))
    }
    pub async fn video_metadata(
        &self,
        provider: &str,
        id: &str,
        movie: bool,
        tmdb: &str,
        tvdb: &str,
        pin: &str,
    ) -> Result<FetchedVideoMetadata, String> {
        if !valid_credit_id(id) {
            return Err("Invalid provider ID".into());
        }
        let data = match provider {
            "tmdb" => {
                if tmdb.is_empty() { return Err("Configure TMDB in Edit Metadata → Provider matching.".into()); }
                let kind = if movie { "movie" } else { "tv" };
                request(self.client.get(format!("https://api.themoviedb.org/3/{kind}/{id}")).tmdb_auth(tmdb).query(&[("append_to_response", if movie { "external_ids,keywords,release_dates,videos" } else { "external_ids,keywords,content_ratings,videos" })])).await?
            },
            "tvdb" => {
                if tvdb.is_empty() { return Err("Configure TheTVDB in Settings → Search Providers.".into()); }
                pace().await; response(self.tvdb_get(&format!("/{}/{id}/extended", if movie { "movies" } else { "series" }), &[], tvdb, pin).await?).await?["data"].clone()
            },
            "anilist" => request(self.client.post(crate::ANILIST_URL).json(&json!({"query":"query($id:Int!){Media(id:$id,type:ANIME){id idMal format title{romaji english native} description(asHtml:false) startDate{year month day} endDate{year month day} duration status countryOfOrigin genres tags{name isMediaSpoiler isGeneralSpoiler} studios{nodes{name}}}}", "variables":{"id":id.parse::<u64>().map_err(|_| "Invalid AniList ID")?}}))).await?["data"]["Media"].clone(),
            "mal" => request(self.client.get(format!("https://api.jikan.moe/v4/anime/{id}/full"))).await?["data"].clone(),
            _ => return Err("Unsupported metadata provider".into()),
        };
        parse(provider, id, movie, &data)
    }
    pub async fn fetch_video_credits(
        &self,
        provider: &str,
        id: &str,
        movie: bool,
        tmdb: &str,
        tvdb: &str,
        pin: &str,
    ) -> Result<CreditSource, String> {
        if !movie {
            return self.fetch_credits(provider, id, tmdb, tvdb, pin).await;
        }
        if !valid_credit_id(id) {
            return Err("Invalid provider ID".into());
        }
        match provider {
            "tmdb" => {
                if tmdb.is_empty() {
                    return Err("Configure TMDB in Edit Metadata → Provider matching.".into());
                }
                let data = request(
                    self.client
                        .get(format!("https://api.themoviedb.org/3/movie/{id}"))
                        .tmdb_auth(tmdb)
                        .query(&[("append_to_response", "credits")]),
                )
                .await?;
                parse_movie_credits(id, data)
            }
            "tvdb" => {
                if tvdb.is_empty() {
                    return Err("Configure TheTVDB in Settings.".into());
                }
                pace().await;
                let data = response(
                    self.tvdb_get(&format!("/movies/{id}/extended"), &[], tvdb, pin)
                        .await?,
                )
                .await?;
                let mut result = parse_tvdb(id, &data["data"])?;
                result.source_url = format!("https://thetvdb.com/dereferrer/movie/{id}");
                Ok(result)
            }
            // These providers share the anime namespace for movies and series.
            "anilist" | "mal" => {
                self.video_metadata(provider, id, true, tmdb, tvdb, pin)
                    .await?;
                self.fetch_credits(provider, id, tmdb, tvdb, pin).await
            }
            _ => Err("Unsupported credits provider".into()),
        }
    }
}
fn parse_movie_credits(id: &str, mut data: Value) -> Result<CreditSource, String> {
    data["name"] = data["title"].clone();
    let mut credits = data["credits"].clone();
    for category in ["cast", "crew"] {
        let rows = credits[category]
            .as_array_mut()
            .ok_or("TMDB credits missing")?;
        for p in rows {
            if category == "cast" {
                p["roles"] = json!([{"character":p["character"]}]);
            } else {
                p["jobs"] = json!([{"job":p["job"]}]);
            }
        }
    }
    data["aggregate_credits"] = credits;
    let mut result = parse_tmdb(id, &data)?;
    result.source_url = format!("https://www.themoviedb.org/movie/{id}");
    Ok(result)
}

fn parse(
    provider: &str,
    id: &str,
    movie: bool,
    data: &Value,
) -> Result<FetchedVideoMetadata, String> {
    let mut out = FetchedVideoMetadata::default();
    if !data.is_object() {
        return Err("Provider returned no metadata".into());
    }
    out.ids.insert(provider.into(), id.into());
    match provider {
        "tmdb" => {
            if text(&data[if movie { "title" } else { "name" }]).is_none() {
                return Err("Provider title is missing".into());
            }
            for (key, raw) in [
                ("summary", "overview"),
                (
                    "original_title",
                    if movie {
                        "original_title"
                    } else {
                        "original_name"
                    },
                ),
                ("tagline", "tagline"),
                ("status", "status"),
                ("language", "original_language"),
                (
                    "premiered",
                    if movie {
                        "release_date"
                    } else {
                        "first_air_date"
                    },
                ),
                ("end_date", "last_air_date"),
            ] {
                put(&mut out, key, clean(&data[raw]));
            }
            put(
                &mut out,
                "year",
                year(
                    &data[if movie {
                        "release_date"
                    } else {
                        "first_air_date"
                    }],
                ),
            );
            for (key, value) in [
                ("genres", names(&data["genres"])),
                (
                    "tags",
                    names(&data["keywords"][if movie { "keywords" } else { "results" }]),
                ),
                ("studios", names(&data["production_companies"])),
                ("countries", names(&data["production_countries"])),
                (
                    "runtime_minutes",
                    if movie {
                        data["runtime"].clone()
                    } else {
                        data["episode_run_time"][0].clone()
                    },
                ),
            ] {
                put(&mut out, key, value);
            }
            // Only use a known territory's certification; never mix regional schemes.
            if movie {
                if let Some(us) = data["release_dates"]["results"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|r| r["iso_3166_1"] == "US")
                {
                    if let Some(cert) = us["release_dates"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .find_map(|r| text(&r["certification"]))
                    {
                        put(&mut out, "content_rating", json!(cert));
                    }
                }
            } else if let Some(us) = data["content_ratings"]["results"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|r| r["iso_3166_1"] == "US")
            {
                put(&mut out, "content_rating", us["rating"].clone());
            }
            for (provider, key) in [("imdb", "imdb_id"), ("tvdb", "tvdb_id")] {
                link_id(&mut out, provider, &data["external_ids"][key]);
            }
            link_id(&mut out, "imdb", &data["imdb_id"]);
            let trailers = data["videos"]["results"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|v| v["site"] == "YouTube" && v["type"] == "Trailer")
                .filter_map(|v| text(&v["key"]))
                .filter(|s| {
                    s.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                })
                .map(|id| format!("https://www.youtube.com/watch?v={id}"))
                .collect::<Vec<_>>();
            put(&mut out, "trailers", json!(trailers));
            if data["vote_count"].as_u64().is_some_and(|n| n > 0) {
                put(&mut out, "rating", data["vote_average"].clone());
            }
        }
        "anilist" => {
            if text(&data["format"]).is_none() || (data["format"] == "MOVIE") != movie {
                return Err(
                    "AniList match has a different media type; review Provider matching.".into(),
                );
            }
            put(&mut out, "summary", clean(&data["description"]));
            put(&mut out, "original_title", data["title"]["native"].clone());
            put(&mut out, "year", data["startDate"]["year"].clone());
            put(&mut out, "genres", data["genres"].clone());
            put(
                &mut out,
                "tags",
                json!(
                    data["tags"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|t| t["isMediaSpoiler"] != true && t["isGeneralSpoiler"] != true)
                        .filter_map(|t| text(&t["name"]))
                        .collect::<Vec<_>>()
                ),
            );
            put(&mut out, "studios", names(&data["studios"]["nodes"]));
            put(&mut out, "runtime_minutes", data["duration"].clone());
            put(&mut out, "status", data["status"].clone());
            if let Some(country) = text(&data["countryOfOrigin"]) {
                put(&mut out, "countries", json!([country]));
            }
            link_id(&mut out, "mal", &data["idMal"]);
            for (field, date) in [("premiered", "startDate"), ("end_date", "endDate")] {
                if let (Some(y), Some(m), Some(d)) = (
                    data[date]["year"].as_u64(),
                    data[date]["month"].as_u64(),
                    data[date]["day"].as_u64(),
                ) {
                    put(&mut out, field, json!(format!("{y:04}-{m:02}-{d:02}")));
                }
            }
        }
        "mal" => {
            if text(&data["type"]).is_none() || (data["type"] == "Movie") != movie {
                return Err(
                    "MyAnimeList match has a different media type; review Provider matching."
                        .into(),
                );
            }
            put(&mut out, "summary", clean(&data["synopsis"]));
            put(&mut out, "original_title", data["title_japanese"].clone());
            put(
                &mut out,
                "year",
                data["aired"]["prop"]["from"]["year"].clone(),
            );
            put(&mut out, "genres", names(&data["genres"]));
            put(&mut out, "tags", names(&data["themes"]));
            put(&mut out, "studios", names(&data["studios"]));
            put(&mut out, "status", data["status"].clone());
            // MAL advisory text isn't a regional certification; retain it separately.
            put(&mut out, "content_advisory", data["rating"].clone());
            put(&mut out, "premiered", data["aired"]["from"].clone());
        }
        "tvdb" => {
            if text(&data["name"]).is_none() {
                return Err("TheTVDB title missing".into());
            }
            put(&mut out, "summary", clean(&data["overview"]));
            put(
                &mut out,
                "year",
                data["year"]
                    .as_str()
                    .and_then(|s| s.parse::<i64>().ok())
                    .map_or_else(|| data["year"].clone(), |y| json!(y)),
            );
            put(&mut out, "genres", names(&data["genres"]));
            put(&mut out, "studios", names(&data["companies"]["production"]));
            put(&mut out, "runtime_minutes", data["runtime"].clone());
            put(&mut out, "language", data["originalLanguage"].clone());
            put(&mut out, "status", data["status"]["name"].clone());
            put(&mut out, "premiered", data["firstAired"].clone());
            if let Some(us) = data["contentRatings"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|r| r["country"] == "usa" || r["country"] == "US")
            {
                put(&mut out, "content_rating", us["name"].clone());
            }
            for remote in data["remoteIds"].as_array().into_iter().flatten() {
                match text(&remote["sourceName"])
                    .unwrap_or_default()
                    .to_lowercase()
                    .as_str()
                {
                    "imdb" => link_id(&mut out, "imdb", &remote["id"]),
                    "themoviedb.com" | "themoviedb.com - movies" | "themoviedb.com - tv" => {
                        link_id(&mut out, "tmdb", &remote["id"])
                    }
                    _ => {}
                }
            }
        }
        _ => return Err("Unsupported provider".into()),
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn movie_credits_keep_movie_links_roles_and_unknown_performance_languages() {
        let data = json!({"title":"Film","original_language":"en","credits":{"cast":[{"id":1,"name":"Actor","character":"Hero","order":0}],"crew":[{"id":2,"name":"Person","job":"Director"}]}});
        let source = parse_movie_credits("123", data).unwrap();
        assert_eq!(source.credits.len(), 2);
        assert_eq!(source.source_url, "https://www.themoviedb.org/movie/123");
        assert!(source.credits[0].language.is_none());
        assert_eq!(source.credits[1].role, "Director");
    }
    #[test]
    fn movie_metadata_normalizes_fields_and_uses_us_certification() {
        let data = json!({"title":"Film","overview":"A<br>story","release_date":"2020-05-02","genres":[{"name":"Drama"}],"production_companies":[{"name":"Studio"}],"keywords":{"keywords":[{"name":"Mystery"}]},"external_ids":{"imdb_id":"tt0000001"},"release_dates":{"results":[{"iso_3166_1":"GB","release_dates":[{"certification":"15"}]},{"iso_3166_1":"US","release_dates":[{"certification":"PG-13"}]}]},"runtime":123});
        let out = parse("tmdb", "1", true, &data).unwrap();
        assert_eq!(out.fields["year"], 2020);
        assert_eq!(out.fields["summary"], "A\nstory");
        assert_eq!(out.fields["content_rating"], "PG-13");
        assert_eq!(out.fields["tags"], json!(["Mystery"]));
        assert_eq!(out.ids["imdb"], "tt0000001");
    }
    #[test]
    fn anime_matches_reject_wrong_type_and_omit_spoiler_tags() {
        let data = json!({"format":"MOVIE","genres":["Action"],"tags":[{"name":"Safe","isMediaSpoiler":false,"isGeneralSpoiler":false},{"name":"Spoiler","isMediaSpoiler":true}],"idMal":123});
        assert!(parse("anilist", "1", false, &data).is_err());
        let out = parse("anilist", "1", true, &data).unwrap();
        assert_eq!(out.fields["tags"], json!(["Safe"]));
        assert_eq!(out.ids["mal"], "123");
    }
}
