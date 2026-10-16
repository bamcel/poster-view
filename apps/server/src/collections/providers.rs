//! Collection lookups use the providers' documented collection/list endpoints.
//! TVDB has no documented fuzzy list search: its exact slug lookup is deliberate.
use super::MetadataCandidate;
use crate::{AppState, HttpError};
use posterview_infra_artwork::ArtworkService;
use posterview_infra_sqlite::ServerStore;
use posterview_url_security::provider_https;
use serde_json::Value;
use std::time::Duration;

pub(super) struct ProviderDetails {
    pub metadata: MetadataCandidate,
    pub members: Vec<ProviderMember>,
}
pub(super) struct ProviderMember {
    pub kind: String,
    pub provider_id: String,
}

fn validate_provider(provider: &str) -> Result<(), HttpError> {
    if matches!(provider, "tmdb" | "tvdb") {
        Ok(())
    } else {
        Err(HttpError::bad_request("Choose TMDB or TheTVDB."))
    }
}
fn numeric_id(id: &str) -> Option<String> {
    if id.is_empty() || id.len() > 19 || !id.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    id.parse::<u64>()
        .ok()
        .filter(|id| *id > 0)
        .map(|id| id.to_string())
}
fn record_id(value: &Value) -> Option<String> {
    value
        .as_str()
        .and_then(numeric_id)
        .or_else(|| value.as_u64().filter(|id| *id > 0).map(|id| id.to_string()))
}
fn key(state: &AppState, name: &str) -> Result<String, HttpError> {
    ServerStore::new(state.runtime.data_dir())
        .get_setting(name)
        .map_err(|_| HttpError::bad_gateway("Could not read provider credentials."))
}
fn credential(state: &AppState, provider: &str) -> Result<String, HttpError> {
    let value = key(
        state,
        if provider == "tmdb" {
            "tmdb_access_token"
        } else {
            "tvdb_api_key"
        },
    )?;
    if value.trim().is_empty() {
        return Err(HttpError::bad_request(
            "Configure the selected provider in Search Providers first.",
        ));
    }
    Ok(value)
}
fn image(provider: &str, value: &Value) -> String {
    let Some(raw) = value.as_str().filter(|s| !s.is_empty()) else {
        return String::new();
    };
    let url = if provider == "tmdb" {
        if !raw.starts_with('/')
            || raw.starts_with("//")
            || raw.contains(['?', '#', '\\'])
            || raw.split('/').any(|s| s == "..")
        {
            return String::new();
        }
        format!("https://image.tmdb.org/t/p/original{raw}")
    } else if raw.starts_with("/banners/") {
        format!("https://artworks.thetvdb.com{raw}")
    } else {
        raw.to_owned()
    };
    let host = if provider == "tmdb" {
        "image.tmdb.org"
    } else {
        "artworks.thetvdb.com"
    };
    provider_https(&url, &[host])
        .ok()
        .filter(|u| {
            u.host_str() == Some(host)
                && u.port_or_known_default() == Some(443)
                && u.query().is_none()
                && u.fragment().is_none()
        })
        .map(|u| u.to_string())
        .unwrap_or_default()
}
fn candidate(provider: &str, raw: &Value) -> Option<MetadataCandidate> {
    let id = record_id(&raw["id"])?;
    let title = raw["name"].as_str()?.trim();
    if title.is_empty() {
        return None;
    }
    Some(MetadataCandidate {
        provider: provider.into(),
        provider_id: id,
        title: title.chars().take(120).collect(),
        overview: raw["overview"]
            .as_str()
            .unwrap_or_default()
            .chars()
            .take(4000)
            .collect(),
        poster_url: image(
            provider,
            &raw[if provider == "tmdb" {
                "poster_path"
            } else {
                "image"
            }],
        ),
        backdrop_url: if provider == "tmdb" {
            image(provider, &raw["backdrop_path"])
        } else {
            String::new()
        },
    })
}
async fn response(response: reqwest::Response) -> Result<Value, HttpError> {
    crate::native_provider::response(response)
        .await
        .map_err(HttpError::bad_gateway)
}
fn client() -> Result<reqwest::Client, HttpError> {
    reqwest::Client::builder()
        .user_agent("PosterView/0.1")
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| HttpError::bad_gateway("Could not initialize metadata connection."))
}
async fn tmdb(state: &AppState, path: &str, query: &[(&str, &str)]) -> Result<Value, HttpError> {
    let token = credential(state, "tmdb")?;
    let mut request = client()?
        .get(format!("https://api.themoviedb.org/3{path}"))
        .query(query);
    request = if token.len() == 32 {
        request.query(&[("api_key", &token)])
    } else {
        request.bearer_auth(token)
    };
    response(
        request
            .send()
            .await
            .map_err(|_| HttpError::bad_gateway("TMDB connection failed."))?,
    )
    .await
}
async fn tvdb(
    state: &AppState,
    service: &ArtworkService,
    path: &str,
    missing_ok: bool,
) -> Result<Option<Value>, HttpError> {
    let token = credential(state, "tvdb")?;
    let pin = key(state, "tvdb_pin")?;
    // Reuse TVDB authentication, token refresh, and trusted redirect policy.
    tokio::time::timeout(Duration::from_secs(25), async {
        let res = service
            .native_tvdb_get(path, &[], &token, &pin)
            .await
            .map_err(|_| HttpError::bad_gateway("TheTVDB connection or authentication failed."))?;
        if missing_ok && res.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        response(res).await.map(Some)
    })
    .await
    .map_err(|_| HttpError::bad_gateway("TheTVDB request timed out."))?
}
fn tvdb_slug(query: &str) -> Result<String, HttpError> {
    if query.len() > 200
        || query
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\' | '?' | '#' | '%'))
    {
        return Err(HttpError::bad_request(
            "Enter a TheTVDB list name, slug, or numeric ID.",
        ));
    }
    let slug = query
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
        .to_lowercase();
    if slug.is_empty()
        || !slug
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_'))
    {
        return Err(HttpError::bad_request(
            "Enter an exact TheTVDB list slug or numeric ID.",
        ));
    }
    Ok(slug)
}

