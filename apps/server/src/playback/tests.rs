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
    database
        .set_setting(
            "transcoding-settings",
            &serde_json::to_string(&crate::transcoding::Settings {
                allow_remux: false,
                ..Default::default()
            })
            .unwrap(),
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
        HeaderMap::new(),
        Path((fixture.library.clone(), fixture.item.clone())),
        Json(original_mkv_input()),
    )
    .await
    .unwrap()
    .0
}

fn save_policy(fixture: &VideoFixture, settings: crate::transcoding::Settings) {
    ServerStore::new(fixture.state.runtime.data_dir())
        .set_setting(
            "transcoding-settings",
            &serde_json::to_string(&settings).unwrap(),
        )
        .unwrap();
}
#[tokio::test]
async fn independent_audio_permission_is_reported_without_enabling_video() {
    let fixture = video_fixture(b"original", original_mkv_probe()).await;
    save_policy(
        &fixture,
        crate::transcoding::Settings {
            allow_audio_transcoding: true,
            allow_remux: false,
            ..Default::default()
        },
    );
    let metadata = info(
        State(fixture.state.clone()),
        HeaderMap::new(),
        Path((fixture.library.clone(), fixture.item.clone())),
    )
    .await
    .unwrap()
    .0;
    assert!(metadata.audio_conversion_allowed);
    assert!(!metadata.conversion_allowed);
    assert!(!metadata.remux_allowed);
    let response = direct(&fixture).await;
    assert_eq!(response.method, "direct");
    assert_eq!(response.generation, 0);
    assert_eq!(fixture.state.playback.producers.load(Ordering::Acquire), 0);
}

#[tokio::test]
async fn producer_commands_copy_tracks_and_apply_only_authorized_encoding() {
    let fixture = video_fixture(b"original", test_support::probe()).await;
    let resolved = source(
        &fixture.state,
        fixture.library.clone(),
        fixture.item.clone(),
    )
    .await
    .unwrap();
    let probe = test_support::probe();
    let request = input();
    let settings = crate::transcoding::Settings::default();
    let chosen = plan(&probe, "mkv", &request, &settings).unwrap();
    let delivery = segmented::Delivery {
        source: &resolved,
        probe: &probe,
        plan: &chosen,
        input: &request,
        settings: &settings,
        select_in_stream: false,
        ready_position_seconds: 0.0,
    };
    let args = segmented::hls_command(&delivery, None, fixture._directory.path())
        .unwrap()
        .as_std()
        .get_args()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert!(args.windows(2).any(|pair| pair == ["-c:v", "copy"]));
    assert!(args.windows(2).any(|pair| pair == ["-c:a", "copy"]));
    assert!(!args.iter().any(|arg| arg == "-strict"));
    assert!(
        !args
            .iter()
            .any(|arg| arg == "-vf" || arg == "-filter_complex")
    );
    let mut audio_probe = probe.clone();
    audio_probe["streams"][1]["codec_name"] = json!("truehd");
    audio_probe["streams"][1]["channels"] = json!(6);
    let audio_settings = crate::transcoding::Settings {
        allow_audio_transcoding: true,
        audio_boost: 2.0,
        ..Default::default()
    };
    let chosen = plan(&audio_probe, "mkv", &request, &audio_settings).unwrap();
    let audio_delivery = segmented::Delivery {
        source: &resolved,
        probe: &audio_probe,
        plan: &chosen,
        input: &request,
        settings: &audio_settings,
        select_in_stream: false,
        ready_position_seconds: 0.0,
    };
    let args = segmented::hls_command(&audio_delivery, None, fixture._directory.path())
        .unwrap()
        .as_std()
        .get_args()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert!(args.windows(2).any(|pair| pair == ["-c:v", "copy"]));
    assert!(args.windows(2).any(|pair| pair == ["-c:a", "aac"]));
    assert!(args.windows(2).any(|pair| pair == ["-af", "volume=2"]));
    assert!(
        segmented::hls_command(
            &audio_delivery,
            Some(("libx264", "software")),
            fixture._directory.path()
        )
        .is_err()
    );
    audio_probe["streams"][1]["channels"] = json!(2);
    let chosen = plan(&audio_probe, "mkv", &request, &audio_settings).unwrap();
    let args = segmented::hls_command(
        &segmented::Delivery {
            source: &resolved,
            probe: &audio_probe,
            plan: &chosen,
            input: &request,
            settings: &audio_settings,
            select_in_stream: false,
            ready_position_seconds: 0.0,
        },
        None,
        fixture._directory.path(),
    )
    .unwrap()
    .as_std()
    .get_args()
    .map(|arg| arg.to_string_lossy().into_owned())
    .collect::<Vec<_>>();
    assert!(!args.iter().any(|arg| arg == "-af"));
    let mut hdr = probe.clone();
    hdr["streams"][0]["color_transfer"] = json!("smpte2084");
    hdr["streams"][0]["width"] = json!(720);
    hdr["streams"][0]["height"] = json!(480);
    hdr["streams"][0]["sample_aspect_ratio"] = json!("32:27");
    let encoded = SessionInput {
        force_transcode: true,
        ..request
    };
    let settings = crate::transcoding::Settings {
        allow_conversion: true,
        ..Default::default()
    };
    let chosen = plan(&hdr, "mkv", &encoded, &settings).unwrap();
    let output = response(
        "test",
        &resolved,
        &hdr,
        &chosen,
        1,
        0.0,
        Some("libx264".into()),
    );
    assert_eq!(output.height, Some(480));
    assert_eq!(output.width, Some(852));
    let args = segmented::hls_command(
        &segmented::Delivery {
            source: &resolved,
            probe: &hdr,
            plan: &chosen,
            input: &encoded,
            settings: &settings,
            select_in_stream: false,
            ready_position_seconds: 0.0,
        },
        Some(("libx264", "software")),
        fixture._directory.path(),
    )
    .unwrap()
    .as_std()
    .get_args()
    .map(|arg| arg.to_string_lossy().into_owned())
    .collect::<Vec<_>>();
    assert!(args.iter().any(|arg| arg.contains("tonemap=tonemap=hable")));
    assert!(args.windows(2).any(|pair| pair == ["-color_trc", "bt709"]));
}

