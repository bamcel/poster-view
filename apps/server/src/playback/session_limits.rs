//! Playback sessions count once, independently of delivery generations and producers.
use super::HttpError;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

#[derive(Default)]
pub(super) struct SessionLimits(Mutex<HashMap<String, u32>>);
pub(super) struct Lease {
    limits: Arc<SessionLimits>,
    owner: String,
}
impl SessionLimits {
    pub(super) fn reserve(self: &Arc<Self>, owner: &str, limit: u32) -> Result<Lease, HttpError> {
        let mut counts = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let count = counts.entry(owner.into()).or_default();
        if limit != 0 && *count >= limit {
            return Err(HttpError {
                status: axum::http::StatusCode::TOO_MANY_REQUESTS,
                detail:
                    "Your simultaneous playback limit was reached. Stop another video and retry."
                        .into(),
            });
        }
        *count += 1;
        Ok(Lease {
            limits: self.clone(),
            owner: owner.into(),
        })
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        let mut counts = self
            .limits
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(count) = counts.get_mut(&self.owner) {
            *count -= 1;
            if *count == 0 {
                counts.remove(&self.owner);
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn limits_are_per_owner_and_zero_is_unlimited() {
        let limits = Arc::new(SessionLimits::default());
        let first = limits.reserve("alice", 1).unwrap();
        assert!(limits.reserve("alice", 1).is_err());
        let other = limits.reserve("bob", 1).unwrap();
        let unlimited = limits.reserve("alice", 0).unwrap();
        drop(first);
        drop(unlimited);
        drop(other);
        assert!(limits.0.lock().unwrap().is_empty());
        assert!(limits.reserve("alice", 1).is_ok());
    }
    #[test]
    fn concurrent_creates_cannot_exceed_one_users_limit() {
        let limits = Arc::new(SessionLimits::default());
        let ready = Arc::new(std::sync::Barrier::new(9));
        let release = Arc::new(std::sync::Barrier::new(9));
        let workers = (0..8)
            .map(|_| {
                let (limits, ready, release) = (limits.clone(), ready.clone(), release.clone());
                std::thread::spawn(move || {
                    let lease = limits.reserve("alice", 2).ok();
                    ready.wait();
                    release.wait();
                    drop(lease);
                })
            })
            .collect::<Vec<_>>();
        ready.wait();
        let count = limits.0.lock().unwrap().get("alice").copied();
        release.wait();
        for worker in workers {
            worker.join().unwrap();
        }
        assert_eq!(count, Some(2));
        assert!(limits.0.lock().unwrap().is_empty());
    }
}