pub(super) async fn search(
    state: &AppState,
    provider: &str,
    query: &str,
) -> Result<Vec<MetadataCandidate>, HttpError> {
    validate_provider(provider)?;
    let query = query.trim();
    if query.is_empty() || query.len() > 200 || query.chars().any(char::is_control) {
        return Err(HttpError::bad_request(
            "Enter a collection search of 1–200 characters.",
        ));
    }
    let _provider = crate::workers::provider(provider).await;
    let _network = crate::workers::network().await;
    if provider == "tmdb" {
        let body = tmdb(
            state,
            "/search/collection",
            &[
                ("query", query),
                ("include_adult", "false"),
                ("language", "en-US"),
            ],
        )
        .await?;
        let records = body["results"]
            .as_array()
            .ok_or_else(|| HttpError::bad_gateway("TMDB returned invalid collection results."))?;
        Ok(records
            .iter()
            .filter_map(|v| candidate(provider, v))
            .take(30)
            .collect())
    } else {
        let path = match numeric_id(query) {
            Some(id) => format!("/lists/{id}"),
            None => format!("/lists/slug/{}", tvdb_slug(query)?),
        };
        let service = ArtworkService::default();
        let Some(body) = tvdb(state, &service, &path, true).await? else {
            return Ok(Vec::new());
        };
        Ok(candidate(provider, &body["data"]).into_iter().collect())
    }
}

fn members(provider: &str, raw: &Value) -> Vec<ProviderMember> {
    let mut rows = raw[if provider == "tmdb" {
        "parts"
    } else {
        "entities"
    }]
    .as_array()
    .cloned()
    .unwrap_or_default();
    if provider == "tvdb" {
        rows.sort_by_key(|row| row["order"].as_i64().unwrap_or(i64::MAX));
    }
    let mut seen = std::collections::BTreeSet::new();
    rows.iter()
        .flat_map(|row| {
            if provider == "tmdb" {
                vec![("movie", record_id(&row["id"]))]
            } else {
                vec![
                    ("movie", record_id(&row["movieId"])),
                    ("series", record_id(&row["seriesId"])),
                ]
            }
        })
        .filter_map(|(kind, id)| id.map(|id| (kind.to_owned(), id)))
        .filter(|pair| seen.insert(pair.clone()))
        .map(|(kind, provider_id)| ProviderMember { kind, provider_id })
        .take(5000)
        .collect()
}

