//! Shared playback fixtures; no production exports.
use super::{SessionInput, Source, Value};
use posterview_contracts::native::NativeCatalogEntry;
use serde_json::json;
use std::path::Path;
pub(super) fn probe() -> Value {
    json!({"format":{"duration":"180","bit_rate":"5000000"},"streams":[{"index":0,"codec_type":"video","codec_name":"h264","pix_fmt":"yuv420p","height":1080},{"index":1,"codec_type":"audio","codec_name":"aac","channels":2,"disposition":{"default":1}},{"index":2,"codec_type":"audio","codec_name":"ac3","channels":6}]})
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
