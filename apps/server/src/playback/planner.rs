//! Capability and quality decisions without filesystem access or process/state mutation.
use super::{bad, duration, number, HttpError, SessionInput, MAX_PLAYBACK_SECONDS};
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
    pub(super) convert_audio: bool,
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
        || input.position_seconds > MAX_PLAYBACK_SECONDS
        || (duration(probe) > 0.0 && input.position_seconds > duration(probe))
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
    let source_bitrate = number(&probe["format"]["bit_rate"])
        .filter(|rate| *rate > 0.0)
        .or_else(|| {
            let size = number(&probe["format"]["size"])?;
            let seconds = duration(probe);
            (size > 0.0 && seconds > 0.0).then_some(size * 8.0 / seconds)
        });
    let too_fast =
        input.max_bitrate > 0 && source_bitrate.is_none_or(|rate| rate > input.max_bitrate as f64);
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
    let audio_ok = audio_ok && ((!needs_video && direct) || matches!(a, "aac" | "mp3" | ""));
    let convert_audio = audio.is_some() && (!audio_ok || (needs_video && input.max_bitrate > 0));
    if convert_audio && !input.audio_codecs.iter().any(|codec| codec == "aac") {
        return Err(bad("Audio conversion requires AAC support in this browser. Select a compatible audio track or a browser with AAC playback support."));
    }
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
    let preferred = if preferred == "avc" {
        "h264"
    } else {
        preferred
    };
    let output_codec = if needs_video {
        [preferred,"h264","hevc","av1"].into_iter().find(|codec|
            input.video_codecs.iter().any(|supported|supported.as_str()==*codec)
                && match *codec {"hevc"=>settings.allow_hevc,"av1"=>settings.allow_av1,_=>true})
            .ok_or_else(||bad("This browser has no compatible video encoder enabled on the server. Enable a supported HEVC or AV1 encoder in Transcoding settings, or use a browser with AVC playback support."))?
    }else{"h264"}.to_string();
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
        convert_audio,
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
    #[test]
    fn output_codec_requires_server_and_browser_support() {
        let settings = Settings {
            allow_av1: true,
            ..Settings::default()
        };
        let mut request = input();
        request.force_transcode = true;
        request.video_codecs = vec!["av1".into()];
        assert_eq!(
            plan(&probe(), "mkv", &request, &settings)
                .unwrap()
                .output_codec,
            "av1"
        );
        let disabled = Settings::default();
        let error = plan(&probe(), "mkv", &request, &disabled).err().unwrap();
        assert!(error.detail.contains("compatible video encoder"));
        request.video_codecs = vec!["hevc".into(), "h264".into()];
        request.preferred_encoder = Some("hevc".into());
        assert_eq!(
            plan(&probe(), "mkv", &request, &disabled)
                .unwrap()
                .output_codec,
            "h264"
        );
        let enabled = Settings {
            allow_hevc: true,
            ..Settings::default()
        };
        assert_eq!(
            plan(&probe(), "mkv", &request, &enabled)
                .unwrap()
                .output_codec,
            "hevc"
        );
    }
    #[test]
    fn compatible_webm_does_not_need_an_enabled_conversion_codec() {
        let mut probe = probe();
        probe["streams"].as_array_mut().unwrap().remove(2);
        probe["streams"][0]["codec_name"] = serde_json::json!("vp9");
        probe["streams"][1]["codec_name"] = serde_json::json!("opus");
        let request = SessionInput {
            video_codecs: vec!["vp9".into()],
            audio_codecs: vec!["opus".into()],
            containers: vec!["webm".into()],
            ..SessionInput::default()
        };
        assert_eq!(
            plan(&probe, "webm", &request, &Settings::default())
                .unwrap()
                .method,
            "direct"
        );
    }
    #[test]
    fn video_conversion_preserves_compatible_audio_and_rejects_incompatible_aac_output() {
        let mut probe = probe();
        probe["streams"][1]["codec_name"] = serde_json::json!("mp3");
        let mut request = input();
        request.force_transcode = true;
        request.audio_codecs = vec!["mp3".into()];
        assert!(
            !plan(&probe, "mkv", &request, &Settings::default())
                .unwrap()
                .convert_audio
        );
        request.audio_index = Some(2);
        assert!(plan(&probe, "mkv", &request, &Settings::default())
            .err()
            .unwrap()
            .detail
            .contains("AAC support"));
        request.audio_codecs.push("aac".into());
        assert!(
            plan(&probe, "mkv", &request, &Settings::default())
                .unwrap()
                .convert_audio
        );
    }
    #[test]
    fn unknown_duration_is_not_a_one_second_video() {
        let mut probe = probe();
        probe["format"].as_object_mut().unwrap().remove("duration");
        let mut request = input();
        request.position_seconds = 600.0;
        assert!(plan(&probe, "mkv", &request, &Settings::default()).is_ok());
        request.position_seconds = MAX_PLAYBACK_SECONDS + 1.0;
        assert!(plan(&probe, "mkv", &request, &Settings::default()).is_err());
        probe["streams"][0]["duration"] = serde_json::json!(120.0);
        request.position_seconds = 121.0;
        assert!(plan(&probe, "mkv", &request, &Settings::default()).is_err());
    }
    #[test]
    fn requested_bitrate_limit_is_enforced_when_source_bitrate_is_unknown() {
        let mut probe = probe();
        probe["format"].as_object_mut().unwrap().remove("bit_rate");
        let mut request = input();
        request.max_bitrate = 1_000_000;
        assert_eq!(
            plan(&probe, "mkv", &request, &Settings::default())
                .unwrap()
                .method,
            "transcode"
        );
        probe["format"]["size"] = serde_json::json!(100_000);
        assert_eq!(
            plan(&probe, "mkv", &request, &Settings::default())
                .unwrap()
                .method,
            "remux"
        );
    }
}
