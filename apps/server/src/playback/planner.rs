//! Playback-only capability and authorization decisions; originals are never replaced.
use super::{HttpError, MAX_PLAYBACK_SECONDS, SessionInput, bad, duration, source_bitrate};
use crate::transcoding::Settings;
use serde_json::Value;

#[derive(Clone)]
pub(super) struct Plan {
    pub(super) method: &'static str,
    pub(super) reason: &'static str,
    pub(super) video: Value,
    pub(super) audio: Option<Value>,
    pub(super) output_codec: String,
    pub(super) hdr: bool,
    pub(super) height: u32,
    pub(super) convert_audio: bool,
    pub(super) bitrate_limit: u64,
    pub(super) bandwidth_adaptation: bool,
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
        .filter(|stream| stream["codec_type"] == kind && stream["disposition"]["attached_pic"] != 1)
        .collect::<Vec<_>>();
    if let Some(index) = index {
        return streams
            .into_iter()
            .find(|stream| stream["index"].as_u64() == Some(u64::from(index)))
            .cloned()
            .map(Some)
            .ok_or_else(|| bad(format!("Selected {kind} track is not available.")));
    }
    Ok(streams
        .iter()
        .find(|stream| stream["disposition"]["default"] == 1)
        .or_else(|| streams.first())
        .map(|stream| (*stream).clone()))
}

pub(super) fn text_subtitle(stream: &Value) -> bool {
    matches!(
        stream["codec_name"].as_str(),
        Some("ass" | "ssa" | "subrip" | "webvtt" | "mov_text" | "text" | "srt")
    )
}

fn supported_video_profile(video: &Value, codec: &str) -> bool {
    let pixel_format = video["pix_fmt"].as_str();
    if codec == "h264" {
        return pixel_format.is_none_or(|format| matches!(format, "yuv420p" | "yuvj420p" | "nv12"));
    }
    if matches!(codec, "hevc" | "av1") {
        let profile = video["profile"].as_str().unwrap_or("").to_ascii_lowercase();
        if !(profile.is_empty() || profile == "main" || codec == "hevc" && profile == "main 10") {
            return false;
        }
        if super::number(&video["bits_per_raw_sample"]).is_some_and(|depth| depth > 10.0) {
            return false;
        }
        return pixel_format.is_none_or(|format| {
            matches!(
                format,
                "yuv420p"
                    | "yuvj420p"
                    | "nv12"
                    | "yuv420p10le"
                    | "yuv420p10be"
                    | "p010le"
                    | "p010be"
            )
        });
    }
    true
}

