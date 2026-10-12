//! Cross-boundary delivery, media processing, and cleanup tests.

use super::test_support::{input, probe};
use super::*;
use serde_json::json;
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
        ..Settings::default()
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
        ..Settings::default()
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
