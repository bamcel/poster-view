use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use chrono::{DateTime, Utc};
use posterview_contracts::{
    ItemDetail, ItemType, Library, LibraryType, MediaItem, Season, ServerType,
};
use reqwest::{Client, StatusCode};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Debug, Clone)]
pub struct ConnectionConfig<'a> {
    pub server_type: ServerType,
    pub base_url: &'a str,
    pub token: &'a str,
}

pub async fn test_connection(config: ConnectionConfig<'_>) -> Result<(String, String), String> {
    let client = Client::builder()
        .danger_accept_invalid_certs(true)
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|error| format!("Could not configure HTTP client: {error}"))?;
    match config.server_type {
        ServerType::Plex => test_plex(&client, &config).await,
        ServerType::Jellyfin => test_emby_family(&client, &config, "Jellyfin").await,
        ServerType::Emby => test_emby_family(&client, &config, "Emby").await,
    }
}

pub async fn get_libraries(config: ConnectionConfig<'_>) -> Result<Vec<Library>, String> {
    let client = Client::builder()
        .danger_accept_invalid_certs(true)
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|error| format!("Could not configure HTTP client: {error}"))?;
    match config.server_type {
        ServerType::Plex => plex_libraries(&client, &config).await,
        ServerType::Jellyfin => emby_libraries(&client, &config, "Jellyfin").await,
        ServerType::Emby => emby_libraries(&client, &config, "Emby").await,
    }
}

pub async fn get_items(
    config: ConnectionConfig<'_>,
    library_id: &str,
    group_collections: bool,
) -> Result<Vec<MediaItem>, String> {
    let client = Client::builder()
        .danger_accept_invalid_certs(true)
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|error| format!("Could not configure HTTP client: {error}"))?;
    match config.server_type {
        ServerType::Plex => plex_items(&client, &config, library_id, group_collections).await,
        ServerType::Jellyfin => {
            emby_items(&client, &config, "Jellyfin", library_id, group_collections).await
        }
        ServerType::Emby => {
            emby_items(&client, &config, "Emby", library_id, group_collections).await
        }
    }
}

pub async fn get_item_detail(
    config: ConnectionConfig<'_>,
    item_id: &str,
) -> Result<ItemDetail, String> {
    let client = Client::builder()
        .danger_accept_invalid_certs(true)
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|error| format!("Could not configure HTTP client: {error}"))?;
    match config.server_type {
        ServerType::Plex => plex_item_detail(&client, &config, item_id).await,
        ServerType::Jellyfin => emby_item_detail(&client, &config, "Jellyfin", item_id).await,
        ServerType::Emby => emby_item_detail(&client, &config, "Emby", item_id).await,
    }
}

