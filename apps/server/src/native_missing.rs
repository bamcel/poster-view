use crate::AppState;
use posterview_contracts::native::{NativeCatalogEntry, NativeLibrary};
use posterview_infra_sqlite::ServerStore;
use serde_json::{Value, json};
fn number(v: &Value) -> Option<u64> {
    v.as_u64().or_else(|| v.as_str()?.parse().ok())
}
fn timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn blank(
    path: String,
    kind: &str,
    parent: String,
    title: String,
    metadata: Value,
) -> NativeCatalogEntry {
    NativeCatalogEntry {
        id: String::new(),
        path,
        kind: kind.into(),
        parent_path: Some(parent),
        title,
        metadata,
        artwork: vec![],
        files: vec![],
        nfo_path: None,
        nfo_xml: None,
        available: true,
        revision: 1,
    }
}
pub(crate) fn arrived(entries: &[NativeCatalogEntry], missing: &NativeCatalogEntry) -> bool {
    entries
        .iter()
        .filter(|e| e.kind == missing.kind && e.metadata["missing"] != true)
        .any(|actual| {
            if missing.kind == "book" {
                return actual.parent_path == missing.parent_path
                    && ((number(&missing.metadata["volume"]).is_some()
                        && number(&actual.metadata["volume"])
                            == number(&missing.metadata["volume"]))
                        || (number(&missing.metadata["chapter"]).is_some()
                            && number(&actual.metadata["chapter"])
                                == number(&missing.metadata["chapter"])));
            }
            if missing.kind == "season" {
                return actual.parent_path == missing.parent_path
                    && number(&actual.metadata["season"]) == number(&missing.metadata["season"]);
            }
            if missing.kind != "episode" {
                return false;
            }
            let root = entries
                .iter()
                .filter(|e| e.kind == "series" && missing.path.starts_with(&format!("{}/", e.path)))
                .max_by_key(|e| e.path.len());
            root.is_some_and(|root| actual.path.starts_with(&format!("{}/", root.path)))
                && number(&actual.metadata["season"]) == number(&missing.metadata["season"])
                && number(&actual.metadata["episode"]) == number(&missing.metadata["episode"])
        })
}
pub(crate) fn reconcile(
    entries: &mut Vec<NativeCatalogEntry>,
    series: &NativeCatalogEntry,
    expected: &[Value],
) {
    let old = entries
        .iter()
        .filter(|e| {
            e.path.starts_with(&format!("{}/", series.path)) && e.metadata["missing"] == true
        })
        .cloned()
        .collect::<Vec<_>>();
    entries.retain(|e| {
        !(e.path.starts_with(&format!("{}/", series.path)) && e.metadata["missing"] == true)
    });
    let today = chrono::Utc::now().date_naive();
    let mut seen=std::collections::BTreeSet::new();
    for episode in expected {
        let (Some(season), Some(n)) = (number(&episode["season"]), number(&episode["episode"]))
        else {
            continue;
        };
        if n == 0 || n > 10000 || season > 1000 || !seen.insert((season,n)) {
            continue;
        }
        let date = episode["aired"]
            .as_str()
            .and_then(|d| d.get(..10))
            .and_then(|d| chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").ok());
        if date.is_none_or(|d| d > today) {
            continue;
        }
        let actual = entries.iter().filter(|e| {
            e.kind == "episode"
                && e.metadata["missing"] != true
                && (e.path.starts_with(&format!("{}/", series.path)))
        });
        if actual.clone().any(|e| {
            episode["identifiers"]
                .as_object()
                .into_iter()
                .flatten()
                .any(|(p, id)| !id.is_null() && e.metadata["identifiers"][p] == *id)
        }) || actual.clone().any(|e| {
            number(&e.metadata["season"]) == Some(season)
                && number(&e.metadata["episode"]) == Some(n)
        }) {
            continue;
        }
        let parent = if let Some(s) = entries.iter().find(|e| {
            e.kind == "season"
                && e.parent_path.as_deref() == Some(&series.path)
                && number(&e.metadata["season"]) == Some(season)
        }) {
            s.path.clone()
        } else {
            let path = format!("{}/@missing-season-{season}", series.path);
            let mut placeholder = blank(
                path.clone(),
                "season",
                series.path.clone(),
                if season == 0 {
                    "Specials".into()
                } else {
                    format!("Season {season}")
                },
                json!({"season":season,"missing":true}),
            );
            if let Some(previous) = old.iter().find(|e| e.path == path) {
                placeholder.artwork = previous.artwork.clone();
                placeholder.id = previous.id.clone();
            }
            entries.push(placeholder);
            path
        };
        let path = format!("{parent}/@missing-episode-{n}");
        let mut metadata = episode.clone();
        metadata["missing"] = json!(true);
        let mut placeholder = blank(
            path.clone(),
            "episode",
            parent,
            episode["title"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| format!("Episode {n}")),
            metadata,
        );
        if let Some(previous) = old.iter().find(|e| {
            number(&e.metadata["season"]) == Some(season)
                && number(&e.metadata["episode"]) == Some(n)
                && e.kind == "episode"
        }) {
            placeholder.artwork = previous.artwork.clone();
            placeholder.id = previous.id.clone();
        }
        entries.push(placeholder);
    }
}
fn tvdb_episode_path(id: &str, language: &str) -> String {
    format!("/series/{id}/episodes/official/{}", crate::native_provider_extra::lang(language))
}
fn cache_identity(provider: &str, id: &str, language: &str) -> String {
    format!("{provider}:{id}:{language}:translated-v1")
}
async fn fetch(
    state: &AppState,
    lib: &NativeLibrary,
    series: &NativeCatalogEntry,
    provider: &str,
    id: &str,
) -> Result<Vec<Value>, String> {
    let store = ServerStore::new(state.runtime.data_dir());
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let mut episodes = Vec::new();
    if provider == "tvdb" {
        let service = posterview_infra_artwork::ArtworkService::default();
        let key = store.get_setting("tvdb_api_key").unwrap_or_default();
        let pin = store.get_setting("tvdb_pin").unwrap_or_default();
        if key.is_empty() {
            return Err("Configure TheTVDB credentials to discover missing episodes.".into());
        }
        for page in 0..100 {
            let _network = crate::workers::network().await;
            let raw = crate::native_provider::response(
                service
                    .native_tvdb_get(
                        &tvdb_episode_path(id, &lib.options.metadata_language),
                        &[("page", &page.to_string())],
                        &key,
                        &pin,
                    )
                    .await?,
            )
            .await?;
            let list = raw["data"]["episodes"]
                .as_array()
                .ok_or("Invalid TheTVDB episode list.")?;
            for e in list {
                episodes.push(json!({"season":e["seasonNumber"],"episode":e["number"],"title":e["name"],"plot":e["overview"],"aired":e["aired"],"runtime":e["runtime"],"identifiers":{"tvdb":number(&e["id"]).map(|v|v.to_string())},"expected_thumb_url":e["image"]}));
            }
            if raw["links"]["next"].is_null() || list.is_empty() {
                break;
            }
            if page == 99 {
                return Err("TheTVDB episode pagination exceeded its limit.".into());
            }
        }
    } else {
        let token = store.get_setting("tmdb_access_token").unwrap_or_default();
        if token.is_empty() {
            return Err("Configure TMDB credentials to discover missing episodes.".into());
        }
        let request = |path: String| {
            let r = client
                .get(format!("https://api.themoviedb.org/3/{path}"))
                .query(&[("language", lib.options.metadata_language.as_str())]);
            if token.len() == 32 {
                r.query(&[("api_key", &token)])
            } else {
                r.bearer_auth(&token)
            }
        };
        let raw = {
            let _network = crate::workers::network().await;
            crate::native_provider::response(
                request(format!("tv/{id}"))
                    .send()
                    .await
                    .map_err(|e| e.to_string())?,
            )
            .await?
        };
        let seasons = raw["seasons"]
            .as_array()
            .ok_or("Invalid TMDB season list.")?;
        if seasons.len() > 100 {
            return Err("TMDB series exceeds the season limit.".into());
        }
        for season in seasons {
            let Some(s) = number(&season["season_number"]) else {
                continue;
            };
            let _network = crate::workers::network().await;
            let raw = crate::native_provider::response(
                request(format!("tv/{id}/season/{s}"))
                    .send()
                    .await
                    .map_err(|e| e.to_string())?,
            )
            .await?;
            for e in raw["episodes"].as_array().into_iter().flatten() {
                episodes.push(json!({"season":e["season_number"],"episode":e["episode_number"],"title":e["name"],"plot":e["overview"],"aired":e["air_date"],"runtime":e["runtime"],"identifiers":{"tmdb":number(&e["id"]).map(|v|v.to_string())},"expected_thumb_url":e["still_path"].as_str().map(|p|format!("https://image.tmdb.org/t/p/w780{p}"))}));
            }
        }
    }
    if episodes.len() > 10000 {
        return Err(format!(
            "{} exceeds the expected episode limit.",
            series.title
        ));
    }
    Ok(episodes)
}
pub(crate) async fn reconcile_library(
    state: &AppState,
    lib: &NativeLibrary,
    entries: &mut Vec<NativeCatalogEntry>,
    network: bool,
    warnings: &mut Vec<String>,
) {
    if !lib.options.show_missing_files {
        return;
    }
    let store = ServerStore::new(state.runtime.data_dir());
    let series = entries
        .iter()
        .filter(|e| e.kind == "series" && e.metadata["_scan_unchanged"] != true)
        .cloned()
        .collect::<Vec<_>>();
    for series in series {
        let mut providers = lib
            .options
            .metadata_providers
            .get("series")
            .cloned()
            .unwrap_or_else(|| vec!["tvdb".into(), "tmdb".into()]);
        providers.sort_by_key(|p|store.get_setting(if p=="tvdb" {"tvdb_api_key"}else{"tmdb_access_token"}).unwrap_or_default().is_empty());
        let Some((provider, id)) = providers
            .iter()
            .filter(|p| ["tvdb", "tmdb"].contains(&p.as_str()))
            .find_map(|p| {
                number(&series.metadata["identifiers"][p])
                    .filter(|id| *id > 0)
                    .map(|id| (p.clone(), id.to_string()))
            })
        else {
            continue;
        };
        let identity = cache_identity(&provider, &id, &lib.options.metadata_language);
        let key = format!("expected-episodes:{}:{}", lib.id, series.path);
        let cached = store
            .get_setting(&key)
            .ok()
            .and_then(|v| serde_json::from_str::<Value>(&v).ok())
            .filter(|v| v["identity"] == identity);
        let fresh = cached
            .as_ref()
            .is_some_and(|v| timestamp().saturating_sub(v["at"].as_u64().unwrap_or(0)) < 86400);
        let mut expected = cached
            .as_ref()
            .and_then(|v| v["episodes"].as_array())
            .cloned();
        if network && !fresh && lib.options.fetch_missing {
            match fetch(state, lib, &series, &provider, &id).await {
                Ok(episodes) => {
                    if let Err(e) = store.set_setting(
                        &key,
                        &json!({"identity":identity,"at":timestamp(),"episodes":episodes})
                            .to_string(),
                    ) {
                        warnings.push(e.to_string());
                    }
                    expected = Some(episodes);
                }
                Err(e) => {
                    warnings.push(format!("{}: missing episode discovery: {e}", series.title))
                }
            }
        }
        if let Some(expected) = expected {
            reconcile(entries, &series, &expected);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn episode_discovery_uses_preferred_language_and_invalidates_untranslated_cache() {
        assert_eq!(tvdb_episode_path("123", "en"), "/series/123/episodes/official/eng");
        assert_eq!(tvdb_episode_path("123", "ja"), "/series/123/episodes/official/jpn");
        assert_ne!(cache_identity("tvdb", "123", "en"), "tvdb:123");
        assert_ne!(cache_identity("tvdb", "123", "en"), cache_identity("tvdb", "123", "ja"));
    }
    fn series() -> NativeCatalogEntry {
        blank(
            "Shows/Test".into(),
            "series",
            "Shows".into(),
            "Test".into(),
            json!({}),
        )
    }
    #[test]
    fn aired_missing_episodes_are_grouped_and_real_arrivals_keep_artwork() {
        let series = series();
        let season = blank(
            "Shows/Test/Season 1".into(),
            "season",
            series.path.clone(),
            "Season 1".into(),
            json!({"season":1}),
        );
        let actual = blank(
            "Shows/Test/Season 1/S01E01.mkv".into(),
            "episode",
            season.path.clone(),
            "One".into(),
            json!({"season":1,"episode":1}),
        );
        let expected = vec![
            json!({"season":1,"episode":1,"title":"One","aired":"2020-01-01","identifiers":{"tvdb":"1"}}),
            json!({"season":1,"episode":2,"title":"Two","aired":"2020-01-02","identifiers":{"tvdb":"2"}}),
            json!({"season":0,"episode":1,"title":"Special","aired":"2020-01-01"}),
            json!({"season":1,"episode":3,"title":"Future","aired":"2999-01-01"}),
            json!({"season":1,"episode":4,"title":"Unknown date"}),
        ];
        let mut entries = vec![series.clone(), season.clone(), actual];
        reconcile(&mut entries, &series, &expected);
        assert_eq!(
            entries
                .iter()
                .filter(|e| e.kind == "episode" && e.metadata["missing"] == true)
                .count(),
            2
        );
        assert!(
            entries
                .iter()
                .any(|e| e.kind == "season" && e.metadata["season"] == 0)
        );
        let missing = entries.iter_mut().find(|e| e.title == "Two").unwrap();
        missing
            .artwork
            .push(posterview_contracts::native::NativeArtwork {
                kind: "thumb".into(),
                path: "@managed/two.jpg".into(),
                source: "manual".into(),
            });
        reconcile(&mut entries, &series, &expected);
        assert_eq!(
            entries
                .iter()
                .find(|e| e.title == "Two")
                .unwrap()
                .artwork
                .len(),
            1
        );
        let temp = tempfile::tempdir().unwrap();
        let db = ServerStore::new(temp.path());
        db.initialize().unwrap();
        let lib = db
            .save_native_library(
                None,
                &posterview_contracts::native::NativeLibraryInput {
                    name: "Shows".into(),
                    library_type: posterview_contracts::native::NativeLibraryType::Shows,
                    anime_content: posterview_contracts::native::AnimeContent::Both,
                    paths: vec!["Shows".into()],
                    revision: None,
                    options: Default::default(),
                },
            )
            .unwrap();
        db.ingest_native_catalog(&lib.id, lib.revision, &entries)
            .unwrap();
        let before = db
            .native_catalog(&lib.id)
            .unwrap()
            .into_iter()
            .find(|e| e.title == "Two")
            .unwrap();
        db.save_native_artwork(&lib.id,&before.id,&before.artwork[0]).unwrap();
        let arriving = blank(
            "Shows/Test/Season 1/S01E02.mkv".into(),
            "episode",
            season.path,
            "Two".into(),
            json!({"season":1,"episode":2}),
        );
        assert!(arrived(&[series.clone(), arriving.clone()], &before));
        entries.push(arriving);
        reconcile(&mut entries, &series, &expected);
        db.ingest_native_catalog(&lib.id, lib.revision, &entries)
            .unwrap();
        let after = db
            .native_catalog(&lib.id)
            .unwrap()
            .into_iter()
            .find(|e| e.path.ends_with("S01E02.mkv"))
            .unwrap();
        assert_eq!(after.id, before.id);
        assert_ne!(after.metadata["missing"], true);
        assert_eq!(after.artwork[0].path, "@managed/two.jpg");
    }
}