pub(super) async fn details(
    state: &AppState,
    provider: &str,
    id: &str,
) -> Result<ProviderDetails, HttpError> {
    validate_provider(provider)?;
    let id = numeric_id(id)
        .ok_or_else(|| HttpError::bad_request("Enter a positive numeric collection ID."))?;
    let _provider = crate::workers::provider(provider).await;
    let _network = crate::workers::network().await;
    let service = ArtworkService::default();
    let mut raw = if provider == "tmdb" {
        tmdb(
            state,
            &format!("/collection/{id}"),
            &[("language", "en-US")],
        )
        .await?
    } else {
        tvdb(state, &service, &format!("/lists/{id}/extended"), false)
            .await?
            .unwrap_or(Value::Null)["data"]
            .clone()
    };
    if provider == "tvdb" {
        // Translation records are documented as an array; tolerate object form too.
        if let Ok(Some(translated)) = tvdb(
            state,
            &service,
            &format!("/lists/{id}/translations/eng"),
            true,
        )
        .await
        {
            let translated = translated["data"]
                .as_array()
                .and_then(|rows| rows.first())
                .unwrap_or(&translated["data"]);
            for field in ["name", "overview"] {
                if let Some(value) = translated[field].as_str().filter(|v| !v.trim().is_empty()) {
                    raw[field] = Value::String(value.into());
                }
            }
        }
    }
    let metadata = candidate(provider, &raw)
        .filter(|v| v.provider_id == id)
        .ok_or_else(|| {
            HttpError::bad_gateway("The provider returned invalid collection details.")
        })?;
    Ok(ProviderDetails {
        metadata,
        members: members(provider, &raw),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn provider_ids_and_slugs_cannot_inject_paths() {
        assert!(validate_provider("tmdb").is_ok());
        assert!(validate_provider("http://localhost").is_err());
        for id in ["", "0", "../1", "1?x=2", "-1", "18446744073709551616"] {
            assert!(numeric_id(id).is_none());
        }
        assert_eq!(tvdb_slug("Star Wars").unwrap(), "star-wars");
        for value in ["../lists", "evil?token=1", "%2fprivate", "\\server"] {
            assert!(tvdb_slug(value).is_err());
        }
    }
    #[test]
    fn candidates_only_expose_trusted_provider_images() {
        let movie=candidate("tmdb",&json!({"id":10,"name":"Saga","poster_path":"/poster.jpg","backdrop_path":"//evil.test/a"})).unwrap();
        assert_eq!(
            movie.poster_url,
            "https://image.tmdb.org/t/p/original/poster.jpg"
        );
        assert!(movie.backdrop_url.is_empty());
        for url in [
            "http://artworks.thetvdb.com/a.jpg",
            "https://evil.artworks.thetvdb.com/a.jpg",
            "https://user:pass@artworks.thetvdb.com/a.jpg",
            "https://artworks.thetvdb.com:9443/a.jpg",
            "https://localhost/a.jpg",
        ] {
            assert!(image("tvdb", &json!(url)).is_empty());
        }
        assert_eq!(
            image("tvdb", &json!("/banners/a.jpg")),
            "https://artworks.thetvdb.com/banners/a.jpg"
        );
    }
    #[test]
    fn list_entities_keep_provider_order_and_deduplicate_movies_and_series() {
        let found = members(
            "tvdb",
            &json!({"entities":[{"order":2,"seriesId":9},{"order":1,"movieId":5},{"order":3,"movieId":5},{"order":4,"movieId":0}]}),
        );
        assert_eq!(found.len(), 2);
        assert_eq!((&*found[0].kind, &*found[0].provider_id), ("movie", "5"));
        assert_eq!((&*found[1].kind, &*found[1].provider_id), ("series", "9"));
        assert_eq!(
            members("tmdb", &json!({"parts":[{"id":5},{"id":5},{"id":6}]})).len(),
            2
        );
    }
}