async fn emby_item_detail(
    client: &Client,
    config: &ConnectionConfig<'_>,
    label: &str,
    item_id: &str,
) -> Result<ItemDetail, String> {
    let user_id = emby_user_id(client, config, label).await?;
    let data = emby_json(
        client,
        config,
        label,
        "/Items",
        &[
            ("Ids", item_id),
            ("userId", user_id.as_str()),
            ("IncludeItemTypes", "Movie,Series,BoxSet"),
            ("Fields", "Overview,ChildCount,ProductionYear,ProviderIds"),
        ],
    )
    .await?;
    let item = data
        .get("Items")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .ok_or_else(|| "Item not found.".to_owned())?;
    let item_type = emby_item_type(item);
    let seasons = if item_type == ItemType::Show {
        let data = emby_json(
            client,
            config,
            label,
            &format!("/Shows/{item_id}/Seasons"),
            &[("userId", user_id.as_str())],
        )
        .await?;
        data.get("Items")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|season| {
                Some(Season {
                    id: season.get("Id")?.as_str()?.to_owned(),
                    title: season
                        .get("Name")
                        .and_then(Value::as_str)
                        .unwrap_or("Season")
                        .to_owned(),
                    index: season.get("IndexNumber").and_then(Value::as_i64),
                    poster: emby_image_ref(season, "Primary"),
                    episode_count: season.get("ChildCount").and_then(Value::as_i64),
                })
            })
            .collect()
    } else {
        Vec::new()
    };
    let members = if item_type == ItemType::Collection {
        let data = emby_json(
            client,
            config,
            label,
            "/Items",
            &[
                ("ParentId", item_id),
                ("IncludeItemTypes", "Movie,Series"),
                ("Fields", "ProductionYear"),
                ("SortBy", "SortName"),
                ("SortOrder", "Ascending"),
                ("ImageTypeLimit", "1"),
                ("EnableImageTypes", "Primary"),
                ("userId", user_id.as_str()),
            ],
        )
        .await?;
        data.get("Items")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(emby_media_item)
            .collect()
    } else {
        Vec::new()
    };
    let external_ids = item
        .get("ProviderIds")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(key, value)| {
            let value = value.as_str().filter(|value| !value.is_empty())?;
            Some((key.to_lowercase(), value.to_owned()))
        })
        .collect();
    Ok(ItemDetail {
        id: item
            .get("Id")
            .and_then(Value::as_str)
            .unwrap_or(item_id)
            .to_owned(),
        title: item
            .get("Name")
            .and_then(Value::as_str)
            .unwrap_or("Untitled")
            .to_owned(),
        year: item.get("ProductionYear").and_then(Value::as_i64),
        item_type,
        poster: emby_image_ref(item, "Primary"),
        background: emby_image_ref(item, "Backdrop"),
        added_at: None,
        summary: item
            .get("Overview")
            .and_then(Value::as_str)
            .map(str::to_owned),
        season_count: (item_type == ItemType::Show)
            .then(|| item.get("ChildCount").and_then(Value::as_i64))
            .flatten(),
        seasons,
        external_ids,
        logo: emby_image_ref(item, "Logo"),
        members,
    })
}

async fn plex_item_detail(
    client: &Client,
    config: &ConnectionConfig<'_>,
    item_id: &str,
) -> Result<ItemDetail, String> {
    let data = plex_json(client, config, &format!("/library/metadata/{item_id}")).await?;
    let empty = Value::Object(serde_json::Map::new());
    let item = data
        .get("Metadata")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .unwrap_or(&empty);
    let item_type = plex_item_type(item);
    let seasons = if item_type == ItemType::Show {
        let data = plex_json(
            client,
            config,
            &format!("/library/metadata/{item_id}/children"),
        )
        .await?;
        data.get("Metadata")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|season| season.get("type").and_then(Value::as_str) == Some("season"))
            .filter_map(|season| {
                Some(Season {
                    id: value_as_string(season.get("ratingKey")?)?,
                    title: season
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("Season")
                        .to_owned(),
                    index: season.get("index").and_then(Value::as_i64),
                    poster: relative_ref(season.get("thumb")),
                    episode_count: season.get("leafCount").and_then(Value::as_i64),
                })
            })
            .collect()
    } else {
        Vec::new()
    };
    let members = if item_type == ItemType::Collection {
        let data = plex_json(
            client,
            config,
            &format!("/library/collections/{item_id}/children"),
        )
        .await?;
        data.get("Metadata")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(plex_media_item)
            .collect()
    } else {
        Vec::new()
    };
    let external_ids = item
        .get("Guid")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|guid| guid.get("id").and_then(Value::as_str))
        .filter_map(|raw| raw.split_once("://"))
        .filter(|(_, value)| !value.is_empty())
        .map(|(scheme, value)| (scheme.to_lowercase(), value.to_owned()))
        .collect::<BTreeMap<_, _>>();
    let logo = item
        .get("Image")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|image| image.get("type").and_then(Value::as_str) == Some("clearLogo"))
        .and_then(|image| relative_ref(image.get("url")));
    Ok(ItemDetail {
        id: item
            .get("ratingKey")
            .and_then(value_as_string)
            .unwrap_or_else(|| item_id.to_owned()),
        title: item
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("Untitled")
            .to_owned(),
        year: item.get("year").and_then(Value::as_i64),
        item_type,
        poster: relative_ref(item.get("thumb")),
        background: relative_ref(item.get("art")),
        added_at: None,
        summary: item
            .get("summary")
            .and_then(Value::as_str)
            .map(str::to_owned),
        season_count: (item_type == ItemType::Show)
            .then(|| item.get("childCount").and_then(Value::as_i64))
            .flatten(),
        seasons,
        external_ids,
        logo,
        members,
    })
}

