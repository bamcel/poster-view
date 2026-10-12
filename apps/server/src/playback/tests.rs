//! Original-file delivery, inspection, resource extraction, and session lifecycle tests.
use super::test_support::{input, original_mkv_input, original_mkv_probe};
use super::*;
use http_body_util::BodyExt;
use posterview_contracts::native::{
    AnimeContent, NativeLibraryInput, NativeLibraryOptions, NativeLibraryType,
};
use serde_json::json;

struct VideoFixture {
    _directory: tempfile::TempDir,
    state: AppState,
    library: String,
    item: String,
    file: PathBuf,
}
async fn video_fixture(bytes: &[u8], data: Value) -> VideoFixture {
    let directory = tempfile::tempdir().unwrap();
    let state = crate::test_support::state(directory.path());
    let file = directory.path().join("media/Movies/Original.mkv");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, bytes).unwrap();
    let database = ServerStore::new(state.runtime.data_dir());
    // Retired settings must neither enable conversion nor disable text/font extraction.
    database
        .set_setting(
            "transcoding-settings",
            &json!({
                "allow_conversion":true,"allow_remux":true,"allow_audio_transcoding":true,
                "auto_bandwidth_transcoding":true,"hardware_acceleration":true,
                "subtitle_extraction":false,"font_extraction":false
            })
            .to_string(),
        )
        .unwrap();
    let library = database
        .save_native_library(
            None,
            &NativeLibraryInput {
                name: "Original".into(),
                library_type: NativeLibraryType::Movies,
                anime_content: AnimeContent::Both,
                paths: vec!["Movies".into()],
                revision: None,
                options: NativeLibraryOptions::default(),
            },
        )
        .unwrap();
    database
        .ingest_native_catalog(
            &library.id,
            library.revision,
            &[NativeCatalogEntry {
                id: String::new(),
                path: "Movies/Original.mkv".into(),
                kind: "movie".into(),
                parent_path: None,
                title: "Original".into(),
                metadata: json!({"plot":"Original-file fixture"}),
                artwork: vec![],
                files: vec![json!({"path":"Movies/Original.mkv"})],
                nfo_path: None,
                nfo_xml: None,
                available: true,
                revision: 1,
            }],
        )
        .unwrap();
    let item = database.native_catalog(&library.id).unwrap().remove(0);
    let resolved = source(&state, library.id.clone(), item.id.clone())
        .await
        .unwrap();
    state.playback.probes.lock().await.insert(
        resolved.path.clone(),
        ProbeCache {
            stamp: resolved.fingerprint,
            probe: data,
            used: Instant::now(),
        },
    );
    VideoFixture {
        _directory: directory,
        state,
        library: library.id,
        item: item.id,
        file,
    }
}
async fn direct(fixture: &VideoFixture) -> SessionResponse {
    create(
        State(fixture.state.clone()),
        Path((fixture.library.clone(), fixture.item.clone())),
        Json(original_mkv_input()),
    )
    .await
    .unwrap()
    .0
}
#[tokio::test]
async fn episode_source_lookup_ignores_unrelated_series_and_preserves_next_across_seasons() {
    use posterview_contracts::native::{
        AnimeContent, NativeLibraryInput, NativeLibraryOptions, NativeLibraryType,
    };
    let directory = tempfile::tempdir().unwrap();
    let state = crate::test_support::state(directory.path());
    let file = directory.path().join("media/Shows/Show/Season1/one.mkv");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, b"fixture").unwrap();
    let flat_file = directory.path().join("media/Shows/Flat/one.mkv");
    std::fs::create_dir_all(flat_file.parent().unwrap()).unwrap();
    std::fs::write(&flat_file, b"fixture").unwrap();
    let database = ServerStore::new(state.runtime.data_dir());
    let library = database
        .save_native_library(
            None,
            &NativeLibraryInput {
                name: "Shows".into(),
                library_type: NativeLibraryType::Shows,
                anime_content: AnimeContent::Both,
                paths: vec!["Shows".into()],
                revision: None,
                options: NativeLibraryOptions::default(),
            },
        )
        .unwrap();
    let make = |path: &str, kind: &str, parent: Option<&str>, season: u32, episode: u32| {
        NativeCatalogEntry {
            id: String::new(),
            path: path.into(),
            kind: kind.into(),
            parent_path: parent.map(str::to_owned),
            title: path.rsplit('/').next().unwrap().into(),
            metadata: json!({"season":season,"episode":episode}),
            artwork: vec![],
            files: if kind == "episode" {
                vec![json!({"path":path})]
            } else {
                vec![]
            },
            nfo_path: None,
            nfo_xml: None,
            available: true,
            revision: 1,
        }
    };
    let mut missing = make(
        "Shows/Show/Season1/missing.mkv",
        "episode",
        Some("Shows/Show/Season1"),
        1,
        2,
    );
    missing.metadata["missing"] = json!(true);
    let entries = vec![
        make("Shows/Show", "series", None, 0, 0),
        make("Shows/Show/Season1", "season", Some("Shows/Show"), 1, 0),
        make("Shows/Show/Season2", "season", Some("Shows/Show"), 2, 0),
        make(
            "Shows/Show/Season1/one.mkv",
            "episode",
            Some("Shows/Show/Season1"),
            1,
            1,
        ),
        missing,
        make(
            "Shows/Show/Season2/unavailable.mkv",
            "episode",
            Some("Shows/Show/Season2"),
            2,
            1,
        ),
        make(
            "Shows/Show/Season2/next.mkv",
            "episode",
            Some("Shows/Show/Season2"),
            2,
            2,
        ),
        make("Shows/Other", "series", None, 0, 0),
        make("Shows/Flat", "series", None, 0, 0),
        make("Shows/Flat/one.mkv", "episode", Some("Shows/Flat"), 1, 1),
        make("Shows/Flat/two.mkv", "episode", Some("Shows/Flat"), 1, 2),
    ];
    database
        .ingest_native_catalog(&library.id, library.revision, &entries)
        .unwrap();
    database
        .ingest_native_catalog_scoped(
            &library.id,
            library.revision,
            &[],
            Some(&["Shows/Show/Season2/unavailable.mkv".into()]),
        )
        .unwrap();
    // A targeted lookup must not depend on parsing any unrelated library snapshot.
    let connection =
        rusqlite::Connection::open(state.runtime.data_dir().join("posterview.db")).unwrap();
    connection.execute("UPDATE native_catalog_sources SET snapshot_json='{}' WHERE library_id=?1 AND relative_path='Shows/Other'",[&library.id]).unwrap();
    drop(connection);
    assert!(database.native_catalog(&library.id).is_err());
    let entry = database
        .native_catalog_path(&library.id, "Shows/Show/Season1/one.mkv")
        .unwrap()
        .unwrap();
    let resolved = source(&state, library.id.clone(), entry.id).await.unwrap();
    assert_eq!(resolved.series_title.as_deref(), Some("Show"));
    let next = resolved.next.unwrap();
    assert_eq!(next.library_id, library.id);
    assert_eq!(next.title, "next.mkv");
    let entry = database
        .native_catalog_path(&library.id, "Shows/Flat/one.mkv")
        .unwrap()
        .unwrap();
    let resolved = source(&state, library.id, entry.id).await.unwrap();
    assert_eq!(resolved.series_title.as_deref(), Some("Flat"));
    assert_eq!(resolved.next.unwrap().title, "two.mkv");
}
#[test]
fn stream_duration_fallback_excludes_subtitle_timelines() {
    let data = json!({"format":{},"streams":[{"codec_type":"video","duration":"120.0"},{"codec_type":"audio","duration":125.0},{"codec_type":"subtitle","duration":999.0}]});
    assert_eq!(duration(&data), 125.0);
    assert_eq!(
        duration(&json!({"format":{"duration":"60.0"},"streams":data["streams"]})),
        60.0
    );
    assert_eq!(
        duration(&json!({"format":{"duration":"NaN"},"streams":[]})),
        0.0
    );
}
#[test]
fn source_bitrate_prefers_container_then_size_and_ignores_attachment_and_subtitle_rates() {
    let streams = json!([
        {"codec_type":"video","bit_rate":"3000000"},
        {"codec_type":"audio","bit_rate":192000},
        {"codec_type":"video","bit_rate":999000000,"disposition":{"attached_pic":1}},
        {"codec_type":"subtitle","bit_rate":999000000}
    ]);
    let mut data = json!({"format":{"bit_rate":"5000000","size":"10000000","duration":"100"},"streams":streams});
    assert_eq!(source_bitrate(&data), Some(5_000_000));
    data["format"]["bit_rate"] = json!("NaN");
    assert_eq!(source_bitrate(&data), Some(800_000));
    data["format"]["duration"] = json!(0);
    assert_eq!(source_bitrate(&data), Some(3_192_000));
    data["streams"][0]
        .as_object_mut()
        .unwrap()
        .remove("bit_rate");
    assert_eq!(source_bitrate(&data), None);
    data["streams"][0]["bit_rate"] = json!("3000000");
    data["streams"][1]
        .as_object_mut()
        .unwrap()
        .remove("bit_rate");
    assert_eq!(source_bitrate(&data), None);
    assert_eq!(source_bitrate(&json!({"format":{},"streams":[]})), None);
}
#[test]
fn catalog_path_must_stay_inside_library() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    std::fs::create_dir(root.join("A")).unwrap();
    std::fs::create_dir(root.join("B")).unwrap();
    std::fs::write(root.join("A/test.mp4"), b"video").unwrap();
    assert!(safe_source_path(&root, "A/test.mp4", &["A".into()]).is_ok());
    assert!(safe_source_path(&root, "A/test.mp4", &["B".into()]).is_err());
    for path in ["../test.mp4", "/test.mp4", "C:/test.mp4", "A\\test.mp4"] {
        assert!(safe_source_path(&root, path, &[]).is_err());
    }
}
#[tokio::test]
async fn streams_ranges_without_reading_whole_file() {
    use http_body_util::BodyExt;
    let temp = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(temp.path(), b"0123456789").unwrap();
    let request = axum::http::Request::builder()
        .header(header::RANGE, "bytes=2-4")
        .body(axum::body::Body::empty())
        .unwrap();
    let response = serve(temp.path().into(), "video/mp4", request)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 2-4/10");
    assert_eq!(
        response.into_body().collect().await.unwrap().to_bytes(),
        "234"
    );
    let request = axum::http::Request::builder()
        .header(header::RANGE, "bytes=100-200")
        .body(axum::body::Body::empty())
        .unwrap();
    assert_eq!(
        serve(temp.path().into(), "video/mp4", request)
            .await
            .unwrap()
            .status(),
        StatusCode::RANGE_NOT_SATISFIABLE
    );
}

