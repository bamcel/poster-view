//! Admission is atomic across the independent job classes and shared user quota.
use super::HttpError;
use crate::transcoding::Settings;
use axum::http::StatusCode;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard},
};

#[derive(Clone, Default)]
struct Counts {
    video: u32,
    stream: u32,
    users: HashMap<String, u32>,
}
#[derive(Default)]
pub(super) struct ProducerLimits(Mutex<Counts>);
pub(super) struct Lease {
    limits: Arc<ProducerLimits>,
    owner: String,
    video: bool,
}
impl Counts {
    fn refusal(&self, owner: &str, video: bool, settings: &Settings) -> Option<&'static str> {
        if self.users.get(owner).copied().unwrap_or(0) >= settings.max_jobs_per_user.max(1) {
            Some(
                "Your concurrent playback job limit was reached. Stop another playback session and retry.",
            )
        } else if video && self.video >= settings.max_concurrent.max(1) {
            Some(
                "The server video encoding job limit was reached. Stop another video transcode and retry.",
            )
        } else if !video && self.stream >= settings.max_stream_jobs.max(1) {
            Some(
                "The server stream-copy and audio conversion job limit was reached. Stop another streamed playback and retry.",
            )
        } else {
            None
        }
    }
}
impl ProducerLimits {
    fn counts(&self) -> MutexGuard<'_, Counts> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
    pub(super) fn at_limit(&self, owner: &str, video: bool, settings: &Settings) -> bool {
        self.counts().refusal(owner, video, settings).is_some()
    }
    pub(super) fn can_replace(
        &self,
        owner: &str,
        old_video: bool,
        new_video: bool,
        settings: &Settings,
    ) -> bool {
        let mut counts = self.counts().clone();
        let Some(user) = counts.users.get_mut(owner).filter(|count| **count > 0) else {
            return false;
        };
        let class = if old_video {
            &mut counts.video
        } else {
            &mut counts.stream
        };
        if *class == 0 {
            return false;
        }
        *user -= 1;
        *class -= 1;
        counts.refusal(owner, new_video, settings).is_none()
    }
    pub(super) fn reserve(
        self: &Arc<Self>,
        owner: &str,
        video: bool,
        settings: &Settings,
    ) -> Result<Lease, HttpError> {
        let mut counts = self.counts();
        if let Some(reason) = counts.refusal(owner, video, settings) {
            return Err(HttpError {
                status: StatusCode::TOO_MANY_REQUESTS,
                detail: reason.into(),
            });
        }
        if video {
            counts.video += 1;
        } else {
            counts.stream += 1;
        }
        *counts.users.entry(owner.into()).or_default() += 1;
        Ok(Lease {
            limits: self.clone(),
            owner: owner.into(),
            video,
        })
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        let mut counts = self.limits.counts();
        if self.video {
            counts.video -= 1;
        } else {
            counts.stream -= 1;
        }
        if let Some(count) = counts.users.get_mut(&self.owner) {
            *count -= 1;
            if *count == 0 {
                counts.users.remove(&self.owner);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replacement_only_retires_a_lease_that_can_make_room() {
        let limits = Arc::new(ProducerLimits::default());
        let settings = Settings {
            max_concurrent: 1,
            max_stream_jobs: 1,
            max_jobs_per_user: 1,
            ..Default::default()
        };
        let video = limits.reserve("alice", true, &settings).unwrap();
        assert!(limits.can_replace("alice", true, true, &settings));
        assert!(limits.can_replace("alice", true, false, &settings));
        assert!(!limits.can_replace("nobody", true, false, &settings));
        let stream = limits.reserve("bob", false, &settings).unwrap();
        assert!(!limits.can_replace("alice", true, false, &settings));
        let relaxed = Settings {
            max_jobs_per_user: 5,
            ..settings.clone()
        };
        assert!(!limits.can_replace("alice", true, false, &relaxed));
        assert!(limits.can_replace("bob", false, false, &settings));
        assert_eq!(limits.counts().video, 1);
        assert_eq!(limits.counts().stream, 1);
        drop(stream);
        drop(video);
        assert!(!limits.can_replace("alice", true, true, &settings));
    }
    #[test]
    fn defaults_admit_eight_stream_jobs_two_video_jobs_and_five_per_user() {
        let limits = Arc::new(ProducerLimits::default());
        let settings = Settings::default();
        let mut held = Vec::new();
        for _ in 0..5 {
            held.push(limits.reserve("alice", false, &settings).unwrap());
        }
        assert!(limits.reserve("alice", false, &settings).is_err());
        for _ in 0..3 {
            held.push(limits.reserve("bob", false, &settings).unwrap());
        }
        assert!(limits.reserve("carol", false, &settings).is_err());
        for _ in 0..2 {
            held.push(limits.reserve("carol", true, &settings).unwrap());
        }
        assert!(limits.reserve("dave", true, &settings).is_err());
        drop(held);
        assert!(!limits.at_limit("alice", false, &settings));
        assert!(!limits.at_limit("carol", true, &settings));
    }
    #[test]
    fn classes_are_independent_but_users_share_their_quota() {
        let limits = Arc::new(ProducerLimits::default());
        let settings = Settings {
            max_concurrent: 1,
            max_stream_jobs: 2,
            max_jobs_per_user: 2,
            ..Default::default()
        };
        let video = limits.reserve("alice", true, &settings).unwrap();
        assert!(limits.at_limit("bob", true, &settings));
        let stream = limits.reserve("alice", false, &settings).unwrap();
        assert!(limits.at_limit("alice", false, &settings));
        assert!(!limits.at_limit("bob", false, &settings));
        let other = limits.reserve("bob", false, &settings).unwrap();
        assert!(limits.at_limit("carol", false, &settings));
        drop(video);
        assert!(!limits.at_limit("alice", true, &settings));
        drop(stream);
        drop(other);
        let counts = limits.counts();
        assert_eq!(counts.video, 0);
        assert_eq!(counts.stream, 0);
        assert!(counts.users.is_empty());
    }
    #[test]
    fn failed_reservations_leave_no_counts_and_explain_the_limit() {
        let limits = Arc::new(ProducerLimits::default());
        let settings = Settings {
            max_concurrent: 1,
            max_stream_jobs: 1,
            max_jobs_per_user: 2,
            ..Default::default()
        };
        let video = limits.reserve("alice", true, &settings).unwrap();
        let stream = limits.reserve("alice", false, &settings).unwrap();
        for (owner, class, text) in [
            ("alice", false, "Your concurrent"),
            ("bob", true, "video encoding"),
            ("bob", false, "stream-copy"),
        ] {
            let error = limits.reserve(owner, class, &settings).err().unwrap();
            assert_eq!(error.status, StatusCode::TOO_MANY_REQUESTS);
            assert!(error.detail.contains(text));
        }
        assert_eq!(limits.counts().users.len(), 1);
        drop(video);
        drop(stream);
        assert!(limits.counts().users.is_empty());
        assert!(limits.reserve("bob", true, &settings).is_ok());
    }
    #[test]
    fn concurrent_reservations_cannot_overbook_or_leak() {
        let limits = Arc::new(ProducerLimits::default());
        let settings = Arc::new(Settings {
            max_concurrent: 3,
            max_stream_jobs: 3,
            max_jobs_per_user: 4,
            ..Default::default()
        });
        let start = Arc::new(std::sync::Barrier::new(13));
        let reserved = Arc::new(std::sync::Barrier::new(13));
        let release = Arc::new(std::sync::Barrier::new(13));
        let workers = (0..12)
            .map(|index| {
                let (limits, settings, start, reserved, release) = (
                    limits.clone(),
                    settings.clone(),
                    start.clone(),
                    reserved.clone(),
                    release.clone(),
                );
                std::thread::spawn(move || {
                    start.wait();
                    let lease = limits.reserve("shared", index % 2 == 0, &settings).ok();
                    reserved.wait();
                    release.wait();
                    drop(lease);
                })
            })
            .collect::<Vec<_>>();
        start.wait();
        reserved.wait();
        {
            let counts = limits.counts();
            assert_eq!(counts.video + counts.stream, 4);
            assert!(counts.video <= 3);
            assert!(counts.stream <= 3);
            assert_eq!(counts.users["shared"], 4);
        }
        release.wait();
        for worker in workers {
            worker.join().unwrap();
        }
        let counts = limits.counts();
        assert_eq!(counts.video + counts.stream, 0);
        assert!(counts.users.is_empty());
    }
}
