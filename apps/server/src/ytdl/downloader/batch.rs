//! Job-local progress for bounded, independently completing video downloads.
use super::{AppState, EncodingProgress, HttpError, Job, download_speed};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashSet},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

#[derive(Clone)]
pub(super) struct Batch(Arc<Mutex<Progress>>);

#[derive(Clone)]
pub(super) struct VideoProgress {
    batch: Batch,
    id: String,
    job: Job,
}

#[derive(Clone)]
struct Progress {
    total: usize,
    completed: HashSet<String>,
    active: BTreeMap<String, Sample>,
}

#[derive(Clone)]
struct Sample {
    title: String,
    phase: String,
    fraction: f64,
    speed: Option<(f64, Instant)>,
    encoding: Option<f64>,
    encoding_detail: Option<String>,
    eta: Option<String>,
}

impl Batch {
    pub(super) fn new(total: usize) -> Self {
        Self(Arc::new(Mutex::new(Progress {
            total,
            completed: HashSet::new(),
            active: BTreeMap::new(),
        })))
    }

    pub(super) async fn start(
        &self,
        state: &AppState,
        job: &Job,
        id: &str,
        title: String,
    ) -> Result<VideoProgress, HttpError> {
        let mut progress = self.0.lock().await;
        if !progress.completed.contains(id) {
            progress.active.entry(id.to_owned()).or_insert(Sample {
                title,
                phase: "inspecting".into(),
                fraction: 0.0,
                speed: None,
                encoding: None,
                encoding_detail: None,
                eta: None,
            });
        }
        progress.persist(state, &job.id).await?;
        Ok(VideoProgress {
            batch: self.clone(),
            id: id.to_owned(),
            job: job.clone(),
        })
    }

    pub(super) async fn complete(
        &self,
        state: &AppState,
        job: &Job,
        id: &str,
    ) -> Result<(), HttpError> {
        let mut progress = self.0.lock().await;
        progress.active.remove(id);
        progress.completed.insert(id.to_owned());
        progress.persist(state, &job.id).await
    }
}

impl VideoProgress {
    pub(super) async fn title(
        &self,
        state: &AppState,
        job: &Job,
        title: String,
    ) -> Result<(), HttpError> {
        let mut progress = self.batch.0.lock().await;
        if let Some(sample) = progress.active.get_mut(&self.id) {
            sample.title = title;
        }
        progress.persist(state, &job.id).await
    }

    pub(super) async fn phase(
        &self,
        state: &AppState,
        job: &Job,
        phase: &str,
    ) -> Result<(), HttpError> {
        let mut progress = self.batch.0.lock().await;
        if let Some(sample) = progress.active.get_mut(&self.id) {
            sample.phase = phase.to_owned();
            sample.speed = None;
            sample.eta = None;
        }
        progress.persist(state, &job.id).await
    }

    pub(super) async fn record(
        &self,
        state: &AppState,
        id: &str,
        encoding: &EncodingProgress,
        duration: Option<Option<f64>>,
        download: Option<&Value>,
    ) -> Result<(), HttpError> {
        let mut progress = self.batch.0.lock().await;
        if let Some(sample) = progress.active.get_mut(&self.id) {
            if let Some(duration) = duration {
                let mut scratch = self.job.clone();
                scratch.encoding_progress = sample.encoding;
                encoding.record(&mut scratch, duration);
                sample.encoding = scratch.encoding_progress;
                sample.encoding_detail = scratch.speed;
                sample.eta = scratch.eta;
                sample.speed = None;
                sample.phase = "processing".into();
                if let Some(percent) = sample.encoding {
                    sample.fraction = sample.fraction.max(0.5 + 0.45 * percent / 100.0);
                }
            } else if let Some(value) = download {
                sample.phase = "downloading".into();
                let total = value["total_bytes"]
                    .as_f64()
                    .or_else(|| value["total_bytes_estimate"].as_f64());
                if let Some((bytes, total)) = value["downloaded_bytes"]
                    .as_f64()
                    .zip(total)
                    .filter(|(bytes, total)| bytes.is_finite() && total.is_finite() && *total > 0.0)
                {
                    let weight = if self.job.settings.effective().convert {
                        0.5
                    } else {
                        0.95
                    };
                    sample.fraction = sample
                        .fraction
                        .max((bytes / total).clamp(0.0, 1.0) * weight);
                }
                sample.speed = value["speed"]
                    .as_f64()
                    .filter(|speed| speed.is_finite() && *speed >= 0.0)
                    .map(|speed| (speed, Instant::now()));
                sample.eta = value["eta"]
                    .as_f64()
                    .filter(|seconds| seconds.is_finite() && *seconds >= 0.0)
                    .map(|seconds| format!("{seconds:.0}s"));
            }
        }
        progress.persist(state, id).await
    }
}