#[tokio::test]
async fn original_sessions_ignore_retired_settings_and_never_start_playback_jobs() {
    let mut data = original_mkv_probe();
    data["chapters"] = json!([{"start_time":"20","tags":{"title":"Chapter 1"}}]);
    data["streams"].as_array_mut().unwrap().push(json!({"index":4,"codec_type":"attachment","codec_name":"ttf","tags":{"filename":"Cover.ttf"}}));
    let fixture = video_fixture(b"0123456789", data).await;
    let metadata = info(
        State(fixture.state.clone()),
        Path((fixture.library.clone(), fixture.item.clone())),
    )
    .await
    .unwrap()
    .0;
    assert!(!metadata.conversion_allowed);
    assert!(!metadata.audio_conversion_allowed);
    assert!(!metadata.bandwidth_adaptation_allowed);
    assert!(!metadata.remux_allowed);
    assert_eq!(metadata.source_bitrate, Some(5_000_000));
    assert_eq!(metadata.overview.as_deref(), Some("Original-file fixture"));
    assert_eq!(metadata.chapters[0].title, "Chapter 1");
    assert_eq!(metadata.fonts[0].index, 4);
    // With all subprocess permits held, cached direct creation must still finish.
    let permits = fixture.state.playback.jobs.acquire_many(2).await.unwrap();
    let response = tokio::time::timeout(
        Duration::from_secs(5),
        create(
            State(fixture.state.clone()),
            Path((fixture.library.clone(), fixture.item.clone())),
            Json(SessionInput {
                position_seconds: 50.0,
                subtitle_index: Some(3),
                hls_video_codecs: vec!["hevc".into()],
                hls_audio_codecs: vec!["opus".into()],
                hls_aac_supported: true,
                ..original_mkv_input()
            }),
        ),
    )
    .await
    .unwrap()
    .unwrap()
    .0;
    drop(permits);
    assert_eq!(response.method, "direct");
    assert_eq!(response.mime, "video/x-matroska");
    assert_eq!(response.offset_seconds, 0.0);
    assert_eq!(response.audio_index, Some(1));
    assert!(response.encoder.is_none());
    assert!(response.url.ends_with("/stream"));
    assert!(!fixture.state.playback.root.exists());
    assert!(fixture.state.playback.resources.lock().await.is_empty());
    assert_eq!(
        fixture.state.playback.session_details(&response.id).await,
        Some((fixture.library.clone(), fixture.item.clone(), 180.0))
    );
    let delivery = stream(
        State(fixture.state.clone()),
        Path(response.id.clone()),
        axum::http::Request::builder()
            .header(header::RANGE, "bytes=2-4")
            .body(axum::body::Body::empty())
            .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(delivery.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(delivery.headers()[header::CONTENT_TYPE], "video/x-matroska");
    assert_eq!(
        delivery.into_body().collect().await.unwrap().to_bytes(),
        "234"
    );
    stop(State(fixture.state.clone()), Path(response.id.clone())).await;
    assert!(fixture
        .state
        .playback
        .session_details(&response.id)
        .await
        .is_none());
    assert_eq!(std::fs::read(&fixture.file).unwrap(), b"0123456789");
}

#[tokio::test]
async fn legacy_conversion_requests_fail_before_inspection_or_allocation() {
    let fixture = video_fixture(b"0123456789", original_mkv_probe()).await;
    let permits = fixture.state.playback.jobs.acquire_many(2).await.unwrap();
    for request in [
        SessionInput {
            max_height: 1080,
            ..original_mkv_input()
        },
        SessionInput {
            max_bitrate: 10_000_000,
            ..original_mkv_input()
        },
        SessionInput {
            bandwidth_limit_bps: 500_000,
            ..original_mkv_input()
        },
        SessionInput {
            force_transcode: true,
            ..original_mkv_input()
        },
        SessionInput {
            force_remux: true,
            ..original_mkv_input()
        },
        SessionInput {
            subtitle_burn_index: Some(3),
            ..original_mkv_input()
        },
        SessionInput {
            preferred_encoder: Some("hevc".into()),
            ..original_mkv_input()
        },
    ] {
        let error = create(
            State(fixture.state.clone()),
            Path((fixture.library.clone(), "unavailable-item".into())),
            Json(request),
        )
        .await
        .err()
        .unwrap();
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
        assert!(error.detail.contains("only plays original files directly"));
    }
    drop(permits);
    assert!(fixture.state.playback.sessions.lock().await.is_empty());
    assert!(fixture.state.playback.resources.lock().await.is_empty());
    assert!(!fixture.state.playback.root.exists());
}

#[tokio::test]
async fn protected_original_delivery_keeps_full_and_range_headers_when_gzip_is_accepted() {
    let bytes = b"0123456789".repeat(100);
    let fixture = video_fixture(&bytes, original_mkv_probe()).await;
    let response = direct(&fixture).await;
    let app = crate::routes::protected(fixture.state.auth.clone())
        .layer(crate::media_compression_layer())
        .with_state(fixture.state.clone());
    for (encoding, range) in [
        ("gzip", None),
        ("identity", None),
        ("gzip", Some("bytes=2-4")),
        ("gzip", Some("bytes=997-")),
    ] {
        let mut request = axum::http::Request::builder()
            .uri(&response.url)
            .header(header::ACCEPT_ENCODING, encoding);
        if let Some(range) = range {
            request = request.header(header::RANGE, range);
        }
        let delivery = app
            .clone()
            .oneshot(request.body(axum::body::Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(delivery.headers()[header::CONTENT_TYPE], "video/x-matroska");
        assert_eq!(
            delivery.headers()[header::CACHE_CONTROL],
            "private, no-store"
        );
        assert_eq!(delivery.headers()[header::ACCEPT_RANGES], "bytes");
        assert!(delivery.headers().get(header::CONTENT_ENCODING).is_none());
        let expected = match range {
            Some("bytes=2-4") => {
                assert_eq!(delivery.status(), StatusCode::PARTIAL_CONTENT);
                assert_eq!(delivery.headers()[header::CONTENT_RANGE], "bytes 2-4/1000");
                &bytes[2..5]
            }
            Some(_) => {
                assert_eq!(delivery.status(), StatusCode::PARTIAL_CONTENT);
                assert_eq!(
                    delivery.headers()[header::CONTENT_RANGE],
                    "bytes 997-999/1000"
                );
                &bytes[997..]
            }
            None => {
                assert_eq!(delivery.status(), StatusCode::OK);
                bytes.as_slice()
            }
        };
        assert_eq!(
            delivery.headers()[header::CONTENT_LENGTH],
            expected.len().to_string()
        );
        assert_eq!(
            delivery
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .as_ref(),
            expected
        );
    }
    for uri in [
        format!("/api/playback/sessions/{}/hls/index.m3u8", response.id),
        "/api/playback/capabilities".into(),
    ] {
        assert_eq!(
            app.clone()
                .oneshot(
                    axum::http::Request::get(uri)
                        .body(axum::body::Body::empty())
                        .unwrap()
                )
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
    }
}

#[tokio::test]
async fn direct_audio_switching_requires_native_tracks_and_original_codec_support() {
    let fixture = video_fixture(b"0123456789", original_mkv_probe()).await;
    let alternate = SessionInput {
        audio_index: Some(2),
        ..original_mkv_input()
    };
    assert!(create(
        State(fixture.state.clone()),
        Path((fixture.library.clone(), fixture.item.clone())),
        Json(alternate)
    )
    .await
    .is_err());
    let selected = create(
        State(fixture.state.clone()),
        Path((fixture.library.clone(), fixture.item.clone())),
        Json(SessionInput {
            audio_index: Some(2),
            native_audio_tracks: true,
            ..original_mkv_input()
        }),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(selected.method, "direct");
    assert_eq!(selected.audio_index, Some(2));
    assert_eq!(selected.offset_seconds, 0.0);
    assert!(selected.encoder.is_none());
}

#[tokio::test]
async fn session_ttl_stop_limit_and_changed_source_do_not_modify_original_files() {
    let fixture = video_fixture(b"0123456789", original_mkv_probe()).await;
    let response = direct(&fixture).await;
    let valid = heartbeat(
        State(fixture.state.clone()),
        Path(response.id.clone()),
        HeaderMap::new(),
        Json(Heartbeat {
            position_seconds: 50.0,
            paused: false,
        }),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(
        valid,
        json!({"ok":true,"method":"direct","encoder":null,"transcoding":false,"throttled":false})
    );
    fixture
        .state
        .playback
        .sessions
        .lock()
        .await
        .get_mut(&response.id)
        .unwrap()
        .touched = Instant::now() - SESSION_IDLE - Duration::from_secs(1);
    assert!(fixture
        .state
        .playback
        .session_details(&response.id)
        .await
        .is_none());
    fixture.state.playback.maintain().await;
    assert!(fixture.state.playback.sessions.lock().await.is_empty());
    let response = direct(&fixture).await;
    std::fs::write(&fixture.file, b"source changed").unwrap();
    assert!(fixture
        .state
        .playback
        .session_details(&response.id)
        .await
        .is_none());
    assert!(stream(
        State(fixture.state.clone()),
        Path(response.id.clone()),
        axum::http::Request::new(axum::body::Body::empty())
    )
    .await
    .is_err());
    assert!(heartbeat(
        State(fixture.state.clone()),
        Path(response.id.clone()),
        HeaderMap::new(),
        Json(Heartbeat {
            position_seconds: 60.0,
            paused: true
        })
    )
    .await
    .is_err());
    stop(State(fixture.state.clone()), Path(response.id)).await;
    assert!(fixture.state.playback.sessions.lock().await.is_empty());
    assert_eq!(std::fs::read(&fixture.file).unwrap(), b"source changed");
    assert!(!fixture.state.playback.root.exists());
}

#[tokio::test]
async fn unknown_duration_heartbeats_keep_real_positions_with_bounded_validation() {
    let mut data = original_mkv_probe();
    data["format"].as_object_mut().unwrap().remove("duration");
    let fixture = video_fixture(b"0123456789", data).await;
    let response = create(
        State(fixture.state.clone()),
        Path((fixture.library.clone(), fixture.item.clone())),
        Json(SessionInput {
            position_seconds: 600.0,
            ..original_mkv_input()
        }),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(response.duration_seconds, 0.0);
    assert!(heartbeat(
        State(fixture.state.clone()),
        Path(response.id.clone()),
        HeaderMap::new(),
        Json(Heartbeat {
            position_seconds: 600.0,
            paused: false
        })
    )
    .await
    .is_ok());
    for position in [f64::NAN, -1.0, f64::INFINITY, MAX_PLAYBACK_SECONDS + 1.0] {
        assert_eq!(
            heartbeat(
                State(fixture.state.clone()),
                Path(response.id.clone()),
                HeaderMap::new(),
                Json(Heartbeat {
                    position_seconds: position,
                    paused: false
                })
            )
            .await
            .err()
            .unwrap()
            .status,
            StatusCode::BAD_REQUEST
        );
    }
}

#[tokio::test]
async fn session_limit_is_bounded_and_expired_entries_release_slots() {
    let fixture = video_fixture(b"0123456789", original_mkv_probe()).await;
    let response = direct(&fixture).await;
    let mut sessions = fixture.state.playback.sessions.lock().await;
    for number in 1..MAX_SESSIONS {
        sessions.insert(
            number.to_string(),
            Session {
                library_id: fixture.library.clone(),
                item_id: fixture.item.clone(),
                source: fixture.file.clone(),
                stamp: stamp(&fixture.file).unwrap(),
                response: response.clone(),
                touched: Instant::now(),
            },
        );
    }
    drop(sessions);
    assert_eq!(
        create(
            State(fixture.state.clone()),
            Path((fixture.library.clone(), fixture.item.clone())),
            Json(original_mkv_input())
        )
        .await
        .err()
        .unwrap()
        .status,
        StatusCode::TOO_MANY_REQUESTS
    );
    for session in fixture.state.playback.sessions.lock().await.values_mut() {
        session.touched = Instant::now() - SESSION_IDLE - Duration::from_secs(1);
    }
    assert_eq!(direct(&fixture).await.method, "direct");
    assert_eq!(fixture.state.playback.sessions.lock().await.len(), 1);
}

#[test]
fn resource_startup_cleanup_preserves_unrelated_files_and_directories() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("playback/resources");
    std::fs::create_dir_all(&root).unwrap();
    let generated = root.join(format!("{}.vtt", uuid::Uuid::new_v4()));
    std::fs::write(&generated, b"resource").unwrap();
    let unrelated = root.join("keep.ttf");
    std::fs::write(&unrelated, b"font").unwrap();
    let nested = root.join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir(&nested).unwrap();
    let _store = PlaybackStore::new(directory.path());
    assert!(!generated.exists());
    assert!(unrelated.exists());
    assert!(nested.exists());
}

#[tokio::test]
async fn real_ffmpeg_inspection_subtitles_fonts_and_direct_delivery_preserve_video() {
    if command("ffmpeg").arg("-version").status().await.is_err() {
        eprintln!("FFmpeg unavailable; real subtitle/font extraction fixture skipped.");
        return;
    }
    let fixture = video_fixture(b"old source", original_mkv_probe()).await;
    let root = fixture._directory.path();
    let srt = root.join("caption.srt");
    let ass = root.join("caption.ass");
    let font_path = root.join("font.ttf");
    std::fs::write(
        &srt,
        "1\n00:00:01,000 --> 00:00:04,000\nDirect subtitle fixture\n",
    )
    .unwrap();
    std::fs::write(&ass,"[Script Info]\nScriptType: v4.00+\nPlayResX: 160\nPlayResY: 90\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,12,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,ASS direct fixture\n").unwrap();
    std::fs::write(&font_path, [0u8, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).unwrap();
    let mut cmd = command("ffmpeg");
    cmd.args([
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-filter_threads",
        "1",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=160x90:rate=25:duration=5",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=5",
        "-i",
    ])
    .arg(&srt)
    .arg("-i")
    .arg(&ass)
    .args([
        "-map",
        "0:v",
        "-map",
        "1:a",
        "-map",
        "2:s",
        "-map",
        "3:s",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-threads",
        "1",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-c:s:0",
        "srt",
        "-c:s:1",
        "ass",
        "-attach",
    ])
    .arg(&font_path)
    .args(["-metadata:s:t", "mimetype=application/x-truetype-font"])
    .arg(&fixture.file);
    run(
        &mut cmd,
        Duration::from_secs(20),
        "Direct fixture generation",
    )
    .await
    .unwrap();
    let source_bytes = std::fs::read(&fixture.file).unwrap();
    let metadata = info(
        State(fixture.state.clone()),
        Path((fixture.library.clone(), fixture.item.clone())),
    )
    .await
    .unwrap()
    .0;
    assert!(metadata.duration_seconds >= 5.0);
    assert_eq!(metadata.tracks.len(), 4);
    assert_eq!(metadata.fonts.len(), 1);
    assert!(!metadata.conversion_allowed);
    assert!(!metadata.remux_allowed);
    assert_eq!(fixture.state.playback.probes.lock().await.len(), 1);
    for (index, expected, mime) in [
        (2, "Direct subtitle fixture", "text/vtt; charset=utf-8"),
        (3, "ASS direct fixture", "text/plain; charset=utf-8"),
    ] {
        let first = subtitle(
            State(fixture.state.clone()),
            Path((fixture.library.clone(), fixture.item.clone(), index)),
        )
        .await
        .unwrap();
        assert_eq!(first.headers()[header::CONTENT_TYPE], mime);
        let first = first.into_body().collect().await.unwrap().to_bytes();
        assert!(String::from_utf8_lossy(&first).contains(expected));
        let second = subtitle(
            State(fixture.state.clone()),
            Path((fixture.library.clone(), fixture.item.clone(), index)),
        )
        .await
        .unwrap()
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
        assert_eq!(first, second);
    }
    let font = font(
        State(fixture.state.clone()),
        Path((fixture.library.clone(), fixture.item.clone(), 4)),
    )
    .await
    .unwrap();
    assert_eq!(font.headers()[header::CONTENT_TYPE], "font/ttf");
    assert_eq!(fixture.state.playback.resources.lock().await.len(), 3);
    let response = create(
        State(fixture.state.clone()),
        Path((fixture.library.clone(), fixture.item.clone())),
        Json(SessionInput {
            position_seconds: 3.1,
            containers: vec!["mkv".into()],
            ..input()
        }),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(response.method, "direct");
    assert_eq!(response.offset_seconds, 0.0);
    assert!(response.encoder.is_none());
    let delivery = stream(
        State(fixture.state.clone()),
        Path(response.id.clone()),
        axum::http::Request::builder()
            .header(header::RANGE, "bytes=100-130")
            .body(axum::body::Body::empty())
            .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(
        delivery
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .as_ref(),
        &source_bytes[100..131]
    );
    stop(State(fixture.state.clone()), Path(response.id)).await;
    assert_eq!(std::fs::read(&fixture.file).unwrap(), source_bytes);
    assert!(!fixture
        .state
        .playback
        .root
        .join("posterview-playback")
        .exists());
}
