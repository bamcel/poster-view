use crate::{AppState, HttpError};
use axum::{
    Json,
    extract::{Path, State},
};
use posterview_infra_sqlite::ServerStore;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    path::{Path as FsPath, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
static RUN_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static RUNNING_TASK: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
struct RunningTask;
impl Drop for RunningTask {
    fn drop(&mut self) { *RUNNING_TASK.lock().unwrap() = None; }
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn bad(e: impl std::fmt::Display) -> HttpError {
    HttpError::bad_request(e.to_string())
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub(crate) struct Task {
    id: String,
    pub title: String,
    pub description: String,
    enabled: bool,
    interval_days: u64,
    retention_days: u64,
    cleanup_artwork: bool,
    cleanup_placeholders: bool,
    cleanup_cache: bool,
    cleanup_temporary: bool,
    last_run: u64,
    last_result: String,
    running: bool,
}
impl Default for Task {
    fn default() -> Self {
        Self {
            id: String::new(),
            title: String::new(),
            description: String::new(),
            enabled: false,
            interval_days: 7,
            retention_days: 30,
            cleanup_artwork: true,
            cleanup_placeholders: true,
            cleanup_cache: true,
            cleanup_temporary: true,
            last_run: 0,
            last_result: String::new(),
            running: false,
        }
    }
}
fn defaults() -> Vec<Task> {
    [
    ("cleanup","Data Cleanup","Remove hidden missing-file placeholders after retention, unused managed artwork, old local artwork mirrors, and abandoned temporary files. Shared artwork and media folders are preserved."),
    ("history","Trim History","Remove application history older than the retention period, including its saved history backups."),
    ("database","Optimize Database","Check database health, optimize query statistics, and checkpoint available WAL pages without an exclusive database rebuild."),
].into_iter().map(|(id,title,description)|Task{id:id.into(),title:title.into(),description:description.into(),..Default::default()}).collect()
}
fn load(state: &AppState) -> Result<Vec<Task>, HttpError> {
    let db = ServerStore::new(state.runtime.data_dir());
    let saved = db.get_setting("scheduled-tasks").map_err(bad)?;
    let saved: Vec<Task> = serde_json::from_str(&saved).unwrap_or_default();
    Ok(defaults()
        .into_iter()
        .map(|mut task| {
            if let Some(s) = saved.iter().find(|s| s.id == task.id) {
                task.enabled = s.enabled;
                task.interval_days = s.interval_days;
                task.retention_days = s.retention_days;
                task.cleanup_artwork = s.cleanup_artwork;
                task.cleanup_placeholders=s.cleanup_placeholders;
                task.cleanup_cache = s.cleanup_cache;
                task.cleanup_temporary = s.cleanup_temporary;
                task.last_run = s.last_run;
                task.last_result = s.last_result.clone();
            }
            task
        })
        .collect())
}
fn save(state: &AppState, tasks: &[Task]) -> Result<(), HttpError> {
    ServerStore::new(state.runtime.data_dir())
        .set_setting(
            "scheduled-tasks",
            &serde_json::to_string(tasks).map_err(bad)?,
        )
        .map_err(bad)
}
pub(crate) async fn list(State(state): State<AppState>) -> Result<Json<Vec<Task>>, HttpError> {
    tokio::task::spawn_blocking(move || {
        let mut tasks = load(&state)?;
        let running = RUNNING_TASK.lock().unwrap();
        for task in &mut tasks { task.running = running.as_deref() == Some(task.id.as_str()); }
        Ok(Json(tasks))
    })
        .await
        .map_err(bad)?
}
pub(crate) async fn configure(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<Task>,
) -> Result<Json<Vec<Task>>, HttpError> {
    let _guard = RUN_LOCK.lock().await;
    tokio::task::spawn_blocking(move || {
        if !(1..=365).contains(&input.interval_days) || !(1..=3650).contains(&input.retention_days)
        {
            return Err(bad(
                "Choose an interval of 1–365 days and retention of 1–3650 days.",
            ));
        }
        let mut tasks = load(&state)?;
        let task = tasks
            .iter_mut()
            .find(|t| t.id == id)
            .ok_or_else(HttpError::not_found)?;
        task.enabled = input.enabled;
        task.interval_days = input.interval_days;
        task.retention_days = input.retention_days;
        task.cleanup_artwork = input.cleanup_artwork;
        task.cleanup_placeholders=input.cleanup_placeholders;
        task.cleanup_cache = input.cleanup_cache;
        task.cleanup_temporary = input.cleanup_temporary;
        save(&state, &tasks)?;
        Ok(Json(tasks))
    })
    .await
    .map_err(bad)?
}
#[derive(Serialize, Default)]
pub(crate) struct Report {
    files: usize,
    placeholders: usize,
    bytes: u64,
    result: String,
}
struct Candidate {
    path: PathBuf,
    bytes: u64,
}
fn references(directory: &FsPath) -> Result<HashSet<String>, HttpError> {
    let db = rusqlite::Connection::open(directory.join("posterview.db")).map_err(bad)?;
    db.busy_timeout(Duration::from_secs(5)).map_err(bad)?;
    let names = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .map_err(bad)?
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(bad)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(bad)?;
    let mut refs = HashSet::new();
    for name in names {
        let name = name.replace('"', "\"\"");
        let mut statement = db
            .prepare(&format!("SELECT * FROM \"{name}\""))
            .map_err(bad)?;
        let columns = statement.column_count();
        let mut rows = statement.query([]).map_err(bad)?;
        while let Some(row) = rows.next().map_err(bad)? {
            for column in 0..columns {
                if let Ok(rusqlite::types::ValueRef::Text(text)) = row.get_ref(column) {
                    for token in String::from_utf8_lossy(text)
                        .split(|c: char| !c.is_ascii_alphanumeric() && !"._-".contains(c))
                    {
                        if !token.is_empty() {
                            refs.insert(token.to_owned());
                        }
                    }
                }
            }
        }
    }
    Ok(refs)
}
fn old(meta: &std::fs::Metadata, days: u64) -> bool {
    meta.modified()
        .ok()
        .and_then(|m| SystemTime::now().duration_since(m).ok())
        .is_some_and(|age| age.as_secs() >= days * 86400)
}
fn hidden_libraries(state:&AppState,task:&Task)->Result<Vec<(String,u64,usize)>,HttpError> {
    if !task.cleanup_placeholders{return Ok(Vec::new());}
    if !state.active_native_scans.lock().unwrap().is_empty(){return Err(bad("Wait for library scans to finish before cleaning data."));}
    let db=ServerStore::new(state.runtime.data_dir());let mut result=Vec::new();
    for library in db.native_libraries().map_err(bad)?.into_iter().filter(|l|!l.options.show_missing_files) {
        let key=format!("missing-hidden-since:{}",library.id);
        let since=db.get_setting(&key).map_err(bad)?.parse::<u64>().ok().unwrap_or_else(now);
        if db.get_setting(&key).map_err(bad)?.is_empty(){db.set_setting(&key,&since.to_string()).map_err(bad)?;}
        if now().saturating_sub(since)>=task.retention_days*86400 {let count=db.native_catalog(&library.id).map_err(bad)?.iter().filter(|e|e.metadata["missing"]==true && e.path.contains("/@missing-") && e.files.is_empty()).count();if count>0{result.push((library.id,since,count));}}
    }Ok(result)
}
fn candidates(state: &AppState, task: &Task) -> Result<Vec<Candidate>, HttpError> {
    let db = ServerStore::new(state.runtime.data_dir());
    if !state.active_native_scans.lock().unwrap().is_empty() {
        return Err(bad("Wait for library scans to finish before cleaning data."));
    }
    let refs = references(state.runtime.data_dir())?;
    let saved: BTreeMap<String, u64> =
        serde_json::from_str(&db.get_setting("cleanup-unreferenced").map_err(bad)?)
            .unwrap_or_default();
    let mut unreferenced = BTreeMap::new();
    let mut result = Vec::new();
    for (folder, enabled, referenced) in [
        ("native-artwork", task.cleanup_artwork, true),
        ("local-artwork-cache", task.cleanup_cache, false),
    ] {
        if !enabled && !task.cleanup_temporary {
            continue;
        }
        let directory = state.runtime.data_dir().join(folder);
        if directory.is_symlink() {
            continue;
        }
        let files = match std::fs::read_dir(&directory) {
            Ok(files) => files,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(bad(e)),
        };
        for file in files {
            let file = file.map_err(bad)?;
            let meta = file.file_type().map_err(bad)?;
            if !meta.is_file() || meta.is_symlink() {
                continue;
            }
            let name = file.file_name().to_string_lossy().into_owned();
            let temp = name.ends_with(".tmp");
            if (!enabled && !temp) || (temp && !task.cleanup_temporary) {
                continue;
            }
            if referenced
                && (refs.contains(&name)
                    || name.strip_suffix(".still.png").is_some_and(|id| {
                        refs.contains(&format!("{id}.gif")) || refs.contains(&format!("{id}.webm"))
                    }))
            {
                continue;
            }
            let meta = file.metadata().map_err(bad)?;
            let past_grace = if referenced && !temp {
                use std::hash::{Hash, Hasher};
                let mut hash = std::collections::hash_map::DefaultHasher::new();
                name.hash(&mut hash);
                let key = format!("{:016x}", hash.finish());
                let since = *saved.get(&key).unwrap_or(&now());
                unreferenced.insert(key, since);
                now().saturating_sub(since) >= task.retention_days * 86400
            } else {
                true
            };
            if past_grace && old(&meta, task.retention_days) {
                result.push(Candidate {
                    path: file.path(),
                    bytes: meta.len(),
                });
            }
        }
    }
    if task.cleanup_artwork {
        db.set_setting(
            "cleanup-unreferenced",
            &serde_json::to_string(&unreferenced).map_err(bad)?,
        )
        .map_err(bad)?;
    }
    Ok(result)
}
pub(crate) async fn preview(State(state): State<AppState>) -> Result<Json<Report>, HttpError> {
    tokio::task::spawn_blocking(move || {
        let task = load(&state)?
            .into_iter()
            .find(|t| t.id == "cleanup")
            .unwrap();
        let files = candidates(&state, &task)?;
        Ok(Json(Report {
            files: files.len(),
            placeholders:hidden_libraries(&state,&task)?.iter().map(|(_,_,count)|count).sum(),
            bytes: files.iter().map(|f| f.bytes).sum(),
            result: "Eligible files after retention and reference checks.".into(),
        }))
    })
    .await
    .map_err(bad)?
}
async fn execute(state: AppState, id: String) -> Result<Report, HttpError> {
    let _guard = RUN_LOCK
        .try_lock()
        .map_err(|_| bad("A scheduled task is already running. Try again shortly."))?;
    tokio::task::spawn_blocking(move||{
        *RUNNING_TASK.lock().unwrap() = Some(id.clone());
        let _running = RunningTask;
        let mut tasks=load(&state)?;let task=tasks.iter_mut().find(|t|t.id==id).ok_or_else(HttpError::not_found)?;
        let result=(||->Result<Report,HttpError>{match id.as_str() {
            "cleanup"=>{let db=ServerStore::new(state.runtime.data_dir());let mut report=Report::default();
                for (library,since,count) in hidden_libraries(&state,task)? {
                    let removed=db.cleanup_hidden_placeholders(&library).map_err(bad)?;report.placeholders+=count;
                    let mut grace:BTreeMap<String,u64>=serde_json::from_str(&db.get_setting("cleanup-unreferenced").map_err(bad)?).unwrap_or_default();
                    for reference in removed {for name in reference.split(|c:char|!c.is_ascii_alphanumeric()&&!"._-".contains(c)) {if !name.contains('.') {continue;}use std::hash::{Hash,Hasher};let mut hash=std::collections::hash_map::DefaultHasher::new();name.hash(&mut hash);grace.insert(format!("{:016x}",hash.finish()),since);
                        if name.ends_with(".gif")||name.ends_with(".webm") {let still=format!("{}.still.png",name.rsplit_once('.').unwrap().0);let mut hash=std::collections::hash_map::DefaultHasher::new();still.hash(&mut hash);grace.insert(format!("{:016x}",hash.finish()),since);}
                    }}db.set_setting("cleanup-unreferenced",&serde_json::to_string(&grace).map_err(bad)?).map_err(bad)?;
                }
                let candidates=candidates(&state,task)?;for file in candidates {let meta=std::fs::symlink_metadata(&file.path).map_err(bad)?;if meta.file_type().is_symlink()||!meta.is_file()||!old(&meta,task.retention_days){continue;}std::fs::remove_file(&file.path).map_err(bad)?;report.files+=1;report.bytes+=file.bytes;}report.result=format!("Removed {} hidden placeholders and {} unused files ({} bytes).",report.placeholders,report.files,report.bytes);Ok(report)},
            "history"=>{let count=state.runtime.purge_history(Some(task.retention_days as i64)).map_err(bad)?;Ok(Report{result:format!("Removed {count} old history records."),..Default::default()})},
            "database"=>{let db=rusqlite::Connection::open(state.runtime.data_dir().join("posterview.db")).map_err(bad)?;db.busy_timeout(Duration::from_secs(5)).map_err(bad)?;let health:String=db.query_row("PRAGMA quick_check",[],|r|r.get(0)).map_err(bad)?;if health!="ok"{return Err(bad(format!("Database check: {health}")));}db.execute_batch("PRAGMA optimize; PRAGMA wal_checkpoint(PASSIVE);").map_err(bad)?;Ok(Report{result:"Database health check passed; optimization and passive checkpoint completed.".into(),..Default::default()})},
            _=>Err(HttpError::not_found()),
        }})();
        task.last_run=now();task.last_result=match &result {Ok(r)=>r.result.clone(),Err(e)=>format!("Failed: {}",e.detail)};save(&state,&tasks)?;result
    }).await.map_err(bad)?
}
pub(crate) async fn run(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Report>, HttpError> {
    execute(state, id).await.map(Json)
}
pub(crate) fn start(state: AppState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        loop {
            interval.tick().await;
            let copy = state.clone();
            let tasks = tokio::task::spawn_blocking(move || load(&copy)).await;
            if let Ok(Ok(tasks)) = tasks {
                for task in tasks {
                    if task.enabled
                        && now().saturating_sub(task.last_run) >= task.interval_days * 86400
                    {
                        if let Err(e) = execute(state.clone(), task.id).await {
                            tracing::warn!(detail=%e.detail,"Scheduled task failed");
                        }
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use posterview_contracts::native::*;
    static TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    fn aged(path: &FsPath) {
        let file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        file.set_times(
            std::fs::FileTimes::new()
                .set_modified(SystemTime::now() - Duration::from_secs(31 * 86400)),
        )
        .unwrap();
    }
    #[tokio::test]
    async fn cleanup_keeps_hidden_missing_artwork_edits_and_animation_stills() {
        let _guard = TEST_LOCK.lock().await;
        let temp = tempfile::tempdir().unwrap();
        let state = crate::native::scan_tests::state(temp.path());
        let dir = state.runtime.data_dir().join("native-artwork");
        std::fs::create_dir_all(&dir).unwrap();
        for name in [
            "missing.jpg",
            "unused.jpg",
            "animation.gif",
            "animation.still.png",
            "edit-original.jpg",
            "recent.jpg",
        ] {
            std::fs::write(dir.join(name), b"image").unwrap();
            if name != "recent.jpg" {
                aged(&dir.join(name));
            }
        }
        let cache = state.runtime.data_dir().join("local-artwork-cache");
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::write(cache.join("old.art"), b"cache").unwrap();
        aged(&cache.join("old.art"));
        let db = ServerStore::new(state.runtime.data_dir());
        let library = db
            .save_native_library(
                None,
                &NativeLibraryInput {
                    name: "Books".into(),
                    library_type: NativeLibraryType::Books,
                    anime_content: AnimeContent::Both,
                    paths: vec!["Books".into()],
                    revision: None,
                    options: NativeLibraryOptions {
                        show_missing_files: false,
                        ..Default::default()
                    },
                },
            )
            .unwrap();
        let entry = NativeCatalogEntry {
            id: String::new(),
            path: "Books/Series/@missing-volume-1".into(),
            kind: "book".into(),
            parent_path: Some("Books/Series".into()),
            title: "Missing".into(),
            metadata: serde_json::json!({"missing":true,"posteredit":{"original":"@managed/edit-original.jpg"}}),
            artwork: vec![
                NativeArtwork {
                    kind: "poster".into(),
                    path: "@managed/missing.jpg".into(),
                    source: "manual".into(),
                },
                NativeArtwork {
                    kind: "poster-animated".into(),
                    path: "@managed/animation.gif".into(),
                    source: "manual".into(),
                },
            ],
            files: vec![],
            nfo_path: None,
            nfo_xml: None,
            available: true,
            revision: 1,
        };
        db.ingest_native_catalog(&library.id, library.revision, &[entry])
            .unwrap();
        let task = defaults().remove(0);
        let eligible = candidates(&state, &task).unwrap();
        assert_eq!(eligible.len(), 1); // Newly discovered unused artwork starts its grace period.
        let mut pending: BTreeMap<String, u64> =
            serde_json::from_str(&db.get_setting("cleanup-unreferenced").unwrap()).unwrap();
        for since in pending.values_mut() {
            *since = now() - 31 * 86400;
        }
        db.set_setting(
            "cleanup-unreferenced",
            &serde_json::to_string(&pending).unwrap(),
        )
        .unwrap();
        assert_eq!(candidates(&state, &task).unwrap().len(), 2);
        let report = execute(state.clone(), "cleanup".into()).await.unwrap();
        assert_eq!(report.files, 2);
        for name in [
            "missing.jpg",
            "animation.gif",
            "animation.still.png",
            "edit-original.jpg",
            "recent.jpg",
        ] {
            assert!(dir.join(name).exists());
        }
        assert!(!dir.join("unused.jpg").exists());
        assert!(!cache.join("old.art").exists());
        assert!(load(&state).unwrap()[0].last_run > 0);
        db.begin_native_scan(&library.id).unwrap();
        // Persisted status without a worker must not prevent cleanup.
        assert!(candidates(&state, &task).is_ok());
        let status = crate::native::status(State(state.clone()), Path(library.id.clone())).await.unwrap().0;
        assert_eq!(status["status"], "interrupted");
        let scan = crate::native::ActiveNativeScan::new(state.active_native_scans.clone(), library.id.clone());
        let status = crate::native::status(State(state.clone()), Path(library.id.clone())).await.unwrap().0;
        assert_eq!(status["status"], "scanning");
        let second_scan = crate::native::ActiveNativeScan::new(state.active_native_scans.clone(), "second".into());
        assert!(candidates(&state, &task).is_err());
        drop(scan);
        assert!(candidates(&state, &task).is_err());
        drop(second_scan);
        assert!(candidates(&state, &task).is_ok());
    }
    #[tokio::test]
    async fn schedules_are_disabled_by_default_validated_and_persisted() {
        let _guard = TEST_LOCK.lock().await;
        let temp = tempfile::tempdir().unwrap();
        let state = crate::native::scan_tests::state(temp.path());
        assert!(load(&state).unwrap().iter().all(|t| !t.enabled));
        *RUNNING_TASK.lock().unwrap() = Some("cleanup".into());
        let running = RunningTask;
        let tasks = list(State(state.clone())).await.unwrap().0;
        assert!(tasks.iter().find(|t| t.id == "cleanup").unwrap().running);
        assert!(!tasks.iter().find(|t| t.id == "database").unwrap().running);
        drop(running);
        assert!(list(State(state.clone())).await.unwrap().0.iter().all(|t| !t.running));
        let mut task = defaults().remove(0);
        task.enabled = true;
        task.interval_days = 0;
        assert!(
            configure(
                State(state.clone()),
                Path("cleanup".into()),
                Json(task.clone())
            )
            .await
            .is_err()
        );
        task.interval_days = 2;
        let _ = configure(State(state.clone()), Path("cleanup".into()), Json(task))
            .await
            .unwrap();
        assert_eq!(load(&state).unwrap()[0].interval_days, 2);
        assert!(load(&state).unwrap()[0].enabled);
        let report = execute(state.clone(), "database".into()).await.unwrap();
        assert!(report.result.contains("passed"));
        assert!(load(&state).unwrap()[2].last_run > 0);
    }
    #[tokio::test]
    async fn hidden_placeholders_and_unused_covers_are_cleaned_after_retention() {
        let _guard=TEST_LOCK.lock().await;let temp=tempfile::tempdir().unwrap();let state=crate::native::scan_tests::state(temp.path());let db=ServerStore::new(state.runtime.data_dir());
        let library=db.save_native_library(None,&NativeLibraryInput{name:"Books".into(),library_type:NativeLibraryType::Books,anime_content:AnimeContent::Both,paths:vec!["Books".into()],revision:None,options:NativeLibraryOptions{show_missing_files:false,..Default::default()}}).unwrap();
        let entry=NativeCatalogEntry{id:String::new(),path:"Books/Test/@missing-volume-1".into(),kind:"book".into(),parent_path:Some("Books/Test".into()),title:"Missing".into(),metadata:serde_json::json!({"missing":true,"volume":1}),artwork:vec![NativeArtwork{kind:"poster".into(),path:"@managed/hidden.jpg".into(),source:"manual".into()}],files:vec![],nfo_path:None,nfo_xml:None,available:true,revision:1};
        db.ingest_native_catalog(&library.id,library.revision,std::slice::from_ref(&entry)).unwrap();let dir=state.runtime.data_dir().join("native-artwork");std::fs::create_dir_all(&dir).unwrap();let cover=dir.join("hidden.jpg");std::fs::write(&cover,b"cover").unwrap();aged(&cover);
        assert!(hidden_libraries(&state,&defaults().remove(0)).unwrap().is_empty());assert!(cover.exists());
        db.set_setting(&format!("missing-hidden-since:{}",library.id),&(now()-31*86400).to_string()).unwrap();
        let report=execute(state.clone(),"cleanup".into()).await.unwrap();assert_eq!(report.placeholders,1);assert_eq!(report.files,1);assert!(!cover.exists());assert!(db.native_catalog(&library.id).unwrap().is_empty());
        db.ingest_native_catalog(&library.id,library.revision,&[entry]).unwrap();assert!(db.native_catalog(&library.id).unwrap().is_empty());
    }

}
