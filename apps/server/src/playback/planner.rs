//! Capability and quality decisions without filesystem access or process/state mutation.
use super::{HttpError, SessionInput, bad, duration, number};
use crate::transcoding::Settings;
use serde_json::Value;

pub(super) struct Plan {
    pub(super) method: &'static str,
    pub(super) reason: &'static str,
    pub(super) video: Value,
    pub(super) audio: Option<Value>,
    pub(super) output_codec: String,
    pub(super) hdr: bool,
    pub(super) height: u32,
}
pub(super) fn selected_stream(
    probe: &Value,
    kind: &str,
    index: Option<u32>,
) -> Result<Option<Value>, HttpError> {
    let streams = probe["streams"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|s| s["codec_type"] == kind && s["disposition"]["attached_pic"] != 1)
        .collect::<Vec<_>>();
    if let Some(index) = index {
        return streams
            .into_iter()
            .find(|s| s["index"].as_u64() == Some(u64::from(index)))
            .cloned()
            .map(Some)
            .ok_or_else(|| bad(format!("Selected {kind} track is not available.")));
    }
    Ok(streams
        .iter()
        .find(|s| s["disposition"]["default"] == 1)
        .or_else(|| streams.first())
        .map(|s| (*s).clone()))
}
pub(super) fn plan(
    probe: &Value,
    ext: &str,
    input: &SessionInput,
    settings: &Settings,
) -> Result<Plan, HttpError> {
    if !input.position_seconds.is_finite()
        || input.position_seconds < 0.0
        || input.position_seconds > duration(probe).max(1.0)
        || input.max_height > 4320
        || input.max_bitrate > 500_000_000
    {
        return Err(bad("Playback position or quality is out of range."));
    }
    if input.video_codecs.len() > 32
        || input.audio_codecs.len() > 32
        || input.containers.len() > 16
        || input
            .video_codecs
            .iter()
            .chain(&input.audio_codecs)
            .chain(&input.containers)
            .any(|v| v.len() > 32)
    {
        return Err(bad("Invalid browser capabilities."));
    }
    let video = selected_stream(probe, "video", None)?
        .ok_or_else(|| bad("This file has no video track."))?;
    let audio = selected_stream(probe, "audio", input.audio_index)?;
    if let Some(index) = input.subtitle_index {
        selected_stream(probe, "subtitle", Some(index))?;
    }
    if let Some(index) = input.subtitle_burn_index {
        selected_stream(probe, "subtitle", Some(index))?;
    }
    let v = video["codec_name"].as_str().unwrap_or("");
    let a = audio
        .as_ref()
        .and_then(|s| s["codec_name"].as_str())
        .unwrap_or("");
    let video_ok = input.video_codecs.iter().any(|c| c == v)
        && !(v == "h264"
            && (video["pix_fmt"]
                .as_str()
                .is_some_and(|p| !["yuv420p", "nv12", "yuvj420p"].contains(&p))));
    let audio_ok = audio.is_none()
        || (input.audio_codecs.iter().any(|c| c == a)
            && audio
                .as_ref()
                .and_then(|s| s["channels"].as_u64())
                .unwrap_or(2)
                <= 2);
    let too_large =
        input.max_height > 0 && video["height"].as_u64().unwrap_or(0) > u64::from(input.max_height);
    let source_bitrate = number(&probe["format"]["bit_rate"]).unwrap_or(0.0);
    let too_fast = input.max_bitrate > 0 && source_bitrate > input.max_bitrate as f64;
    let default_audio = selected_stream(probe, "audio", None)?
        .as_ref()
        .and_then(|a| a["index"].as_u64());
    let chosen_audio = audio.as_ref().and_then(|a| a["index"].as_u64());
    let direct_container = matches!(ext, "mp4" | "m4v" | "mov" | "webm")
        && input
            .containers
            .iter()
            .any(|c| c == ext || (c == "mp4" && ext == "m4v"));
    let audio_count = probe["streams"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|s| s["codec_type"] == "audio")
        .count();
    let direct = direct_container && default_audio == chosen_audio && audio_count <= 1;
    // WebM codec support alone does not establish support for those codecs in HLS/fMP4.
    let hls_video_ok = matches!(v, "h264" | "hevc" | "av1");
    let needs_video = input.force_transcode
        || !video_ok
        || (!direct && !hls_video_ok)
        || too_large
        || too_fast
        || input.subtitle_burn_index.is_some();
    let audio_ok = audio_ok && (direct || matches!(a, "aac" | "mp3" | ""));
    let hdr = matches!(
        video["color_transfer"].as_str(),
        Some("smpte2084" | "arib-std-b67")
    );
    let preferred = input
        .preferred_encoder
        .as_deref()
        .unwrap_or(&settings.preferred_encoder);
    if !["avc", "hevc", "av1"].contains(&preferred) {
        return Err(bad("Unsupported output encoder preference."));
    }
    let output_codec = if preferred == "hevc"
        && settings.allow_hevc
        && input.video_codecs.iter().any(|c| c == "hevc")
    {
        "hevc"
    } else if preferred == "av1"
        && settings.allow_av1
        && input.video_codecs.iter().any(|c| c == "av1")
    {
        "av1"
    } else {
        "h264"
    }
    .to_string();
    let height = match (input.max_height, settings.max_resolution) {
        (0, s) => s,
        (i, 0) => i,
        (i, s) => i.min(s),
    };
    let (method, reason) = if needs_video {
        (
            "transcode",
            if input.subtitle_burn_index.is_some() {
                "The selected subtitles require video rendering."
            } else if !video_ok {
                "The browser does not support this video profile."
            } else {
                "The requested quality requires video conversion."
            },
        )
    } else if !audio_ok {
        (
            "audio_transcode",
            "The selected audio requires conversion; video is preserved.",
        )
    } else if direct {
        (
            "direct",
            "The browser supports the original file and selected tracks.",
        )
    } else {
        (
            "remux",
            "The original video and audio are preserved in a browser-compatible container.",
        )
    };
    Ok(Plan {
        method,
        reason,
        video,
        audio,
        output_codec,
        hdr,
        height,
    })
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{input, probe};
    use super::*;
    #[test]
    fn preserves_video_and_selects_least_cost_method() {
        let settings = Settings::default();
        let mut p = probe();
        p["streams"].as_array_mut().unwrap().remove(2);
        assert_eq!(
            plan(&p, "mp4", &input(), &settings).unwrap().method,
            "direct"
        );
        assert_eq!(
            plan(&p, "mkv", &input(), &settings).unwrap().method,
            "remux"
        );
        let mut i = input();
        i.audio_index = Some(2);
        assert_eq!(
            plan(&probe(), "mkv", &i, &settings).unwrap().method,
            "audio_transcode"
        );
        i.audio_index = None;
        i.max_height = 720;
        assert_eq!(plan(&p, "mp4", &i, &settings).unwrap().method, "transcode");
        i.max_height = 0;
        i.max_bitrate = 1_000_000;
        assert_eq!(plan(&p, "mp4", &i, &settings).unwrap().method, "transcode");
    }
    #[test]
    fn rejects_invalid_tracks_and_positions() {
        let mut i = input();
        i.audio_index = Some(77);
        assert!(plan(&probe(), "mp4", &i, &Settings::default()).is_err());
        i.audio_index = None;
        i.position_seconds = f64::NAN;
        assert!(plan(&probe(), "mp4", &i, &Settings::default()).is_err());
        i.position_seconds = 181.0;
        assert!(plan(&probe(), "mp4", &i, &Settings::default()).is_err());
    }
}
