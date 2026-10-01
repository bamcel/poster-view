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

fn relevant(path: &Path, root: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    !relative.components().any(|part| {
        let v = part.as_os_str().to_string_lossy().to_ascii_lowercase();
        v.starts_with('.') || v == "backdrop" || v == "backdrops"
    })
}
pub(crate) fn start(state: AppState) {
    tokio::spawn(async move {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<notify::Result<Event>>(1000);
        let overflow = Arc::new(AtomicBool::new(false));
        let mut signature = String::new();
        let mut roots = Vec::<(String, PathBuf)>::new();
        let mut pending = BTreeMap::<String, (Instant, Instant)>::new();
        let mut native = None;
        let mut poll = None;
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        let mut refreshed = Instant::now() - Duration::from_secs(10);
        loop {
            tokio::select! {
                event=rx.recv()=>{if let Some(event)=event{
                    match event{
                        Ok(event) if !matches!(event.kind,EventKind::Access(_))=>{
                            for (id,root) in &roots{if event.paths.iter().any(|p|relevant(p,root)){let now=Instant::now();pending.entry(id.clone()).and_modify(|v|v.1=now).or_insert((now,now));}}
                        }
                        Err(error)=>{tracing::warn!(%error,"Native library monitor event failed; polling remains enabled");overflow.store(true,Ordering::Relaxed);}
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
                    if overflow.swap(false,Ordering::Relaxed){for (id,_) in &roots{let now=Instant::now();pending.entry(id.clone()).or_insert((now,now));}}
                    let ready=pending.iter().filter(|(_,times)|times.1.elapsed()>=Duration::from_secs(5)||times.0.elapsed()>=Duration::from_secs(30)).map(|(id,_)|id.clone()).collect::<Vec<_>>();
                    for id in ready{
                        let db=ServerStore::new(state.runtime.data_dir());
                        let enabled=db.native_libraries().ok().is_some_and(|v|v.iter().any(|l|l.id==id&&l.options.real_time_monitor));
                        if !enabled{pending.remove(&id);continue;}
                        if db.native_scan_status(&id).is_ok_and(|s|s.status=="scanning"){continue;}
                        pending.remove(&id);
                        if let Err(error)=super::native::start_scan(state.clone(),id).await{tracing::warn!(message=%error.detail,"Automatic native library scan could not start");}
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
    fn ignores_backdrop_and_temporary_events() {
        let root = Path::new("media");
        assert!(relevant(Path::new("media/Anime/episode.mkv"), root));
        assert!(!relevant(Path::new("media/Anime/Backdrops/NCOP.mp4"), root));
        assert!(!relevant(Path::new("media/Anime/.temp"), root));
        assert!(!relevant(Path::new("outside/file.mkv"), root));
    }
}