pub async fn fetch_image(
    config: ConnectionConfig<'_>,
    reference: &str,
) -> Result<(Vec<u8>, String), String> {
    let client = Client::builder()
        .danger_accept_invalid_certs(true)
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|error| format!("Could not configure HTTP client: {error}"))?;
    let mut request = client.get(format!(
        "{}/{}",
        config.base_url.trim_end_matches('/'),
        reference.trim_start_matches('/')
    ));
    request = match config.server_type {
        ServerType::Plex => request.header("X-Plex-Token", config.token),
        ServerType::Jellyfin | ServerType::Emby => request.header("X-Emby-Token", config.token),
    };
    let response = request
        .send()
        .await
        .map_err(|error| format!("Image fetch failed: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Image fetch failed: {error}"))?;
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_owned();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Image fetch failed: {error}"))?;
    Ok((bytes.to_vec(), content_type))
}

pub async fn set_image(
    config: ConnectionConfig<'_>,
    item_id: &str,
    target: &str,
    data: &[u8],
    content_type: &str,
) -> Result<(), String> {
    let client = Client::builder()
        .danger_accept_invalid_certs(true)
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|error| format!("Could not configure HTTP client: {error}"))?;
    match config.server_type {
        ServerType::Plex => {
            let endpoint = match target {
                "background" => "arts",
                "logo" => "clearLogos",
                _ => "posters",
            };
            let response = client
                .post(format!(
                    "{}/library/metadata/{item_id}/{endpoint}",
                    config.base_url.trim_end_matches('/')
                ))
                .header("X-Plex-Token", config.token)
                .header(reqwest::header::CONTENT_TYPE, content_type)
                .body(data.to_vec())
                .send()
                .await
                .map_err(|error| format!("Plex upload failed: {error}"))?;
            upload_result(response, "Plex", "token").await
        }
        ServerType::Jellyfin => {
            set_emby_image(
                &client,
                &config,
                "Jellyfin",
                item_id,
                target,
                data,
                content_type,
            )
            .await
        }
        ServerType::Emby => {
            set_emby_image(
                &client,
                &config,
                "Emby",
                item_id,
                target,
                data,
                content_type,
            )
            .await
        }
    }
}

async fn set_emby_image(
    client: &Client,
    config: &ConnectionConfig<'_>,
    label: &str,
    item_id: &str,
    target: &str,
    data: &[u8],
    content_type: &str,
) -> Result<(), String> {
    let image_type = match target {
        "background" => "Backdrop",
        "logo" => "Logo",
        _ => "Primary",
    };
    if image_type == "Backdrop" {
        for _ in 0..25 {
            let response = client
                .delete(format!(
                    "{}/Items/{item_id}/Images/Backdrop/0",
                    config.base_url.trim_end_matches('/')
                ))
                .header("X-Emby-Token", config.token)
                .send()
                .await
                .map_err(|error| format!("{label} upload failed: {error}"))?;
            if !matches!(response.status(), StatusCode::OK | StatusCode::NO_CONTENT) {
                break;
            }
        }
    }
    let response = client
        .post(format!(
            "{}/Items/{item_id}/Images/{image_type}",
            config.base_url.trim_end_matches('/')
        ))
        .header("X-Emby-Token", config.token)
        .header(reqwest::header::CONTENT_TYPE, content_type)
        .body(BASE64.encode(data))
        .send()
        .await
        .map_err(|error| format!("{label} upload failed: {error}"))?;
    upload_result(response, label, "API key").await
}

