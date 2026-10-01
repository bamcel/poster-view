use crate::AppState;
use notify::{Config, Event, EventKind, PollWatcher, RecursiveMode, Watcher};
use posterview_infra_sqlite::ServerStore;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

// Keep fingerprints until the file changes, including delayed events from long scans.
// The lock spans the atomic rename: an event cannot race fingerprint registration.
type WriteStamp = (u64, std::time::SystemTime);
static OWN_WRITES: std::sync::LazyLock<std::sync::Mutex<BTreeMap<PathBuf, (Instant, WriteStamp)>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(BTreeMap::new()));

fn stamp(path: &Path) -> Option<WriteStamp> {
    let metadata = std::fs::metadata(path).ok()?;
    Some((metadata.len(), metadata.modified().ok()?))
}

pub(crate) fn own_write<T>(
    path: &Path,
    write: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let mut writes = OWN_WRITES.lock().unwrap_or_else(|e| e.into_inner());
    // Bound the registry without expiring fingerprints during a long library scan.
    if writes.len() >= 50_000 && !writes.contains_key(path) {
        if let Some(oldest) = writes
            .iter()
            .min_by_key(|(_, (time, _))| *time)
            .map(|(path, _)| path.clone())
        {
            writes.remove(&oldest);
        }
    }
    let result = write();
    if result.is_ok() {
        if let Some(value) = stamp(path) {
            writes.insert(path.to_path_buf(), (Instant::now(), value));
        }
    }
    result
}

fn external_change(path: &Path, kind: &EventKind) -> bool {
    // Directory modification notifications accompany atomic sidecar writes.
    // Child create/remove/rename events still report actual folder-content changes.
    if matches!(kind, EventKind::Modify(modification) if !matches!(modification, notify::event::ModifyKind::Name(_)))
        && path.is_dir()
    {
        return false;
    }
    let mut writes = OWN_WRITES.lock().unwrap_or_else(|e| e.into_inner());
    if writes
        .get(path)
        .is_some_and(|(_, expected)| stamp(path).as_ref() == Some(expected))
    {
        false
    } else {
        writes.remove(path);
        true
    }
}

fn relevant(path: &Path, root: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    !crate::native_scan::credit_video(path)
        && !relative.components().any(|part| {
            let v = part.as_os_str().to_string_lossy().to_ascii_lowercase();
            v.starts_with('.') || crate::native_scan::auxiliary_folder(&v)
        })
}
#[derive(Default)]
struct RecoveryGate {
    requested: bool,
}
impl RecoveryGate {
    fn request(&mut self) -> bool {
        if self.requested {
            false
        } else {
            self.requested = true;
            true
        }
    }
    fn reset(&mut self) {
        self.requested = false;
    }
}
struct Pending {
    first: Instant,
    last: Instant,
    // None means watcher overflow/error: reconcile the full library.
    paths: Option<std::collections::BTreeSet<PathBuf>>,
}
impl Pending {
    fn new() -> Self {
        let now = Instant::now();
        Self {
            first: now,
            last: now,
            paths: Some(Default::default()),
        }
    }
}
fn changed_scope(path: &Path, root: &Path) -> PathBuf {
    // A configured series root must be reconciled as one hierarchy.
    if root.join("tvshow.nfo").is_file() {
        return root.to_owned();
    }
    let Ok(relative) = path.strip_prefix(root) else {
        return root.to_owned();
    };
    let Some(first) = relative.components().next() else {
        return root.to_owned();
    };
    let directory = if path.is_file() || (!path.is_dir() && path.extension().is_some()) {
        path.parent().unwrap_or(root)
    } else {
        path
    };
    for parent in directory.ancestors().take_while(|p| p.starts_with(root)) {
        if crate::native_scan::season_folder(
            &parent.file_name().unwrap_or_default().to_string_lossy(),
        )
        .is_none()
            && parent.join("tvshow.nfo").is_file()
        {
            return parent.to_owned();
        }
    }
    let candidate = root.join(first.as_os_str());
    // Loose media and sidecars share the selected root; reconcile siblings together.
    if relative.components().count() == 1
        && (candidate.is_file() || candidate.extension().is_some())
    {
        return root.to_owned();
    }
    candidate
}

