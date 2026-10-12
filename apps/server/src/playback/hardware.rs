//! Encoder discovery, real hardware probes, and encoder selection.
use super::{command, failure, run, Plan, PlaybackStore};
use crate::{transcoding::Settings, AppState, HttpError};
use axum::{extract::State, Json};
use serde::Serialize;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tokio::process::Command;

#[derive(Clone, Serialize)]
pub(crate) struct Encoder {
    name: String,
    backend: String,
    codec: String,
    available: bool,
    detail: String,
}
fn candidates() -> Vec<(&'static str, &'static str, &'static str)> {
    vec![
        ("h264_qsv", "qsv", "h264"),
        ("hevc_qsv", "qsv", "hevc"),
        ("av1_qsv", "qsv", "av1"),
        ("h264_nvenc", "nvenc", "h264"),
        ("hevc_nvenc", "nvenc", "hevc"),
        ("av1_nvenc", "nvenc", "av1"),
        ("h264_vaapi", "vaapi", "h264"),
        ("hevc_vaapi", "vaapi", "hevc"),
        ("av1_vaapi", "vaapi", "av1"),
    ]
}
pub(super) fn hardware_input(cmd: &mut Command, backend: &str) {
    if backend == "qsv" {
        cmd.args(["-init_hw_device", "qsv=qs", "-filter_hw_device", "qs"]);
    } else if backend == "vaapi" {
        cmd.args(["-vaapi_device", "/dev/dri/renderD128"]);
    }
}
pub(super) fn upload(backend: &str) -> &'static str {
    match backend {
        "qsv" => ",format=nv12,hwupload=extra_hw_frames=64",
        "vaapi" => ",format=nv12,hwupload",
        _ => ",format=yuv420p",
    }
}
fn playback_candidates(
    codec: &str,
    backend: &str,
) -> Vec<(&'static str, &'static str, &'static str)> {
    candidates()
        .into_iter()
        .filter(|(_, candidate_backend, candidate_codec)| {
            *candidate_codec == codec && (backend == "auto" || *candidate_backend == backend)
        })
        .collect()
}
async fn test_encoder(
    store: &PlaybackStore,
    (name, backend, codec): (&str, &str, &str),
) -> Encoder {
    let mut cache = store.hardware.lock().await;
    if let Some((used, encoder)) = cache.get(name) {
        if used.elapsed() < Duration::from_secs(300) {
            return encoder.clone();
        }
    }
    let mut cmd = command("ffmpeg");
    cmd.args(["-nostdin", "-hide_banner", "-v", "error"]);
    hardware_input(&mut cmd, backend);
    cmd.args([
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=128x128:r=10:d=0.2",
        "-vf",
    ]);
    let filter = upload(backend).trim_start_matches(',');
    cmd.arg(filter)
        .args(["-c:v", name, "-frames:v", "2", "-f", "null", "-"]);
    let available = run(
        &mut cmd,
        Duration::from_secs(4),
        "Hardware encoder validation",
    )
    .await
    .is_ok();
    let result = Encoder {
        name: name.into(),
        backend: backend.into(),
        codec: codec.into(),
        available,
        detail: if available {
            "A real encode completed successfully."
        } else {
            "A test encode failed. Check GPU devices, drivers, and this FFmpeg build."
        }
        .into(),
    };
    cache.insert(name.into(), (Instant::now(), result.clone()));
    result
}
async fn test_encoders(store: &PlaybackStore) -> Vec<Encoder> {
    let mut encoders = vec![];
    for candidate in candidates() {
        encoders.push(test_encoder(store, candidate).await);
    }
    encoders
}
pub(crate) async fn capabilities(State(state): State<AppState>) -> Result<Json<Value>, HttpError> {
    let encoders = test_encoders(&state.playback).await;
    Ok(Json(
        json!({"encoders":encoders,"hardware_help":{"qsv":"Expose /dev/dri to the container and give the container user access to the render device.","vaapi":"Expose /dev/dri and the render device with working Intel/AMD userspace drivers.","nvenc":"Install the Unraid NVIDIA driver and configure NVIDIA Container Toolkit/GPU access."},"software":"H.264 uses libx264; HEVC and AV1 are used only when enabled and supported by the browser."}),
    ))
}
pub(super) async fn encoder(
    store: &PlaybackStore,
    plan: &Plan,
    settings: &Settings,
) -> Result<(String, String), HttpError> {
    if settings.hardware_enabled {
        // Playback validates only the requested codec/backend, stopping at the
        // preferred available encoder. The explicit capability action remains exhaustive.
        for candidate in playback_candidates(&plan.output_codec, &settings.hardware_backend) {
            let result = test_encoder(store, candidate).await;
            if result.available {
                return Ok((result.name, result.backend));
            }
        }
        if !settings.software_fallback {
            return Err(failure(
                "The selected hardware encoder is unavailable and software fallback is disabled. Check Transcoding settings and GPU device access.",
            ));
        }
    }
    Ok((
        match plan.output_codec.as_str() {
            "hevc" => "libx265",
            "av1" => "libsvtav1",
            _ => "libx264",
        }
        .into(),
        "software".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::playback::{
        plan,
        test_support::{input, probe},
    };
    fn cached(candidate: (&str, &str, &str), available: bool) -> Encoder {
        Encoder {
            name: candidate.0.into(),
            backend: candidate.1.into(),
            codec: candidate.2.into(),
            available,
            detail: "Fixture".into(),
        }
    }
    #[test]
    fn playback_candidates_match_only_requested_backend_and_codec_in_priority_order() {
        assert_eq!(
            playback_candidates("hevc", "auto")
                .into_iter()
                .map(|candidate| candidate.0)
                .collect::<Vec<_>>(),
            ["hevc_qsv", "hevc_nvenc", "hevc_vaapi"]
        );
        assert_eq!(
            playback_candidates("h264", "nvenc"),
            [("h264_nvenc", "nvenc", "h264")]
        );
    }
    #[tokio::test]
    async fn playback_stops_at_cached_preferred_encoder_without_testing_other_codecs() {
        let directory = tempfile::tempdir().unwrap();
        let store = PlaybackStore::new(directory.path());
        let result = cached(("h264_qsv", "qsv", "h264"), true);
        store
            .hardware
            .lock()
            .await
            .insert(result.name.clone(), (Instant::now(), result));
        let settings = Settings {
            hardware_enabled: true,
            ..Settings::default()
        };
        let mut request = input();
        request.force_transcode = true;
        let chosen = plan(&probe(), "mkv", &request, &settings).unwrap();
        assert_eq!(
            encoder(&store, &chosen, &settings).await.unwrap(),
            ("h264_qsv".into(), "qsv".into())
        );
        assert_eq!(store.hardware.lock().await.len(), 1);
        let failed = cached(("h264_qsv", "qsv", "h264"), false);
        let fallback = cached(("h264_nvenc", "nvenc", "h264"), true);
        {
            let mut cache = store.hardware.lock().await;
            cache.insert(failed.name.clone(), (Instant::now(), failed));
            cache.insert(fallback.name.clone(), (Instant::now(), fallback));
        }
        assert_eq!(
            encoder(&store, &chosen, &settings).await.unwrap(),
            ("h264_nvenc".into(), "nvenc".into())
        );
        assert_eq!(store.hardware.lock().await.len(), 2);
    }
    #[tokio::test]
    async fn explicit_capabilities_still_reports_all_individually_cached_encoders() {
        let directory = tempfile::tempdir().unwrap();
        let store = PlaybackStore::new(directory.path());
        for candidate in candidates() {
            let result = cached(candidate, candidate.1 == "nvenc");
            store
                .hardware
                .lock()
                .await
                .insert(result.name.clone(), (Instant::now(), result));
        }
        let results = test_encoders(&store).await;
        assert_eq!(results.len(), 9);
        assert!(results
            .iter()
            .all(|result| result.available == (result.backend == "nvenc")));
        assert_eq!(
            results
                .iter()
                .map(|result| result.name.as_str())
                .collect::<Vec<_>>(),
            candidates()
                .iter()
                .map(|candidate| candidate.0)
                .collect::<Vec<_>>()
        );
    }
}
