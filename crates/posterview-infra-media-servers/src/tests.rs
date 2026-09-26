use axum::{Json, Router, http::StatusCode, response::IntoResponse, routing::{delete, get}};
use serde_json::json;
use tokio::net::TcpListener;

use super::*;

#[test]
fn plex_nfo_location_requires_one_distinct_path() {
    assert_eq!(plex_source_path(&json!({"type":"show","Location":[{"path":"/media/TV/Series"}]})), Some("/media/TV/Series".into()));
    assert_eq!(plex_source_path(&json!({"type":"show","Location":[{"path":"/media/TV/Series"},{"path":"/other/Series"}]})), None);
    assert_eq!(plex_source_path(&json!({"type":"movie","Media":[{"Part":[{"file":"/media/Movie.mkv"}]}]})), Some("/media/Movie.mkv".into()));
    assert_eq!(plex_source_path(&json!({"type":"movie","Media":[{"Part":[{"file":"/media/Movie.mkv"},{"file":"/media/Movie2.mkv"}]}]})), None);
}

#[tokio::test]
async fn book_folder_detail_falls_back_to_user_scoped_item_endpoint() {
    let app = Router::new()
        .route("/Users", get(|| async { Json(json!([{"Id":"reader"}])) }))
        .route("/Items", get(|| async { Json(json!({"Items":[]})) }))
        .route("/Users/reader/Items/book-series", get(|| async {
            Json(json!({"Id":"book-series","Name":"Book Series","Type":"Folder","IsFolder":true,"Path":"/media/Books/Book Series"}))
        }));
    let (base_url, task) = serve(app).await;
    let detail = get_item_detail(ConnectionConfig {
        server_type: ServerType::Emby,
        base_url: &base_url,
        token: "test",
    }, "book-series").await.unwrap();
    task.abort();
    assert_eq!(detail.id, "book-series");
    assert_eq!(detail.item_type, ItemType::Folder);
    assert_eq!(detail.source_path.as_deref(), Some("/media/Books/Book Series"));
}

#[tokio::test]
async fn failure_messages_distinguish_credentials_rate_limits_outages_and_unreachable_servers() {
    for (status, expected) in [
        (StatusCode::UNAUTHORIZED, "rejected"),
        (StatusCode::FORBIDDEN, "credentials"),
        (StatusCode::TOO_MANY_REQUESTS, "rate limiting"),
        (StatusCode::SERVICE_UNAVAILABLE, "temporarily unavailable"),
    ] {
        let app = Router::new().route("/System/Info", get(move || async move { status }));
        let (base_url, task) = serve(app).await;
        let result = test_connection(ConnectionConfig {
            server_type: ServerType::Jellyfin,
            base_url: &base_url,
            token: "secret",
        })
        .await;
        let message = result.unwrap_err();
        assert!(message.contains(expected), "{message}");
        assert!(!message.contains("secret"));
        task.abort();
    }
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let message = test_connection(ConnectionConfig {
        server_type: ServerType::Jellyfin,
        base_url: &base_url,
        token: "secret",
    })
    .await
    .unwrap_err();
    assert!(message.contains("unreachable"), "{message}");
}

#[test]
fn jellyfin_uses_current_auth_scheme_while_emby_keeps_its_token_header() {
    let client = Client::new();
    let jellyfin = ConnectionConfig {
        server_type: ServerType::Jellyfin,
        base_url: "http://localhost",
        token: "jellyfin-key",
    };
    let request = emby_family_auth(client.get(jellyfin.base_url), &jellyfin)
        .build()
        .unwrap();
    assert_eq!(
        request
            .headers()
            .get(reqwest::header::AUTHORIZATION)
            .unwrap(),
        "MediaBrowser Token=\"jellyfin-key\""
    );
    assert!(!request.headers().contains_key("X-Emby-Token"));

    let emby = ConnectionConfig {
        server_type: ServerType::Emby,
        base_url: "http://localhost",
        token: "emby-key",
    };
    let request = emby_family_auth(client.get(emby.base_url), &emby)
        .build()
        .unwrap();
    assert_eq!(request.headers().get("X-Emby-Token").unwrap(), "emby-key");
    assert!(
        !request
            .headers()
            .contains_key(reqwest::header::AUTHORIZATION)
    );
}

