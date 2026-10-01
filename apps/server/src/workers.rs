use std::{
    collections::HashMap,
    sync::{Arc, Condvar, LazyLock, Mutex},
    time::{Duration, Instant},
};

fn limit(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|v| (1..=8).contains(v))
        .unwrap_or(default)
}
static CPU: LazyLock<(Mutex<usize>, Condvar, usize)> = LazyLock::new(|| {
    (
        Mutex::new(0),
        Condvar::new(),
        limit("POSTERVIEW_MEDIA_WORKERS", 2),
    )
});
static NETWORK: LazyLock<Arc<tokio::sync::Semaphore>> = LazyLock::new(|| {
    Arc::new(tokio::sync::Semaphore::new(limit(
        "POSTERVIEW_NETWORK_WORKERS",
        4,
    )))
});
pub(crate) fn network_limit() -> usize {
    limit("POSTERVIEW_NETWORK_WORKERS", 4)
}
pub(crate) async fn network() -> tokio::sync::OwnedSemaphorePermit {
    NETWORK
        .clone()
        .acquire_owned()
        .await
        .expect("worker pool is never closed")
}
struct CpuPermit;
impl Drop for CpuPermit {
    fn drop(&mut self) {
        *CPU.0.lock().unwrap_or_else(|e| e.into_inner()) -= 1;
        CPU.1.notify_one();
    }
}
pub(crate) fn blocking<T>(job: impl FnOnce() -> T) -> T {
    let mut active = CPU.0.lock().unwrap_or_else(|e| e.into_inner());
    while *active >= CPU.2 {
        active = CPU.1.wait(active).unwrap_or_else(|e| e.into_inner());
    }
    *active += 1;
    drop(active);
    let _permit = CpuPermit;
    job()
}
/// Scoped workers preserve input order and share the process-wide CPU budget.
pub(crate) fn parallel<T: Send, R: Send>(jobs: Vec<T>, work: impl Fn(T) -> R + Sync) -> Vec<R> {
    let count = jobs.len();
    let queue = Mutex::new(jobs.into_iter().enumerate());
    let results = Mutex::new(Vec::with_capacity(count));
    std::thread::scope(|scope| {
        for _ in 0..CPU.2.min(count) {
            let work = &work;
            let queue = &queue;
            let results = &results;
            scope.spawn(move || {
                loop {
                    let Some((index, item)) =
                        queue.lock().unwrap_or_else(|e| e.into_inner()).next()
                    else {
                        break;
                    };
                    let result = blocking(|| work(item));
                    results
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .push((index, result));
                }
            });
        }
    });
    let mut results = results.into_inner().unwrap_or_else(|e| e.into_inner());
    results.sort_by_key(|(index, _)| *index);
    results.into_iter().map(|(_, result)| result).collect()
}
type Gate = Arc<tokio::sync::Mutex<Instant>>;
static GATES: LazyLock<Mutex<HashMap<String, Gate>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
pub(crate) async fn provider(name: &str) -> tokio::sync::OwnedMutexGuard<Instant> {
    let gate = GATES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(name.into())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(Instant::now())))
        .clone();
    let mut guard = gate.lock_owned().await;
    tokio::time::sleep(guard.saturating_duration_since(Instant::now())).await;
    *guard = Instant::now() + Duration::from_millis(if name == "anilist" { 1500 } else { 250 });
    guard
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scoped_workers_are_bounded_and_preserve_order() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let active = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);
        let results = parallel((0..12).collect(), |v| {
            let n = active.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(n, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(5));
            active.fetch_sub(1, Ordering::SeqCst);
            v * 2
        });
        assert_eq!(results, (0..12).map(|v| v * 2).collect::<Vec<_>>());
        assert!(peak.load(Ordering::SeqCst) <= CPU.2);
    }
    #[tokio::test]
    async fn network_budget_applies_across_job_groups() {
        let mut permits = Vec::new();
        for _ in 0..network_limit() {
            permits.push(network().await);
        }
        let started = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let signal = started.clone();
        let waiting = tokio::spawn(async move {
            let _permit = network().await;
            signal.store(true, std::sync::atomic::Ordering::SeqCst);
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!started.load(std::sync::atomic::Ordering::SeqCst));
        permits.pop();
        tokio::time::timeout(Duration::from_secs(2), waiting)
            .await
            .unwrap()
            .unwrap();
        assert!(started.load(std::sync::atomic::Ordering::SeqCst));
    }
}
