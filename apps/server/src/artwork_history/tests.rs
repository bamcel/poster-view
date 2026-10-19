use super::*;
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use tower::ServiceExt;

fn snapshot(group: &str, item: &str, days: i64) -> Record {
    let mut value = record(
        0,
        item.into(),
        group.into(),
        "Series".into(),
        item.into(),
        "poster".into(),
        None,
    );
    value.created_at = (Utc::now() - Duration::days(days)).to_rfc3339();
    value
}

#[test]
fn twenty_changes_are_shared_by_series_and_its_seasons_but_not_other_titles() {
    let mut doc = Document::default();
    for index in 0..25 {
        let mut value = snapshot("series", &format!("season-{index}"), 0);
        value.created_at = (Utc::now() - Duration::minutes(index)).to_rfc3339();
        doc.records.push(value);
    }
    doc.records.push(snapshot("other-series", "poster", 0));
    prune(&mut doc);
    assert_eq!(
        doc.records
            .iter()
            .filter(|r| r.group_id == "series")
            .count(),
        20
    );
    assert_eq!(
        doc.records
            .iter()
            .filter(|r| r.group_id == "other-series")
            .count(),
        1
    );
    assert!(!doc.records.iter().any(|r| r.item_id == "season-24"));
}

#[test]
fn expired_and_invalid_dates_are_removed_without_hiding_recent_changes() {
    let mut invalid = snapshot("series", "invalid", 0);
    invalid.created_at = "invalid".into();
    let mut doc = Document {
        records: vec![
            snapshot("series", "recent", 6),
            snapshot("series", "expired", 8),
            invalid,
        ],
        ..Default::default()
    };
    prune(&mut doc);
    assert_eq!(doc.records.len(), 1);
    assert_eq!(doc.records[0].item_id, "recent");
}

#[tokio::test]
async fn committed_backups_survive_cache_cleanup_and_only_orphan_owned_files_are_pruned() {
    let temp = tempfile::tempdir().unwrap();
    let state = crate::test_support::state(temp.path());
    let guard = lock().lock_owned().await;
    let previous = snapshot("series", "poster", 0);
    let id = previous.id.clone();
    Pending {
        record: Some(previous),
        bytes: vec![(
            "poster".into(),
            b"previous-image".to_vec(),
            "image/png".into(),
        )],
        _guard: Some(guard),
    }
    .commit(&state)
    .await
    .unwrap();
    let root = directory(&state);
    let saved = format!("{id}-0.bin");
    let orphan = format!("{}-0.bin", uuid::Uuid::new_v4());
    std::fs::write(root.join(&orphan), b"orphan").unwrap();
    std::fs::write(root.join("user-file.txt"), b"preserve").unwrap();
    clean(&state).await.unwrap();
    assert_eq!(std::fs::read(root.join(&saved)).unwrap(), b"previous-image");
    assert!(!root.join(orphan).exists());
    assert!(root.join("user-file.txt").exists());
    let mut doc = load(&state).unwrap();
    doc.records[0].created_at = (Utc::now() - Duration::days(8)).to_rfc3339();
    save(&state, &doc).unwrap();
    clean(&state).await.unwrap();
    assert!(load(&state).unwrap().records.is_empty());
    assert!(!root.join(saved).exists());
    assert!(root.join("user-file.txt").exists());
}

#[tokio::test]
async fn missing_restore_returns_not_found_without_creating_history() {
    let temp = tempfile::tempdir().unwrap();
    let state = crate::test_support::state(temp.path());
    let response = restore(State(state.clone()), Path(uuid::Uuid::new_v4().to_string())).await;
    assert_eq!(response.unwrap_err().status, StatusCode::NOT_FOUND);
    assert!(load(&state).unwrap().records.is_empty());
}

#[tokio::test]
async fn production_routes_require_sign_in_and_administrator_permissions() {
    let temp = tempfile::tempdir().unwrap();
    let mut state = crate::test_support::state(temp.path());
    let store = db(&state);
    store.bootstrap_user("admin", "admin-password").unwrap();
    store
        .create_user(&posterview_contracts::UserCreate {
            username: "viewer".into(),
            display_name: "Viewer".into(),
            password: "viewer-password".into(),
            role: posterview_contracts::UserRole::User,
            enabled: true,
            permissions: Default::default(),
        })
        .unwrap();
    state.auth = crate::AuthState::load(state.runtime.data_dir(), None, "admin", false).unwrap();
    let (_, cookie) = state.auth.login("viewer", "viewer-password").unwrap();
    let app = crate::routes::protected(state.auth.clone()).with_state(state);
    for (method, uri) in [
        ("GET", "/api/artwork/history/groups"),
        (
            "GET",
            "/api/artwork/history?server_id=0&item_id=collection:test",
        ),
        ("GET", "/api/artwork/history/missing/image"),
        ("POST", "/api/artwork/history/missing/restore"),
    ] {
        let anonymous = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(uri)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(anonymous.status(), StatusCode::UNAUTHORIZED);
        let viewer = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(uri)
                    .header(header::COOKIE, cookie.clone())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(viewer.status(), StatusCode::FORBIDDEN);
    }
}
