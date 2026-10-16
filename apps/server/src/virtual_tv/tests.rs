use super::*;
use posterview_contracts::{
    UserPermissions,
    native::{AnimeContent, NativeLibraryInput},
};

fn viewer(library_ids: Vec<String>) -> UserAccount {
    UserAccount {
        id: "viewer".into(),
        username: "viewer".into(),
        display_name: "Viewer".into(),
        role: UserRole::User,
        enabled: true,
        permissions: UserPermissions {
            library_ids,
            ..Default::default()
        },
        revision: 1,
        created_at: String::new(),
    }
}
fn input(library: &str) -> ChannelInput {
    ChannelInput {
        name: "Channel".into(),
        number: 1,
        library_ids: vec![library.into()],
        show_ids: vec![],
        movie_ids: vec![],
        genres: vec![],
        order: "random".into(),
        start_at: (Utc::now() - chrono::Duration::hours(1)).to_rfc3339(),
        revision: None,
    }
}
fn fixture() -> (tempfile::TempDir, AppState, String) {
    let temp = tempfile::tempdir().unwrap();
    let state = crate::test_support::state(temp.path());
    let store = ServerStore::new(state.runtime.data_dir());
    let library = store
        .save_native_library(
            None,
            &NativeLibraryInput {
                name: "Movies".into(),
                library_type: NativeLibraryType::Movies,
                anime_content: AnimeContent::Both,
                paths: vec!["Movies".into()],
                options: Default::default(),
                revision: None,
            },
        )
        .unwrap();
    let entry = NativeCatalogEntry {
        id: String::new(),
        path: "Movies/Test.mp4".into(),
        kind: "movie".into(),
        parent_path: None,
        title: "Test film".into(),
        metadata: json!({"genre":["Comedy"],"mpaa":"R"}),
        artwork: vec![],
        files: vec![
            json!({"path":"Movies/Test.mp4","media_info":{"format":{"duration":"1800.5"}}}),
        ],
        nfo_path: None,
        nfo_xml: None,
        available: true,
        revision: 1,
    };
    store
        .ingest_native_catalog(&library.id, library.revision, &[entry])
        .unwrap();
    (temp, state, library.id)
}
#[tokio::test]
async fn durable_channel_uses_real_durations_and_requires_every_library() {
    let (_temp, state, library) = fixture();
    let _ = save_settings(
        State(state.clone()),
        HeaderMap::new(),
        Json(Settings { enabled: true }),
    )
    .await
    .unwrap();
    let channel = create(
        State(state.clone()),
        HeaderMap::new(),
        Json(input(&library)),
    )
    .await
    .unwrap()
    .0;
    let record = load(&state).unwrap().channels.last().unwrap().clone();
    assert_eq!(record.candidates[0].duration_seconds, 1800.5);
    assert_eq!(record.channel.id, channel.id);
    let user = viewer(vec![library.clone()]);
    assert!(require_channel(&state, &user, &channel.id).is_ok());
    assert!(require_channel(&state, &viewer(vec![]), &channel.id).is_err());
    let mut mixed = channel.clone();
    mixed.library_ids.push("restricted".into());
    assert!(!allowed(&user, &mixed));
    let record_before = program_list(&record).unwrap();
    *state.virtual_tv.cache.write().unwrap() = None;
    let loaded = load(&state).unwrap().channels.last().unwrap().clone();
    assert_eq!(record_before[0].id, program_list(&loaded).unwrap()[0].id);
    let _ = save_settings(
        State(state.clone()),
        HeaderMap::new(),
        Json(Settings { enabled: false }),
    )
    .await
    .unwrap();
    assert!(require_channel(&state, &user, &channel.id).is_err());
}

