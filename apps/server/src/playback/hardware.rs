//! Encoder discovery, real hardware probes, and encoder selection.
use super::{PlaybackStore, command, failure, planner::Plan, run};
use crate::{AppState, HttpError, transcoding::Settings};
use axum::{Json, extract::State};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    future::Future,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::process::Command;
use tokio::sync::Mutex;

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
#[derive(Default)]
pub(super) struct ProbeGates(Mutex<HashMap<String, Arc<Mutex<()>>>>);
impl ProbeGates {
    async fn gate(&self, name: &str) -> Arc<Mutex<()>> {
        self.0
            .lock()
            .await
            .entry(name.to_owned())
            .or_default()
            .clone()
    }
}
async fn cached_probe<F, Fut>(store: &PlaybackStore, name: &str, probe: F) -> Encoder
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Encoder>,
{
    let cached = || async {
        store
            .hardware
            .lock()
            .await
            .get(name)
            .filter(|(used, _)| used.elapsed() < Duration::from_secs(300))
            .map(|(_, encoder)| encoder.clone())
    };
    if let Some(result) = cached().await {
        return result;
    }
    let gate = store.hardware_probes.gate(name).await;
    let _probe = gate.lock().await;
    // A same-encoder request may have filled the cache while this one waited.
    if let Some(result) = cached().await {
        return result;
    }
    let result = probe().await;
    store
        .hardware
        .lock()
        .await
        .insert(name.into(), (Instant::now(), result.clone()));
    result
}

async fn test_encoder(
    store: &PlaybackStore,
    (name, backend, codec): (&str, &str, &str),
) -> Encoder {
    cached_probe(store, name, || async {
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
        Encoder {
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
        }
    })
    .await
}
async fn test_encoders(store: &PlaybackStore) -> Vec<Encoder> {
    let mut encoders = vec![];
    for candidate in candidates() {
        encoders.push(test_encoder(store, candidate).await);
    }
    encoders
}
pub(crate) async fn validate_download_encoder(
    state: &AppState,
    codec: &str,
    backend: &str,
) -> Result<(), HttpError> {
    for candidate in playback_candidates(codec, backend) {
        if test_encoder(&state.playback, candidate).await.available {
            return Ok(());
        }
    }
    Err(failure(
        "The selected YouTube GPU encoder is unavailable. Test hardware encoders and check container GPU passthrough and drivers, or select CPU encoding.",
    ))
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
    #[tokio::test]
    async fn same_encoder_probes_share_one_fill_and_independent_encoders_do_not_wait() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let directory = tempfile::tempdir().unwrap();
        let store = PlaybackStore::new(directory.path());
        let calls = AtomicUsize::new(0);
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let first = cached_probe(&store, "h264_qsv", || async {
            calls.fetch_add(1, Ordering::Relaxed);
            started_tx.send(()).unwrap();
            release_rx.await.unwrap();
            cached(("h264_qsv", "qsv", "h264"), true)
        });
        let other = async {
            started_rx.await.unwrap();
            let different = tokio::time::timeout(
                Duration::from_secs(1),
                cached_probe(&store, "h264_nvenc", || async {
                    cached(("h264_nvenc", "nvenc", "h264"), true)
                }),
            )
            .await
            .unwrap();
            assert_eq!(different.name, "h264_nvenc");
            // Reading/updating the shared cache remains possible during a probe.
            assert_eq!(store.hardware.lock().await.len(), 1);
            release_tx.send(()).unwrap();
            cached_probe(&store, "h264_qsv", || async {
                calls.fetch_add(1, Ordering::Relaxed);
                cached(("h264_qsv", "qsv", "h264"), false)
            })
            .await
        };
        let (first, second) = tokio::join!(first, other);
        assert!(first.available && second.available);
        assert_eq!(calls.load(Ordering::Relaxed), 1);
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
            allow_conversion: true,
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
        assert!(
            results
                .iter()
                .all(|result| result.available == (result.backend == "nvenc"))
        );
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
