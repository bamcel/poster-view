use super::*;
use posterview_contracts::{EpisodeDetail, SeasonDetail};

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn people(item: &Value, kind: &str, plex: bool) -> Vec<String> {
    let mut result = item
        .get(if plex { kind } else { "People" })
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|p| {
            plex || p
                .get("Type")
                .and_then(Value::as_str)
                .is_some_and(|t| t.eq_ignore_ascii_case(kind))
        })
        .filter_map(|p| text(p, if plex { "tag" } else { "Name" }))
        .collect::<Vec<_>>();
    let mut seen = HashSet::new();
    result.retain(|name| seen.insert(name.clone()));
    result
}

fn episode(item: &Value, plex: bool) -> Option<EpisodeDetail> {
    let id = item
        .get(if plex { "ratingKey" } else { "Id" })
        .and_then(value_as_string)?;
    Some(EpisodeDetail {
        id,
        title: text(item, if plex { "title" } else { "Name" })
            .unwrap_or_else(|| "Untitled episode".into()),
        index: item
            .get(if plex { "index" } else { "IndexNumber" })
            .and_then(Value::as_i64),
        index_end: item
            .get(if plex { "indexEnd" } else { "IndexNumberEnd" })
            .and_then(Value::as_i64),
        image: if plex {
            relative_ref(item.get("thumb"))
        } else {
            emby_image_ref(item, "Primary")
        },
        summary: text(item, if plex { "summary" } else { "Overview" }),
        aired: text(
            item,
            if plex {
                "originallyAvailableAt"
            } else {
                "PremiereDate"
            },
        ),
        runtime_minutes: item
            .get(if plex { "duration" } else { "RunTimeTicks" })
            .and_then(Value::as_i64)
            .filter(|duration| *duration > 0)
            .map(|duration| (duration / if plex { 60_000 } else { 600_000_000 }).max(1)),
        rating: item
            .get(if plex { "rating" } else { "CommunityRating" })
            .and_then(Value::as_f64),
        directors: people(item, "Director", plex),
        writers: people(item, "Writer", plex),
        cast: people(item, if plex { "Role" } else { "Actor" }, plex),
    })
}