async fn upload_result(
    response: reqwest::Response,
    label: &str,
    credential: &str,
) -> Result<(), String> {
    let status = response.status();
    if status == StatusCode::UNAUTHORIZED {
        return Err(format!(
            "{label} rejected the {credential} while uploading."
        ));
    }
    if status.is_client_error() || status.is_server_error() {
        let body = response.text().await.unwrap_or_default();
        let truncated = body.chars().take(200).collect::<String>();
        return Err(format!(
            "{label} upload failed ({}): {truncated}",
            status.as_u16()
        ));
    }
    Ok(())
}

async fn emby_items(
    client: &Client,
    config: &ConnectionConfig<'_>,
    label: &str,
    library_id: &str,
    group_collections: bool,
) -> Result<Vec<MediaItem>, String> {
    let user_id = emby_user_id(client, config, label).await?;
    let is_collections = library_id == "collections";
    let mut query = vec![
        ("Recursive", "true"),
        (
            "IncludeItemTypes",
            if is_collections {
                "BoxSet"
            } else {
                "Movie,Series"
            },
        ),
        ("Fields", "ProductionYear,DateCreated"),
        ("SortBy", "SortName"),
        ("SortOrder", "Ascending"),
        ("ImageTypeLimit", "1"),
        ("EnableImageTypes", "Primary"),
        ("userId", user_id.as_str()),
    ];
    if !is_collections {
        query.push(("ParentId", library_id));
    }
    let data = emby_json(client, config, label, "/Items", &query).await?;
    let mut raw = data
        .get("Items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if !is_collections && group_collections {
        raw = collapse_emby_collections(client, config, label, &user_id, raw).await?;
    }
    Ok(raw.iter().filter_map(emby_media_item).collect())
}

async fn collapse_emby_collections(
    client: &Client,
    config: &ConnectionConfig<'_>,
    label: &str,
    user_id: &str,
    items: Vec<Value>,
) -> Result<Vec<Value>, String> {
    let data = emby_json(
        client,
        config,
        label,
        "/Items",
        &[
            ("IncludeItemTypes", "BoxSet"),
            ("Recursive", "true"),
            ("Fields", "ProductionYear,DateCreated"),
            ("ImageTypeLimit", "1"),
            ("EnableImageTypes", "Primary"),
            ("userId", user_id),
        ],
    )
    .await?;
    let boxsets = data
        .get("Items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut member_map: HashMap<String, Value> = HashMap::new();
    for boxset in boxsets {
        let Some(id) = boxset.get("Id").and_then(Value::as_str) else {
            continue;
        };
        let children = emby_json(
            client,
            config,
            label,
            "/Items",
            &[
                ("ParentId", id),
                ("IncludeItemTypes", "Movie,Series"),
                ("userId", user_id),
            ],
        )
        .await;
        let Ok(children) = children else {
            continue;
        };
        for child in children
            .get("Items")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(child_id) = child.get("Id").and_then(Value::as_str) {
                member_map
                    .entry(child_id.to_owned())
                    .or_insert_with(|| boxset.clone());
            }
        }
    }
    collapse_members(items, &member_map, "Id", "Name")
}