#[tokio::test]
async fn book_libraries_and_items_are_browseable_in_emby_family_servers() {
    let app = Router::new()
        .route("/Users", get(|| async { Json(json!([{"Id":"reader"}])) }))
        .route("/Library/MediaFolders", get(|| async { Json(json!({"Items":[
            {"Id":"manga","Name":"Manga","CollectionType":"books"},
            {"Id":"audio","Name":"Audiobooks","CollectionType":"audiobooks"}
        ]})) }))
        .route("/Items", get(|axum::extract::Query(query): axum::extract::Query<HashMap<String, String>>| async move {
            if query.get("IncludeItemTypes").is_some_and(|value| value == "BoxSet") { return Json(json!({"Items":[],"TotalRecordCount":0})); }
            assert!(query["IncludeItemTypes"].split(',').any(|kind| kind == "Book"));
            assert!(query["IncludeItemTypes"].split(',').any(|kind| kind == "AudioBook"));
            Json(json!({"Items":[{"Id":"book","Name":"Food Wars Vol 14","Type":"Book","Path":"/manga/Food Wars v14.epub","IndexNumber":14,"ProviderIds":{}}]}))
        }));
    let (base_url, task) = serve(app).await;
    for server_type in [ServerType::Jellyfin, ServerType::Emby] {
        let config = ConnectionConfig {
            server_type,
            base_url: &base_url,
            token: "test",
        };
        let libs = get_libraries(config.clone()).await.unwrap();
        assert!(
            libs.iter()
                .any(|lib| lib.id == "manga" && lib.library_type == LibraryType::Book)
        );
        let items = get_items(config.clone(), "manga", true).await.unwrap();
        assert_eq!(items[0].item_type, ItemType::Book);
        let detail = get_item_detail(config, "book").await.unwrap();
        assert_eq!(detail.file_name.as_deref(), Some("Food Wars v14.epub"));
        assert_eq!(detail.volume.as_deref(), Some("14"));
    }
    task.abort();
}

#[tokio::test]
async fn emby_family_library_items_include_backdrops() {
    let app = Router::new()
        .route("/Users", get(|| async { Json(json!([{"Id":"viewer"}])) }))
        .route(
            "/Items",
            get(
                |axum::extract::Query(query): axum::extract::Query<
                    HashMap<String, String>,
                >| async move {
                    assert!(query["Fields"].contains("BackdropImageTags"));
                    assert!(query["EnableImageTypes"].contains("Backdrop"));
                    Json(json!({"Items":[{
                        "Id":"anime-1",
                        "Name":"Anime",
                        "Type":"Series",
                        "BackdropImageTags":["backdrop-tag"]
                    }]}))
                },
            ),
        );
    let (base_url, task) = serve(app).await;
    let items = get_items(
        ConnectionConfig {
            server_type: ServerType::Emby,
            base_url: &base_url,
            token: "test",
        },
        "anime",
        false,
    )
    .await
    .unwrap();

    assert_eq!(
        items[0].background.as_deref(),
        Some("Items/anime-1/Images/Backdrop?tag=backdrop-tag")
    );
    task.abort();
}

#[test]
fn plex_library_items_include_backdrops() {
    let item = json!({
        "ratingKey": "anime-1",
        "title": "Anime",
        "type": "show",
        "art": "/library/metadata/anime-1/art/1"
    });

    assert_eq!(
        plex_media_item(&item).unwrap().background.as_deref(),
        Some("library/metadata/anime-1/art/1")
    );
}

#[tokio::test]
async fn manga_folder_browsing_returns_only_immediate_series_and_volume_children() {
    let app = Router::new()
        .route("/Users", get(|| async { Json(json!([{"Id":"reader"}])) }))
        .route("/Items", get(|axum::extract::Query(query): axum::extract::Query<HashMap<String, String>>| async move {
            if query.contains_key("Ids") {
                return Json(json!({"Items":[{"Id":"food-wars","Name":"Food Wars!","Type":"Folder","IsFolder":true}]}));
            }
            if query.get("Recursive").map(String::as_str) == Some("true") {
                assert_eq!(query.get("ParentId").map(String::as_str), Some("manga"));
                assert_eq!(query.get("IncludeItemTypes").map(String::as_str), Some("Book,AudioBook"));
                return Json(json!({"Items":[
                    {"Id":"volume-1","ParentId":"food-wars","Name":"Volume 01","Type":"Book","ImageTags":{"Primary":"cover-1"}},
                    {"Id":"one-piece-1","ParentId":"one-piece","Name":"Volume 01","Type":"Book","ImageTags":{"Primary":"cover-2"}}
                ]}));
            }
            assert_eq!(query.get("Recursive").map(String::as_str), Some("false"));
            if query.get("ParentId").map(String::as_str) == Some("food-wars") {
                return Json(json!({"Items":[
                    {"Id":"volume-1","Name":"Volume 01","Type":"Book","ImageTags":{"Primary":"cover-1"}},
                    {"Id":"volume-2","Name":"Volume 02","Type":"Book"}
                ]}));
            }
            assert_eq!(query.get("ParentId").map(String::as_str), Some("manga"));
            assert!(!query.contains_key("IncludeItemTypes"));
            assert!(query["Fields"].contains("BackdropImageTags"));
            assert!(query["EnableImageTypes"].contains("Backdrop"));
            Json(json!({"Items":[
                {"Id":"food-wars","Name":"Food Wars!","Type":"Folder","IsFolder":true,"BackdropImageTags":["series-backdrop"]},
                {"Id":"one-piece","Name":"One Piece","Type":"Folder","IsFolder":true}
            ]}))
        }));
    let (base_url, task) = serve(app).await;
    let items = get_folder_items(
        ConnectionConfig {
            server_type: ServerType::Emby,
            base_url: &base_url,
            token: "test",
        },
        "manga",
    )
    .await
    .unwrap();
    assert_eq!(items.len(), 2);
    assert!(items.iter().all(|item| item.item_type == ItemType::Folder));
    assert_eq!(items[0].title, "Food Wars!");
    assert_eq!(
        items[0].poster.as_deref(),
        Some("Items/volume-1/Images/Primary?tag=cover-1")
    );
    assert_eq!(
        items[0].background.as_deref(),
        Some("Items/food-wars/Images/Backdrop?tag=series-backdrop")
    );
    let detail = get_item_detail(
        ConnectionConfig {
            server_type: ServerType::Emby,
            base_url: &base_url,
            token: "test",
        },
        "food-wars",
    )
    .await
    .unwrap();
    task.abort();
    assert_eq!(detail.item_type, ItemType::Folder);
    assert_eq!(detail.members.len(), 2);
    assert_eq!(
        detail.poster.as_deref(),
        Some("Items/volume-1/Images/Primary?tag=cover-1")
    );
}

