use super::*;
use posterview_contracts::{
    UserPermissions,
    native::{AnimeContent, NativeLibraryInput},
};

#[test]
fn source_picker_excludes_misclassified_specials_seasons_and_trailers() {
    let (_temp, state, library) = fixture();
    let mut entry = ServerStore::new(state.runtime.data_dir())
        .native_catalog(&library)
        .unwrap()
        .remove(0);
    entry.kind = "series".into();
    for path in [
        "Anime/Show/Specials",
        "Anime/Show/Season 1",
        "Anime/Show/S00",
        "Anime/Show/Extras",
    ] {
        entry.path = path.into();
        assert!(!source_title(&entry), "{path}");
    }
    entry.path = "Anime/Show".into();
    assert!(source_title(&entry));
    entry.kind = "movie".into();
    for path in [
        "Anime/Show/Trailers/Trailer 1.mp4",
        "Anime/Show/Specials/Bonus.mp4",
        "Movies/Film/Film-trailer.mkv",
    ] {
        entry.path = path.into();
        assert!(!source_title(&entry), "{path}");
    }
    entry.path = "Movies/Trailer Park Boys/Trailer Park Boys.mkv".into();
    entry.title = "Trailer Park Boys".into();
    assert!(source_title(&entry));
}

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

#[test]
fn specials_require_valid_special_episode_info() {
    let (_temp, state, library) = fixture();
    let mut entry = ServerStore::new(state.runtime.data_dir())
        .native_catalog(&library)
        .unwrap()
        .remove(0);
    entry.kind = "episode".into();
    entry.path = "Shows/Example/Specials/Bonus.mkv".into();
    for metadata in [
        json!({"season":0}),
        json!({"season":0,"airs_before_episode":2}),
        json!({"season":0,"airs_before_season":0}),
        json!({"season":0,"airs_before_season":1,"airs_after_season":2}),
        json!({"season":0,"airs_before_season":1,"airs_before_episode":-1}),
    ] {
        entry.metadata = metadata;
        assert!(!source_title(&entry));
    }
    for metadata in [
        json!({"season":0,"airs_before_season":1}),
        json!({"season":0,"airs_before_season":1,"airs_before_episode":2}),
        json!({"season":0,"airs_after_season":1}),
    ] {
        entry.metadata = metadata;
        assert!(source_title(&entry));
        assert!(special_placement(&entry).is_some());
    }
    entry.metadata = json!({});
    assert!(!source_title(&entry)); // Legacy Specials path without season metadata.
    entry.path = "Shows/Example/Season 1/Episode.mkv".into();
    entry.metadata = json!({"season":1});
    assert!(source_title(&entry));
}
fn input(library: &str) -> ChannelInput {
    ChannelInput {
        name: "Channel".into(),
        number: 1,
        library_ids: vec![library.into()],
        collection_ids: vec![],
        genre_library_ids: None,
        youtube_playlists: None,
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
async fn obsolete_channels_release_numbers_and_cleanup_survives_cache_reload() {
    let (_temp, state, library) = fixture();
    let _guard = WRITE.lock().await;
    let record = |id: &str, number, libraries: Vec<String>| {
        let mut channel = validate(input(&library), id.into(), 1).unwrap();
        channel.number = number;
        channel.library_ids = libraries;
        Record {
            channel,
            candidates: vec![],
        }
    };
    persist(
        &state,
        &Document {
            enabled: false,
            channels: vec![
                record("valid", 1, vec![library.clone()]),
                record("obsolete", 2, vec!["deleted-library".into()]),
                record("mixed", 3, vec![library.clone(), "deleted-library".into()]),
            ],
        },
    )
    .unwrap();
    let doc = load_current_channels(&state).unwrap();
    assert!(!doc.enabled);
    assert_eq!(
        doc.channels
            .iter()
            .map(|r| r.channel.id.as_str())
            .collect::<Vec<_>>(),
        vec!["valid", "mixed"]
    );
    assert!(!doc.channels.iter().any(|r| r.channel.number == 2));
    *state.virtual_tv.cache.write().unwrap() = None;
    assert_eq!(load(&state).unwrap().channels.len(), 2);
    assert_eq!(load_current_channels(&state).unwrap().channels.len(), 2);
}
#[tokio::test]
async fn default_channel_image_prefers_current_video_thumbnail_over_poster() {
    let (temp, state, library) = fixture();
    let item = ServerStore::new(state.runtime.data_dir())
        .native_catalog(&library)
        .unwrap()
        .remove(0);
    std::fs::create_dir_all(temp.path().join("media/Movies")).unwrap();
    for (kind, color) in [
        ("thumb", image::Rgb([255_u8, 0, 0])),
        ("poster", image::Rgb([0_u8, 0, 255])),
    ] {
        let relative = format!("Movies/{kind}.png");
        image::RgbImage::from_pixel(1280, 720, color)
            .save(temp.path().join("media").join(&relative))
            .unwrap();
        ServerStore::new(state.runtime.data_dir())
            .save_native_artwork(
                &library,
                &item.id,
                &posterview_contracts::native::NativeArtwork {
                    kind: kind.into(),
                    path: relative,
                    source: "local".into(),
                },
            )
            .unwrap();
    }
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
    let (_, _, bytes) = channel_image(State(state), HeaderMap::new(), Path(channel.id))
        .await
        .unwrap();
    assert_eq!(image::load_from_memory(&bytes).unwrap().width(), 1280);
    assert_eq!(image::load_from_memory(&bytes).unwrap().height(), 720);
    let pixel = image::load_from_memory(&bytes)
        .unwrap()
        .to_rgb8()
        .get_pixel(0, 0)
        .0;
    assert!(pixel[0] > 200 && pixel[2] < 20);
}

#[tokio::test]
async fn selected_program_uses_its_own_thumbnail_and_rejects_items_outside_channel() {
    let (temp, state, library) = fixture();
    let store = ServerStore::new(state.runtime.data_dir());
    let first = store.native_catalog(&library).unwrap().remove(0);
    let mut second = first.clone();
    second.id = String::new();
    second.path = "Movies/Second.mp4".into();
    second.title = "Second film".into();
    second.files =
        vec![json!({"path":"Movies/Second.mp4","media_info":{"format":{"duration":"1800"}}})];
    let revision = store
        .native_libraries()
        .unwrap()
        .into_iter()
        .find(|l| l.id == library)
        .unwrap()
        .revision;
    store
        .ingest_native_catalog(&library, revision, &[first, second])
        .unwrap();
    let item = store
        .native_catalog(&library)
        .unwrap()
        .into_iter()
        .find(|e| e.title == "Second film")
        .unwrap();
    std::fs::create_dir_all(temp.path().join("media/Movies")).unwrap();
    image::RgbImage::from_pixel(32, 16, image::Rgb([0_u8, 255, 0]))
        .save(temp.path().join("media/Movies/second-thumb.png"))
        .unwrap();
    store
        .save_native_artwork(
            &library,
            &item.id,
            &posterview_contracts::native::NativeArtwork {
                kind: "thumb".into(),
                path: "Movies/second-thumb.png".into(),
                source: "local".into(),
            },
        )
        .unwrap();
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
    let (_, _, bytes) = artwork(
        State(state.clone()),
        HeaderMap::new(),
        Path((channel.id.clone(), library.clone(), item.id.clone())),
        axum::extract::Query(HashMap::new()),
    )
    .await
    .unwrap();
    let pixel = image::load_from_memory(&bytes)
        .unwrap()
        .to_rgb8()
        .get_pixel(0, 0)
        .0;
    assert!(pixel[1] > 200 && pixel[0] < 20);
    let backdrop_query =
        || axum::extract::Query(HashMap::from([("kind".into(), "backdrop".into())]));
    assert!(
        artwork(
            State(state.clone()),
            HeaderMap::new(),
            Path((channel.id.clone(), library.clone(), item.id.clone())),
            backdrop_query(),
        )
        .await
        .is_err(),
        "A thumbnail must not be used as the guide backdrop"
    );
    image::RgbImage::from_pixel(1280, 720, image::Rgb([0_u8, 0, 255]))
        .save(temp.path().join("media/Movies/second-backdrop.png"))
        .unwrap();
    store
        .save_native_artwork(
            &library,
            &item.id,
            &posterview_contracts::native::NativeArtwork {
                kind: "backdrop".into(),
                path: "Movies/second-backdrop.png".into(),
                source: "local".into(),
            },
        )
        .unwrap();
    let (_, _, bytes) = artwork(
        State(state.clone()),
        HeaderMap::new(),
        Path((channel.id.clone(), library.clone(), item.id)),
        backdrop_query(),
    )
    .await
    .unwrap();
    let backdrop = image::load_from_memory(&bytes).unwrap().to_rgb8();
    assert_eq!(backdrop.dimensions(), (1280, 720));
    assert!(backdrop.get_pixel(0, 0).0[2] > 200);
    assert!(
        artwork(
            State(state),
            HeaderMap::new(),
            Path((channel.id, library, "outside-channel".into())),
            axum::extract::Query(HashMap::from([("kind".into(), "backdrop".into())])),
        )
        .await
        .is_err()
    );
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
            Path((channel.id.clone(), library.clone(), "unknown".into())),
            axum::extract::Query(HashMap::from([("kind".into(), "backdrop".into())])),
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

#[test]
fn collection_sources_expand_series_and_keep_other_library_titles_out() {
    use posterview_contracts::collections::CollectionMemberRef;
    let (_temp, state, library) = fixture();
    let store = ServerStore::new(state.runtime.data_dir());
    let movie = store.native_catalog(&library).unwrap().remove(0);
    let second = store
        .save_native_library(
            None,
            &NativeLibraryInput {
                name: "Series".into(),
                library_type: NativeLibraryType::Shows,
                anime_content: AnimeContent::Both,
                paths: vec!["Shows".into()],
                options: Default::default(),
                revision: None,
            },
        )
        .unwrap();
    let mut show = movie.clone();
    show.id = String::new();
    show.kind = "series".into();
    show.path = "Shows/Selected".into();
    show.title = "Selected show".into();
    show.files.clear();
    let mut episode = movie.clone();
    episode.id = String::new();
    episode.kind = "episode".into();
    episode.path = "Shows/Selected/Episode.mp4".into();
    episode.parent_path = Some(show.path.clone());
    episode.metadata = json!({"season":1,"episode":1});
    let mut unrelated = movie.clone();
    unrelated.id = String::new();
    unrelated.path = "Shows/Other.mp4".into();
    store
        .ingest_native_catalog(&second.id, second.revision, &[show, episode, unrelated])
        .unwrap();
    let show = store
        .native_catalog(&second.id)
        .unwrap()
        .into_iter()
        .find(|e| e.kind == "series")
        .unwrap();
    let collection = store
        .create_collection(
            "Mix",
            "",
            "custom",
            &[
                CollectionMemberRef {
                    library_id: library.clone(),
                    item_id: movie.id.clone(),
                },
                CollectionMemberRef {
                    library_id: second.id.clone(),
                    item_id: show.id.clone(),
                },
            ],
        )
        .unwrap();
    let mut request = input(&library);
    request.library_ids.clear();
    request.collection_ids = vec![collection.id.clone(), collection.id.clone()];
    let mut channel = validate(request, "collection-channel".into(), 1).unwrap();
    let lineup = candidates(&state, &mut channel).unwrap();
    assert_eq!(lineup.len(), 2);
    assert_eq!(channel.collection_ids, vec![collection.id]);
    assert_eq!(channel.library_ids.len(), 2);
    assert!(
        lineup
            .iter()
            .any(|e| e.item_id == movie.id && e.library_id == library)
    );
    assert!(
        lineup
            .iter()
            .any(|e| e.series_id.as_ref() == Some(&show.id))
    );
    assert!(!allowed(&viewer(vec![library.clone()]), &channel));
    assert!(!allowed(&viewer(vec![second.id.clone()]), &channel));
    assert!(allowed(&viewer(vec![library, second.id]), &channel));
}

#[test]
fn collections_reject_missing_and_empty_sources_and_legacy_channels_default_empty() {
    let (_temp, state, library) = fixture();
    let mut request = input(&library);
    request.collection_ids = vec!["missing".into()];
    let mut channel = validate(request, "channel".into(), 1).unwrap();
    assert!(candidates(&state, &mut channel).is_err());
    let collection = ServerStore::new(state.runtime.data_dir())
        .create_collection("Empty", "", "title", &[])
        .unwrap();
    channel.collection_ids = vec![collection.id];
    assert!(candidates(&state, &mut channel).is_err());
    let mut raw = serde_json::to_value(&channel).unwrap();
    raw.as_object_mut().unwrap().remove("collection_ids");
    let legacy: Channel = serde_json::from_value(raw).unwrap();
    assert!(legacy.collection_ids.is_empty());
}

fn youtube_fixture() -> (tempfile::TempDir, AppState, String) {
    let (temp, state, _) = fixture();
    let store = ServerStore::new(state.runtime.data_dir());
    let library = store
        .save_native_library(
            None,
            &NativeLibraryInput {
                name: "YouTube".into(),
                library_type: NativeLibraryType::Youtube,
                anime_content: AnimeContent::Both,
                paths: vec!["YouTube".into()],
                options: Default::default(),
                revision: None,
            },
        )
        .unwrap();
    let entries: Vec<_> = [("one", "channel-a", vec!["playlist-a", "shared"]),
        ("two", "channel-a", vec!["playlist-b"]),
        ("three", "channel-b", vec!["playlist-a"])]
        .into_iter().map(|(title, channel, playlists)| NativeCatalogEntry {
            id: String::new(), path: format!("YouTube/{title}.mkv"), kind: "episode".into(),
            parent_path: None, title: title.into(),
            metadata: json!({"season": 0, "episode":0, "youtube":{"channel_id":channel,"duration_seconds":120,"playlists":playlists.into_iter().map(|id| json!({"id":id})).collect::<Vec<_>>()}}),
            artwork: vec![], files: vec![json!({"path":format!("YouTube/{title}.mkv")})],
            nfo_path: None, nfo_xml: None, available:true, revision:1,
        }).collect();
    store
        .ingest_native_catalog(&library.id, library.revision, &entries)
        .unwrap();
    (temp, state, library.id)
}
fn playlist(library: &str, channel: &str, id: &str) -> YoutubePlaylistSelection {
    YoutubePlaylistSelection {
        library_id: library.into(),
        channel_id: channel.into(),
        playlist_id: id.into(),
    }
}
#[test]
fn youtube_playlist_filters_are_scoped_and_shared_videos_only_appear_once() {
    let (_temp, state, library) = youtube_fixture();
    let mut request = input(&library);
    request.youtube_playlists = Some(vec![
        playlist(&library, "channel-a", "playlist-a"),
        playlist(&library, "channel-a", "shared"),
    ]);
    request.genres = vec!["anything".into()];
    let mut channel = validate(request, "youtube".into(), 1).unwrap();
    let videos = candidates(&state, &mut channel).unwrap();
    assert_eq!(videos.len(), 1);
    assert_eq!(videos[0].title, "one");
    assert_eq!(videos[0].season, None);
    assert!(schedule::generate(&channel, videos, Utc::now()).is_ok());
    channel.youtube_playlists = Some(vec![playlist(&library, "channel-b", "playlist-a")]);
    assert_eq!(candidates(&state, &mut channel).unwrap()[0].title, "three");
    channel.youtube_playlists = Some(vec![playlist("another-library", "channel-a", "playlist-a")]);
    assert!(candidates(&state, &mut channel).is_err());
    channel.youtube_playlists = Some(vec![playlist(&library, "channel-a", "missing")]);
    assert!(candidates(&state, &mut channel).is_err());
}
#[test]
fn youtube_legacy_selections_include_videos_without_special_placement() {
    let (_temp, state, library) = youtube_fixture();
    let mut channel = validate(input(&library), "youtube".into(), 1).unwrap();
    let videos = candidates(&state, &mut channel).unwrap();
    assert_eq!(videos.len(), 3);
    assert!(schedule::generate(&channel, videos, Utc::now()).is_ok());
    let mut value = serde_json::to_value(&channel).unwrap();
    value.as_object_mut().unwrap().remove("youtube_playlists");
    let legacy: Channel = serde_json::from_value(value).unwrap();
    assert!(legacy.youtube_playlists.is_none());
    channel.youtube_playlists = Some(vec![]);
    assert!(candidates(&state, &mut channel).is_err());
}
#[test]
fn youtube_empty_selection_keeps_non_youtube_sources() {
    let (_temp, state, library) = fixture();
    let mut request = input(&library);
    request.youtube_playlists = Some(vec![]);
    let mut channel = validate(request, "movie".into(), 1).unwrap();
    assert_eq!(candidates(&state, &mut channel).unwrap().len(), 1);
    channel.youtube_playlists = Some(vec![playlist(&library, "channel-a", "playlist-a")]);
    assert!(candidates(&state, &mut channel).is_err());
}

#[tokio::test]
async fn movie_release_year_reaches_guide_and_legacy_schedules_still_load() {
    for year in [json!(2007), json!("2007")] {
        let (_temp, state, library) = fixture();
        let store = ServerStore::new(state.runtime.data_dir());
        let mut entry = store.native_catalog(&library).unwrap().remove(0);
        entry.metadata["year"] = year;
        let revision = store
            .native_libraries()
            .unwrap()
            .into_iter()
            .find(|item| item.id == library)
            .unwrap()
            .revision;
        store
            .ingest_native_catalog(&library, revision, &[entry])
            .unwrap();
        let mut channel = validate(input(&library), "year-channel".into(), 1).unwrap();
        let lineup = candidates(&state, &mut channel).unwrap();
        assert_eq!(lineup[0].year, Some(2007));
        let mut legacy = serde_json::to_value(&lineup[0]).unwrap();
        legacy.as_object_mut().unwrap().remove("year");
        assert_eq!(
            serde_json::from_value::<Candidate>(legacy).unwrap().year,
            None
        );
        let mut old_lineup = lineup.clone();
        old_lineup[0].year = None;
        persist(
            &state,
            &Document {
                enabled: true,
                channels: vec![Record {
                    channel: channel.clone(),
                    candidates: old_lineup,
                }],
            },
        )
        .unwrap();
        let Json(legacy_guide) = guide(
            State(state.clone()),
            HeaderMap::new(),
            Path(channel.id.clone()),
            axum::extract::Query(GuideWindow::default()),
        )
        .await
        .unwrap();
        assert!(!legacy_guide.is_empty());
        assert!(
            legacy_guide
                .iter()
                .all(|program| program.year == Some(2007))
        );
        let programs = schedule::generate(&channel, lineup, Utc::now()).unwrap();
        assert!(!programs.is_empty());
        assert!(programs.iter().all(|program| program.year == Some(2007)));
        let mut legacy = serde_json::to_value(&programs[0]).unwrap();
        legacy.as_object_mut().unwrap().remove("year");
        assert_eq!(
            serde_json::from_value::<Program>(legacy).unwrap().year,
            None
        );
    }
}

#[test]
fn genre_library_scope_excludes_matches_and_permissions_but_preserves_explicit_titles() {
    let (_temp, state, library) = fixture();
    let store = ServerStore::new(state.runtime.data_dir());
    let second = store
        .save_native_library(
            None,
            &NativeLibraryInput {
                name: "Other".into(),
                library_type: NativeLibraryType::Movies,
                anime_content: AnimeContent::Both,
                paths: vec!["Other".into()],
                options: Default::default(),
                revision: None,
            },
        )
        .unwrap();
    let mut movie = store.native_catalog(&library).unwrap().remove(0);
    movie.id = String::new();
    movie.path = "Other/Film.mp4".into();
    movie.title = "Other film".into();
    movie.files = vec![json!({"path":"Other/Film.mp4","media_info":{"format":{"duration":"120"}}})];
    store
        .ingest_native_catalog(&second.id, second.revision, &[movie])
        .unwrap();
    let other = store.native_catalog(&second.id).unwrap().remove(0);
    let mut request = input(&library);
    request.library_ids.push(second.id.clone());
    request.genres = vec!["Comedy".into()];
    request.genre_library_ids = Some(vec![library.clone()]);
    let mut channel = validate(request, "genre-channel".into(), 1).unwrap();
    let values = candidates(&state, &mut channel).unwrap();
    assert_eq!(values.len(), 1);
    assert_eq!(values[0].library_id, library);
    assert_eq!(channel.library_ids, vec![library.clone()]);
    assert!(allowed(&viewer(vec![library.clone()]), &channel));
    channel
        .source_library_ids
        .as_mut()
        .unwrap()
        .push(second.id.clone());
    channel.movie_ids = vec![other.id];
    assert_eq!(candidates(&state, &mut channel).unwrap().len(), 2);
    assert!(!allowed(&viewer(vec![library.clone()]), &channel));
    let mut request = input(&library);
    request.library_ids.clear();
    request.genres = vec!["Comedy".into()];
    request.genre_library_ids = Some(vec![library.clone()]);
    let mut genre_only = validate(request, "genres-only".into(), 1).unwrap();
    assert_eq!(candidates(&state, &mut genre_only).unwrap().len(), 1);
    genre_only.genre_library_ids = Some(vec!["missing".into()]);
    assert!(candidates(&state, &mut genre_only).is_err());
}

#[test]
fn legacy_genre_channels_keep_their_selected_library_scope() {
    let (_temp, state, library) = fixture();
    let mut request = input(&library);
    request.genres = vec!["Comedy".into()];
    let mut channel = validate(request, "legacy".into(), 1).unwrap();
    let mut value = serde_json::to_value(&channel).unwrap();
    value.as_object_mut().unwrap().remove("genre_library_ids");
    channel = serde_json::from_value(value).unwrap();
    assert!(channel.genre_library_ids.is_none());
    assert_eq!(candidates(&state, &mut channel).unwrap().len(), 1);
    assert_eq!(channel.library_ids, vec![library]);
}
