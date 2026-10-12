//! Shared playback fixtures; no production exports.
use super::{SessionInput, Source, Value};
use posterview_contracts::native::NativeCatalogEntry;
use serde_json::json;
use std::path::Path;
pub(super) fn conversion_settings() -> crate::transcoding::Settings {
    crate::transcoding::Settings {
        allow_conversion: true,
        ..Default::default()
    }
}
pub(super) fn original_only_settings() -> crate::transcoding::Settings {
    crate::transcoding::Settings {
        allow_remux: false,
        ..Default::default()
    }
}
pub(super) fn lossless_mkv_input() -> SessionInput {
    SessionInput {
        hls_video_codecs: vec!["hevc".into()],
        hls_audio_codecs: vec!["opus".into()],
        ..original_mkv_input()
    }
}
pub(super) fn probe() -> Value {
    json!({"format":{"duration":"180","bit_rate":"5000000"},"streams":[{"index":0,"codec_type":"video","codec_name":"h264","pix_fmt":"yuv420p","height":1080},{"index":1,"codec_type":"audio","codec_name":"aac","channels":2,"disposition":{"default":1}},{"index":2,"codec_type":"audio","codec_name":"ac3","channels":6}]})
}
pub(super) fn original_mkv_probe() -> Value {
    json!({"format":{"duration":"180","bit_rate":"5000000"},"streams":[
        {"index":0,"codec_type":"video","codec_name":"hevc","profile":"Main 10","pix_fmt":"yuv420p10le","height":1080},
        {"index":1,"codec_type":"audio","codec_name":"opus","channels":2,"tags":{"language":"eng"},"disposition":{"default":1}},
        {"index":2,"codec_type":"audio","codec_name":"opus","channels":2,"tags":{"language":"jpn"}},
        {"index":3,"codec_type":"subtitle","codec_name":"ass","tags":{"language":"eng"}}
    ]})
}
pub(super) fn original_mkv_input() -> SessionInput {
    SessionInput {
        video_codecs: vec!["hevc".into()],
        audio_codecs: vec!["opus".into()],
        containers: vec!["mkv".into()],
        ..Default::default()
    }
}
pub(super) fn source(path: &Path) -> Source {
    Source {
        library_id: "fixture-library".into(),
        item: NativeCatalogEntry {
            id: "fixture-item".into(),
            path: "fixture.mkv".into(),
            kind: "movie".into(),
            parent_path: None,
            title: "Fixture".into(),
            metadata: json!({}),
            artwork: vec![],
            files: vec![],
            nfo_path: None,
            nfo_xml: None,
            available: true,
            revision: 1,
        },
        path: path.to_path_buf(),
        fingerprint: super::stamp(path).unwrap(),
        series_title: None,
        next: None,
    }
}
pub(super) fn input() -> SessionInput {
    SessionInput {
        video_codecs: vec!["h264".into()],
        audio_codecs: vec!["aac".into()],
        containers: vec!["mp4".into()],
        ..Default::default()
    }
}
pub(super) async fn packet_hashes(
    path: &Path,
    selection: &str,
) -> std::collections::HashSet<String> {
    let output = tempfile::NamedTempFile::new().unwrap();
    let mut probe = super::command("ffprobe");
    probe
        .args([
            "-v",
            "error",
            "-select_streams",
            selection,
            "-show_packets",
            "-show_data_hash",
            "sha256",
            "-show_entries",
            "packet=data_hash",
            "-of",
            "json",
        ])
        .arg(path)
        .stdout(output.reopen().unwrap());
    super::run(
        &mut probe,
        std::time::Duration::from_secs(15),
        "Fixture packet inspection",
    )
    .await
    .unwrap();
    let packets: Value = serde_json::from_slice(&std::fs::read(output.path()).unwrap()).unwrap();
    packets["packets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|packet| packet["data_hash"].as_str().unwrap().to_owned())
        .collect()
}