#[test]
fn manga_series_own_cover_wins_over_first_volume_fallback() {
    let series = json!({
        "Id": "food-wars",
        "Type": "Folder",
        "IsFolder": true,
        "ImageTags": {"Primary": "series-cover"}
    });
    let members = vec![MediaItem {
        id: "volume-1".to_owned(),
        title: "Volume 01".to_owned(),
        year: None,
        item_type: ItemType::Book,
        poster: Some("Items/volume-1/Images/Primary?tag=volume-cover".to_owned()),
        background: None,
        added_at: None,
    }];

    assert_eq!(
        emby_detail_poster(&series, ItemType::Folder, &members).as_deref(),
        Some("Items/food-wars/Images/Primary?tag=series-cover")
    );
}

pub(super) async fn serve(app: Router) -> (String, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://{address}"), task)
}

#[tokio::test]
async fn jellyfin_connection_contract_is_parsed_directly() {
    let app = Router::new().route(
        "/System/Info",
        get(|| async { Json(json!({ "ServerName": "Living Room", "Version": "10.10.7" })) }),
    );
    let (base_url, task) = serve(app).await;
    let result = test_connection(ConnectionConfig {
        server_type: ServerType::Jellyfin,
        base_url: &base_url,
        token: "test-token",
    })
    .await;
    task.abort();
    assert_eq!(
        result.unwrap(),
        ("Living Room".to_owned(), "10.10.7".to_owned())
    );
}

#[tokio::test]
async fn cross_origin_redirects_are_not_followed() {
    let app = Router::new().route(
        "/System/Info/Public",
        get(|| async {
            (
                StatusCode::TEMPORARY_REDIRECT,
                [("location", "http://127.0.0.1:9/private")],
            )
                .into_response()
        }),
    );
    let (base_url, task) = serve(app).await;
    let result = test_connection(ConnectionConfig {
        server_type: ServerType::Jellyfin,
        base_url: &base_url,
        token: "test-token",
    })
    .await;
    task.abort();
    assert!(result.is_err());
}

#[tokio::test]
async fn unsafe_server_url_is_rejected_before_network_access() {
    let result = test_connection(ConnectionConfig {
        server_type: ServerType::Plex,
        base_url: "file:///etc/passwd",
        token: "token",
    })
    .await;
    assert_eq!(
        result.unwrap_err(),
        "Media-server URLs must use HTTP or HTTPS."
    );
}

#[tokio::test]
async fn emby_family_artwork_can_be_removed() {
    let app = Router::new().route(
        "/Items/example/Images/Primary",
        delete(|| async { StatusCode::NO_CONTENT }),
    );
    let (base_url, task) = serve(app).await;
    for server_type in [ServerType::Emby, ServerType::Jellyfin] {
        remove_image(
            ConnectionConfig {
                server_type,
                base_url: &base_url,
                token: "test-token",
            },
            "example",
            "poster",
        )
        .await
        .unwrap();
    }
    task.abort();
}

#[tokio::test]
async fn plex_artwork_removal_fails_safely() {
    let message = remove_image(
        ConnectionConfig {
            server_type: ServerType::Plex,
            base_url: "http://127.0.0.1:9",
            token: "test-token",
        },
        "example",
        "poster",
    )
    .await
    .unwrap_err();
    assert!(message.contains("not supported for Plex"));
}
