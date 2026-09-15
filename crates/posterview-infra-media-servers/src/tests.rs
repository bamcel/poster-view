use axum::{Json, Router, http::StatusCode, response::IntoResponse, routing::get};
use serde_json::json;
use tokio::net::TcpListener;

use super::*;

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
            Json(json!({"Items":[
                {"Id":"food-wars","Name":"Food Wars!","Type":"Folder","IsFolder":true},
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

async fn serve(app: Router) -> (String, tokio::task::JoinHandle<()>) {
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