#[tokio::test]
async fn copied_flac_hls_preserves_lossless_audio_and_video() {
    let fixture = video_fixture(b"placeholder", test_support::probe()).await;
    let mut cmd = command("ffmpeg");
    cmd.args([
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=160x90:rate=25:duration=2",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000:duration=2",
        "-c:v",
        "libx264",
        "-threads",
        "1",
        "-c:a",
        "flac",
        "-sample_fmt",
        "s32",
    ])
    .arg(&fixture.file);
    run(&mut cmd, Duration::from_secs(15), "FLAC fixture")
        .await
        .unwrap();
    let resolved = source(
        &fixture.state,
        fixture.library.clone(),
        fixture.item.clone(),
    )
    .await
    .unwrap();
    fixture.state.playback.probes.lock().await.clear();
    let probe = fixture.state.playback.probe(&resolved).await.unwrap();
    let request = SessionInput {
        hls_audio_codecs: vec!["flac".into()],
        force_remux: true,
        ..input()
    };
    let settings = crate::transcoding::Settings::default();
    let chosen = plan(&probe, "mkv", &request, &settings).unwrap();
    assert_eq!(chosen.method, "remux");
    assert!(!chosen.convert_audio);
    let mut cmd = segmented::hls_command(
        &segmented::Delivery {
            source: &resolved,
            probe: &probe,
            plan: &chosen,
            input: &request,
            settings: &settings,
            select_in_stream: false,
            ready_position_seconds: 0.0,
        },
        None,
        fixture._directory.path(),
    )
    .unwrap();
    let args = cmd
        .as_std()
        .get_args()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert!(args.windows(2).any(|pair| pair == ["-c:v", "copy"]));
    assert!(args.windows(2).any(|pair| pair == ["-c:a", "copy"]));
    assert!(
        args.windows(2)
            .any(|pair| pair == ["-strict", "experimental"])
    );
    run(&mut cmd, Duration::from_secs(15), "FLAC HLS copy")
        .await
        .unwrap();
    assert!(fixture._directory.path().join("init.mp4").is_file());
    assert!(
        std::fs::read_to_string(fixture._directory.path().join("index.m3u8"))
            .unwrap()
            .contains("#EXT-X-ENDLIST")
    );
}