async fn plex_items(
    client: &Client,
    config: &ConnectionConfig<'_>,
    library_id: &str,
    group_collections: bool,
) -> Result<Vec<MediaItem>, String> {
    let mut raw = if library_id == "collections" {
        let sections = plex_json(client, config, "/library/sections").await?;
        let mut all = Vec::new();
        for section in sections
            .get("Directory")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if !matches!(
                section.get("type").and_then(Value::as_str),
                Some("movie" | "show")
            ) {
                continue;
            }
            let Some(key) = section.get("key").and_then(value_as_string) else {
                continue;
            };
            if let Ok(data) = plex_json(
                client,
                config,
                &format!("/library/sections/{key}/collections"),
            )
            .await
            {
                all.extend(
                    data.get("Metadata")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default(),
                );
            }
        }
        all
    } else {
        let data = plex_json(
            client,
            config,
            &format!("/library/sections/{library_id}/all"),
        )
        .await?;
        let items = data
            .get("Metadata")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if group_collections {
            collapse_plex_collections(client, config, library_id, items).await?
        } else {
            items
        }
    };
    raw.sort_by_key(|item| {
        item.get("title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase()
    });
    Ok(raw.iter().filter_map(plex_media_item).collect())
}

async fn collapse_plex_collections(
    client: &Client,
    config: &ConnectionConfig<'_>,
    library_id: &str,
    items: Vec<Value>,
) -> Result<Vec<Value>, String> {
    let data = plex_json(
        client,
        config,
        &format!("/library/sections/{library_id}/collections"),
    )
    .await?;
    let collections = data
        .get("Metadata")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut member_map = HashMap::new();
    for collection in collections {
        let Some(id) = collection.get("ratingKey").and_then(value_as_string) else {
            continue;
        };
        let children = plex_json(
            client,
            config,
            &format!("/library/collections/{id}/children"),
        )
        .await;
        let Ok(children) = children else {
            continue;
        };
        for child in children
            .get("Metadata")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(child_id) = child.get("ratingKey").and_then(value_as_string) {
                member_map
                    .entry(child_id)
                    .or_insert_with(|| collection.clone());
            }
        }
    }
    collapse_members(items, &member_map, "ratingKey", "title")
}

fn collapse_members(
    items: Vec<Value>,
    member_map: &HashMap<String, Value>,
    id_field: &str,
    title_field: &str,
) -> Result<Vec<Value>, String> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for item in items {
        let Some(id) = item.get(id_field).and_then(value_as_string) else {
            continue;
        };
        let Some(collection) = member_map.get(&id) else {
            result.push(item);
            continue;
        };
        let Some(collection_id) = collection.get(id_field).and_then(value_as_string) else {
            continue;
        };
        if seen.insert(collection_id) {
            result.push(collection.clone());
        }
    }
    result.sort_by_key(|item| {
        item.get(title_field)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase()
    });
    Ok(result)
}