pub(crate) fn start(state: AppState) {
    tokio::spawn(async move {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<notify::Result<Event>>(1000);
        let overflow = Arc::new(AtomicBool::new(false));
        let mut signature = String::new();
        let mut recovery = RecoveryGate::default();
        let mut roots = Vec::<(String, PathBuf)>::new();
        let mut pending = BTreeMap::<String, Pending>::new();
        let mut native = None;
        let mut poll = None;
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        let mut refreshed = Instant::now() - Duration::from_secs(10);
        loop {
            tokio::select! {
                event=rx.recv()=>{if let Some(event)=event{
                    match event{
                        Ok(event) if !matches!(event.kind,EventKind::Access(_))=>{
                            for (id,root) in &roots {
                                for path in event.paths.iter().filter(|p| relevant(p,root) && external_change(p,&event.kind)) {
                                    recovery.reset();
                                    let job = pending.entry(id.clone()).or_insert_with(Pending::new);
                                    job.last = Instant::now();
                                    if let Some(paths) = &mut job.paths { paths.insert(changed_scope(path,root)); }
                                }
                            }
                        }
                        Err(error) if recovery.request()=>{tracing::warn!(%error,"Native library monitor event failed; requesting one recovery scan");overflow.store(true,Ordering::Relaxed); }
                        _=>{}
                    }
                }else{return;}}
                _=tick.tick()=>{
                    if refreshed.elapsed()>=Duration::from_secs(5){
                        refreshed=Instant::now();
                        let db=ServerStore::new(state.runtime.data_dir());
                        if let Ok(libraries)=db.native_libraries(){
                            let mut next=Vec::new();
                            for library in &libraries{if library.options.real_time_monitor{for path in &library.paths{if let Ok(root)=state.metadata.directory(path,true){next.push((library.id.clone(),root));}}}}
                            let next_signature=format!("{next:?}");
                            if signature!=next_signature{
                                recovery.reset();
                                drop(native.take());drop(poll.take());signature=next_signature;
                                let native_tx=tx.clone();let native_overflow=overflow.clone();
                                native=notify::RecommendedWatcher::new(move|event|{if native_tx.try_send(event).is_err(){native_overflow.store(true,Ordering::Relaxed);}},Config::default().with_follow_symlinks(false)).ok();
                                let poll_tx=tx.clone();let poll_overflow=overflow.clone();
                                poll=PollWatcher::new(move|event|{if poll_tx.try_send(event).is_err(){poll_overflow.store(true,Ordering::Relaxed);}},Config::default().with_follow_symlinks(false).with_poll_interval(Duration::from_secs(15))).ok();
                                for (_,root) in &next{
                                    if let Some(watcher)=native.as_mut(){if let Err(error)=watcher.watch(root,RecursiveMode::Recursive){tracing::warn!(%error,"Native watch unavailable; using polling");}}
                                    if let Some(watcher)=poll.as_mut(){if let Err(error)=watcher.watch(root,RecursiveMode::Recursive){tracing::warn!(%error,"Native polling watch unavailable");}}
                                }
                                pending.retain(|id,_|next.iter().any(|(library,_)|library==id));
                                roots=next;
                            }
                        }
                    }
                    if overflow.swap(false,Ordering::Relaxed){for (id,_) in &roots{pending.entry(id.clone()).or_insert_with(Pending::new).paths=None;}}
                    let ready=pending.iter().filter(|(_,times)|times.last.elapsed()>=Duration::from_secs(5)||times.first.elapsed()>=Duration::from_secs(30)).map(|(id,_)|id.clone()).collect::<Vec<_>>();
                    for id in ready{
                        let db=ServerStore::new(state.runtime.data_dir());
                        let enabled=db.native_libraries().ok().is_some_and(|v|v.iter().any(|l|l.id==id&&l.options.real_time_monitor));
                        if !enabled{pending.remove(&id);continue;}
                        if db.native_scan_status(&id).is_ok_and(|s|s.status=="scanning"){continue;}
                        let job = pending.remove(&id).unwrap();
                        let scopes = if let Some(paths) = job.paths.as_ref() {
                            let media_root = match state.metadata.directory("",true) { Ok(root)=>root, Err(error)=>{tracing::warn!(message=%error.detail,"Automatic scan root unavailable");continue;} };
                            let paths = paths.iter().filter(|p| !paths.iter().any(|parent| parent != *p && p.starts_with(parent))).filter_map(|p|p.strip_prefix(&media_root).ok().map(|v|v.to_string_lossy().replace('\\',"/"))).collect::<Vec<_>>();
                            Some(paths)
                        } else { None };
                        if let Err(error)=super::native::start_scan_scoped(state.clone(),id.clone(),scopes).await{
                            if error.status == axum::http::StatusCode::CONFLICT { pending.insert(id,job); }
                            tracing::warn!(message=%error.detail,"Automatic native library scan could not start");
                        }
                    }
                    // Watchers must remain alive while events are being processed.
                    let _=(&native,&poll);
                }
            }
        }
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repeated_watcher_errors_request_only_one_recovery_until_a_real_change() {
        let mut recovery = RecoveryGate::default();
        assert!(recovery.request());
        for _ in 0..100 {
            assert!(!recovery.request());
        }
        recovery.reset();
        assert!(recovery.request());
    }
    #[test]
    fn delayed_own_write_events_remain_ignored_and_directory_renames_are_external() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("tvshow.nfo");
        own_write(&path, || {
            std::fs::write(&path, b"metadata").map_err(|e| e.to_string())
        })
        .unwrap();
        OWN_WRITES.lock().unwrap().get_mut(&path).unwrap().0 =
            Instant::now() - Duration::from_secs(120);
        assert!(!external_change(
            &path,
            &EventKind::Modify(notify::event::ModifyKind::Any)
        ));
        std::fs::write(&path, b"external change").unwrap();
        assert!(external_change(
            &path,
            &EventKind::Modify(notify::event::ModifyKind::Any)
        ));
        assert!(external_change(
            temp.path(),
            &EventKind::Modify(notify::event::ModifyKind::Name(
                notify::event::RenameMode::To
            ))
        ));
    }

    #[test]
    fn change_scopes_cover_series_movie_and_deleted_folder_without_neighbors() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let series = root.join("Shows/Example");
        std::fs::create_dir_all(series.join("Specials")).unwrap();
        std::fs::write(series.join("tvshow.nfo"), b"<tvshow/>").unwrap();
        std::fs::write(series.join("Specials/tvshow.nfo"), b"<tvshow/>").unwrap();
        assert_eq!(
            changed_scope(&series.join("Specials/S00E01.mkv"), root),
            series
        );
        let movie = root.join("Movie");
        std::fs::create_dir(&movie).unwrap();
        assert_eq!(changed_scope(&movie.join("Movie.mkv"), root), movie);
        assert_eq!(
            changed_scope(&root.join("Deleted/Season 1/S01E01.mkv"), root),
            root.join("Deleted")
        );
        assert_eq!(changed_scope(&root.join("loose-movie.nfo"), root), root);
    }

    #[test]
    fn own_writes_ignore_delayed_events_but_external_edits_and_removals_remain_visible() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("tvshow.nfo");
        let kind = EventKind::Modify(notify::event::ModifyKind::Any);
        own_write(&path, || {
            std::fs::write(&path, b"local metadata").map_err(|e| e.to_string())
        })
        .unwrap();
        assert!(!external_change(&path, &kind));
        assert!(!external_change(&path, &kind)); // Both native and polling notifications.
        std::fs::write(&path, b"external metadata edit").unwrap();
        assert!(external_change(&path, &kind));
        std::fs::remove_file(&path).unwrap();
        assert!(external_change(
            &path,
            &EventKind::Remove(notify::event::RemoveKind::File)
        ));
        let new_file = directory.path().join("episode.mkv");
        std::fs::write(&new_file, b"video").unwrap();
        assert!(external_change(
            &new_file,
            &EventKind::Create(notify::event::CreateKind::File)
        ));
        assert!(!external_change(directory.path(), &kind));
        assert!(external_change(
            directory.path(),
            &EventKind::Create(notify::event::CreateKind::Folder)
        ));
    }

    #[test]
    fn credit_video_names_are_bounded_tokens() {
        for name in [
            "NCOP.mkv",
            "NCED01.mp4",
            "Show - NCOP2v2 [1080p].mkv",
            "NCOPs.mp4",
        ] {
            assert!(crate::native_scan::credit_video(Path::new(name)), "{name}");
        }
        for name in ["Once Upon a Time.mkv", "Show S01E01.mkv", "Advanced.mkv"] {
            assert!(!crate::native_scan::credit_video(Path::new(name)), "{name}");
        }
    }

    #[test]
    fn ignores_backdrop_and_temporary_events() {
        let root = Path::new("media");
        assert!(relevant(Path::new("media/Anime/episode.mkv"), root));
        assert!(!relevant(Path::new("media/Anime/Backdrops/NCOP.mp4"), root));
        assert!(!relevant(Path::new("media/Anime/.temp"), root));
        assert!(!relevant(Path::new("media/Anime/Extras/clip.mkv"), root));
        assert!(relevant(
            Path::new("media/Anime/Specials/episode.mkv"),
            root
        ));
        assert!(!relevant(Path::new("outside/file.mkv"), root));
    }
}