#[tokio::test]
async fn viewer_routes_hide_mixed_channels_and_reject_management_and_artwork() {
    use posterview_contracts::{UserCreate, UserUpdate};
    let (_temp, mut state, library) = fixture();
    let _ = save_settings(
        State(state.clone()),
        HeaderMap::new(),
        Json(Settings { enabled: true }),
    )
    .await
    .unwrap();
    let store = ServerStore::new(state.runtime.data_dir());
    let second = store
        .save_native_library(
            None,
            &NativeLibraryInput {
                name: "Second".into(),
                library_type: NativeLibraryType::Shows,
                anime_content: AnimeContent::Both,
                paths: vec!["Shows".into()],
                options: Default::default(),
                revision: None,
            },
        )
        .unwrap();
    let mut channel_input = input(&library);
    channel_input.library_ids.push(second.id.clone());
    let channel = create(State(state.clone()), HeaderMap::new(), Json(channel_input))
        .await
        .unwrap()
        .0;
    store.bootstrap_user("admin", "password123").unwrap();
    let viewer = store
        .create_user(&UserCreate {
            username: "viewer".into(),
            display_name: "Viewer".into(),
            password: "password123".into(),
            role: UserRole::User,
            enabled: true,
            permissions: UserPermissions {
                library_ids: vec![library.clone()],
                ..Default::default()
            },
        })
        .unwrap();
    state.auth = crate::AuthState::load(state.runtime.data_dir(), None, "admin", false).unwrap();
    let (_, cookie) = state.auth.login("viewer", "password123").unwrap();
    let mut headers = HeaderMap::new();
    headers.insert(axum::http::header::COOKIE, cookie);
    assert!(
        channels(State(state.clone()), headers.clone())
            .await
            .unwrap()
            .0
            .is_empty()
    );
    assert!(
        guide(
            State(state.clone()),
            headers.clone(),
            Path(channel.id.clone()),
            axum::extract::Query(GuideWindow::default())
        )
        .await
        .is_err()
    );
    assert!(
        tune(
            State(state.clone()),
            headers.clone(),
            Path(channel.id.clone())
        )
        .await
        .is_err()
    );
    assert!(
        artwork(
            State(state.clone()),
            headers.clone(),
            Path((channel.id.clone(), library.clone(), "unknown".into()))
        )
        .await
        .is_err()
    );
    assert_eq!(
        save_settings(
            State(state.clone()),
            headers.clone(),
            Json(Settings { enabled: false })
        )
        .await
        .err()
        .unwrap()
        .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        create(State(state.clone()), headers.clone(), Json(input(&library)))
            .await
            .err()
            .unwrap()
            .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        delete(
            State(state.clone()),
            headers.clone(),
            Path(channel.id.clone())
        )
        .await
        .err()
        .unwrap()
        .status,
        StatusCode::FORBIDDEN
    );
    let mut permissions = viewer.permissions.clone();
    permissions.library_ids.push(second.id);
    let updated = store
        .update_user(
            &viewer.id,
            &UserUpdate {
                revision: viewer.revision,
                username: viewer.username.clone(),
                display_name: viewer.display_name.clone(),
                role: viewer.role,
                enabled: true,
                permissions,
                password: None,
            },
        )
        .unwrap()
        .unwrap();
    assert!(
        channels(State(state.clone()), headers.clone())
            .await
            .is_err()
    );
    let (_, cookie) = state.auth.login("viewer", "password123").unwrap();
    headers.insert(axum::http::header::COOKIE, cookie);
    assert_eq!(
        channels(State(state.clone()), headers.clone())
            .await
            .unwrap()
            .0
            .len(),
        1
    );
    assert!(
        tune(
            State(state.clone()),
            headers.clone(),
            Path(channel.id.clone())
        )
        .await
        .is_ok()
    );
    let _ = store
        .update_user(
            &viewer.id,
            &UserUpdate {
                revision: updated.revision,
                username: viewer.username,
                display_name: viewer.display_name,
                role: viewer.role,
                enabled: true,
                permissions: Default::default(),
                password: None,
            },
        )
        .unwrap();
    let (_, cookie) = state.auth.login("viewer", "password123").unwrap();
    headers.insert(axum::http::header::COOKIE, cookie);
    assert!(
        tune(
            State(state.clone()),
            headers.clone(),
            Path(channel.id.clone())
        )
        .await
        .is_err()
    );
    assert!(channels(State(state), headers).await.unwrap().0.is_empty());
}
#[tokio::test]
async fn create_validates_sources_unique_numbers_and_edit_revision() {
    let (_temp, state, library) = fixture();
    let created = create(
        State(state.clone()),
        HeaderMap::new(),
        Json(input(&library)),
    )
    .await
    .unwrap()
    .0;
    assert!(
        create(
            State(state.clone()),
            HeaderMap::new(),
            Json(input(&library))
        )
        .await
        .is_err()
    );
    let mut edit = input(&library);
    edit.revision = Some(0);
    assert_eq!(
        update(
            State(state.clone()),
            HeaderMap::new(),
            Path(created.id.clone()),
            Json(edit)
        )
        .await
        .err()
        .unwrap()
        .status,
        StatusCode::CONFLICT
    );
    let mut edit = input(&library);
    edit.revision = Some(1);
    assert_eq!(
        update(
            State(state.clone()),
            HeaderMap::new(),
            Path(created.id.clone()),
            Json(edit)
        )
        .await
        .unwrap()
        .0
        .revision,
        2
    );
    let mut wrong = input(&library);
    wrong.number = 2;
    wrong.movie_ids.push("outside-library".into());
    assert!(
        create(State(state.clone()), HeaderMap::new(), Json(wrong))
            .await
            .is_err()
    );
    delete(State(state.clone()), HeaderMap::new(), Path(created.id))
        .await
        .unwrap();
    assert!(load(&state).unwrap().channels.is_empty());
}
#[tokio::test]
async fn tune_checks_rating_restrictions_and_current_program() {
    let (_temp, state, library) = fixture();
    let _ = save_settings(
        State(state.clone()),
        HeaderMap::new(),
        Json(Settings { enabled: true }),
    )
    .await
    .unwrap();
    let channel = create(
        State(state.clone()),
        HeaderMap::new(),
        Json(input(&library)),
    )
    .await
    .unwrap()
    .0;
    let record = load(&state).unwrap().channels.last().unwrap().clone();
    let candidate = &record.candidates[0];
    let mut user = viewer(vec![library.clone()]);
    user.permissions.max_movie_rating = Some("PG".into());
    assert!(live_position(&state, &user, &channel.id, &library, &candidate.item_id).is_err());
    user.permissions.max_movie_rating = None;
    assert!(live_position(&state, &user, &channel.id, &library, &candidate.item_id).unwrap() > 0.0);
    assert!(live_position(&state, &user, &channel.id, &library, "unrelated").is_err());
}
#[test]
fn invalid_configuration_and_non_admin_writes_are_rejected() {
    let (_temp, state, library) = fixture();
    let mut invalid = input(&library);
    invalid.library_ids.clear();
    assert!(validate(invalid, "id".into(), 1).is_err());
    let mut invalid = input(&library);
    invalid.order = "unknown".into();
    assert!(validate(invalid, "id".into(), 1).is_err());
    let user = viewer(vec![library]);
    let req = axum::extract::Request::builder()
        .method("PUT")
        .uri("/api/plugins/virtual-tv")
        .body(axum::body::Body::empty())
        .unwrap();
    assert!(crate::access::authorize_request(&state.auth, &user, &req).is_err());
}
