use super::*;
use axum::{
    body::{Body, to_bytes},
    http::{Request, header},
};
use posterview_contracts::native::{AnimeContent, NativeLibraryInput};
use serde_json::{Value, json};
use tower::ServiceExt;

fn input(action: &str, token: Option<&str>, item: Option<&str>) -> RankingAction {
    serde_json::from_value(json!({"revision":0,"action":action,"token":token,"item_id":item}))
        .unwrap()
}
fn ids() -> HashSet<String> {
    ["a", "b", "c"].into_iter().map(str::to_owned).collect()
}

#[test]
fn exclusion_preserves_votes_allow_restores_and_undo_returns_original_pair() {
    let mut board = RankingBoard::default();
    let visible = ids();
    apply(&mut board, &input("start", None, None), &visible).unwrap();
    let pair = board.pair.clone().unwrap();
    apply(
        &mut board,
        &input("left", Some(&pair.token), None),
        &visible,
    )
    .unwrap();
    assert_eq!(comparisons(&board, &visible).len(), 1);
    apply(&mut board, &input("undo", None, None), &visible).unwrap();
    assert!(board.events.is_empty());
    let restored = board.pair.clone().unwrap();
    assert_eq!(restored.left_id, pair.left_id);
    assert_eq!(restored.right_id, pair.right_id);
    assert_ne!(restored.token, pair.token);
    apply(
        &mut board,
        &input("tie", Some(&restored.token), None),
        &visible,
    )
    .unwrap();
    apply(
        &mut board,
        &input("exclude", None, Some(&pair.left_id)),
        &visible,
    )
    .unwrap();
    assert!(excluded(&board, &visible).contains(&pair.left_id));
    let active = visible
        .difference(&excluded(&board, &visible))
        .cloned()
        .collect();
    assert!(comparisons(&board, &active).is_empty());
    apply(
        &mut board,
        &input("allow", None, Some(&pair.left_id)),
        &visible,
    )
    .unwrap();
    assert_eq!(comparisons(&board, &visible).len(), 1);
}

#[test]
fn skip_has_no_evidence_stale_tokens_and_hidden_titles_are_rejected() {
    let mut board = RankingBoard::default();
    let visible = ids();
    apply(&mut board, &input("start", None, None), &visible).unwrap();
    let pair = board.pair.clone().unwrap();
    apply(
        &mut board,
        &input("skip", Some(&pair.token), None),
        &visible,
    )
    .unwrap();
    assert!(board.events.is_empty());
    assert_eq!(board.recent.len(), 1);
    assert_eq!(
        apply(
            &mut board,
            &input("left", Some(&pair.token), None),
            &visible
        )
        .unwrap_err()
        .status,
        StatusCode::CONFLICT
    );
    assert_eq!(
        apply(
            &mut board,
            &input("exclude", None, Some("hidden")),
            &visible
        )
        .unwrap_err()
        .status,
        StatusCode::NOT_FOUND
    );
    assert!(board.events.is_empty());
}

#[test]
fn latest_pair_decision_replaces_previous_and_hidden_event_cannot_be_undone() {
    let board = RankingBoard {
        events: vec![
            RankingEvent {
                left_id: "a".into(),
                right_id: Some("b".into()),
                outcome: "left".into(),
                pair: None,
            },
            RankingEvent {
                left_id: "b".into(),
                right_id: Some("a".into()),
                outcome: "tie".into(),
                pair: None,
            },
        ],
        ..Default::default()
    };
    let choices = comparisons(&board, &ids());
    assert_eq!(choices.len(), 1);
    assert_eq!(choices[0].outcome, model::Outcome::Tie);
    let visible = ["a".into()].into_iter().collect();
    assert!(!event_visible(board.events.last().unwrap(), &visible));
    let mut board = board;
    assert!(apply(&mut board, &input("undo", None, None), &visible).is_err());
}