fn emby_media_item(item: &Value) -> Option<MediaItem> {
    Some(MediaItem {
        id: item.get("Id")?.as_str()?.to_owned(),
        title: item
            .get("Name")
            .and_then(Value::as_str)
            .unwrap_or("Untitled")
            .to_owned(),
        year: item.get("ProductionYear").and_then(Value::as_i64),
        item_type: emby_item_type(item),
        poster: emby_image_ref(item, "Primary"),
        background: None,
        added_at: item
            .get("DateCreated")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

fn plex_media_item(item: &Value) -> Option<MediaItem> {
    Some(MediaItem {
        id: value_as_string(item.get("ratingKey")?)?,
        title: item
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("Untitled")
            .to_owned(),
        year: item.get("year").and_then(Value::as_i64),
        item_type: plex_item_type(item),
        poster: relative_ref(item.get("thumb")),
        background: None,
        added_at: item
            .get("addedAt")
            .and_then(Value::as_i64)
            .and_then(|timestamp| DateTime::<Utc>::from_timestamp(timestamp, 0))
            .map(|date| date.to_rfc3339()),
    })
}

fn emby_item_type(item: &Value) -> ItemType {
    match item.get("Type").and_then(Value::as_str) {
        Some("BoxSet") => ItemType::Collection,
        Some("Series") => ItemType::Show,
        _ => ItemType::Movie,
    }
}

fn plex_item_type(item: &Value) -> ItemType {
    match item.get("type").and_then(Value::as_str) {
        Some("collection") => ItemType::Collection,
        Some("show") => ItemType::Show,
        _ => ItemType::Movie,
    }
}

fn emby_image_ref(item: &Value, image_type: &str) -> Option<String> {
    let id = item.get("Id")?.as_str()?;
    if image_type == "Backdrop" {
        let tag = item
            .get("BackdropImageTags")?
            .as_array()?
            .first()?
            .as_str()?;
        return Some(format!("Items/{id}/Images/Backdrop?tag={tag}"));
    }
    let tag = item.get("ImageTags")?.get(image_type)?.as_str()?;
    Some(format!("Items/{id}/Images/{image_type}?tag={tag}"))
}

fn relative_ref(value: Option<&Value>) -> Option<String> {
    value?
        .as_str()
        .map(|path| path.trim_start_matches('/').to_owned())
}

async fn emby_user_id(
    client: &Client,
    config: &ConnectionConfig<'_>,
    label: &str,
) -> Result<String, String> {
    let users = emby_json(client, config, label, "/Users", &[]).await?;
    users
        .as_array()
        .and_then(|items| items.first())
        .and_then(|user| user.get("Id"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("{label} returned no users for this API key."))
}

async fn plex_libraries(
    client: &Client,
    config: &ConnectionConfig<'_>,
) -> Result<Vec<Library>, String> {
    let sections = plex_json(client, config, "/library/sections").await?;
    let directories = sections
        .get("Directory")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut libraries = directories
        .iter()
        .filter_map(|item| {
            Some(Library {
                id: value_as_string(item.get("key")?)?,
                title: item
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("Library")
                    .to_owned(),
                library_type: match item.get("type").and_then(Value::as_str) {
                    Some("movie") => LibraryType::Movie,
                    Some("show") => LibraryType::Show,
                    _ => LibraryType::Other,
                },
            })
        })
        .collect::<Vec<_>>();
    for section in &directories {
        if !matches!(
            section.get("type").and_then(Value::as_str),
            Some("movie" | "show")
        ) {
            continue;
        }
        let Some(key) = section.get("key").and_then(value_as_string) else {
            continue;
        };
        let has_any = plex_json(
            client,
            config,
            &format!("/library/sections/{key}/collections"),
        )
        .await
        .ok()
        .and_then(|value| value.get("Metadata").and_then(Value::as_array).cloned())
        .is_some_and(|items| !items.is_empty());
        if has_any {
            libraries.push(collections_library());
            break;
        }
    }
    Ok(libraries)
}

async fn emby_libraries(
    client: &Client,
    config: &ConnectionConfig<'_>,
    label: &str,
) -> Result<Vec<Library>, String> {
    let folders = emby_json(client, config, label, "/Library/MediaFolders", &[]).await?;
    let mut libraries = folders
        .get("Items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            Some(Library {
                id: item.get("Id")?.as_str()?.to_owned(),
                title: item
                    .get("Name")
                    .and_then(Value::as_str)
                    .unwrap_or("Library")
                    .to_owned(),
                library_type: match item.get("CollectionType").and_then(Value::as_str) {
                    Some("movies" | "homevideos") => LibraryType::Movie,
                    Some("tvshows") => LibraryType::Show,
                    _ => LibraryType::Other,
                },
            })
        })
        .collect::<Vec<_>>();
    let users = emby_json(client, config, label, "/Users", &[]).await?;
    let user_id = users
        .as_array()
        .and_then(|items| items.first())
        .and_then(|user| user.get("Id"))
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{label} returned no users for this API key."))?;
    let boxsets = emby_json(
        client,
        config,
        label,
        "/Items",
        &[
            ("IncludeItemTypes", "BoxSet"),
            ("Recursive", "true"),
            ("Limit", "1"),
            ("userId", user_id),
        ],
    )
    .await?;
    if boxsets
        .get("TotalRecordCount")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        > 0
    {
        libraries.push(collections_library());
    }
    Ok(libraries)
}

async fn plex_json(
    client: &Client,
    config: &ConnectionConfig<'_>,
    path: &str,
) -> Result<Value, String> {
    let response = client
        .get(format!("{}{}", config.base_url.trim_end_matches('/'), path))
        .header("X-Plex-Token", config.token)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|error| format!("Could not reach Plex at {}: {error}", config.base_url))?;
    if response.status() == StatusCode::UNAUTHORIZED {
        return Err("Plex rejected the token (401 Unauthorized).".to_owned());
    }
    let body: Value = response
        .error_for_status()
        .map_err(|error| format!("Could not reach Plex at {}: {error}", config.base_url))?
        .json()
        .await
        .map_err(|error| format!("Could not reach Plex at {}: {error}", config.base_url))?;
    Ok(body.get("MediaContainer").cloned().unwrap_or(Value::Null))
}

