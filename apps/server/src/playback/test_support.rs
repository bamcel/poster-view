//! Shared original-playback fixtures; no production exports.
use super::{SessionInput, Value};
use serde_json::json;

pub(super) fn probe() -> Value {
    json!({"format":{"duration":"180","bit_rate":"5000000"},"streams":[
        {"index":0,"codec_type":"video","codec_name":"h264","pix_fmt":"yuv420p","height":1080},
        {"index":1,"codec_type":"audio","codec_name":"aac","channels":2,"disposition":{"default":1}},
        {"index":2,"codec_type":"audio","codec_name":"ac3","channels":6}
    ]})
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
pub(super) fn input() -> SessionInput {
    SessionInput {
        video_codecs: vec!["h264".into()],
        audio_codecs: vec!["aac".into()],
        containers: vec!["mp4".into()],
        ..Default::default()
    }
}
