
use axum::{Json, Router, http::StatusCode, response::IntoResponse, routing::get};
use serde_json::json;
use tokio::net::TcpListener;

use super::*;

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