fn active_status(status: &str) -> bool {
    matches!(
        status,
        "queued" | "inspecting" | "downloading" | "processing"
    )
}

impl Progress {
    async fn persist(&self, state: &AppState, id: &str) -> Result<(), HttpError> {
        let guard = state.ytdl_lock.clone().lock_owned().await;
        let state = state.clone();
        let id = id.to_owned();
        let snapshot = self.clone();
        tokio::task::spawn_blocking(move || {
            // Retain the queue lock through atomic persistence even if a sibling
            // failure drops the async worker while this write is in flight.
            let _guard = guard;
            let mut jobs: Vec<Job> = super::super::load(&state, "plugin-ytdl-jobs")?;
            if let Some(job) = jobs
                .iter_mut()
                .find(|job| job.id == id && active_status(&job.status))
            {
                snapshot.apply(job);
            }
            super::super::save(&state, "plugin-ytdl-jobs", &jobs)
        })
        .await
        .map_err(super::super::err)?
    }

    fn apply(&self, job: &mut Job) {
        job.total_videos = self.total;
        job.completed_videos = self.completed.len();
        let fraction = self.completed.len() as f64
            + self
                .active
                .values()
                .map(|sample| sample.fraction)
                .sum::<f64>();
        job.progress = Some(
            job.progress
                .unwrap_or(0.0)
                .max((fraction / self.total.max(1) as f64 * 100.0).clamp(0.0, 100.0)),
        );
        job.current_video_title = (!self.active.is_empty()).then(|| {
            self.active
                .values()
                .take(2)
                .map(|sample| sample.title.as_str())
                .collect::<Vec<_>>()
                .join(" · ")
        });
        let downloading = self
            .active
            .values()
            .any(|sample| sample.phase == "downloading");
        let processing = self
            .active
            .values()
            .any(|sample| sample.phase == "processing");
        if !self.active.is_empty() {
            job.status = if downloading {
                "downloading"
            } else if processing {
                "processing"
            } else {
                "inspecting"
            }
            .into();
        }
        let speeds = self
            .active
            .values()
            .filter_map(|sample| sample.speed)
            .filter(|(_, updated)| updated.elapsed() <= Duration::from_secs(5))
            .map(|(speed, _)| speed)
            .collect::<Vec<_>>();
        job.speed = if !speeds.is_empty() {
            Some(download_speed(speeds.iter().sum()))
        } else if processing && !downloading {
            self.active
                .values()
                .find_map(|sample| sample.encoding_detail.clone())
        } else {
            None
        };
        job.encoding_progress = if processing {
            let samples = self
                .active
                .values()
                .filter_map(|sample| sample.encoding)
                .collect::<Vec<_>>();
            (!samples.is_empty()).then(|| samples.iter().sum::<f64>() / samples.len() as f64)
        } else {
            None
        };
        // Preserve individual-video estimates, but never present one stream's
        // ETA as the estimate for two independently progressing videos.
        job.eta = if self.active.len() == 1 {
            self.active
                .values()
                .next()
                .and_then(|sample| sample.eta.clone())
        } else {
            None
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn job() -> Job {
        serde_json::from_value(json!({"id":"batch", "url":"", "title":"", "status":"downloading", "progress":null, "speed":null, "eta":null, "error":null, "created_at":"", "settings":super::super::super::Settings::default()})).unwrap()
    }

    #[tokio::test]
    async fn independent_downloads_aggregate_and_complete_out_of_order() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        let job = job();
        super::super::super::save(&state, "plugin-ytdl-jobs", &vec![job.clone()]).unwrap();
        let batch = Batch::new(2);
        let first = batch
            .start(&state, &job, "a", "First".into())
            .await
            .unwrap();
        let second = batch
            .start(&state, &job, "b", "Second".into())
            .await
            .unwrap();
        for handle in [&first, &second] {
            handle
                .record(
                    &state,
                    &job.id,
                    &EncodingProgress::default(),
                    None,
                    Some(&json!({"downloaded_bytes":50,"total_bytes":100,"speed":20_000_000})),
                )
                .await
                .unwrap();
        }
        let read = || {
            super::super::super::load::<Vec<Job>>(&state, "plugin-ytdl-jobs")
                .unwrap()
                .remove(0)
        };
        assert_eq!(read().speed.as_deref(), Some("40.0 MB/s"));
        assert_eq!(read().progress, Some(47.5));
        first
            .record(
                &state,
                &job.id,
                &EncodingProgress::default(),
                None,
                Some(&json!({"downloaded_bytes":5,"total_bytes":100,"speed":20_000_000})),
            )
            .await
            .unwrap();
        assert_eq!(
            read().progress,
            Some(47.5),
            "audio stream restarts must not regress progress"
        );
        batch.complete(&state, &job, "b").await.unwrap();
        assert_eq!(read().completed_videos, 1);
        assert_eq!(read().speed.as_deref(), Some("20.0 MB/s"));
        batch.complete(&state, &job, "a").await.unwrap();
        assert_eq!(read().progress, Some(100.0));
        assert_eq!(read().speed, None);
    }

    #[tokio::test]
    async fn batch_progress_surfaces_queue_write_failures() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        let job = job();
        super::super::super::save(&state, "plugin-ytdl-jobs", &vec![job.clone()]).unwrap();
        let batch = Batch::new(2);
        let video = batch
            .start(&state, &job, "a", "First".into())
            .await
            .unwrap();
        std::fs::write(
            state.runtime.data_dir().join("ytdl-jobs.json"),
            "invalid queue",
        )
        .unwrap();
        assert!(
            video
                .record(
                    &state,
                    &job.id,
                    &EncodingProgress::default(),
                    None,
                    Some(&json!({"downloaded_bytes":50,"total_bytes":100}))
                )
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn mixed_encoding_samples_and_late_updates_preserve_cancellation() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        let mut job = job();
        job.settings.convert = true;
        super::super::super::save(&state, "plugin-ytdl-jobs", &vec![job.clone()]).unwrap();
        let batch = Batch::new(2);
        let first = batch
            .start(&state, &job, "a", "First".into())
            .await
            .unwrap();
        let second = batch
            .start(&state, &job, "b", "Second".into())
            .await
            .unwrap();
        first.phase(&state, &job, "processing").await.unwrap();
        second
            .record(
                &state,
                &job.id,
                &EncodingProgress::default(),
                None,
                Some(&json!({"downloaded_bytes":50,"total_bytes":100,"speed":10_000_000})),
            )
            .await
            .unwrap();
        let encoding = EncodingProgress {
            seconds: Some(50.0),
            ..Default::default()
        };
        first
            .record(&state, &job.id, &encoding, Some(Some(100.0)), None)
            .await
            .unwrap();
        let mut saved = super::super::super::load::<Vec<Job>>(&state, "plugin-ytdl-jobs").unwrap();
        assert_eq!(saved[0].status, "downloading");
        assert_eq!(saved[0].encoding_progress, Some(50.0));
        assert_eq!(saved[0].progress, Some(48.75));
        saved[0].status = "cancelled".into();
        super::super::super::save(&state, "plugin-ytdl-jobs", &saved).unwrap();
        batch.complete(&state, &job, "a").await.unwrap();
        first.title(&state, &job, "Late".into()).await.unwrap();
        let after = super::super::super::load::<Vec<Job>>(&state, "plugin-ytdl-jobs").unwrap();
        assert_eq!(after[0].status, "cancelled");
        assert_eq!(after[0].progress, saved[0].progress);
    }
}
