use super::*;
use axum::{
    body::{Body, to_bytes},
    http::{Request, header},
};
use posterview_contracts::{
    UserCreate, UserPermissions,
    native::{AnimeContent, NativeLibraryInput, NativeLibraryType},
};
use serde_json::{Value, json};
use tower::ServiceExt;

fn fixture() -> (tempfile::TempDir, AppState, Vec<CollectionMemberRef>) {
    let temp = tempfile::tempdir().unwrap();
    let mut state = crate::test_support::state(temp.path());
    let store = ServerStore::new(state.runtime.data_dir());
    store.bootstrap_user("admin", "admin-password").unwrap();
    state.auth = crate::AuthState::load(state.runtime.data_dir(), None, "admin", false).unwrap();
    let mut members = Vec::new();
    for name in ["Movies", "Anime"] {
        let library = store
            .save_native_library(
                None,
                &NativeLibraryInput {
                    name: name.into(),
                    library_type: if name == "Movies" {
                        NativeLibraryType::Movies
                    } else {
                        NativeLibraryType::Anime
                    },
                    anime_content: AnimeContent::Both,
                    paths: vec![name.into()],
                    options: Default::default(),
                    revision: None,
                },
            )
            .unwrap();
        let entries: Vec<NativeCatalogEntry> = [("Early", "PG", 1977), ("Later", "R", 1980)]
            .into_iter()
            .map(|(title, rating, year)| NativeCatalogEntry {
                id: String::new(),
                path: format!("{name}/{title}"),
                kind: if name == "Anime" { "series" } else { "movie" }.into(),
                parent_path: None,
                title: title.into(),
                metadata: json!({"mpaa":rating,"year":year,"release_date":format!("{year}-06-01")}),
                files: vec![],
                artwork: vec![],
                nfo_path: None,
                nfo_xml: None,
                available: true,
                revision: 1,
            })
            .collect();
        store
            .ingest_native_catalog(&library.id, library.revision, &entries)
            .unwrap();
        for entry in store.native_catalog(&library.id).unwrap() {
            members.push(CollectionMemberRef {
                library_id: library.id.clone(),
                item_id: entry.id,
            });
        }
    }
    (temp, state, members)
}
fn viewer(library: &str) -> UserAccount {
    UserAccount {
        id: "viewer".into(),
        username: "viewer".into(),
        display_name: "Viewer".into(),
        role: UserRole::User,
        enabled: true,
        permissions: UserPermissions {
            library_ids: vec![library.into()],
            max_movie_rating: Some("PG".into()),
            max_tv_rating: Some("TV-PG".into()),
            ..Default::default()
        },
        revision: 1,
        created_at: String::new(),
    }
}

