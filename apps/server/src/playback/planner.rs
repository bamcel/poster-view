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
        || input.hls_video_codecs.len() > 32
        || input.hls_audio_codecs.len() > 32
        || input.containers.len() > 16
        || input
            .video_codecs
            .iter()
            .chain(&input.audio_codecs)
            .chain(&input.hls_video_codecs)
            .chain(&input.hls_audio_codecs)
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
    let video_profile_ok = !(v == "h264"
        && (video["pix_fmt"]
            .as_str()
            .is_some_and(|p| !["yuv420p", "nv12", "yuvj420p"].contains(&p))));
    let video_ok = video_profile_ok && input.video_codecs.iter().any(|c| c == v);
    let audio_ok = audio.is_none() || input.audio_codecs.iter().any(|c| c == a);
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
    let direct_container = matches!(ext, "mp4" | "m4v" | "mov" | "webm" | "mkv")
        && input
            .containers
            .iter()
            .any(|c| c == ext || (c == "mp4" && ext == "m4v"));
    // Multiple embedded tracks do not prevent original-file playback. Selecting
    // a different one requires the browser's native track-selection support.
    let native_audio_selection = default_audio == chosen_audio || input.native_audio_tracks;
    let direct = direct_container && native_audio_selection && !input.force_remux;
    // WebM codec support alone does not establish support for those codecs in HLS/fMP4.
    let hls_video_ok = matches!(v, "h264" | "hevc" | "av1");
    let needs_video = input.force_transcode
        || !video_ok
        || (!direct && !hls_video_ok)
        || too_large
        || too_fast
        || input.subtitle_burn_index.is_some();
    if !settings.allow_conversion || input.force_remux {
        let fits_original = direct && video_ok && audio_ok && !needs_video;
        let remux_allowed = settings.allow_remux || settings.allow_conversion;
        let copy_video_ok =
            hls_video_ok && video_profile_ok && input.hls_video_codecs.iter().any(|c| c == v);
        let copy_audio_ok = audio.is_none()
            || (matches!(a, "aac" | "mp3" | "opus" | "flac" | "ac3" | "eac3" | "alac")
                && input.hls_audio_codecs.iter().any(|c| c == a));
        let fits_copy = !input.force_transcode
            && !too_large
            && !too_fast
            && input.subtitle_burn_index.is_none();
        if !fits_original && remux_allowed && copy_video_ok && copy_audio_ok && fits_copy {
            let output_codec = v.to_string();
            let hdr = matches!(
                video["color_transfer"].as_str(),
                Some("smpte2084" | "arib-std-b67")
            );
            return Ok(Plan {
                method: "remux",
                reason: "The selected tracks are copied without audio or video encoding.",
                video,
                audio,
                output_codec,
                hdr,
                height: 0,
                convert_audio: false,
            });
        }
        if !fits_original {
            let reason = if input.force_transcode {
                "the request requires a converted stream"
            } else if input.subtitle_burn_index.is_some() {
                "the selected subtitles require video rendering"
            } else if too_large || too_fast {
                "the requested quality requires changing the original video"
            } else if input.force_remux && !remux_allowed {
                "lossless track repackaging is disabled"
            } else if input.force_remux && !copy_video_ok {
                "the browser has not reported support for this video profile in segmented playback"
            } else if input.force_remux && !copy_audio_ok {
                "the browser has not reported support for the selected audio codec in segmented playback"
            } else if !direct_container {
                "the browser has not reported support for the original container"
            } else if !native_audio_selection {
                "this browser cannot select the requested audio track in the original file"
            } else if !video_ok {
                "the browser has not reported support for the original video profile"
            } else {
                "the browser has not reported support for the original audio track"
            };
            let policy = if !remux_allowed {
                "Conversion and remuxing are disabled."
            } else {
                "Audio/video encoding is disabled for this request. Lossless repackaging requires browser support for the original codecs in segmented playback."
            };
            return Err(bad(format!(
                "Original playback is unavailable: {reason}. {policy}"
            )));
        }
    }
    let audio_ok = audio_ok
        && ((!needs_video && direct)
            || (matches!(a, "aac" | "mp3" | "")
                && audio
                    .as_ref()
                    .and_then(|s| s["channels"].as_u64())
                    .unwrap_or(2)
                    <= 2));
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
    use super::super::test_support::{
        conversion_settings, input, lossless_mkv_input, original_mkv_input, original_mkv_probe,
        original_only_settings, probe,
    };
    use super::*;
    #[test]
    fn lossless_track_switch_preserves_opus_multichannel_and_prefers_direct_default() {
        let settings = Settings::default();
        let mut data = original_mkv_probe();
        let request = lossless_mkv_input();
        assert_eq!(
            plan(&data, "mkv", &request, &settings).unwrap().method,
            "direct"
        );
        let request = SessionInput {
            audio_index: Some(2),
            ..lossless_mkv_input()
        };
        let copied = plan(&data, "mkv", &request, &settings).unwrap();
        assert_eq!(copied.method, "remux");
        assert!(!copied.convert_audio);
        assert_eq!(copied.audio.unwrap()["index"], 2);
        data["streams"][2]["channels"] = serde_json::json!(6);
        let copied = plan(&data, "mkv", &request, &settings).unwrap();
        assert_eq!(copied.method, "remux");
        assert!(!copied.convert_audio);
        let native = SessionInput {
            audio_index: Some(2),
            native_audio_tracks: true,
            ..lossless_mkv_input()
        };
        assert_eq!(
            plan(&data, "mkv", &native, &settings).unwrap().method,
            "direct"
        );
        let forced = SessionInput {
            audio_index: Some(2),
            native_audio_tracks: true,
            force_remux: true,
            ..lossless_mkv_input()
        };
        assert_eq!(
            plan(&data, "mkv", &forced, &settings).unwrap().method,
            "remux"
        );
    }
    #[test]
    fn lossless_requires_segmented_capabilities_and_never_adapts_quality_or_subtitles() {
        let settings = Settings::default();
        let data = original_mkv_probe();
        let cases = [
            SessionInput {
                audio_index: Some(2),
                hls_video_codecs: vec![],
                ..lossless_mkv_input()
            },
            SessionInput {
                audio_index: Some(2),
                hls_audio_codecs: vec!["aac".into()],
                ..lossless_mkv_input()
            },
            SessionInput {
                force_remux: true,
                max_height: 720,
                ..lossless_mkv_input()
            },
            SessionInput {
                force_remux: true,
                max_bitrate: 1_000_000,
                ..lossless_mkv_input()
            },
            SessionInput {
                force_remux: true,
                subtitle_burn_index: Some(3),
                ..lossless_mkv_input()
            },
            SessionInput {
                force_remux: true,
                force_transcode: true,
                ..lossless_mkv_input()
            },
        ];
        for request in cases {
            assert!(plan(&data, "mkv", &request, &settings).is_err());
            if request.force_remux {
                assert!(plan(&data, "mkv", &request, &conversion_settings()).is_err());
            }
        }
        let mut high10 = data;
        high10["streams"][0]["codec_name"] = serde_json::json!("h264");
        let request = SessionInput {
            audio_index: Some(2),
            hls_video_codecs: vec!["h264".into()],
            ..lossless_mkv_input()
        };
        assert!(plan(&high10, "mkv", &request, &settings).is_err());
        let request = SessionInput {
            audio_index: Some(2),
            ..lossless_mkv_input()
        };
        assert!(plan(
            &original_mkv_probe(),
            "mkv",
            &request,
            &original_only_settings()
        )
        .is_err());
    }
    #[test]
    fn original_mkv_allows_default_and_natively_selectable_audio_without_conversion() {
        let mut data = original_mkv_probe();
        let settings = Settings::default();
        let mut request = original_mkv_input();
        request.subtitle_index = Some(3);
        let selected = plan(&data, "mkv", &request, &settings).unwrap();
        assert_eq!(selected.method, "direct");
        assert!(!selected.convert_audio);
        assert_eq!(selected.audio.unwrap()["index"], 1);
        // Channel count alone must not force a downmix of natively supported audio.
        data["streams"][1]["channels"] = serde_json::json!(6);
        assert_eq!(
            plan(&data, "mkv", &request, &settings).unwrap().method,
            "direct"
        );
        request.audio_index = Some(2);
        let error = plan(&data, "mkv", &request, &settings).err().unwrap();
        assert!(error
            .detail
            .contains("cannot select the requested audio track"));
        request.native_audio_tracks = true;
        let selected = plan(&data, "mkv", &request, &settings).unwrap();
        assert_eq!(selected.method, "direct");
        assert_eq!(selected.audio.unwrap()["index"], 2);
        assert!(!selected.convert_audio);
    }
    #[test]
    fn original_only_rejects_conversion_and_remux_requirements_with_clear_reasons() {
        let data = original_mkv_probe();
        let settings = original_only_settings();
        let cases = [
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
                    audio_codecs: vec!["aac".into()],
                    ..original_mkv_input()
                },
                "original audio track",
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
                    max_bitrate: 1_000_000,
                    ..original_mkv_input()
                },
                "requested quality",
            ),
            (
                SessionInput {
                    force_transcode: true,
                    ..original_mkv_input()
                },
                "converted stream",
            ),
            (
                SessionInput {
                    subtitle_burn_index: Some(3),
                    ..original_mkv_input()
                },
                "video rendering",
            ),
        ];
        for (request, reason) in cases {
            let error = plan(&data, "mkv", &request, &settings).err().unwrap();
            assert_eq!(error.status, axum::http::StatusCode::BAD_REQUEST);
            assert!(error.detail.contains(reason), "{}", error.detail);
            assert!(error
                .detail
                .contains("Conversion and remuxing are disabled"));
        }
        let request = SessionInput {
            containers: vec!["mp4".into()],
            audio_codecs: vec!["opus".into(), "aac".into()],
            ..original_mkv_input()
        };
        let selected = plan(&data, "mkv", &request, &conversion_settings()).unwrap();
        assert_eq!(selected.method, "audio_transcode");
        assert!(selected.convert_audio);
        assert_eq!(selected.video["codec_name"], "hevc");
    }
    #[test]
    fn preserves_video_and_selects_least_cost_method() {
        let settings = conversion_settings();
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
            ..conversion_settings()
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
        let disabled = conversion_settings();
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
            ..conversion_settings()
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
            !plan(&probe, "mkv", &request, &conversion_settings())
                .unwrap()
                .convert_audio
        );
        request.audio_index = Some(2);
        assert!(plan(&probe, "mkv", &request, &conversion_settings())
            .err()
            .unwrap()
            .detail
            .contains("AAC support"));
        request.audio_codecs.push("aac".into());
        assert!(
            plan(&probe, "mkv", &request, &conversion_settings())
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
        assert!(plan(&probe, "mkv", &request, &conversion_settings()).is_ok());
        request.position_seconds = MAX_PLAYBACK_SECONDS + 1.0;
        assert!(plan(&probe, "mkv", &request, &conversion_settings()).is_err());
        probe["streams"][0]["duration"] = serde_json::json!(120.0);
        request.position_seconds = 121.0;
        assert!(plan(&probe, "mkv", &request, &conversion_settings()).is_err());
    }
    #[test]
    fn requested_bitrate_limit_is_enforced_when_source_bitrate_is_unknown() {
        let mut probe = probe();
        probe["format"].as_object_mut().unwrap().remove("bit_rate");
        let mut request = input();
        request.max_bitrate = 1_000_000;
        assert_eq!(
            plan(&probe, "mkv", &request, &conversion_settings())
                .unwrap()
                .method,
            "transcode"
        );
        probe["format"]["size"] = serde_json::json!(100_000);
        assert_eq!(
            plan(&probe, "mkv", &request, &conversion_settings())
                .unwrap()
                .method,
            "remux"
        );
    }
}
