//! Cross-boundary delivery, media processing, and cleanup tests.

use super::test_support::{
    conversion_settings, input, original_mkv_input, original_mkv_probe, probe,
};
use super::*;
use serde_json::json;
#[test]
fn copied_video_can_fill_ahead_faster_without_changing_transcode_or_windows_pacing() {
    for method in ["remux", "audio_transcode"] {
        assert_eq!(throttled_readrate(method, true), "8");
        assert_eq!(throttled_readrate(method, false), "1");
    }
    assert_eq!(throttled_readrate("transcode", true), "4");
    assert_eq!(throttled_readrate("transcode", false), "1");
    let directory = tempfile::tempdir().unwrap();
    let file = directory.path().join("copy.mkv");
    std::fs::write(&file, b"fixture").unwrap();
    let source = super::test_support::source(&file);
    let settings = conversion_settings();
    let mut data = probe();
    data["streams"][0]["codec_name"] = json!("hevc");
    let mut request = input();
    request.video_codecs = vec!["hevc".into()];
    for audio_index in [None, Some(2)] {
        request.audio_index = audio_index;
        let chosen = plan(&data, "mkv", &request, &settings).unwrap();
        assert_eq!(
            chosen.method,
            if audio_index.is_some() {
                "audio_transcode"
            } else {
                "remux"
            }
        );
        let command = hls_command(
            &source,
            &data,
            &chosen,
            &request,
            &settings,
            None,
            directory.path(),
        )
        .unwrap();
        let args = command
            .as_std()
            .get_args()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-readrate", if cfg!(unix) { "8" } else { "1" }]));
        assert!(args.windows(2).any(|pair| pair == ["-c:v", "copy"]));
        assert!(args.windows(2).any(|pair| pair == ["-hls_time", "4"]));
        assert!(!args.iter().any(|argument| argument == "-force_key_frames"));
        assert!(!args
            .iter()
            .any(|argument| argument.contains("split_by_time")));
        let unthrottled = Settings {
            throttle: false,
            ..settings.clone()
        };
        let command = hls_command(
            &source,
            &data,
            &chosen,
            &request,
            &unthrottled,
            None,
            directory.path(),
        )
        .unwrap();
        assert!(!command
            .as_std()
            .get_args()
            .any(|argument| argument == "-readrate"));
    }
}
#[test]
fn throttling_keeps_separate_suspend_and_resume_thresholds_at_small_buffer_limits() {
    assert_eq!(throttle_actions(10, false, 11.0), (true, false));
    assert_eq!(throttle_actions(10, false, 4.0), (false, true));
    assert_eq!(throttle_actions(600, true, 13.0), (true, false));
    for cap in 10..=600 {
        assert_eq!(
            throttle_actions(cap, false, f64::from(cap) * 0.75),
            (false, false)
        );
        assert!(
            !throttle_actions(cap, true, 0.0).1,
            "A paused job must not resume itself."
        );
    }
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
fn audio_boost_applies_only_to_multichannel_downmixing() {
    let directory = tempfile::tempdir().unwrap();
    let file = directory.path().join("fixture.mkv");
    std::fs::write(&file, b"fixture").unwrap();
    let source = super::test_support::source(&file);
    let settings = Settings {
        audio_boost: 2.0,
        ..conversion_settings()
    };
    let mut data = probe();
    data["streams"][1]["codec_name"] = json!("opus");
    let request = input();
    let chosen = plan(&data, "mkv", &request, &settings).unwrap();
    assert!(chosen.convert_audio);
    let command = hls_command(
        &source,
        &data,
        &chosen,
        &request,
        &settings,
        None,
        directory.path(),
    )
    .unwrap();
    let args = command
        .as_std()
        .get_args()
        .map(|value| value.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert!(
        !args.iter().any(|argument| argument == "-af"),
        "Stereo conversion must not receive downmix gain."
    );
    let mut request = input();
    request.audio_index = Some(2);
    let chosen = plan(&data, "mkv", &request, &settings).unwrap();
    let command = hls_command(
        &source,
        &data,
        &chosen,
        &request,
        &settings,
        None,
        directory.path(),
    )
    .unwrap();
    let args = command
        .as_std()
        .get_args()
        .map(|value| value.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert!(args.windows(2).any(|pair| pair == ["-af", "volume=2"]));
}
#[tokio::test]
async fn unknown_duration_heartbeats_keep_real_positions_with_bounded_validation() {
    let directory = tempfile::tempdir().unwrap();
    let state = crate::test_support::state(directory.path());
    let file = directory.path().join("fixture.mkv");
    std::fs::write(&file, b"fixture").unwrap();
    let source = super::test_support::source(&file);
    let id = uuid::Uuid::new_v4().to_string();
    let response = SessionResponse {
        id: id.clone(),
        method: "direct".into(),
        reason: "Fixture".into(),
        url: String::new(),
        mime: "video/mp4".into(),
        offset_seconds: 0.0,
        duration_seconds: 0.0,
        encoder: None,
        audio_index: None,
    };
    state.playback.sessions.lock().await.insert(
        id.clone(),
        Session {
            library_id: source.library_id,
            item_id: source.item.id,
            source: source.path,
            stamp: source.fingerprint,
            directory: None,
            response,
            child: None,
            touched: Instant::now() - Duration::from_secs(100),
            position: 0.0,
            buffer_seconds: 0,
            paused: false,
            suspended: false,
            cache_limit: 1024 * 1024 * 1024,
            error: None,
        },
    );
    let response = heartbeat(
        State(state.clone()),
        Path(id.clone()),
        HeaderMap::new(),
        Json(Heartbeat {
            position_seconds: 600.0,
            paused: false,
        }),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(response["ok"], true);
    let sessions = state.playback.sessions.lock().await;
    let saved = sessions.get(&id).unwrap();
    assert_eq!(saved.position, 600.0);
    assert!(saved.touched.elapsed() < Duration::from_secs(1));
    drop(sessions);
    for position in [f64::NAN, -1.0, MAX_PLAYBACK_SECONDS + 1.0] {
        assert!(heartbeat(
            State(state.clone()),
            Path(id.clone()),
            HeaderMap::new(),
            Json(Heartbeat {
                position_seconds: position,
                paused: false
            })
        )
        .await
        .is_err());
    }
    state.playback.stop_id(&id).await;
}
#[test]
fn segment_paths_cannot_escape_session() {
    for good in ["index.m3u8", "init.mp4", "segment-000001.m4s"] {
        assert!(safe_segment(good), "{good}");
    }
    for bad in [
        "../index.m3u8",
        "/init.mp4",
        "segment-a00001.m4s",
        "segment-000001.m4s/..",
        "ffmpeg.log",
        "segment-000001.m4s.tmp",
    ] {
        assert!(!safe_segment(bad), "{bad}");
    }
}
#[test]
fn retires_only_owned_orphan_directories() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let owned = uuid::Uuid::new_v4().to_string();
    let owned_dir = root.join(&owned);
    std::fs::create_dir(&owned_dir).unwrap();
    std::fs::write(
        owned_dir.join("owner.json"),
        serde_json::to_vec(&SessionOwner {
            id: owned,
            instance: "older-server".into(),
            pid: None,
        })
        .unwrap(),
    )
    .unwrap();
    std::fs::write(owned_dir.join("segment-000001.m4s"), b"old segment").unwrap();
    let foreign = uuid::Uuid::new_v4().to_string();
    let foreign_dir = root.join(&foreign);
    std::fs::create_dir(&foreign_dir).unwrap();
    std::fs::write(
        foreign_dir.join("owner.json"),
        serde_json::to_vec(&SessionOwner {
            id: foreign,
            instance: "older-server".into(),
            pid: None,
        })
        .unwrap(),
    )
    .unwrap();
    std::fs::write(foreign_dir.join("unrelated-document.txt"), b"keep this").unwrap();
    retire_orphans(&root, "new-server");
    assert!(!owned_dir.exists());
    assert!(foreign_dir.exists());
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
async fn original_dual_audio_mkv_uses_ranges_and_rejects_conversion_before_jobs() {
    use http_body_util::BodyExt;
    use posterview_contracts::native::{
        AnimeContent, NativeLibraryInput, NativeLibraryOptions, NativeLibraryType,
    };
    let directory = tempfile::tempdir().unwrap();
    let state = crate::test_support::state(directory.path());
    let file = directory.path().join("media/Movies/Original.mkv");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    // Cached media metadata lets this delivery/policy fixture run without FFmpeg.
    std::fs::write(&file, b"0123456789").unwrap();
    let database = ServerStore::new(state.runtime.data_dir());
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
                metadata: json!({}),
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
            probe: original_mkv_probe(),
            used: Instant::now(),
        },
    );
    let metadata = info(
        State(state.clone()),
        Path((library.id.clone(), item.id.clone())),
    )
    .await
    .unwrap()
    .0;
    assert!(!metadata.conversion_allowed);
    assert_eq!(metadata.container, "mkv");
    assert_eq!(
        metadata
            .tracks
            .iter()
            .filter(|track| track.kind == "audio")
            .count(),
        2
    );
    let response = create(
        State(state.clone()),
        Path((library.id.clone(), item.id.clone())),
        Json(SessionInput {
            position_seconds: 50.0,
            subtitle_index: Some(3),
            ..original_mkv_input()
        }),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(response.method, "direct");
    assert_eq!(response.mime, "video/x-matroska");
    assert_eq!(response.offset_seconds, 0.0);
    assert_eq!(response.audio_index, Some(1));
    assert!(response.encoder.is_none());
    let sessions = state.playback.sessions.lock().await;
    let saved = sessions.get(&response.id).unwrap();
    assert!(saved.child.is_none());
    assert!(saved.directory.is_none());
    drop(sessions);
    let request = axum::http::Request::builder()
        .header(header::RANGE, "bytes=2-4")
        .body(axum::body::Body::empty())
        .unwrap();
    let delivery = stream(State(state.clone()), Path(response.id.clone()), request)
        .await
        .unwrap();
    assert_eq!(delivery.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(delivery.headers()[header::CONTENT_TYPE], "video/x-matroska");
    assert_eq!(delivery.headers()[header::CONTENT_RANGE], "bytes 2-4/10");
    assert_eq!(
        delivery.into_body().collect().await.unwrap().to_bytes(),
        "234"
    );
    state.playback.stop_id(&response.id).await;
    let cases = [
        (
            SessionInput {
                audio_index: Some(2),
                ..original_mkv_input()
            },
            "cannot select the requested audio track",
        ),
        (
            SessionInput {
                containers: vec!["mp4".into()],
                ..original_mkv_input()
            },
            "original container",
        ),
        (
            SessionInput {
                video_codecs: vec!["h264".into()],
                ..original_mkv_input()
            },
            "video profile",
        ),
        (
            SessionInput {
                max_height: 720,
                ..original_mkv_input()
            },
            "requested quality",
        ),
        (
            SessionInput {
                subtitle_burn_index: Some(3),
                ..original_mkv_input()
            },
            "video rendering",
        ),
        (
            SessionInput {
                force_transcode: true,
                ..original_mkv_input()
            },
            "converted stream",
        ),
    ];
    for (request, reason) in cases {
        let error = create(
            State(state.clone()),
            Path((library.id.clone(), item.id.clone())),
            Json(request),
        )
        .await
        .err()
        .unwrap();
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
        assert!(error.detail.contains(reason), "{}", error.detail);
        assert!(state.playback.sessions.lock().await.is_empty());
        assert!(state.playback.hardware.lock().await.is_empty());
        assert!(state.playback.resources.lock().await.is_empty());
        assert!(!state.playback.root.join("posterview-playback").exists());
    }
    let native_selection = create(
        State(state.clone()),
        Path((library.id.clone(), item.id.clone())),
        Json(SessionInput {
            audio_index: Some(2),
            native_audio_tracks: true,
            ..original_mkv_input()
        }),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(native_selection.method, "direct");
    assert_eq!(native_selection.audio_index, Some(2));
    state.playback.stop_id(&native_selection.id).await;
    database
        .set_setting(
            "transcoding-settings",
            &serde_json::to_string(&conversion_settings()).unwrap(),
        )
        .unwrap();
    assert!(
        info(State(state.clone()), Path((library.id, item.id)))
            .await
            .unwrap()
            .0
            .conversion_allowed
    );
}
#[test]
fn conversion_disabled_cannot_construct_a_segmented_playback_command() {
    let directory = tempfile::tempdir().unwrap();
    let file = directory.path().join("fixture.mkv");
    std::fs::write(&file, b"fixture").unwrap();
    let source = super::test_support::source(&file);
    let data = probe();
    let request = input();
    let chosen = plan(&data, "mkv", &request, &conversion_settings()).unwrap();
    assert!(hls_command(
        &source,
        &data,
        &chosen,
        &request,
        &Settings::default(),
        None,
        directory.path()
    )
    .err()
    .unwrap()
    .detail
    .contains("Conversion and remuxing are disabled"));
}
#[tokio::test]
async fn copied_hevc_main10_with_opus_preserves_long_gop_video_and_converts_only_audio() {
    if command("ffmpeg").arg("-version").status().await.is_err() {
        eprintln!("FFmpeg not installed; HEVC playback fixture skipped.");
        return;
    }
    let directory = tempfile::tempdir().unwrap();
    let video = directory.path().join("long-gop.mkv");
    let mut generate = command("ffmpeg");
    generate
        .args([
            "-nostdin",
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=96x64:rate=10:duration=14",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=14",
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-c:v",
            "libx265",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p10le",
            "-threads",
            "1",
            "-x265-params",
            "keyint=70:min-keyint=70:scenecut=0:open-gop=0:pools=1:frame-threads=1:log-level=error",
            "-c:a",
            "libopus",
            "-ac",
            "2",
        ])
        .arg(&video);
    run(
        &mut generate,
        Duration::from_secs(20),
        "HEVC playback fixture creation",
    )
    .await
    .unwrap();
    let source = super::test_support::source(&video);
    let store = PlaybackStore::new(directory.path());
    let data = store.probe(&source).await.unwrap();
    let mut request = input();
    request.video_codecs = vec!["hevc".into()];
    let settings = Settings {
        throttle: false,
        ..conversion_settings()
    };
    let chosen = plan(&data, "mkv", &request, &settings).unwrap();
    assert_eq!(chosen.method, "audio_transcode");
    assert_eq!(chosen.video["codec_name"], "hevc");
    assert_eq!(chosen.video["pix_fmt"], "yuv420p10le");
    assert_eq!(chosen.audio.as_ref().unwrap()["codec_name"], "opus");
    let output = directory.path().join("hls");
    std::fs::create_dir(&output).unwrap();
    let mut convert =
        hls_command(&source, &data, &chosen, &request, &settings, None, &output).unwrap();
    run(
        &mut convert,
        Duration::from_secs(20),
        "HEVC copied playback",
    )
    .await
    .unwrap();
    let playlist = std::fs::read_to_string(output.join("index.m3u8")).unwrap();
    let first_duration = playlist
        .lines()
        .find_map(|line| {
            line.strip_prefix("#EXTINF:")?
                .split(',')
                .next()?
                .parse::<f64>()
                .ok()
        })
        .unwrap();
    assert!(
        (6.8..=7.2).contains(&first_duration),
        "Copied video must keep its source keyframes, not force a shorter GOP: {first_duration}"
    );
    let first_segment = playlist
        .lines()
        .find(|line| safe_segment(line) && line.ends_with(".m4s"))
        .unwrap();
    let mut bytes = std::fs::read(output.join("init.mp4")).unwrap();
    bytes.extend(std::fs::read(output.join(first_segment)).unwrap());
    let fragment = directory.path().join("first-fragment.mp4");
    std::fs::write(&fragment, bytes).unwrap();
    let delivered = store
        .probe(&super::test_support::source(&fragment))
        .await
        .unwrap();
    let video = selected_stream(&delivered, "video", None).unwrap().unwrap();
    let audio = selected_stream(&delivered, "audio", None).unwrap().unwrap();
    assert_eq!(video["codec_name"], "hevc");
    assert_eq!(video["pix_fmt"], "yuv420p10le");
    assert_eq!(audio["codec_name"], "aac");
}
#[tokio::test]
async fn real_ffmpeg_remux_audio_conversion_subtitles_and_cleanup() {
    use http_body_util::BodyExt;
    use posterview_contracts::native::{
        AnimeContent, NativeLibraryInput, NativeLibraryOptions, NativeLibraryType,
    };
    // This exercises the installed toolchain, not a mocked FFmpeg command.
    if command("ffmpeg").arg("-version").status().await.is_err() {
        eprintln!("FFmpeg not installed; real playback fixture skipped.");
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let state = crate::test_support::state(temp.path());
    let media = temp.path().join("media/Movies");
    std::fs::create_dir(&media).unwrap();
    let video = media.join("Test's episode.mkv");
    let subtitle_file = temp.path().join("caption.srt");
    let font_file = temp.path().join("font.ttf");
    std::fs::write(
        &subtitle_file,
        "1\n00:00:01,000 --> 00:00:04,000\nPlayback subtitle fixture\n",
    )
    .unwrap();
    std::fs::write(&font_file, [0u8, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).unwrap();
    let mut cmd = command("ffmpeg");
    cmd.args([
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=160x90:rate=25:duration=8",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=8",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=880:duration=8",
        "-i",
    ])
    .arg(&subtitle_file)
    .args([
        "-map",
        "0:v",
        "-map",
        "1:a",
        "-map",
        "2:a",
        "-map",
        "3:s",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-g",
        "50",
        "-pix_fmt",
        "yuv420p",
        "-c:a:0",
        "aac",
        "-c:a:1",
        "ac3",
        "-ac:a:1",
        "6",
        "-c:s",
        "srt",
        "-metadata:s:a:0",
        "language=jpn",
        "-metadata:s:a:1",
        "language=eng",
        "-metadata:s:s:0",
        "language=eng",
        "-attach",
    ])
    .arg(&font_file)
    .args(["-metadata:s:t", "mimetype=application/x-truetype-font"])
    .arg(&video);
    run(
        &mut cmd,
        Duration::from_secs(20),
        "Playback fixture creation",
    )
    .await
    .unwrap();
    let db = ServerStore::new(state.runtime.data_dir());
    let lib = db
        .save_native_library(
            None,
            &NativeLibraryInput {
                name: "Test".into(),
                library_type: NativeLibraryType::Movies,
                anime_content: AnimeContent::Both,
                paths: vec!["Movies".into()],
                revision: None,
                options: NativeLibraryOptions::default(),
            },
        )
        .unwrap();
    let entry = NativeCatalogEntry {
        id: String::new(),
        path: "Movies/Test's episode.mkv".into(),
        kind: "movie".into(),
        parent_path: None,
        title: "Test".into(),
        metadata: json!({}),
        artwork: vec![],
        files: vec![json!({"path":"Movies/Test's episode.mkv"})],
        nfo_path: None,
        nfo_xml: None,
        available: true,
        revision: 1,
    };
    db.ingest_native_catalog(&lib.id, lib.revision, &[entry])
        .unwrap();
    let item = db.native_catalog(&lib.id).unwrap().remove(0);
    let settings = Settings {
        throttle: false,
        max_resolution: 0,
        ..conversion_settings()
    };
    db.set_setting(
        "transcoding-settings",
        &serde_json::to_string(&settings).unwrap(),
    )
    .unwrap();
    let info = info(
        State(state.clone()),
        Path((lib.id.clone(), item.id.clone())),
    )
    .await
    .unwrap()
    .0;
    assert!(info.duration_seconds >= 8.0);
    assert_eq!(info.tracks.len(), 4);
    assert_eq!(info.fonts.len(), 1);
    let first_sub = subtitle(
        State(state.clone()),
        Path((lib.id.clone(), item.id.clone(), 3)),
    )
    .await
    .unwrap()
    .into_body()
    .collect()
    .await
    .unwrap()
    .to_bytes();
    assert!(String::from_utf8_lossy(&first_sub).contains("Playback subtitle fixture"));
    // The cached resource is reused even after the extraction executable would be needed again.
    assert_eq!(state.playback.resources.lock().await.len(), 1);
    let second_sub = subtitle(
        State(state.clone()),
        Path((lib.id.clone(), item.id.clone(), 3)),
    )
    .await
    .unwrap()
    .into_body()
    .collect()
    .await
    .unwrap()
    .to_bytes();
    assert_eq!(first_sub, second_sub);
    assert_eq!(state.playback.resources.lock().await.len(), 1);
    let font = font(
        State(state.clone()),
        Path((lib.id.clone(), item.id.clone(), 4)),
    )
    .await
    .unwrap();
    assert_eq!(font.headers()[header::CONTENT_TYPE], "font/ttf");
    let mut request = input();
    request.position_seconds = 3.1;
    let session = create(
        State(state.clone()),
        Path((lib.id.clone(), item.id.clone())),
        Json(request),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(session.method, "remux");
    assert!(
        session.offset_seconds <= 3.1 && session.offset_seconds >= 1.9,
        "actual aligned seek: {}",
        session.offset_seconds
    );
    let path = state
        .playback
        .sessions
        .lock()
        .await
        .get(&session.id)
        .unwrap()
        .directory
        .clone()
        .unwrap();
    assert!(path.join("init.mp4").exists());
    assert!(std::fs::read_to_string(path.join("index.m3u8"))
        .unwrap()
        .contains("segment-"));
    state.playback.stop_id(&session.id).await;
    assert!(!path.exists());
    assert!(state.playback.session_details(&session.id).await.is_none());
    let mut request = input();
    request.audio_index = Some(2);
    let audio = create(
        State(state.clone()),
        Path((lib.id.clone(), item.id.clone())),
        Json(request),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(audio.method, "audio_transcode");
    assert!(audio.encoder.is_none());
    state.playback.stop_id(&audio.id).await;
    let mut request = input();
    request.force_transcode = true;
    request.max_height = 72;
    let converted = create(
        State(state.clone()),
        Path((lib.id.clone(), item.id.clone())),
        Json(request),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(converted.method, "transcode");
    assert_eq!(converted.encoder.as_deref(), Some("libx264"));
    let converted_directory = state
        .playback
        .sessions
        .lock()
        .await
        .get(&converted.id)
        .unwrap()
        .directory
        .clone()
        .unwrap();
    let playlist = std::fs::read_to_string(converted_directory.join("index.m3u8")).unwrap();
    assert!(playlist.contains("#EXT-X-TARGETDURATION:2"));
    let first_fragment = playlist
        .lines()
        .find_map(|line| {
            line.strip_prefix("#EXTINF:")?
                .split(',')
                .next()?
                .parse::<f64>()
                .ok()
        })
        .unwrap();
    assert!(
        (1.9..=2.1).contains(&first_fragment),
        "The first transcoded fragment should contain two seconds of video: {first_fragment}"
    );
    state.playback.stop_id(&converted.id).await;
    let mut request = input();
    request.subtitle_burn_index = Some(3);
    request.position_seconds = 2.0;
    let burn = create(
        State(state.clone()),
        Path((lib.id.clone(), item.id.clone())),
        Json(request),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(burn.method, "transcode");
    assert_eq!(burn.offset_seconds, 2.0);
    state.playback.stop_id(&burn.id).await;
}