#[test]
fn projects_only_visible_members_and_never_leaks_hidden_overview_or_artwork() {
    let (_temp, state, members) = fixture();
    let store = ServerStore::new(state.runtime.data_dir());
    let mut record = store
        .create_collection("Franchise", "Secret R-rated plot", "release", &members)
        .unwrap();
    record.metadata = posterview_contracts::collections::CollectionMetadata {
        provider: "tmdb".into(),
        provider_id: "10".into(),
        poster_url: "https://image.tmdb.org/t/p/original/restricted.jpg".into(),
        ..Default::default()
    };
    let user = viewer(&members[0].library_id);
    let projected = project_one(&store, &user, record.clone()).unwrap();
    assert_eq!(projected.members.len(), 1);
    assert!(projected.overview.is_empty());
    assert_eq!(projected.metadata, Default::default());
    assert_eq!(projected.members[0].entry.title, "Early");
    assert_eq!(
        projected.members[0].entry.metadata["release_date"],
        "1977-06-01"
    );
    let hidden_user = viewer("not-permitted");
    assert_eq!(
        project_one(&store, &hidden_user, record)
            .err()
            .unwrap()
            .status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn api_supports_duplicate_counts_ordering_conflicts_and_non_destructive_delete() {
    let (_temp, state, members) = fixture();
    let (_, cookie) = state.auth.login("admin", "admin-password").unwrap();
    let app = crate::routes::protected(state.auth.clone()).with_state(state.clone());
    let request = |method: &str, url: &str, body: Value| {
        Request::builder()
            .method(method)
            .uri(url)
            .header(header::COOKIE, &cookie)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    };
    let response = app
        .clone()
        .oneshot(request(
            "POST",
            "/api/collections",
            json!({"title":"Franchise","overview":"","ordering":"release","members":members[..2]}),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let collection: Collection =
        serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap())
            .unwrap();
    assert_eq!(collection.members[0].entry.title, "Early");
    let url = format!("/api/collections/{}/members", collection.id);
    let response = app
        .clone()
        .oneshot(request(
            "POST",
            &url,
            json!({"revision":1,"members":members}),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let added: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap())
            .unwrap();
    assert_eq!(added["added"], 2);
    assert_eq!(added["existing"], 2);
    let response = app
        .clone()
        .oneshot(request(
            "POST",
            &url,
            json!({"revision":1,"members":members}),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let url = format!("/api/collections/{}", collection.id);
    let ordered: Vec<_> = members.iter().rev().cloned().collect();
    let response=app.clone().oneshot(request("PUT",&url,json!({"revision":2,"title":"Franchise","overview":"","ordering":"custom","members":ordered}))).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let collection: Collection =
        serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap())
            .unwrap();
    assert_eq!(collection.members[0].item_id, ordered[0].item_id);
    let response = app
        .oneshot(request("DELETE", &url, Value::Null))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let store = ServerStore::new(state.runtime.data_dir());
    assert!(
        store
            .native_catalog_item(&members[0].library_id, &members[0].item_id)
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
async fn router_enforces_viewer_permissions_and_personal_preferences() {
    let (_temp, state, members) = fixture();
    let store = ServerStore::new(state.runtime.data_dir());
    let collection = store
        .create_collection("Franchise", "Restricted plot", "release", &members)
        .unwrap();
    let permissions = viewer(&members[0].library_id).permissions;
    store
        .create_user(&UserCreate {
            username: "viewer".into(),
            display_name: "Viewer".into(),
            password: "viewer-password".into(),
            role: UserRole::User,
            enabled: true,
            permissions,
        })
        .unwrap();
    let (_, cookie) = state.auth.login("viewer", "viewer-password").unwrap();
    let app = crate::routes::protected(state.auth.clone()).with_state(state.clone());
    let request = |method: &str, url: &str, body: Value| {
        Request::builder()
            .method(method)
            .uri(url)
            .header(header::COOKIE, &cookie)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    };
    let response = app
        .clone()
        .oneshot(request("GET", "/api/collections", Value::Null))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap())
            .unwrap();
    assert_eq!(response[0]["members"].as_array().unwrap().len(), 1);
    assert_eq!(response[0]["overview"], "");
    for (method, url) in [
        ("POST", "/api/collections".into()),
        ("PUT", format!("/api/collections/{}", collection.id)),
        ("DELETE", format!("/api/collections/{}", collection.id)),
        (
            "POST",
            format!("/api/collections/{}/members", collection.id),
        ),
    ] {
        let response = app
            .clone()
            .oneshot(request(method, &url, json!({})))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
    let url = format!("/api/collections/preferences/{}", members[0].library_id);
    let response = app
        .clone()
        .oneshot(request("PUT", &url, json!({"group_collections":true})))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response = app
        .clone()
        .oneshot(request("GET", &url, Value::Null))
        .await
        .unwrap();
    let value: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap())
            .unwrap();
    assert_eq!(value["group_collections"], true);
    let url = format!("/api/collections/preferences/{}", members[2].library_id);
    assert_eq!(
        app.oneshot(request("GET", &url, Value::Null))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
}

#[test]
fn title_and_release_order_are_stable_with_unknown_dates_last() {
    let (_temp, state, members) = fixture();
    let store = ServerStore::new(state.runtime.data_dir());
    let admin = store
        .users()
        .unwrap()
        .into_iter()
        .find(|user| user.role == UserRole::Admin)
        .unwrap();
    let record = store
        .create_collection("Franchise", "", "title", &members)
        .unwrap();
    let collection = project_one(&store, &admin, record).unwrap();
    assert_eq!(
        collection
            .members
            .iter()
            .map(|m| m.entry.title.as_str())
            .collect::<Vec<_>>(),
        vec!["Early", "Early", "Later", "Later"]
    );
    let mut unknown = collection.members[0].entry.clone();
    unknown.metadata = json!({"year":"invalid"});
    assert!(release(&unknown) > release(&collection.members[1].entry));
}

#[tokio::test]
async fn artwork_is_collection_owned_locked_and_validated() {
    let (_temp, state, members) = fixture();
    let store = ServerStore::new(state.runtime.data_dir());
    let collection = store
        .create_collection("Art collection", "Keep overview", "custom", &members)
        .unwrap();
    let target = format!("collection:{}", collection.id);
    let detail = state
        .runtime
        .get_item_detail(0, &target)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(detail.item_type, posterview_contracts::ItemType::Collection);
    assert!(detail.members.is_empty());
    let mut image = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(8, 12)
        .write_to(&mut image, image::ImageFormat::Png)
        .unwrap();
    ServerStore::new(state.runtime.data_dir())
        .set_setting(
            "plugin-artwork",
            r#"{"enabled":false,"pinned":true,"poster_edit":true,"backdrop_edit":true}"#,
        )
        .unwrap();
    super::apply_panel_artwork(
        state.clone(),
        target.clone(),
        posterview_contracts::ImageTarget::Poster,
        Some(image.into_inner()),
    )
    .await
    .unwrap();
    let saved = store.collection(&collection.id).unwrap().unwrap();
    assert!(
        saved
            .metadata
            .poster_url
            .starts_with(&format!("/api/collections/{}/artwork/", collection.id))
    );
    assert!(saved.metadata.locks.contains(&"poster".into()));
    assert_eq!(saved.members, collection.members);
    assert_eq!(saved.overview, "Keep overview");
    let app = crate::routes::protected(state.auth.clone()).with_state(state.clone());
    let (_, admin_cookie) = state.auth.login("admin", "admin-password").unwrap();
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(&saved.metadata.poster_url)
                .header(header::COOKIE, admin_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    store
        .create_user(&UserCreate {
            username: "artviewer".into(),
            display_name: "Viewer".into(),
            password: "viewer-password".into(),
            role: UserRole::User,
            enabled: true,
            permissions: viewer(&members[0].library_id).permissions,
        })
        .unwrap();
    let (_, cookie) = state.auth.login("artviewer", "viewer-password").unwrap();
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(&saved.metadata.poster_url)
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/artwork/remove")
                .header(header::COOKIE, cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({"server_id":0,"item_id":target,"target":"poster"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let file = saved.metadata.poster_url.rsplit('/').next().unwrap();
    assert!(
        state
            .runtime
            .data_dir()
            .join("collection-artwork")
            .join(file)
            .exists()
    );
    assert!(
        super::apply_panel_artwork(
            state.clone(),
            target.clone(),
            posterview_contracts::ImageTarget::Logo,
            None
        )
        .await
        .is_err()
    );
    assert!(
        super::apply_panel_artwork(
            state.clone(),
            target.clone(),
            posterview_contracts::ImageTarget::Background,
            Some(vec![0, 1, 2])
        )
        .await
        .is_err()
    );
    super::apply_panel_artwork(
        state,
        target,
        posterview_contracts::ImageTarget::Poster,
        None,
    )
    .await
    .unwrap();
    let removed = store.collection(&collection.id).unwrap().unwrap();
    assert!(removed.metadata.poster_url.is_empty());
    assert!(removed.metadata.locks.contains(&"poster".into()));
}
