//! Direct-file capability validation without filesystem access or process/state mutation.
use super::{bad, duration, HttpError, SessionInput, MAX_PLAYBACK_SECONDS};
use serde_json::Value;

pub(super) struct Plan {
    pub(super) method: &'static str,
    pub(super) reason: &'static str,
    pub(super) audio: Option<Value>,
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

pub(super) fn validate_request(input: &SessionInput) -> Result<(), HttpError> {
    if input.max_height > 0
        || input.max_bitrate > 0
        || input.bandwidth_limit_bps > 0
        || input.force_transcode
        || input.force_remux
        || input.subtitle_burn_index.is_some()
        || input.preferred_encoder.is_some()
    {
        return Err(bad("PosterView only plays original files directly. Conversion, remuxing, quality limits, bandwidth adaptation, encoders, and subtitle burn-in are unavailable."));
    }
    if !input.position_seconds.is_finite()
        || input.position_seconds < 0.0
        || input.position_seconds > MAX_PLAYBACK_SECONDS
    {
        return Err(bad("Playback position is out of range."));
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
    if input.source_video_supported == Some(false) {
        return Err(bad("This browser does not support the original video profile. Direct playback requires a compatible browser and file."));
    }
    Ok(())
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

pub(super) fn plan(probe: &Value, ext: &str, input: &SessionInput) -> Result<Plan, HttpError> {
    validate_request(input)?;
    if duration(probe) > 0.0 && input.position_seconds > duration(probe) {
        return Err(bad("Playback position is out of range."));
    }
    if !matches!(ext, "mp4" | "m4v" | "mov" | "webm" | "mkv")
        || !input
            .containers
            .iter()
            .any(|container| container == ext || container == "mp4" && ext == "m4v")
    {
        return Err(bad("This browser does not support the original container. Direct playback cannot remux the file."));
    }
    let video = selected_stream(probe, "video", None)?
        .ok_or_else(|| bad("This file has no video track."))?;
    let video_codec = video["codec_name"].as_str().unwrap_or("");
    if !matches!(video_codec, "h264" | "hevc" | "av1" | "vp8" | "vp9")
        || !input.video_codecs.iter().any(|codec| codec == video_codec)
        || !supported_video_profile(&video, video_codec)
    {
        return Err(bad("This browser does not support the original video codec or profile. Direct playback cannot convert the video."));
    }
    let audio = selected_stream(probe, "audio", input.audio_index)?;
    if let Some(audio) = &audio {
        let codec = audio["codec_name"].as_str().unwrap_or("");
        if !matches!(
            codec,
            "aac" | "mp3" | "opus" | "vorbis" | "flac" | "alac" | "ac3" | "eac3"
        ) || !input
            .audio_codecs
            .iter()
            .any(|supported| supported == codec)
        {
            return Err(bad("This browser does not support the original audio codec. Direct playback cannot convert or downmix the audio."));
        }
    }
    let default_audio = selected_stream(probe, "audio", None)?;
    if default_audio
        .as_ref()
        .and_then(|stream| stream["index"].as_u64())
        != audio.as_ref().and_then(|stream| stream["index"].as_u64())
        && !input.native_audio_tracks
    {
        return Err(bad("This browser cannot select the requested embedded audio track in the original file. Choose the default audio track or a browser with native audio-track selection."));
    }
    if let Some(index) = input.subtitle_index {
        let subtitle = selected_stream(probe, "subtitle", Some(index))?
            .ok_or_else(|| bad("Subtitle track not found."))?;
        if !text_subtitle(&subtitle) {
            return Err(bad("This subtitle track is not supported in direct playback. Choose ASS/SSA or a text subtitle track."));
        }
    }
    Ok(Plan {
        method: "direct",
        reason:
            "The browser plays the original file and supported selected tracks without conversion.",
        audio,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::playback::test_support::{input, original_mkv_input, original_mkv_probe, probe};
    use serde_json::json;

    #[test]
    fn supported_original_containers_and_default_tracks_stay_direct() {
        for container in ["mp4", "m4v", "mov", "webm", "mkv"] {
            let mut request = input();
            request.containers = vec![container.into()];
            let chosen = plan(&probe(), container, &request).unwrap();
            assert_eq!(chosen.method, "direct");
            assert_eq!(chosen.audio.unwrap()["index"], 1);
        }
        assert!(plan(&probe(), "m4v", &input()).is_ok());
    }
    #[test]
    fn all_legacy_conversion_controls_are_rejected() {
        for request in [
            SessionInput {
                max_height: 1080,
                ..input()
            },
            SessionInput {
                max_bitrate: 10_000_000,
                ..input()
            },
            SessionInput {
                bandwidth_limit_bps: 500_000,
                ..input()
            },
            SessionInput {
                force_transcode: true,
                ..input()
            },
            SessionInput {
                force_remux: true,
                ..input()
            },
            SessionInput {
                subtitle_burn_index: Some(3),
                ..input()
            },
            SessionInput {
                preferred_encoder: Some("avc".into()),
                ..input()
            },
            SessionInput {
                preferred_encoder: Some(String::new()),
                ..input()
            },
        ] {
            assert_eq!(
                plan(&probe(), "mp4", &request).err().unwrap().status,
                axum::http::StatusCode::BAD_REQUEST
            );
        }
    }
    #[test]
    fn legacy_neutral_hls_fields_do_not_change_original_playback() {
        let request = SessionInput {
            hls_video_codecs: vec!["hevc".into()],
            hls_audio_codecs: vec!["opus".into()],
            hls_aac_supported: true,
            ..input()
        };
        assert_eq!(plan(&probe(), "mp4", &request).unwrap().method, "direct");
    }
    #[test]
    fn original_audio_requires_native_selection_for_alternate_track() {
        let request = SessionInput {
            audio_index: Some(2),
            ..original_mkv_input()
        };
        assert!(plan(&original_mkv_probe(), "mkv", &request).is_err());
        let native = SessionInput {
            native_audio_tracks: true,
            ..request
        };
        assert_eq!(
            plan(&original_mkv_probe(), "mkv", &native)
                .unwrap()
                .audio
                .unwrap()["index"],
            2
        );
        let mut multichannel = original_mkv_probe();
        multichannel["streams"][1]["channels"] = json!(6);
        assert!(plan(&multichannel, "mkv", &original_mkv_input()).is_ok());
    }
    #[test]
    fn unsupported_container_codec_and_precise_profile_are_rejected() {
        assert!(plan(&probe(), "avi", &input()).is_err());
        assert!(plan(&probe(), "mkv", &input()).is_err());
        let mut high10 = probe();
        high10["streams"][0]["pix_fmt"] = json!("yuv420p10le");
        assert!(plan(&high10, "mp4", &input()).is_err());
        let mut hevc12 = original_mkv_probe();
        hevc12["streams"][0]["pix_fmt"] = json!("yuv420p12le");
        assert!(plan(&hevc12, "mkv", &original_mkv_input()).is_err());
        assert!(plan(
            &probe(),
            "mp4",
            &SessionInput {
                source_video_supported: Some(false),
                ..input()
            }
        )
        .is_err());
        assert!(plan(
            &probe(),
            "mp4",
            &SessionInput {
                source_video_supported: Some(true),
                ..input()
            }
        )
        .is_ok());
        for codec in ["truehd", "dts", "pcm_s16le", "pcm_s24le", "pcm_bluray"] {
            let mut unsupported = probe();
            unsupported["streams"][1]["codec_name"] = json!(codec);
            assert!(plan(
                &unsupported,
                "mp4",
                &SessionInput {
                    audio_codecs: vec![codec.into()],
                    ..input()
                }
            )
            .is_err());
        }
    }
    #[test]
    fn invalid_tracks_and_graphical_subtitles_do_not_create_playback() {
        let mut data = probe();
        data["streams"]
            .as_array_mut()
            .unwrap()
            .push(json!({"index":3,"codec_type":"subtitle","codec_name":"hdmv_pgs_subtitle"}));
        assert!(plan(
            &data,
            "mp4",
            &SessionInput {
                subtitle_index: Some(3),
                ..input()
            }
        )
        .is_err());
        assert!(plan(
            &data,
            "mp4",
            &SessionInput {
                audio_index: Some(20),
                ..input()
            }
        )
        .is_err());
        assert!(plan(
            &data,
            "mp4",
            &SessionInput {
                subtitle_index: Some(20),
                ..input()
            }
        )
        .is_err());
        data["streams"][3]["codec_name"] = json!("ass");
        assert!(plan(
            &data,
            "mp4",
            &SessionInput {
                subtitle_index: Some(3),
                ..input()
            }
        )
        .is_ok());
    }
    #[test]
    fn unknown_duration_allows_resume_but_all_positions_remain_bounded() {
        let mut data = probe();
        data["format"].as_object_mut().unwrap().remove("duration");
        assert!(plan(
            &data,
            "mp4",
            &SessionInput {
                position_seconds: 600.0,
                ..input()
            }
        )
        .is_ok());
        for position in [-1.0, f64::NAN, f64::INFINITY, MAX_PLAYBACK_SECONDS + 1.0] {
            assert!(plan(
                &data,
                "mp4",
                &SessionInput {
                    position_seconds: position,
                    ..input()
                }
            )
            .is_err());
        }
        assert!(plan(
            &probe(),
            "mp4",
            &SessionInput {
                position_seconds: 181.0,
                ..input()
            }
        )
        .is_err());
    }
}