pub async fn get_season_detail(
    config: ConnectionConfig<'_>,
    series_id: &str,
    season_id: &str,
) -> Result<SeasonDetail, String> {
    // Item IDs are path segments on the upstream server.
    if [series_id, season_id].iter().any(|id| {
        id.is_empty()
            || !id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
    }) {
        return Err("Invalid series or season ID.".into());
    }
    let client = media_client(&config)?;
    let plex = config.server_type == ServerType::Plex;
    let label = if config.server_type == ServerType::Jellyfin {
        "Jellyfin"
    } else {
        "Emby"
    };
    let user = if plex {
        String::new()
    } else {
        emby_user_id(&client, &config, label).await?
    };
    let item = if plex {
        let data = plex_json(&client, &config, &format!("/library/metadata/{season_id}")).await?;
        data.get("Metadata")
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .cloned()
    } else {
        Some(
            emby_json(
                &client,
                &config,
                label,
                &format!("/Users/{user}/Items/{season_id}"),
                &[],
            )
            .await?,
        )
    }
    .ok_or("Season not found.")?;
    let parent = item
        .get(if plex { "parentRatingKey" } else { "SeriesId" })
        .and_then(value_as_string);
    if item
        .get(if plex { "type" } else { "Type" })
        .and_then(Value::as_str)
        != Some(if plex { "season" } else { "Season" })
        || parent.as_deref() != Some(series_id)
        || item
            .get(if plex { "ratingKey" } else { "Id" })
            .and_then(value_as_string)
            .as_deref()
            != Some(season_id)
    {
        return Err("This season does not belong to the selected series.".into());
    }
    let mut episodes = Vec::new();
    let mut seen = HashSet::new();
    let mut start = 0usize;
    loop {
        let data = if plex {
            plex_json(&client, &config, &format!("/library/metadata/{season_id}/children?X-Plex-Container-Start={start}&X-Plex-Container-Size=200")).await?
        } else {
            emby_json(
                &client,
                &config,
                label,
                "/Items",
                &[
                    ("ParentId", season_id),
                    ("userId", &user),
                    ("IncludeItemTypes", "Episode"),
                    ("Recursive", "false"),
                    (
                        "Fields",
                        "Overview,People,PremiereDate,RunTimeTicks,CommunityRating",
                    ),
                    ("SortBy", "ParentIndexNumber,IndexNumber,SortName"),
                    ("SortOrder", "Ascending"),
                    ("StartIndex", &start.to_string()),
                    ("Limit", "200"),
                ],
            )
            .await?
        };
        let empty = Vec::new();
        let items = data
            .get(if plex { "Metadata" } else { "Items" })
            .and_then(Value::as_array)
            .or_else(|| {
                (plex && data.get("size").and_then(Value::as_u64) == Some(0)).then_some(&empty)
            })
            .ok_or("The server returned an invalid episode list.")?;
        let total = data
            .get(if plex {
                "totalSize"
            } else {
                "TotalRecordCount"
            })
            .and_then(Value::as_u64);
        let before = episodes.len();
        for value in items {
            if value
                .get(if plex { "type" } else { "Type" })
                .and_then(Value::as_str)
                .is_some_and(|t| !t.eq_ignore_ascii_case("episode"))
            {
                continue;
            }
            if let Some(episode) = episode(value, plex)
                && seen.insert(episode.id.clone())
            {
                episodes.push(episode);
            }
        }
        start += items.len();
        if items.is_empty()
            || total.is_some_and(|total| start as u64 >= total)
            || (total.is_none() && items.len() < 200)
        {
            break;
        }
        if episodes.len() == before || start >= 20_000 {
            return Err("The server could not finish paging the season's episodes.".into());
        }
    }
    episodes.sort_by_key(|episode| (episode.index.unwrap_or(i64::MAX), episode.id.clone()));
    Ok(SeasonDetail {
        id: season_id.into(),
        series_id: series_id.into(),
        title: text(&item, if plex { "title" } else { "Name" }).unwrap_or_else(|| "Season".into()),
        index: item
            .get(if plex { "index" } else { "IndexNumber" })
            .and_then(Value::as_i64),
        poster: if plex {
            relative_ref(item.get("thumb"))
        } else {
            emby_image_ref(&item, "Primary")
        },
        background: if plex {
            relative_ref(item.get("art"))
        } else {
            emby_image_ref(&item, "Backdrop")
        },
        summary: text(&item, if plex { "summary" } else { "Overview" }),
        episodes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Json, Router, extract::Query, routing::get};
    use serde_json::json;

    #[tokio::test]
    async fn emby_and_jellyfin_page_sort_and_normalize_episode_metadata() {
        let app = Router::new()
            .route("/Users", get(|| async { Json(json!([{"Id":"user"}])) }))
            .route("/Users/user/Items/season", get(|| async { Json(json!({"Id":"season","Type":"Season","SeriesId":"show","Name":"Specials","IndexNumber":0,"Overview":"Season plot","ImageTags":{"Primary":"poster"}})) }))
            .route("/Items", get(|Query(q): Query<HashMap<String,String>>| async move {
                assert_eq!(q["ParentId"], "season"); assert_eq!(q["IncludeItemTypes"], "Episode");
                let item = if q["StartIndex"] == "0" { json!({"Id":"e2","Type":"Episode","IndexNumber":2,"Name":"Second"}) } else { json!({"Id":"e1","Type":"Episode","IndexNumber":1,"IndexNumberEnd":1,"Name":"First","Overview":"Episode plot","PremiereDate":"2020-01-02T00:00:00Z","RunTimeTicks":25200000000_i64,"CommunityRating":8.5,"ImageTags":{"Primary":"still"},"People":[{"Name":"Director","Type":"Director"},{"Name":"Writer","Type":"Writer"},{"Name":"Guest","Type":"Actor"}]}) };
                Json(json!({"TotalRecordCount":2,"Items":[item]}))
            }));
        let (url, task) = crate::tests::serve(app).await;
        for server_type in [ServerType::Emby, ServerType::Jellyfin] {
            let config = ConnectionConfig {
                server_type,
                base_url: &url,
                token: "fixture",
            };
            let result = get_season_detail(config.clone(), "show", "season")
                .await
                .unwrap();
            assert_eq!(result.index, Some(0));
            assert_eq!(result.episodes.len(), 2);
            let first = &result.episodes[0];
            assert_eq!(first.title, "First");
            assert_eq!(first.runtime_minutes, Some(42));
            assert_eq!(first.rating, Some(8.5));
            assert_eq!(first.directors, vec!["Director"]);
            assert_eq!(first.writers, vec!["Writer"]);
            assert_eq!(first.cast, vec!["Guest"]);
            assert_eq!(
                first.image.as_deref(),
                Some("Items/e1/Images/Primary?tag=still")
            );
            assert!(
                get_season_detail(config, "wrong-show", "season")
                    .await
                    .is_err()
            );
        }
        task.abort();
    }

    #[tokio::test]
    async fn plex_normalizes_episode_details_and_accepts_empty_seasons() {
        let app = Router::new()
            .route("/library/metadata/season", get(|| async { Json(json!({"MediaContainer":{"Metadata":[{"ratingKey":"season","type":"season","parentRatingKey":"show","title":"Season 1","index":1,"thumb":"/season/poster","art":"/show/backdrop"}]}})) }))
            .route("/library/metadata/season/children", get(|| async { Json(json!({"MediaContainer":{"size":1,"totalSize":1,"Metadata":[{"ratingKey":"episode","type":"episode","title":"Pilot","index":1,"duration":2520000,"rating":9.0,"thumb":"/episode/still","Director":[{"tag":"Director"}],"Writer":[{"tag":"Writer"}],"Role":[{"tag":"Actor"}]}]}})) }))
            .route("/library/metadata/empty", get(|| async { Json(json!({"MediaContainer":{"Metadata":[{"ratingKey":"empty","type":"season","parentRatingKey":"show"}]}})) }))
            .route("/library/metadata/empty/children", get(|| async { Json(json!({"MediaContainer":{"size":0}})) }));
        let (url, task) = crate::tests::serve(app).await;
        let config = ConnectionConfig {
            server_type: ServerType::Plex,
            base_url: &url,
            token: "fixture",
        };
        let result = get_season_detail(config.clone(), "show", "season")
            .await
            .unwrap();
        assert_eq!(result.poster.as_deref(), Some("season/poster"));
        assert_eq!(result.episodes[0].runtime_minutes, Some(42));
        assert_eq!(result.episodes[0].cast, vec!["Actor"]);
        assert!(
            get_season_detail(config, "show", "empty")
                .await
                .unwrap()
                .episodes
                .is_empty()
        );
        task.abort();
    }
}