fn fixture() -> (tempfile::TempDir, AppState, String, axum::http::HeaderValue) {
    let temp = tempfile::tempdir().unwrap();
    let mut state = crate::test_support::state(temp.path());
    let store = ServerStore::new(state.runtime.data_dir());
    store.bootstrap_user("admin", "admin-password").unwrap();
    state.auth = crate::AuthState::load(state.runtime.data_dir(), None, "admin", false).unwrap();
    let library = store
        .save_native_library(
            None,
            &NativeLibraryInput {
                name: "Movies".into(),
                library_type: NativeLibraryType::Movies,
                anime_content: AnimeContent::Both,
                paths: vec!["Movies".into()],
                revision: None,
                options: Default::default(),
            },
        )
        .unwrap();
    let entries: Vec<_> = ["First", "Second", "Third"]
        .into_iter()
        .map(|title| NativeCatalogEntry {
            id: String::new(),
            path: format!("Movies/{title}"),
            kind: "movie".into(),
            parent_path: None,
            title: title.into(),
            metadata: json!({}),
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
    let (_, cookie) = state.auth.login("admin", "admin-password").unwrap();
    (temp, state, library.id, cookie)
}
fn request(
    method: &str,
    url: &str,
    cookie: &axum::http::HeaderValue,
    body: Value,
) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(url)
        .header(header::COOKIE, cookie)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

#[tokio::test]
async fn api_requires_enabled_plugin_saves_resumes_and_rejects_duplicate_decisions() {
    let (_temp, state, library, cookie) = fixture();
    let app = crate::routes::protected(state.auth.clone()).with_state(state.clone());
    let url = format!("/api/rankings/{library}");
    let response = app
        .clone()
        .oneshot(request("GET", &url, &cookie, Value::Null))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let response = app
        .clone()
        .oneshot(request(
            "PUT",
            "/api/plugins/pairwise",
            &cookie,
            json!({"enabled":true}),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response = app
        .clone()
        .oneshot(request(
            "POST",
            &format!("{url}/actions"),
            &cookie,
            json!({"revision":0,"action":"start"}),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let view: RankingView =
        serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap())
            .unwrap();
    assert_eq!(view.titles.len(), 3);
    assert_eq!(view.revision, 1);
    assert_eq!(view.ranked_count, 0);
    let choice = json!({"revision":view.revision,"action":"left","token":view.pair.unwrap().token});
    let response = app
        .clone()
        .oneshot(request(
            "POST",
            &format!("{url}/actions"),
            &cookie,
            choice.clone(),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response = app
        .clone()
        .oneshot(request("POST", &format!("{url}/actions"), &cookie, choice))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let response = app
        .oneshot(request("GET", &url, &cookie, Value::Null))
        .await
        .unwrap();
    let view: RankingView =
        serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap())
            .unwrap();
    assert_eq!(view.decision_count, 1);
    assert_eq!(view.ranked_count, 2);
    assert!(view.can_undo);
}

#[tokio::test]
async fn users_are_isolated_and_library_permissions_and_admin_settings_are_enforced() {
    let (_temp, state, library, cookie) = fixture();
    let store = ServerStore::new(state.runtime.data_dir());
    store.set_setting(KEY, "{\"enabled\":true}").unwrap();
    for (name, allowed) in [("viewer", true), ("denied", false)] {
        store
            .create_user(&posterview_contracts::UserCreate {
                username: name.into(),
                display_name: name.into(),
                password: "viewer-password".into(),
                role: UserRole::User,
                enabled: true,
                permissions: posterview_contracts::UserPermissions {
                    library_ids: if allowed {
                        vec![library.clone()]
                    } else {
                        vec![]
                    },
                    ..Default::default()
                },
            })
            .unwrap();
    }
    let (_, viewer) = state.auth.login("viewer", "viewer-password").unwrap();
    let (_, denied) = state.auth.login("denied", "viewer-password").unwrap();
    let app = crate::routes::protected(state.auth.clone()).with_state(state.clone());
    let url = format!("/api/rankings/{library}");
    let response = app
        .clone()
        .oneshot(request(
            "POST",
            &format!("{url}/actions"),
            &cookie,
            json!({"revision":0,"action":"start"}),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response = app
        .clone()
        .oneshot(request("GET", &url, &viewer, Value::Null))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let result: RankingView =
        serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap())
            .unwrap();
    assert_eq!(result.revision, 0);
    assert!(result.pair.is_none());
    // Exercise ordinary-user writes through the actual production auth gate.
    let response = app
        .clone()
        .oneshot(request(
            "POST",
            &format!("{url}/actions"),
            &viewer,
            json!({"revision":0,"action":"start"}),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let started: RankingView =
        serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap())
            .unwrap();
    let response = app
        .clone()
        .oneshot(request(
            "POST",
            &format!("{url}/actions"),
            &viewer,
            json!({"revision":started.revision,"action":"tie","token":started.pair.unwrap().token}),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let ranked: RankingView =
        serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap())
            .unwrap();
    assert_eq!(ranked.decision_count, 1);
    let response = app
        .clone()
        .oneshot(Request::builder().uri(&url).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let response = app
        .clone()
        .oneshot(request("GET", &url, &denied, Value::Null))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let response = app
        .clone()
        .oneshot(request(
            "GET",
            "/api/rankings/libraries",
            &denied,
            Value::Null,
        ))
        .await
        .unwrap();
    let result: Vec<RankingLibrary> =
        serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap())
            .unwrap();
    assert!(result.is_empty());
    let response = app
        .oneshot(request(
            "PUT",
            "/api/plugins/pairwise",
            &viewer,
            json!({"enabled":false}),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[test]
fn parental_filters_remove_restricted_titles_and_non_video_libraries_are_ineligible() {
    let (_temp, state, library, _) = fixture();
    let store = ServerStore::new(state.runtime.data_dir());
    let mut entries = store.native_catalog(&library).unwrap();
    entries[0].metadata = json!({"mpaa":"R"});
    entries[1].metadata = json!({"mpaa":"PG"});
    entries[2].metadata = json!({"mpaa":"PG"});
    let revision = store.native_libraries().unwrap()[0].revision;
    store
        .ingest_native_catalog(&library, revision, &entries)
        .unwrap();
    let viewer = UserAccount {
        id: "viewer".into(),
        username: "viewer".into(),
        display_name: "viewer".into(),
        role: UserRole::User,
        enabled: true,
        permissions: posterview_contracts::UserPermissions {
            library_ids: vec![library.clone()],
            max_movie_rating: Some("PG".into()),
            ..Default::default()
        },
        revision: 1,
        created_at: String::new(),
    };
    let visible = catalog(&store, &viewer, &library).unwrap();
    assert_eq!(visible.len(), 2);
    assert!(visible.iter().all(|entry| entry.metadata["mpaa"] == "PG"));
    assert!(!eligible_type(NativeLibraryType::Books));
    assert!(!eligible_type(NativeLibraryType::Youtube));
}