#[tokio::test]
async fn expired_producer_releases_capacity_before_replacement_allocation() {
    let fixture = video_fixture(b"placeholder", test_support::probe()).await;
    let mut cmd = command("ffmpeg");
    cmd.args([
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=160x90:rate=25:duration=2",
        "-c:v",
        "libx264",
        "-threads",
        "1",
    ])
    .arg(&fixture.file);
    run(
        &mut cmd,
        Duration::from_secs(15),
        "Expired producer fixture",
    )
    .await
    .unwrap();
    fixture.state.playback.probes.lock().await.clear();
    save_policy(
        &fixture,
        crate::transcoding::Settings {
            max_concurrent: 1,
            max_stream_jobs: 8,
            max_jobs_per_user: 1,
            ..Default::default()
        },
    );
    let allocate = || {
        create(
            State(fixture.state.clone()),
            HeaderMap::new(),
            Path((fixture.library.clone(), fixture.item.clone())),
            Json(SessionInput {
                force_remux: true,
                ..input()
            }),
        )
    };
    let first = allocate().await.unwrap().0;
    assert_eq!(fixture.state.playback.producers.load(Ordering::Acquire), 1);
    let refused = allocate().await.err().unwrap();
    assert_eq!(refused.status, StatusCode::TOO_MANY_REQUESTS);
    assert!(refused.detail.contains("Your concurrent"));
    let original = create(
        State(fixture.state.clone()),
        HeaderMap::new(),
        Path((fixture.library.clone(), fixture.item.clone())),
        Json(SessionInput {
            containers: vec!["mkv".into()],
            ..input()
        }),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(original.method, "direct");
    assert_eq!(fixture.state.playback.producers.load(Ordering::Acquire), 1);
    fixture.state.playback.stop_id(&original.id).await;
    let first_handle = handle(&fixture.state.playback, &first.id).await.unwrap();
    first_handle.lock().await.touched = Instant::now() - SESSION_IDLE - Duration::from_secs(1);
    retire_idle(&fixture.state.playback).await;
    assert_eq!(fixture.state.playback.producers.load(Ordering::Acquire), 0);
    assert!(first_handle.lock().await.closed);
    let replacement = allocate().await.unwrap().0;
    assert_eq!(replacement.method, "remux");
    fixture.state.playback.stop_id(&replacement.id).await;
    assert_eq!(fixture.state.playback.producers.load(Ordering::Acquire), 0);
}

#[tokio::test]
async fn real_copied_preparation_covers_resume_target_before_publishing() {
    let fixture = video_fixture(b"placeholder", test_support::probe()).await;
    let mut cmd = command("ffmpeg");
    cmd.args([
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=160x90:rate=25:duration=12",
        "-c:v",
        "libx264",
        "-threads",
        "1",
        "-g",
        "50",
        "-sc_threshold",
        "0",
    ])
    .arg(&fixture.file);
    run(
        &mut cmd,
        Duration::from_secs(15),
        "Resume readiness fixture",
    )
    .await
    .unwrap();
    let source = source(
        &fixture.state,
        fixture.library.clone(),
        fixture.item.clone(),
    )
    .await
    .unwrap();
    fixture.state.playback.probes.lock().await.clear();
    let probe = fixture.state.playback.probe(&source).await.unwrap();
    let input = SessionInput {
        force_remux: true,
        ..input()
    };
    let settings = crate::transcoding::Settings::default();
    let plan = plan(&probe, "mkv", &input, &settings).unwrap();
    assert_eq!(plan.method, "remux");
    for requested in [3.5, 6.5, 12.0] {
        let (producer, encoder) = segmented::start(
            &fixture.state.playback,
            &uuid::Uuid::new_v4().to_string(),
            "test-user",
            1,
            &segmented::Delivery {
                source: &source,
                probe: &probe,
                plan: &plan,
                input: &input,
                settings: &settings,
                select_in_stream: false,
                ready_position_seconds: requested,
            },
        )
        .await
        .unwrap();
        assert!(encoder.is_none());
        let raw = std::fs::read_to_string(producer.dir.join("index.m3u8")).unwrap();
        let prepared = manifest::playlist_seconds(&producer.dir.join("index.m3u8"));
        assert!(prepared >= requested + 2.0 || raw.lines().any(|line| line == "#EXT-X-ENDLIST"));
        assert!(
            prepared > 4.0,
            "The first fragment alone cannot reach this resume point."
        );
        producer.stop().await;
    }
}

#[tokio::test]
async fn real_copy_track_promotion_seeks_and_stale_generations_preserve_source() {
    let fixture = video_fixture(b"placeholder", test_support::probe()).await;
    let mut cmd = command("ffmpeg");
    cmd.args([
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=160x90:rate=25:duration=12",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=12",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=880:duration=12",
        "-map",
        "0:v",
        "-map",
        "1:a",
        "-map",
        "2:a",
        "-c:v",
        "libx264",
        "-threads",
        "1",
        "-g",
        "50",
        "-sc_threshold",
        "0",
        "-c:a",
        "aac",
        "-disposition:a:0",
        "default",
        "-disposition:a:1",
        "0",
    ])
    .arg(&fixture.file);
    run(&mut cmd, Duration::from_secs(15), "Generation fixture")
        .await
        .unwrap();
    fixture.state.playback.probes.lock().await.clear();
    save_policy(
        &fixture,
        crate::transcoding::Settings {
            throttle: false,
            max_concurrent: 1,
            max_stream_jobs: 1,
            ..Default::default()
        },
    );
    let original = std::fs::read(&fixture.file).unwrap();
    let created = create(
        State(fixture.state.clone()),
        HeaderMap::new(),
        Path((fixture.library.clone(), fixture.item.clone())),
        Json(SessionInput {
            containers: vec!["mkv".into()],
            native_audio_tracks: true,
            hls_audio_track_indexes: Some(vec![1, 2]),
            ..input()
        }),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(created.method, "direct");
    assert_eq!(created.generation, 0);
    let promoted = seek(
        State(fixture.state.clone()),
        HeaderMap::new(),
        Path(created.id.clone()),
        Json(SeekInput {
            position_seconds: 1.0,
            generation: 0,
            audio_index: Some(2),
        }),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(promoted.id, created.id);
    assert_eq!(promoted.generation, 1);
    assert_eq!(promoted.method, "remux");
    assert_eq!(promoted.audio_index, Some(2));
    assert!(promoted.encoder.is_none());
    assert!(promoted.duration_seconds >= 12.0);
    assert!(promoted.offset_seconds <= 1.0);
    let stale = heartbeat(
        State(fixture.state.clone()),
        Path(created.id.clone()),
        HeaderMap::new(),
        Json(Heartbeat {
            position_seconds: 11.0,
            paused: true,
            generation: Some(0),
            ..Default::default()
        }),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(stale.status, StatusCode::CONFLICT);
    let handle = handle(&fixture.state.playback, &created.id).await.unwrap();
    let dir = handle.lock().await.producer.as_ref().unwrap().dir.clone();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        fixture.state.playback.maintain().await;
        if std::fs::read_to_string(dir.join("index.m3u8"))
            .unwrap_or_default()
            .contains("#EXT-X-ENDLIST")
            && fixture.state.playback.producers.load(Ordering::Acquire) == 0
        {
            break;
        }
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(fixture.state.playback.producers.load(Ordering::Acquire), 0);
    let retained = seek(
        State(fixture.state.clone()),
        HeaderMap::new(),
        Path(created.id.clone()),
        Json(SeekInput {
            position_seconds: 6.0,
            generation: 1,
            audio_index: None,
        }),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(retained.generation, 1);
    assert_eq!(retained.url, promoted.url);
    assert_eq!(handle.lock().await.position, 1.0);
    assert_eq!(
        seek(
            State(fixture.state.clone()),
            HeaderMap::new(),
            Path(created.id.clone()),
            Json(SeekInput {
                position_seconds: 2.0,
                generation: 0,
                audio_index: None
            })
        )
        .await
        .err()
        .unwrap()
        .status,
        StatusCode::CONFLICT
    );
    std::fs::remove_file(dir.join("segment-000000.m4s")).unwrap();
    let restarted = seek(
        State(fixture.state.clone()),
        HeaderMap::new(),
        Path(created.id.clone()),
        Json(SeekInput {
            position_seconds: 0.0,
            generation: 1,
            audio_index: None,
        }),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(restarted.id, created.id);
    assert_eq!(restarted.generation, 2);
    assert_eq!(restarted.audio_index, Some(2));
    assert_eq!(restarted.duration_seconds, promoted.duration_seconds);
    assert_eq!(
        segment(
            State(fixture.state.clone()),
            Path((created.id.clone(), 1, "init.mp4".into())),
            Request::new(axum::body::Body::empty())
        )
        .await
        .err()
        .unwrap()
        .status,
        StatusCode::CONFLICT
    );
    // The generation becomes inaccessible immediately; process/directory retirement runs
    // after publishing its replacement so cleanup cannot delay the seek response.
    tokio::time::timeout(Duration::from_secs(3), async {
        while dir.exists() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("Retired playback generation was not cleaned up.");
    let a = seek(
        State(fixture.state.clone()),
        HeaderMap::new(),
        Path(created.id.clone()),
        Json(SeekInput {
            position_seconds: 2.0,
            generation: 2,
            audio_index: Some(1),
        }),
    );
    let b = seek(
        State(fixture.state.clone()),
        HeaderMap::new(),
        Path(created.id.clone()),
        Json(SeekInput {
            position_seconds: 3.0,
            generation: 2,
            audio_index: Some(1),
        }),
    );
    let (a, b) = tokio::join!(a, b);
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    assert_eq!(
        a.err().or_else(|| b.err()).unwrap().status,
        StatusCode::CONFLICT
    );
    stop(
        State(fixture.state.clone()),
        Path(created.id.clone()),
        HeaderMap::new(),
    )
    .await
    .unwrap();
    assert_eq!(fixture.state.playback.producers.load(Ordering::Acquire), 0);
    assert!(
        fixture
            .state
            .playback
            .session_details(&created.id)
            .await
            .is_none()
    );
    assert_eq!(std::fs::read(&fixture.file).unwrap(), original);
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
async fn compatible_original_sessions_prefer_direct_and_never_start_playback_jobs() {
    let mut data = original_mkv_probe();
    data["chapters"] = json!([{"start_time":"20","tags":{"title":"Chapter 1"}}]);
    data["streams"].as_array_mut().unwrap().push(json!({"index":4,"codec_type":"attachment","codec_name":"ttf","tags":{"filename":"Cover.ttf"}}));
    let fixture = video_fixture(b"0123456789", data).await;
    let metadata = info(
        State(fixture.state.clone()),
        HeaderMap::new(),
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
            HeaderMap::new(),
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
    stop(
        State(fixture.state.clone()),
        Path(response.id.clone()),
        HeaderMap::new(),
    )
    .await
    .unwrap();
    assert!(
        fixture
            .state
            .playback
            .session_details(&response.id)
            .await
            .is_none()
    );
    assert_eq!(std::fs::read(&fixture.file).unwrap(), b"0123456789");
}

#[tokio::test]
async fn direct_only_conversion_requests_fail_before_inspection_or_allocation() {
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
            HeaderMap::new(),
            Path((fixture.library.clone(), "unavailable-item".into())),
            Json(SessionInput {
                direct_only: true,
                ..request
            }),
        )
        .await
        .err()
        .unwrap();
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
        assert!(error.detail.contains("Direct-only") || error.detail.contains("burn-in"));
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
    for uri in [format!(
        "/api/playback/sessions/{}/hls/index.m3u8",
        response.id
    )] {
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
    assert!(
        create(
            State(fixture.state.clone()),
            HeaderMap::new(),
            Path((fixture.library.clone(), fixture.item.clone())),
            Json(alternate)
        )
        .await
        .is_err()
    );
    let selected = create(
        State(fixture.state.clone()),
        HeaderMap::new(),
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
            ..Default::default()
        }),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(
        valid,
        json!({"ok":true,"method":"direct","encoder":null,"generation":0,"transcoding":false,"throttled":false,"fps":null,"speed":null})
    );
    fixture
        .state
        .playback
        .sessions
        .lock()
        .await
        .get(&response.id)
        .unwrap()
        .lock()
        .await
        .touched = Instant::now() - SESSION_IDLE - Duration::from_secs(1);
    assert!(
        fixture
            .state
            .playback
            .session_details(&response.id)
            .await
            .is_none()
    );
    fixture.state.playback.maintain().await;
    assert!(fixture.state.playback.sessions.lock().await.is_empty());
    let response = direct(&fixture).await;
    std::fs::write(&fixture.file, b"source changed").unwrap();
    assert!(
        fixture
            .state
            .playback
            .session_details(&response.id)
            .await
            .is_none()
    );
    assert!(
        stream(
            State(fixture.state.clone()),
            Path(response.id.clone()),
            axum::http::Request::new(axum::body::Body::empty())
        )
        .await
        .is_err()
    );
    assert!(
        heartbeat(
            State(fixture.state.clone()),
            Path(response.id.clone()),
            HeaderMap::new(),
            Json(Heartbeat {
                position_seconds: 60.0,
                paused: true,
                ..Default::default()
            })
        )
        .await
        .is_err()
    );
    stop(
        State(fixture.state.clone()),
        Path(response.id),
        HeaderMap::new(),
    )
    .await
    .unwrap();
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
        HeaderMap::new(),
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
    assert!(
        heartbeat(
            State(fixture.state.clone()),
            Path(response.id.clone()),
            HeaderMap::new(),
            Json(Heartbeat {
                position_seconds: 600.0,
                paused: false,
                ..Default::default()
            })
        )
        .await
        .is_ok()
    );
    for position in [f64::NAN, -1.0, f64::INFINITY, MAX_PLAYBACK_SECONDS + 1.0] {
        assert_eq!(
            heartbeat(
                State(fixture.state.clone()),
                Path(response.id.clone()),
                HeaderMap::new(),
                Json(Heartbeat {
                    position_seconds: position,
                    paused: false,
                    ..Default::default()
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
    let resolved = source(
        &fixture.state,
        fixture.library.clone(),
        fixture.item.clone(),
    )
    .await
    .unwrap();
    let mut sessions = fixture.state.playback.sessions.lock().await;
    for number in 1..MAX_SESSIONS {
        sessions.insert(
            number.to_string(),
            Arc::new(Mutex::new(Session {
                preparation: None,
                next_generation: 1,
                owner: fixture
                    .state
                    .auth
                    .request_user(&HeaderMap::new())
                    .unwrap()
                    .id,
                source: resolved.clone(),
                probe: original_mkv_probe(),
                input: original_mkv_input(),
                response: response.clone(),
                touched: Instant::now(),
                producer: None,
                position: 0.0,
                paused: false,
                speed: 1.0,
                closed: false,
            })),
        );
    }
    drop(sessions);
    assert_eq!(
        create(
            State(fixture.state.clone()),
            HeaderMap::new(),
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
        session.lock().await.touched = Instant::now() - SESSION_IDLE - Duration::from_secs(1);
    }
    assert_eq!(direct(&fixture).await.method, "direct");
    assert_eq!(fixture.state.playback.sessions.lock().await.len(), 1);
}

#[tokio::test]
async fn queued_seek_cannot_resurrect_a_stopped_session() {
    let fixture = video_fixture(b"unchanged original", original_mkv_probe()).await;
    let created = direct(&fixture).await;
    // A request may retain its lookup handle while DELETE waits to authorize ownership.
    // DELETE must keep the session registered until it can check the owner under this lock.
    let pending = handle(&fixture.state.playback, &created.id).await.unwrap();
    let guard = pending.lock().await;
    let stop_state = fixture.state.clone();
    let stop_id = created.id.clone();
    let (started, ready) = tokio::sync::oneshot::channel();
    let stopping = tokio::spawn(async move {
        started.send(()).unwrap();
        stop(State(stop_state), Path(stop_id), HeaderMap::new()).await
    });
    ready.await.unwrap();
    tokio::task::yield_now().await;
    assert!(!stopping.is_finished());
    assert!(!guard.closed);
    assert!(
        fixture
            .state
            .playback
            .sessions
            .lock()
            .await
            .contains_key(&created.id)
    );
    drop(guard);
    assert_eq!(stopping.await.unwrap().unwrap(), StatusCode::NO_CONTENT);
    // A stale lookup resumed after deletion cannot prepare or register a new generation.
    let error = seek_session(
        fixture.state.clone(),
        created.id.clone(),
        pending.clone(),
        SeekInput {
            position_seconds: 10.0,
            generation: 0,
            audio_index: None,
        },
    )
    .await
    .err()
    .unwrap();
    assert_eq!(error.status, StatusCode::BAD_REQUEST);
    let stopped = pending.lock().await;
    assert!(stopped.closed);
    assert!(validate_session(&stopped).is_err());
    assert!(stopped.producer.is_none());
    drop(stopped);
    assert!(
        fixture
            .state
            .playback
            .session_details(&created.id)
            .await
            .is_none()
    );
    assert!(fixture.state.playback.sessions.lock().await.is_empty());
    assert_eq!(fixture.state.playback.producers.load(Ordering::Acquire), 0);
    assert!(!fixture.state.playback.root.exists());
    assert_eq!(std::fs::read(&fixture.file).unwrap(), b"unchanged original");
}

#[tokio::test]
async fn canceled_preparation_is_swept_after_session_expiry_without_touching_unrelated_files() {
    let fixture = video_fixture(b"placeholder", test_support::probe()).await;
    let mut cmd = command("ffmpeg");
    cmd.args([
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=160x90:rate=25:duration=120",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=120",
        "-map",
        "0:v",
        "-map",
        "1:a",
        "-c:v",
        "libx264",
        "-threads",
        "1",
        "-g",
        "2500",
        "-sc_threshold",
        "0",
        "-c:a",
        "aac",
    ])
    .arg(&fixture.file);
    run(
        &mut cmd,
        Duration::from_secs(15),
        "Canceled preparation fixture",
    )
    .await
    .unwrap();
    fixture.state.playback.probes.lock().await.clear();
    save_policy(&fixture, crate::transcoding::Settings::default());
    let original = std::fs::read(&fixture.file).unwrap();
    let state = fixture.state.clone();
    let library = fixture.library.clone();
    let item = fixture.item.clone();
    let creating = tokio::spawn(async move {
        create(
            State(state),
            HeaderMap::new(),
            Path((library, item)),
            Json(input()),
        )
        .await
    });
    let root = fixture.state.playback.root.join("posterview-playback");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let abandoned = loop {
        assert!(
            !creating.is_finished(),
            "The long-GOP producer must still be preparing when canceled."
        );
        let pending = std::fs::read_dir(&root)
            .into_iter()
            .flatten()
            .flatten()
            .find_map(|entry| {
                let owner: Value =
                    serde_json::from_slice(&std::fs::read(entry.path().join("owner.json")).ok()?)
                        .ok()?;
                owner["pid"].as_u64().map(|_| entry.path())
            });
        if let Some(path) = pending {
            break path;
        }
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    assert!(abandoned.join("owner.json").is_file());
    creating.abort();
    let canceled = match creating.await {
        Err(error) => error,
        Ok(_) => panic!("Canceled preparation unexpectedly completed."),
    };
    assert!(canceled.is_cancelled());
    assert_eq!(fixture.state.playback.producers.load(Ordering::Acquire), 0);
    let unrelated = root.join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir(&unrelated).unwrap();
    std::fs::write(unrelated.join("user.txt"), b"keep").unwrap();
    std::fs::write(root.join("user.txt"), b"keep").unwrap();
    let handles = fixture
        .state
        .playback
        .sessions
        .lock()
        .await
        .values()
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(handles.len(), 1);
    for handle in handles {
        let mut session = handle.lock().await;
        assert!(session.producer.is_none());
        session.touched = Instant::now() - SESSION_IDLE - Duration::from_secs(1);
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    // Cancellation retries directory cleanup independently of session expiry.
    // Wait for both outcomes, even if the directory is already gone.
    loop {
        fixture.state.playback.maintain().await;
        if !abandoned.exists() && fixture.state.playback.sessions.lock().await.is_empty() {
            break;
        }
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(fixture.state.playback.sessions.lock().await.is_empty());
    assert_eq!(segmented::total_bytes(&fixture.state.playback), 0);
    assert_eq!(std::fs::read(unrelated.join("user.txt")).unwrap(), b"keep");
    assert_eq!(std::fs::read(root.join("user.txt")).unwrap(), b"keep");
    assert_eq!(std::fs::read(&fixture.file).unwrap(), original);
}

#[tokio::test]
async fn sweep_rechecks_new_sessions_and_retries_locked_files_without_losing_marker() {
    let fixture = video_fixture(b"original", original_mkv_probe()).await;
    let old_snapshot = HashSet::new();
    let created = direct(&fixture).await;
    let root = fixture.state.playback.root.join("posterview-playback");
    let dir = root.join(format!("{}.g1", created.id));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("owner.json"),
        json!({"id":created.id,"instance":fixture.state.playback.instance,"pid":null}).to_string(),
    )
    .unwrap();
    std::fs::write(dir.join("init.mp4"), b"cached fragment").unwrap();
    fixture
        .state
        .playback
        .cache_roots
        .lock()
        .unwrap()
        .insert(root.canonicalize().unwrap());
    segmented::sweep_abandoned(&fixture.state.playback, &old_snapshot).await;
    assert!(
        dir.join("init.mp4").is_file(),
        "A session added after the snapshot must survive cleanup."
    );
    #[cfg(windows)]
    let locked = {
        use std::os::windows::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(dir.join("init.mp4"))
            .unwrap()
    };
    stop(
        State(fixture.state.clone()),
        Path(created.id),
        HeaderMap::new(),
    )
    .await
    .unwrap();
    fixture.state.playback.maintain().await;
    #[cfg(windows)]
    {
        assert!(
            dir.join("owner.json").is_file(),
            "Failed unlink must retain ownership for the next tick."
        );
        drop(locked);
        fixture.state.playback.maintain().await;
    }
    assert!(!dir.exists());
    assert_eq!(std::fs::read(&fixture.file).unwrap(), b"original");
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
async fn resource_sweep_removes_abandoned_outputs_but_preserves_live_cached_and_unrelated_files() {
    let directory = tempfile::tempdir().unwrap();
    let store = PlaybackStore::new(directory.path());
    let root = store.root.join("resources");
    std::fs::create_dir_all(&root).unwrap();
    let abandoned = root.join(format!("{}.sup", uuid::Uuid::new_v4()));
    std::fs::write(&abandoned, b"partial bitmap").unwrap();
    let cached = root.join(format!("{}.vtt", uuid::Uuid::new_v4()));
    std::fs::write(&cached, b"cached subtitle").unwrap();
    let active = root.join(format!("{}.mks", uuid::Uuid::new_v4()));
    let unrelated = root.join("user.font");
    std::fs::write(&unrelated, b"keep").unwrap();
    let unknown = root.join(format!("{}.txt", uuid::Uuid::new_v4()));
    std::fs::write(&unknown, b"keep").unwrap();
    let nested = root.join(format!("{}.font", uuid::Uuid::new_v4()));
    std::fs::create_dir(&nested).unwrap();
    let target = directory.path().join("original.txt");
    std::fs::write(&target, b"original").unwrap();
    let link = root.join(format!("{}.sup", uuid::Uuid::new_v4()));
    #[cfg(unix)]
    let linked = std::os::unix::fs::symlink(&target, &link).is_ok();
    #[cfg(windows)]
    let linked = std::os::windows::fs::symlink_file(&target, &link).is_ok();
    let mut fill = store.resources.lock().await;
    fill.insert(
        (directory.path().join("source.mkv"), 1, 1, 0, "vtt".into()),
        ResourceCache {
            path: cached.clone(),
            bytes: 15,
            used: Instant::now(),
        },
    );
    std::fs::write(&active, b"live extraction").unwrap();
    store.sweep_resources();
    assert!(active.exists());
    assert!(abandoned.exists());
    drop(fill); // Simulate cancellation before inserting the active output.
    store.maintain().await;
    assert!(!active.exists());
    assert!(!abandoned.exists());
    assert!(cached.exists());
    assert!(unrelated.exists());
    assert!(unknown.exists());
    assert!(nested.is_dir());
    if linked {
        assert!(
            std::fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }
    assert_eq!(std::fs::read(target).unwrap(), b"original");
    assert_eq!(store.resources.lock().await.len(), 1);
}

#[test]
fn resource_sweep_limits_each_tick_and_retries_remaining_generated_outputs() {
    let directory = tempfile::tempdir().unwrap();
    let store = PlaybackStore::new(directory.path());
    let root = store.root.join("resources");
    std::fs::create_dir_all(&root).unwrap();
    for _ in 0..35 {
        std::fs::write(
            root.join(format!("{}.font", uuid::Uuid::new_v4())),
            b"abandoned",
        )
        .unwrap();
    }
    store.sweep_resources();
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 3);
    store.sweep_resources();
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
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
        HeaderMap::new(),
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
            Request::new(axum::body::Body::empty()),
        )
        .await
        .unwrap();
        assert_eq!(first.headers()[header::CONTENT_TYPE], mime);
        let first = first.into_body().collect().await.unwrap().to_bytes();
        assert!(String::from_utf8_lossy(&first).contains(expected));
        let second = subtitle(
            State(fixture.state.clone()),
            Path((fixture.library.clone(), fixture.item.clone(), index)),
            Request::new(axum::body::Body::empty()),
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
        HeaderMap::new(),
        Path((fixture.library.clone(), fixture.item.clone(), 4)),
    )
    .await
    .unwrap();
    assert_eq!(font.headers()[header::CONTENT_TYPE], "font/ttf");
    assert_eq!(fixture.state.playback.resources.lock().await.len(), 3);
    let response = create(
        State(fixture.state.clone()),
        HeaderMap::new(),
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
    stop(
        State(fixture.state.clone()),
        Path(response.id),
        HeaderMap::new(),
    )
    .await
    .unwrap();
    assert_eq!(std::fs::read(&fixture.file).unwrap(), source_bytes);
    assert!(
        !fixture
            .state
            .playback
            .root
            .join("posterview-playback")
            .exists()
    );
}

#[tokio::test]
async fn session_resources_reject_another_account_even_an_administrator() {
    let fixture = video_fixture(b"0123456789", original_mkv_probe()).await;
    let response = direct(&fixture).await;
    let owner = fixture.state.auth.request_user(&HeaderMap::new()).unwrap();
    let mut other = owner.clone();
    other.id = "other-admin".into();
    assert!(
        authorize_session(&fixture.state, &response.id, &owner)
            .await
            .is_ok()
    );
    assert_eq!(
        authorize_session(&fixture.state, &response.id, &other)
            .await
            .unwrap_err()
            .status,
        StatusCode::NOT_FOUND
    );
    assert!(
        fixture
            .state
            .playback
            .session_details_for(&response.id, &other.id)
            .await
            .is_err()
    );
    assert!(
        fixture
            .state
            .playback
            .session_details_for(&response.id, &owner.id)
            .await
            .unwrap()
            .is_some()
    );
}

async fn gated_seek(
    fixture: &VideoFixture,
    id: &str,
    generation: u64,
) -> (
    Arc<PreparationGate>,
    tokio::task::JoinHandle<Result<Json<SessionResponse>, HttpError>>,
) {
    save_policy(fixture, crate::transcoding::Settings::default());
    {
        let session = handle(&fixture.state.playback, id).await.unwrap();
        let mut session = session.lock().await;
        session.input.hls_supported = true;
        session.input.hls_video_codecs = vec!["hevc".into()];
        session.input.hls_audio_codecs = vec!["opus".into()];
    }
    let gate = Arc::new(PreparationGate::default());
    *fixture.state.playback.preparation_gate.lock().await = Some(gate.clone());
    let state = fixture.state.clone();
    let id = id.to_owned();
    let task = tokio::spawn(async move {
        seek(
            State(state),
            HeaderMap::new(),
            Path(id),
            Json(SeekInput {
                position_seconds: 30.0,
                generation,
                audio_index: Some(2),
            }),
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(2), gate.entered.notified())
        .await
        .unwrap();
    (gate, task)
}
#[tokio::test]
async fn stop_cancels_preparation_without_waiting_for_media_work() {
    let fixture = video_fixture(b"original", original_mkv_probe()).await;
    let initial = direct(&fixture).await;
    let (_gate, preparing) = gated_seek(&fixture, &initial.id, initial.generation).await;
    let owner = fixture.state.auth.request_user(&HeaderMap::new()).unwrap();
    let mut other = owner.clone();
    other.id = "another-account".into();
    assert!(
        authorize_session(&fixture.state, &initial.id, &other)
            .await
            .is_err()
    );
    assert!(
        fixture
            .state
            .playback
            .sessions
            .lock()
            .await
            .contains_key(&initial.id)
    );
    let stopped = tokio::time::timeout(
        Duration::from_secs(1),
        stop(
            State(fixture.state.clone()),
            Path(initial.id.clone()),
            HeaderMap::new(),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(stopped, StatusCode::NO_CONTENT);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), preparing)
            .await
            .unwrap()
            .unwrap()
            .err()
            .unwrap()
            .status,
        StatusCode::CONFLICT
    );
    assert!(fixture.state.playback.sessions.lock().await.is_empty());
}
#[tokio::test]
async fn superseding_seek_cancels_preparation_and_failed_replacement_keeps_direct_delivery() {
    let fixture = video_fixture(b"original", original_mkv_probe()).await;
    let initial = direct(&fixture).await;
    let (_first_gate, first) = gated_seek(&fixture, &initial.id, 0).await;
    // The current direct generation stays available while its replacement warms.
    assert!(session_path(&fixture.state, &initial.id).await.is_ok());
    let (second_gate, second) = gated_seek(&fixture, &initial.id, 0).await;
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), first)
            .await
            .unwrap()
            .unwrap()
            .err()
            .unwrap()
            .status,
        StatusCode::CONFLICT
    );
    second_gate.release.notify_one();
    assert!(second.await.unwrap().is_err());
    assert!(session_path(&fixture.state, &initial.id).await.is_ok());
    let handle = handle(&fixture.state.playback, &initial.id).await.unwrap();
    let session = handle.lock().await;
    assert_eq!(session.response.generation, 0);
    assert!(session.preparation.is_none());
    assert_eq!(session.next_generation, 3);
}

#[tokio::test]
async fn inspection_rechecks_cache_after_waiting_for_a_job_permit() {
    let fixture = video_fixture(b"not a real media file", original_mkv_probe()).await;
    let source = source(
        &fixture.state,
        fixture.library.clone(),
        fixture.item.clone(),
    )
    .await
    .unwrap();
    fixture.state.playback.probes.lock().await.clear();
    let permits = fixture.state.playback.jobs.acquire_many(2).await.unwrap();
    let store = fixture.state.playback.clone();
    let inspected = source.clone();
    let waiting = tokio::spawn(async move { store.probe(&inspected).await });
    tokio::task::yield_now().await;
    fixture.state.playback.probes.lock().await.insert(
        source.path.clone(),
        ProbeCache {
            stamp: source.fingerprint,
            probe: original_mkv_probe(),
            used: Instant::now(),
        },
    );
    drop(permits);
    let result = waiting.await.unwrap().unwrap();
    assert_eq!(result, original_mkv_probe());
}

#[tokio::test]
async fn source_replacement_during_preparation_cannot_publish_a_generation() {
    let fixture = video_fixture(b"original", original_mkv_probe()).await;
    let initial = direct(&fixture).await;
    let retained = handle(&fixture.state.playback, &initial.id).await.unwrap();
    let (gate, preparing) = gated_seek(&fixture, &initial.id, 0).await;
    std::fs::write(&fixture.file, b"replacement with different fingerprint").unwrap();
    gate.release.notify_one();
    let error = preparing.await.unwrap().err().unwrap();
    assert_eq!(error.status, StatusCode::BAD_REQUEST);
    assert!(error.detail.contains("file changed"));
    assert!(fixture.state.playback.sessions.lock().await.is_empty());
    let session = retained.lock().await;
    assert!(session.closed);
    assert_eq!(session.response.generation, 0);
    assert!(session.preparation.is_none());
    assert!(session.producer.is_none());
}
