//! Playback request/response wire models. Coordinate serialized changes with clients.
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize)]
pub(crate) struct Track {
    pub(super) index: u32,
    pub(super) kind: String,
    pub(super) codec: String,
    pub(super) language: Option<String>,
    pub(super) title: Option<String>,
    pub(super) profile: Option<String>,
    #[serde(rename = "default")]
    pub(super) is_default: bool,
    pub(super) forced: bool,
    pub(super) hearing_impaired: bool,
    pub(super) channels: Option<u32>,
    pub(super) width: Option<u32>,
    pub(super) height: Option<u32>,
    pub(super) bit_depth: Option<u32>,
    pub(super) pixel_format: Option<String>,
    pub(super) bitrate: Option<u64>,
    pub(super) frame_rate: Option<f64>,
    pub(super) subtitle_format: Option<String>,
    pub(super) url: Option<String>,
}
#[derive(Clone, Serialize)]
pub(crate) struct Chapter {
    pub(super) title: String,
    pub(super) start_seconds: f64,
}
#[derive(Clone, Serialize)]
pub(crate) struct Font {
    pub(super) index: u32,
    pub(super) name: String,
    pub(super) url: String,
}
#[derive(Clone, Serialize)]
pub(crate) struct NextItem {
    pub(super) library_id: String,
    pub(super) item_id: String,
    pub(super) title: String,
}
#[derive(Serialize)]
pub(crate) struct Info {
    pub(super) library_id: String,
    pub(super) item_id: String,
    pub(super) title: String,
    pub(super) series_title: Option<String>,
    pub(super) overview: Option<String>,
    pub(super) season: Option<i64>,
    pub(super) episode: Option<i64>,
    pub(super) poster_url: Option<String>,
    pub(super) duration_seconds: f64,
    pub(super) container: String,
    pub(super) conversion_allowed: bool,
    pub(super) audio_conversion_allowed: bool,
    pub(super) bandwidth_adaptation_allowed: bool,
    pub(super) source_bitrate: Option<u64>,
    pub(super) remux_allowed: bool,
    pub(super) tracks: Vec<Track>,
    pub(super) chapters: Vec<Chapter>,
    pub(super) fonts: Vec<Font>,
    pub(super) next: Option<NextItem>,
}
#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub(crate) struct SessionInput {
    pub(super) position_seconds: f64,
    pub(super) audio_index: Option<u32>,
    pub(super) subtitle_index: Option<u32>,
    pub(super) subtitle_burn_index: Option<u32>,
    pub(super) max_height: u32,
    pub(super) max_bitrate: u64,
    pub(super) bandwidth_limit_bps: u64,
    pub(super) video_codecs: Vec<String>,
    pub(super) audio_codecs: Vec<String>,
    pub(super) hls_video_codecs: Vec<String>,
    pub(super) hls_audio_codecs: Vec<String>,
    pub(super) hls_aac_supported: bool,
    pub(super) containers: Vec<String>,
    pub(super) native_audio_tracks: bool,
    pub(super) source_video_supported: bool,
    pub(super) force_transcode: bool,
    pub(super) force_remux: bool,
    pub(super) preferred_encoder: Option<String>,
}
#[derive(Clone, Serialize)]
pub(crate) struct SessionResponse {
    pub(super) id: String,
    pub(super) method: String,
    pub(super) reason: String,
    pub(super) url: String,
    pub(super) mime: String,
    pub(super) offset_seconds: f64,
    pub(super) duration_seconds: f64,
    pub(super) encoder: Option<String>,
    pub(super) audio_index: Option<u32>,
}
