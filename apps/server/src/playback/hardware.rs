//! Encoder discovery, real hardware probes, and encoder selection.
use super::{Plan, PlaybackStore, command, failure, run};
use crate::{AppState, HttpError, transcoding::Settings};
use axum::{Json, extract::State};
use serde::Serialize;
use serde_json::{Value, json};
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
async fn test_encoders(store: &PlaybackStore) -> Vec<Encoder> {
    let mut cache = store.hardware.lock().await;
    if let Some((used, encoders)) = &*cache {
        if used.elapsed() < Duration::from_secs(300) {
            return encoders.clone();
        }
    }
    let mut encoders = vec![];
    for (name, backend, codec) in candidates() {
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
        encoders.push(Encoder {
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
        });
    }
    *cache = Some((Instant::now(), encoders.clone()));
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
        let encoders = test_encoders(store).await;
        let chosen = encoders
            .iter()
            .filter(|e| {
                e.available
                    && e.codec == plan.output_codec
                    && (settings.hardware_backend == "auto"
                        || e.backend == settings.hardware_backend)
            })
            .min_by_key(|e| match e.backend.as_str() {
                "qsv" => 0,
                "nvenc" => 1,
                _ => 2,
            });
        if let Some(e) = chosen {
            return Ok((e.name.clone(), e.backend.clone()));
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