pub(super) fn validate_request(input: &SessionInput) -> Result<(), HttpError> {
    if !input.position_seconds.is_finite()
        || input.position_seconds < 0.0
        || input.position_seconds > MAX_PLAYBACK_SECONDS
        || input.max_height > 4320
        || input.max_bitrate > 500_000_000
    {
        return Err(bad("Playback position or quality is out of range."));
    }
    if input.subtitle_burn_index.is_some() {
        return Err(bad(
            "Subtitle burn-in is unavailable. Use the client text or bitmap subtitle overlay.",
        ));
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
            .any(|value| value.len() > 32)
    {
        return Err(bad("Invalid browser capabilities."));
    }
    if input.direct_only
        && (input.force_transcode
            || input.force_remux
            || input.max_height > 0
            || input.max_bitrate > 0
            || input.bandwidth_limit_bps > 0
            || input.preferred_encoder.is_some())
    {
        return Err(bad(
            "Direct-only playback cannot request conversion, repackaging, or a different quality.",
        ));
    }
    Ok(())
}
pub(super) fn plan(
    probe: &Value,
    ext: &str,
    input: &SessionInput,
    settings: &Settings,
) -> Result<Plan, HttpError> {
    plan_for_delivery(probe, ext, input, settings, false)
}
pub(super) fn plan_for_delivery(
    probe: &Value,
    ext: &str,
    input: &SessionInput,
    settings: &Settings,
    select_in_stream: bool,
) -> Result<Plan, HttpError> {
    validate_request(input)?;
    if duration(probe) > 0.0 && input.position_seconds > duration(probe) {
        return Err(bad("Playback position is out of range."));
    }
    let video = selected_stream(probe, "video", None)?
        .ok_or_else(|| bad("This file has no video track."))?;
    let audio = selected_stream(probe, "audio", input.audio_index)?;
    if let Some(index) = input.subtitle_index {
        let subtitle = selected_stream(probe, "subtitle", Some(index))?
            .ok_or_else(|| bad("Subtitle track not found."))?;
        if !text_subtitle(&subtitle)
            && !matches!(
                subtitle["codec_name"].as_str(),
                Some("hdmv_pgs_subtitle" | "dvd_subtitle")
            )
        {
            return Err(bad(
                "This subtitle format has no supported client renderer.",
            ));
        }
    }
    let v = video["codec_name"].as_str().unwrap_or("");
    let a = audio
        .as_ref()
        .and_then(|stream| stream["codec_name"].as_str())
        .unwrap_or("");
    let source_video_ok = input.source_video_supported != Some(false)
        && supported_video_profile(&video, v)
        && input.video_codecs.iter().any(|codec| codec == v);
    let source_audio_ok = audio.is_none()
        || matches!(
            a,
            "aac" | "mp3" | "opus" | "vorbis" | "flac" | "alac" | "ac3" | "eac3"
        ) && input.audio_codecs.iter().any(|codec| codec == a);
    let default_audio = selected_stream(probe, "audio", None)?;
    let native_audio = default_audio
        .as_ref()
        .and_then(|stream| stream["index"].as_u64())
        == audio.as_ref().and_then(|stream| stream["index"].as_u64())
        || input.native_audio_tracks;
    let direct_container = matches!(ext, "mkv" | "mp4" | "m4v" | "mov" | "webm")
        && input
            .containers
            .iter()
            .any(|container| container == ext || container == "mp4" && ext == "m4v");
    let rate = source_bitrate(probe);
    let too_large =
        input.max_height > 0 && video["height"].as_u64().unwrap_or(0) > u64::from(input.max_height);
    let too_fast = input.max_bitrate > 0 && rate.is_none_or(|rate| rate > input.max_bitrate);
    let bandwidth = input.bandwidth_limit_bps > 0;
    if bandwidth
        && (!settings.auto_bandwidth_transcoding
            || !(500_000..=500_000_000).contains(&input.bandwidth_limit_bps)
            || rate.is_none_or(|rate| input.bandwidth_limit_bps >= rate))
    {
        return Err(bad(
            "Automatic bandwidth adaptation requires its server permission and a valid budget below the known source bitrate.",
        ));
    }
    if bandwidth
        && (input.force_remux
            || !settings.allow_conversion
                && (input.force_transcode
                    || too_large
                    || input.max_height > 0
                    || input.max_bitrate > 0
                    || !source_video_ok
                    || input.source_video_supported != Some(true)))
    {
        return Err(bad(
            "Automatic bandwidth permission only adapts an otherwise compatible source at Original quality.",
        ));
    }
    let hdr = matches!(
        video["color_transfer"].as_str(),
        Some("smpte2084" | "arib-std-b67")
    );
    let original = direct_container
        && native_audio
        && source_video_ok
        && source_audio_ok
        && !select_in_stream
        && !input.force_remux
        && !input.force_transcode
        && !too_large
        && !too_fast
        && !bandwidth;
    if original {
        return Ok(Plan {
            method: "direct",
            reason: "The browser plays the original file and selected tracks directly.",
            output_codec: v.into(),
            video,
            audio,
            hdr,
            height: 0,
            convert_audio: false,
            bitrate_limit: 0,
            bandwidth_adaptation: false,
        });
    }
    if input.direct_only {
        return Err(bad(
            "The requested track, container, codec or quality cannot use direct-only playback.",
        ));
    }
    if !input.hls_supported {
        return Err(bad(
            "This browser has no supported segmented-playback delivery. Use a compatible browser or original track.",
        ));
    }
    let copy_video = matches!(v, "h264" | "hevc" | "av1")
        && input
            .source_hls_video_supported
            .unwrap_or(input.source_video_supported != Some(false))
        && supported_video_profile(&video, v)
        && input.hls_video_codecs.iter().any(|codec| codec == v);
    if let Some(indexes) = &input.hls_audio_track_indexes {
        if indexes.len() > 256
            || indexes
                .iter()
                .any(|index| selected_stream(probe, "audio", Some(*index)).is_err())
        {
            return Err(bad("Invalid browser audio-track capabilities."));
        }
    }
    let supported_audio_index = input
        .hls_audio_track_indexes
        .as_ref()
        .is_none_or(|indexes| {
            audio
                .as_ref()
                .and_then(|stream| stream["index"].as_u64())
                .is_some_and(|index| indexes.contains(&(index as u32)))
        });
    let copy_audio = audio.is_none()
        || supported_audio_index
            && matches!(a, "aac" | "mp3" | "opus" | "flac" | "alac" | "ac3" | "eac3")
            && input.hls_audio_codecs.iter().any(|codec| codec == a);
    let encode_video = input.force_transcode || !copy_video || too_large || too_fast || bandwidth;
    let copy_allowed = settings.allow_remux;
    if input.force_remux {
        if !copy_allowed || !copy_video || !copy_audio || encode_video {
            return Err(bad(
                "Forced stream copying requires supported original codecs and remux permission; it cannot encode audio or video.",
            ));
        }
        return Ok(Plan {
            method: "remux",
            reason: "The original video and selected audio are copied without encoding.",
            output_codec: v.into(),
            video,
            audio,
            hdr,
            height: 0,
            convert_audio: false,
            bitrate_limit: 0,
            bandwidth_adaptation: false,
        });
    }
    if !encode_video && copy_audio && copy_allowed {
        return Ok(Plan {
            method: "remux",
            reason: "The original video and selected audio are copied without encoding.",
            output_codec: v.into(),
            video,
            audio,
            hdr,
            height: 0,
            convert_audio: false,
            bitrate_limit: 0,
            bandwidth_adaptation: false,
        });
    }
    if encode_video && !settings.allow_conversion && !bandwidth {
        return Err(bad(
            "This video profile or requested quality needs video transcoding, which is disabled.",
        ));
    }
    let convert_audio = audio.is_some() && !copy_audio;
    if convert_audio && !(settings.allow_conversion || settings.allow_audio_transcoding) {
        return Err(bad(
            "The selected audio needs audio-only transcoding, which is disabled.",
        ));
    }
    if convert_audio
        && (!input.audio_codecs.iter().any(|codec| codec == "aac")
            || !encode_video && !input.hls_aac_supported)
    {
        return Err(bad(
            "Audio transcoding requires supported AAC-LC output with the selected video.",
        ));
    }
    if !encode_video && !convert_audio {
        return Err(bad("Stream-copy repackaging is disabled."));
    }
    let preferred = input
        .preferred_encoder
        .as_deref()
        .unwrap_or(&settings.preferred_encoder);
    if !matches!(preferred, "avc" | "hevc" | "av1") {
        return Err(bad("Unsupported output encoder preference."));
    }
    let preferred = if preferred == "avc" {
        "h264"
    } else {
        preferred
    };
    let output_codec = if encode_video {
        [preferred,"h264","hevc","av1"].into_iter().find(|codec|
            input.video_codecs.iter().any(|candidate|candidate==codec)
            && input.hls_video_codecs.iter().any(|candidate|candidate==codec)
            && match *codec {"hevc"=>settings.allow_hevc,"av1"=>settings.allow_av1,_=>true})
            .ok_or_else(||bad("No output video codec is supported by both this browser and the enabled server encoders."))?.to_string()
    } else {
        v.into()
    };
    let height = if encode_video {
        match (input.max_height, settings.max_resolution) {
            (0, max) => max,
            (height, 0) => height,
            (height, max) => height.min(max),
        }
    } else {
        0
    };
    let bitrate_limit = if bandwidth {
        if input.max_bitrate > 0 {
            input.max_bitrate.min(input.bandwidth_limit_bps)
        } else {
            input.bandwidth_limit_bps
        }
    } else {
        input.max_bitrate
    };
    let copied_audio_rate = audio.as_ref().map_or(0, |audio| {
        if convert_audio {
            192_000
        } else {
            super::number(&audio["bit_rate"])
                .or_else(|| super::number(&audio["tags"]["BPS"]))
                .or_else(|| super::number(&audio["tags"]["BPS-eng"]))
                .filter(|rate| *rate > 0.0)
                .map_or(512_000, |rate| rate as u64)
        }
    });
    if encode_video
        && bitrate_limit > 0
        && copied_audio_rate.saturating_add(300_000) > bitrate_limit
    {
        return Err(bad(
            "The requested bitrate cannot fit the selected copied audio and a usable video stream. Choose a larger bitrate or a lower-rate audio track.",
        ));
    }
    Ok(Plan {
        method: if encode_video {
            "transcode"
        } else {
            "audio_transcode"
        },
        reason: if encode_video {
            if bandwidth {
                "Measured bandwidth requires playback-only video adaptation."
            } else if too_large || too_fast {
                "The requested quality requires playback-only video transcoding."
            } else {
                "The browser does not support this original video profile in the required delivery."
            }
        } else {
            "The selected audio is converted to AAC while the original video is copied."
        },
        video,
        audio,
        output_codec,
        hdr,
        height,
        convert_audio,
        bitrate_limit,
        bandwidth_adaptation: bandwidth,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::playback::test_support::{input, probe};
    use serde_json::json;
    #[test]
    fn direct_preference_and_independent_permissions() {
        let data = probe();
        let request = input();
        let all = Settings {
            allow_conversion: true,
            allow_audio_transcoding: true,
            auto_bandwidth_transcoding: true,
            ..Default::default()
        };
        assert_eq!(plan(&data, "mp4", &request, &all).unwrap().method, "direct");
        assert_eq!(
            plan(&data, "mkv", &request, &Settings::default())
                .unwrap()
                .method,
            "remux"
        );
        let disabled = Settings {
            allow_remux: false,
            ..Default::default()
        };
        assert!(plan(&data, "mkv", &request, &disabled).is_err());
        let audio = Settings {
            allow_audio_transcoding: true,
            allow_remux: false,
            ..Default::default()
        };
        for codec in [
            "flac",
            "truehd",
            "dts",
            "pcm_s16le",
            "pcm_s24le",
            "pcm_s32le",
            "pcm_s16be",
            "pcm_s24be",
            "pcm_f32le",
            "pcm_f64le",
            "pcm_bluray",
        ] {
            let mut source = data.clone();
            source["streams"][1]["codec_name"] = json!(codec);
            if codec == "dts" {
                source["streams"][1]["profile"] = json!("DTS-HD MA");
            }
            let planned = plan(&source, "mkv", &request, &audio).unwrap();
            assert_eq!(planned.method, "audio_transcode");
            assert!(planned.convert_audio);
            assert_eq!(planned.output_codec, "h264");
            assert!(plan(&source, "mkv", &request, &disabled).is_err());
            let mut unsupported = request.clone();
            unsupported.hls_aac_supported = false;
            assert!(plan(&source, "mkv", &unsupported, &audio).is_err());
        }
    }
    #[test]
    fn precise_audio_profiles_and_forced_copy_never_encode() {
        let mut data = probe();
        data["streams"][2]["codec_name"] = json!("aac");
        data["streams"][2]["profile"] = json!("HE-AAC");
        let request = SessionInput {
            audio_index: Some(2),
            hls_audio_track_indexes: Some(vec![1]),
            ..input()
        };
        assert!(plan(&data, "mkv", &request, &Settings::default()).is_err());
        let audio = Settings {
            allow_audio_transcoding: true,
            ..Default::default()
        };
        assert_eq!(
            plan(&data, "mkv", &request, &audio).unwrap().method,
            "audio_transcode"
        );
        assert!(
            plan(
                &data,
                "mkv",
                &SessionInput {
                    force_remux: true,
                    ..request.clone()
                },
                &Settings {
                    allow_conversion: true,
                    ..audio
                }
            )
            .is_err()
        );
        let invalid = SessionInput {
            hls_audio_track_indexes: Some(vec![999]),
            ..request
        };
        assert!(plan(&data, "mkv", &invalid, &Settings::default()).is_err());
    }
    #[test]
    fn video_quality_preserves_supported_audio_and_output_intersection() {
        let settings = Settings {
            allow_conversion: true,
            ..Default::default()
        };
        let request = SessionInput {
            max_height: 720,
            ..input()
        };
        let planned = plan(&probe(), "mkv", &request, &settings).unwrap();
        assert_eq!(planned.method, "transcode");
        assert!(!planned.convert_audio);
        assert_eq!(planned.height, 720);
        assert!(
            plan(
                &probe(),
                "mkv",
                &request,
                &Settings {
                    allow_audio_transcoding: true,
                    ..Default::default()
                }
            )
            .is_err()
        );
        let incompatible = SessionInput {
            hls_video_codecs: vec!["hevc".into()],
            ..request
        };
        assert!(plan(&probe(), "mkv", &incompatible, &settings).is_err());
    }
    #[test]
    fn unsupported_source_profile_can_use_supported_avc_output_without_copying_source() {
        let mut source = probe();
        source["streams"][0]["pix_fmt"] = json!("yuv420p10le");
        source["streams"][0]["profile"] = json!("High 10");
        let request = SessionInput {
            source_video_supported: Some(false),
            source_hls_video_supported: Some(false),
            ..input()
        };
        assert!(
            plan(
                &source,
                "mkv",
                &request,
                &Settings {
                    allow_audio_transcoding: true,
                    ..Default::default()
                }
            )
            .is_err()
        );
        let planned = plan(
            &source,
            "mkv",
            &request,
            &Settings {
                allow_conversion: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(planned.method, "transcode");
        assert_eq!(planned.output_codec, "h264");
        let mut hevc = source;
        hevc["streams"][0]["codec_name"] = json!("hevc");
        hevc["streams"][0]["profile"] = json!("Main 10");
        let request = SessionInput {
            video_codecs: vec!["h264".into(), "hevc".into()],
            hls_video_codecs: vec!["h264".into(), "hevc".into()],
            ..request
        };
        assert_eq!(
            plan(
                &hevc,
                "mkv",
                &request,
                &Settings {
                    allow_conversion: true,
                    ..Default::default()
                }
            )
            .unwrap()
            .method,
            "transcode"
        );
    }
    #[test]
    fn bandwidth_scope_does_not_grant_compatibility_burn_or_manual_quality() {
        let settings = Settings {
            auto_bandwidth_transcoding: true,
            ..Default::default()
        };
        let request = SessionInput {
            bandwidth_limit_bps: 2_000_000,
            source_video_supported: Some(true),
            ..input()
        };
        let planned = plan(&probe(), "mp4", &request, &settings).unwrap();
        assert_eq!(planned.bitrate_limit, 2_000_000);
        assert!(planned.bandwidth_adaptation);
        assert!(!planned.convert_audio);
        for blocked in [
            SessionInput {
                source_video_supported: Some(false),
                ..request.clone()
            },
            SessionInput {
                force_transcode: true,
                ..request.clone()
            },
            SessionInput {
                max_height: 720,
                ..request.clone()
            },
            SessionInput {
                subtitle_burn_index: Some(3),
                ..request.clone()
            },
            SessionInput {
                bandwidth_limit_bps: 5_000_000,
                ..request.clone()
            },
        ] {
            assert!(plan(&probe(), "mp4", &blocked, &settings).is_err());
        }
        let mut unsupported_audio = probe();
        unsupported_audio["streams"][1]["codec_name"] = json!("truehd");
        assert!(plan(&unsupported_audio, "mkv", &request, &settings).is_err());
        let permitted = Settings {
            allow_audio_transcoding: true,
            ..settings
        };
        let planned = plan(&unsupported_audio, "mkv", &request, &permitted).unwrap();
        assert_eq!(planned.method, "transcode");
        assert!(planned.convert_audio);
        assert_eq!(planned.bitrate_limit, 2_000_000);
    }
}