async fn emby_json(
    client: &Client,
    config: &ConnectionConfig<'_>,
    label: &str,
    path: &str,
    query: &[(&str, &str)],
) -> Result<Value, String> {
    let response = client
        .get(format!("{}{}", config.base_url.trim_end_matches('/'), path))
        .header("X-Emby-Token", config.token)
        .header("Accept", "application/json")
        .query(query)
        .send()
        .await
        .map_err(|error| format!("Could not reach {label} at {}: {error}", config.base_url))?;
    if response.status() == StatusCode::UNAUTHORIZED {
        return Err(format!("{label} rejected the API key (401 Unauthorized)."));
    }
    response
        .error_for_status()
        .map_err(|error| format!("Could not reach {label} at {}: {error}", config.base_url))?
        .json()
        .await
        .map_err(|error| format!("Could not reach {label} at {}: {error}", config.base_url))
}

fn value_as_string(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::to_owned)
        .or_else(|| value.as_i64().map(|number| number.to_string()))
}

fn collections_library() -> Library {
    Library {
        id: "collections".to_owned(),
        title: "Collections".to_owned(),
        library_type: LibraryType::Collection,
    }
}

async fn test_plex(
    client: &Client,
    config: &ConnectionConfig<'_>,
) -> Result<(String, String), String> {
    let response = client
        .get(format!("{}/", config.base_url.trim_end_matches('/')))
        .header("X-Plex-Token", config.token)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|error| format!("Could not reach Plex at {}: {error}", config.base_url))?;
    if response.status() == StatusCode::UNAUTHORIZED {
        return Err("Plex rejected the token (401 Unauthorized).".to_owned());
    }
    let body: Value = response
        .error_for_status()
        .map_err(|error| format!("Could not reach Plex at {}: {error}", config.base_url))?
        .json()
        .await
        .map_err(|error| format!("Could not reach Plex at {}: {error}", config.base_url))?;
    let container = body.get("MediaContainer").unwrap_or(&Value::Null);
    Ok((
        string_field(container, "friendlyName", "Plex"),
        string_field(container, "version", ""),
    ))
}

async fn test_emby_family(
    client: &Client,
    config: &ConnectionConfig<'_>,
    label: &str,
) -> Result<(String, String), String> {
    let response = client
        .get(format!(
            "{}/System/Info",
            config.base_url.trim_end_matches('/')
        ))
        .header("X-Emby-Token", config.token)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|error| format!("Could not reach {label} at {}: {error}", config.base_url))?;
    if response.status() == StatusCode::UNAUTHORIZED {
        return Err(format!("{label} rejected the API key (401 Unauthorized)."));
    }
    let body: Value = response
        .error_for_status()
        .map_err(|error| format!("Could not reach {label} at {}: {error}", config.base_url))?
        .json()
        .await
        .map_err(|error| format!("Could not reach {label} at {}: {error}", config.base_url))?;
    Ok((
        string_field(&body, "ServerName", label),
        string_field(&body, "Version", ""),
    ))
}

fn string_field(value: &Value, field: &str, fallback: &str) -> String {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .to_owned()
}
