use std::{path::PathBuf, sync::Arc};

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use posterview_runtime::Runtime;
use tempfile::tempdir;
use tower::ServiceExt;

fn router(runtime: Arc<Runtime>, ui_dir: PathBuf) -> axum::Router {
    super::router(runtime, ui_dir, super::AuthState::for_tests(""))
}

#[tokio::test]
async fn security_routes_require_auth_and_local_bypass_uses_connection_info() {
    let data = tempdir().unwrap();
    let runtime = Arc::new(Runtime::new(data.path()));
    runtime.initialize().unwrap();
    let auth = super::AuthState::for_tests("password");
    let app = super::router(runtime, PathBuf::from("missing-ui"), auth.clone());
    let denied = app
        .clone()
        .oneshot(
            Request::get("/api/security/settings")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
    let rejected = app
        .clone()
        .oneshot(
            Request::put("/api/security/settings")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"idle_timeout_minutes":null,"local_network_bypass":true}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(rejected.status(), StatusCode::UNAUTHORIZED);

    let (_, cookie) = auth.login("admin", "password").unwrap();
    let invalid = app
        .clone()
        .oneshot(
            Request::put("/api/security/settings")
                .header("cookie", cookie.clone())
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"idle_timeout_minutes":0,"local_network_bypass":true}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
    let saved = app
        .clone()
        .oneshot(
            Request::put("/api/security/settings")
                .header("cookie", cookie)
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"idle_timeout_minutes":30,"local_network_bypass":true}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(saved.status(), StatusCode::OK);

    for (address, expected) in [
        ("192.168.1.20:80", StatusCode::OK),
        ("172.18.0.2:80", StatusCode::OK),
        ("8.8.8.8:80", StatusCode::UNAUTHORIZED),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::get("/api/security/settings")
                    .extension(axum::extract::ConnectInfo(
                        address.parse::<std::net::SocketAddr>().unwrap(),
                    ))
                    .header("x-forwarded-for", "192.168.1.20")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), expected, "{address}");
    }
    let unknown = app
        .clone()
        .oneshot(
            Request::get("/api/security/settings")
                .header("x-forwarded-for", "192.168.1.20")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unknown.status(), StatusCode::UNAUTHORIZED);
    let local = app
        .oneshot(
            Request::get("/api/auth/status")
                .extension(axum::extract::ConnectInfo(
                    "192.168.1.20:80".parse::<std::net::SocketAddr>().unwrap(),
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status: serde_json::Value =
        serde_json::from_slice(&local.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(status["authenticated"], true);
    assert_eq!(status["password_required"], false);
    assert_eq!(status["idle_timeout_minutes"], 30);
}

#[tokio::test]
async fn administrator_session_protects_api_routes() {
    let data = tempdir().unwrap();
    let runtime = Arc::new(Runtime::new(data.path()));
    runtime.initialize().unwrap();
    let app = super::router(
        runtime,
        PathBuf::from("missing-ui"),
        super::AuthState::for_tests("correct-password"),
    );

    let denied = app
        .clone()
        .oneshot(Request::get("/api/status").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);

    let rejected = app
        .clone()
        .oneshot(
            Request::post("/api/auth/login")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"username":"admin","password":"wrong"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(rejected.status(), StatusCode::UNAUTHORIZED);

    let accepted = app
        .clone()
        .oneshot(
            Request::post("/api/auth/login")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"username":"wrong-user","password":"correct-password"}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::UNAUTHORIZED);

    let accepted = app
        .clone()
        .oneshot(
            Request::post("/api/auth/login")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"username":"admin","password":"correct-password"}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::OK);
    let cookie = accepted
        .headers()
        .get("set-cookie")
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();

    let allowed = app
        .oneshot(
            Request::get("/api/status")
                .header("cookie", cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(allowed.status(), StatusCode::OK);
}

#[tokio::test]
async fn disabled_login_allows_remote_access_and_reports_no_password_required() {
    let data = tempdir().unwrap();
    let runtime = Arc::new(Runtime::new(data.path()));
    runtime.initialize().unwrap();
    let auth = super::AuthState::for_tests("password").with_authentication(false);
    let app = super::router(runtime, PathBuf::from("missing-ui"), auth);
    for path in ["/api/security/settings", "/api/servers"] {
        let response = app
            .clone()
            .oneshot(
                Request::get(path)
                    .extension(axum::extract::ConnectInfo(
                        "8.8.8.8:1234".parse::<std::net::SocketAddr>().unwrap(),
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
    let response = app
        .oneshot(
            Request::get("/api/auth/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status: serde_json::Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(status["authenticated"], true);
    assert_eq!(status["password_required"], false);
}

#[tokio::test]
async fn health_contract_matches_public_schema() {
    let app = router(Arc::new(Runtime::new("data")), PathBuf::from("missing-ui"));
    let response = app
        .oneshot(Request::get("/api/health").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        json,
        serde_json::json!({"status": "ok", "version": "0.1.0"})
    );
}

#[tokio::test]
async fn login_status_exposes_configured_username_but_never_password() {
    let data = tempdir().unwrap();
    let auth = super::AuthState::load(data.path(), Some("test-secret"), "curator", false).unwrap();
    let app = super::router(
        Arc::new(Runtime::new(data.path())),
        PathBuf::from("missing-ui"),
        auth,
    );
    let response = app
        .oneshot(
            Request::get("/api/auth/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let status: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(status["username"], "curator");
    assert_eq!(status["authenticated"], false);
    assert!(status.get("password").is_none());
    assert!(!String::from_utf8_lossy(&body).contains("test-secret"));
}

#[tokio::test]
async fn unknown_api_routes_return_json() {
    let app = router(Arc::new(Runtime::new("data")), PathBuf::from("missing-ui"));
    let response = app
        .oneshot(
            Request::get("/api/not-migrated")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let content_type = response
        .headers()
        .get("content-type")
        .unwrap()
        .to_str()
        .unwrap();
    assert!(content_type.starts_with("application/json"));
}

#[tokio::test]
async fn media_server_crud_matches_the_frontend_contract() {
    let directory = tempdir().unwrap();
    let runtime = Arc::new(Runtime::new(directory.path()));
    runtime.initialize().unwrap();
    let app = router(runtime, PathBuf::from("missing-ui"));

    let create = app
            .clone()
            .oneshot(
                Request::post("/api/servers")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"name":"Living Room","type":"jellyfin","base_url":"http://media:8096/","token":"secret","is_default":false}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
    assert_eq!(create.status(), StatusCode::CREATED);
    let created: serde_json::Value =
        serde_json::from_slice(&create.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(created["name"], "Living Room");
    assert_eq!(created["type"], "jellyfin");
    assert_eq!(created["base_url"], "http://media:8096");
    assert_eq!(created["is_default"], true);
    assert_eq!(created["has_token"], true);
    assert!(created.get("token").is_none());
    let id = created["id"].as_i64().unwrap();

    let list = app
        .clone()
        .oneshot(Request::get("/api/servers").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(list.status(), StatusCode::OK);
    let listed: serde_json::Value =
        serde_json::from_slice(&list.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(listed.as_array().unwrap().len(), 1);

    let patch = app
        .clone()
        .oneshot(
            Request::patch(format!("/api/servers/{id}"))
                .header("content-type", "application/json")
                .body(Body::from(r#"{"name":"Updated","token":""}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(patch.status(), StatusCode::OK);
    let updated: serde_json::Value =
        serde_json::from_slice(&patch.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(updated["name"], "Updated");
    assert_eq!(updated["has_token"], true);

    let delete = app
        .clone()
        .oneshot(
            Request::delete(format!("/api/servers/{id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(delete.status(), StatusCode::NO_CONTENT);

    let missing = app
        .oneshot(
            Request::get(format!("/api/servers/{id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    let body: serde_json::Value =
        serde_json::from_slice(&missing.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(body, serde_json::json!({"detail": "Server not found"}));
}

#[tokio::test]
async fn adhoc_jellyfin_connection_test_matches_public_schema() {
    let media_app = axum::Router::new().route(
        "/System/Info",
        axum::routing::get(|| async {
            axum::Json(serde_json::json!({
                "ServerName": "Fixture Jellyfin",
                "Version": "10.10.7"
            }))
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let media_server = tokio::spawn(async move {
        axum::serve(listener, media_app).await.unwrap();
    });

    let directory = tempdir().unwrap();
    let runtime = Arc::new(Runtime::new(directory.path()));
    runtime.initialize().unwrap();
    let app = router(runtime, PathBuf::from("missing-ui"));
    let response = app
            .oneshot(
                Request::post("/api/servers/test")
                    .header("content-type", "application/json")
                    .body(Body::from(format!(
                        r#"{{"name":"Fixture","type":"jellyfin","base_url":"http://{address}","token":"api-key","is_default":false}}"#
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: serde_json::Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(
        body,
        serde_json::json!({
            "ok": true,
            "message": "Connected successfully.",
            "server_name": "Fixture Jellyfin",
            "version": "10.10.7"
        })
    );
    media_server.abort();
}

#[tokio::test]
async fn jellyfin_library_discovery_is_normalized() {
    let media_app = axum::Router::new()
        .route(
            "/Library/MediaFolders",
            axum::routing::get(|| async {
                axum::Json(serde_json::json!({"Items": [
                    {"Id": "movies", "Name": "Movies", "CollectionType": "movies"},
                    {"Id": "shows", "Name": "TV Shows", "CollectionType": "tvshows"}
                ]}))
            }),
        )
        .route(
            "/Users",
            axum::routing::get(|| async { axum::Json(serde_json::json!([{"Id": "user-1"}])) }),
        )
        .route(
            "/Items",
            axum::routing::get(|| async {
                axum::Json(serde_json::json!({"Items": [], "TotalRecordCount": 1}))
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let media_server = tokio::spawn(async move {
        axum::serve(listener, media_app).await.unwrap();
    });

    let directory = tempdir().unwrap();
    let runtime = Arc::new(Runtime::new(directory.path()));
    runtime.initialize().unwrap();
    let app = router(runtime, PathBuf::from("missing-ui"));
    let create = app.clone().oneshot(
            Request::post("/api/servers")
                .header("content-type", "application/json")
                .body(Body::from(format!(r#"{{"name":"Fixture","type":"jellyfin","base_url":"http://{address}","token":"key","is_default":true}}"#)))
                .unwrap(),
        ).await.unwrap();
    let created: serde_json::Value =
        serde_json::from_slice(&create.into_body().collect().await.unwrap().to_bytes()).unwrap();
    let id = created["id"].as_i64().unwrap();
    let response = app
        .oneshot(
            Request::get(format!("/api/servers/{id}/libraries"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: serde_json::Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(
        body,
        serde_json::json!([
            {"id":"movies","title":"Movies","type":"movie"},
            {"id":"shows","title":"TV Shows","type":"show"},
            {"id":"collections","title":"Collections","type":"collection"}
        ])
    );
    media_server.abort();
}

#[tokio::test]
async fn jellyfin_item_detail_is_normalized() {
    let media_app = axum::Router::new()
        .route(
            "/Users",
            axum::routing::get(|| async { axum::Json(serde_json::json!([{"Id": "u1"}])) }),
        )
        .route(
            "/Items",
            axum::routing::get(|| async {
                axum::Json(serde_json::json!({"Items": [{
                    "Id":"show-1","Name":"Example Show","Type":"Series",
                    "ProductionYear":2024,"Overview":"Summary","ChildCount":2,
                    "ProviderIds":{"Tmdb":"123","Tvdb":"456"},
                    "ImageTags":{"Primary":"p","Logo":"l"},
                    "BackdropImageTags":["b"]
                }]}))
            }),
        )
        .route(
            "/Shows/show-1/Seasons",
            axum::routing::get(|| async {
                axum::Json(serde_json::json!({"Items":[{
                    "Id":"season-1","Name":"Season 1","IndexNumber":1,
                    "ChildCount":10,"ImageTags":{"Primary":"sp"}
                }]}))
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let media_server = tokio::spawn(async move {
        axum::serve(listener, media_app).await.unwrap();
    });
    let directory = tempdir().unwrap();
    let runtime = Arc::new(Runtime::new(directory.path()));
    runtime.initialize().unwrap();
    let app = router(runtime, PathBuf::from("missing-ui"));
    let created = app.clone().oneshot(
            Request::post("/api/servers").header("content-type", "application/json")
                .body(Body::from(format!(r#"{{"name":"Fixture","type":"jellyfin","base_url":"http://{address}","token":"key","is_default":true}}"#))).unwrap(),
        ).await.unwrap();
    let server: serde_json::Value =
        serde_json::from_slice(&created.into_body().collect().await.unwrap().to_bytes()).unwrap();
    let response = app
        .oneshot(
            Request::get(format!("/api/servers/{}/items/show-1", server["id"]))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let detail: serde_json::Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(detail["type"], "show");
    assert_eq!(
        detail["external_ids"],
        serde_json::json!({"tmdb":"123","tvdb":"456"})
    );
    assert_eq!(detail["seasons"][0]["episode_count"], 10);
    assert_eq!(detail["background"], "Items/show-1/Images/Backdrop?tag=b");
    media_server.abort();
}

#[tokio::test]
async fn manual_upload_is_applied_and_recorded_in_history() {
    let media_app = axum::Router::new().route(
        "/Items/movie-1/Images/Primary",
        axum::routing::post(|| async { StatusCode::NO_CONTENT }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let media_server = tokio::spawn(async move {
        axum::serve(listener, media_app).await.unwrap();
    });
    let directory = tempdir().unwrap();
    let runtime = Arc::new(Runtime::new(directory.path()));
    runtime.initialize().unwrap();
    let app = router(runtime, PathBuf::from("missing-ui"));
    let created = app.clone().oneshot(
            Request::post("/api/servers").header("content-type", "application/json")
                .body(Body::from(format!(r#"{{"name":"Fixture","type":"jellyfin","base_url":"http://{address}","token":"key","is_default":true}}"#))).unwrap(),
        ).await.unwrap();
    let server: serde_json::Value =
        serde_json::from_slice(&created.into_body().collect().await.unwrap().to_bytes()).unwrap();
    let boundary = "posterview-test";
    let body = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"server_id\"\r\n\r\n{}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"item_id\"\r\n\r\nmovie-1\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"target\"\r\n\r\nposter\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"item_title\"\r\n\r\nExample Movie\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"poster.jpg\"\r\nContent-Type: image/jpeg\r\n\r\nimage-bytes\r\n--{boundary}--\r\n",
        server["id"]
    );
    let applied = app
        .clone()
        .oneshot(
            Request::post("/api/artwork/upload")
                .header(
                    "content-type",
                    format!("multipart/form-data; boundary={boundary}"),
                )
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(applied.status(), StatusCode::OK);
    let history = app
        .oneshot(Request::get("/api/history").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let entries: serde_json::Value =
        serde_json::from_slice(&history.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(entries[0]["item_title"], "Example Movie");
    assert_eq!(entries[0]["provider"], "manual");
    assert!(
        directory
            .path()
            .join("history")
            .read_dir()
            .unwrap()
            .next()
            .is_some()
    );
    media_server.abort();
}

#[tokio::test]
async fn provider_settings_and_posterdb_credentials_match_frontend_contracts() {
    let directory = tempdir().unwrap();
    let runtime = Arc::new(Runtime::new(directory.path()));
    runtime.initialize().unwrap();
    let app = router(runtime, PathBuf::from("missing-ui"));

    let providers = app
        .clone()
        .oneshot(
            Request::get("/api/artwork/providers")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let providers: serde_json::Value =
        serde_json::from_slice(&providers.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(providers.as_array().unwrap().len(), 4);

    for provider in ["fanart", "tvdb"] {
        let tested = app
            .clone()
            .oneshot(
                Request::post("/api/artwork/test")
                    .header("content-type", "application/json")
                    .body(Body::from(format!(r#"{{"provider":"{provider}"}}"#)))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(tested.status(), StatusCode::OK);
        let tested: serde_json::Value =
            serde_json::from_slice(&tested.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(tested["ok"], false);
        assert!(
            tested["message"]
                .as_str()
                .unwrap()
                .contains("not configured")
        );
    }

    let settings = app
            .clone()
            .oneshot(
                Request::put("/api/artwork/settings")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"fanart_api_key":"fanart-secret","tvdb_api_key":"tvdb-secret","tvdb_pin":"1234"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
    let settings: serde_json::Value =
        serde_json::from_slice(&settings.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(
        settings,
        serde_json::json!({
            "fanart_configured": true,
            "tvdb_configured": true,
            "default_provider": "posterdb",
            "enabled_providers": ["posterdb", "fanart", "tvdb", "anilist", "mediux"]
        })
    );

    let preferences = app
        .clone()
        .oneshot(
            Request::put("/api/artwork/settings")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"default_provider":"tvdb","enabled_providers":["tvdb","mediux"]}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let preferences: serde_json::Value =
        serde_json::from_slice(&preferences.into_body().collect().await.unwrap().to_bytes())
            .unwrap();
    assert_eq!(preferences["default_provider"], "tvdb");
    assert_eq!(
        preferences["enabled_providers"],
        serde_json::json!(["tvdb", "mediux"])
    );

    let credentials = app
        .oneshot(
            Request::put("/api/posterdb/credentials")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"email":"viewer@example.com","password":"private"}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let credentials: serde_json::Value =
        serde_json::from_slice(&credentials.into_body().collect().await.unwrap().to_bytes())
            .unwrap();
    assert_eq!(credentials["configured"], true);
    assert_eq!(credentials["email"], "viewer@example.com");
    assert!(credentials.get("password").is_none());
}

#[tokio::test]
async fn artwork_cache_defaults_to_250_mb_and_can_be_configured_and_cleared() {
    let directory = tempdir().unwrap();
    let runtime = Arc::new(Runtime::new(directory.path()));
    runtime.initialize().unwrap();
    let app = router(runtime, PathBuf::from("missing-ui"));

    let status = app
        .clone()
        .oneshot(
            Request::get("/api/artwork/cache")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status: serde_json::Value =
        serde_json::from_slice(&status.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(status["max_mb"], 250);
    assert_eq!(status["ttl_days"], 30);

    let updated = app
        .clone()
        .oneshot(
            Request::put("/api/artwork/cache")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"max_mb":500,"ttl_days":60}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    let updated: serde_json::Value =
        serde_json::from_slice(&updated.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(updated["max_mb"], 500);
    assert_eq!(updated["ttl_days"], 60);

    let cleared = app
        .oneshot(
            Request::delete("/api/artwork/cache")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(cleared.status(), StatusCode::OK);
}
