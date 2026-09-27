use crate::{Runtime, RuntimeError};
use chrono::Utc;
use posterview_contracts::ItemType;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

const KEY: &str = "scheduled_tasks_v2";

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn builtins_are_fixed_persist_and_cancel_after_restart() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = Runtime::new(dir.path());
        runtime.initialize().unwrap();
        let tasks = runtime.scheduled_tasks().unwrap();
        assert_eq!(tasks.len(), 4);
        let mut config = tasks[0].config.clone();
        assert!(runtime.save_scheduled_task(None, config.clone()).is_err());
        assert!(runtime.task_action(&tasks[0].id, "delete").is_err());
        config.name = "Custom".into();
        config.providers.clear();
        config.enabled = true;
        let saved = runtime
            .save_scheduled_task(Some(&tasks[0].id), config)
            .unwrap();
        assert_eq!(saved.config.name, tasks[0].config.name);
        assert_eq!(saved.config.providers.len(), 4);
        runtime.task_action(&saved.id, "run").unwrap();
        assert!(runtime.task_action(&saved.id, "run").is_err());
        drop(runtime);
        let runtime = Runtime::new(dir.path());
        runtime.initialize().unwrap();
        assert_eq!(runtime.scheduled_tasks().unwrap()[0].status, "queued");
        runtime.task_action(&saved.id, "cancel").unwrap();
        runtime.scheduled_task_tick().await.unwrap();
        let task = &runtime.scheduled_tasks().unwrap()[0];
        assert_eq!(task.status, "cancelled");
        assert_eq!(task.history.len(), 1);
        assert!(task.next_run.unwrap() > now());
    }
    #[tokio::test]
    async fn builtin_running_checkpoint_resumes() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = Runtime::new(dir.path());
        runtime.initialize().unwrap();
        runtime
            .update_task("missing_credits", |t| {
                t.status = "running".into();
                t.processed = 2;
                t.total = 2;
            })
            .unwrap();
        runtime
            .server_store()
            .unwrap()
            .set_setting("task_inventory:missing_credits", "[]")
            .unwrap();
        drop(runtime);
        let runtime = Runtime::new(dir.path());
        runtime.initialize().unwrap();
        runtime.scheduled_task_tick().await.unwrap();
        assert_eq!(runtime.scheduled_tasks().unwrap()[0].status, "completed");
    }
    #[test]
    fn legacy_schedules_are_retained_but_do_not_execute() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = Runtime::new(dir.path());
        runtime.initialize().unwrap();
        runtime
            .server_store()
            .unwrap()
            .set_setting("scheduled_tasks_v1", "legacy-data")
            .unwrap();
        assert!(
            runtime
                .scheduled_tasks()
                .unwrap()
                .iter()
                .all(|t| !t.config.enabled && t.status == "idle")
        );
        assert_eq!(
            runtime
                .server_store()
                .unwrap()
                .get_setting("scheduled_tasks_v1")
                .unwrap(),
            "legacy-data"
        );
    }
    #[test]
    fn new_builtin_is_added_to_existing_task_settings_without_resetting_schedules() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = Runtime::new(dir.path());
        runtime.initialize().unwrap();
        let mut saved = builtin_tasks();
        saved.retain(|t| t.id != "imdb_refresh");
        saved[0].config.enabled = true;
        runtime
            .server_store()
            .unwrap()
            .set_setting(KEY, &serde_json::to_string(&saved).unwrap())
            .unwrap();
        let loaded = runtime.scheduled_tasks().unwrap();
        assert_eq!(loaded.len(), 4);
        assert!(loaded[0].config.enabled);
        assert_eq!(loaded.last().unwrap().id, "imdb_refresh");
    }
}

fn invalid(message: impl Into<String>) -> RuntimeError {
    RuntimeError::Watchdog(message.into())
}
fn now() -> i64 {
    Utc::now().timestamp()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TaskConfig {
    pub name: String,
    pub kind: String,
    pub providers: Vec<String>,
    pub enabled: bool,
    pub interval_hours: i64,
    pub stale_days: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TaskIssue {
    pub server_id: i64,
    pub item_id: String,
    pub title: String,
    pub message: String,
    pub needs_matching: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScheduledTask {
    pub id: String,
    pub config: TaskConfig,
    pub status: String,
    pub next_run: Option<i64>,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub processed: usize,
    pub total: usize,
    pub updated: usize,
    pub skipped: usize,
    pub failed: usize,
    pub needs_matching: usize,
    pub current_title: Option<String>,
    pub message: String,
    pub issues: Vec<TaskIssue>,
    pub history: Vec<TaskHistory>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TaskHistory {
    pub finished_at: i64,
    pub status: String,
    pub processed: usize,
    pub updated: usize,
    pub failed: usize,
    pub needs_matching: usize,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct WorkItem {
    server_id: i64,
    id: String,
    title: String,
}
fn active(task: &ScheduledTask) -> bool {
    ["queued", "running", "stopping"].contains(&task.status.as_str())
}
fn queue(task: &mut ScheduledTask) {
    task.status = "queued".into();
    task.started_at = Some(now());
    task.finished_at = None;
    task.processed = 0;
    task.total = 0;
    task.updated = 0;
    task.skipped = 0;
    task.failed = 0;
    task.needs_matching = 0;
    task.issues.clear();
    task.current_title = None;
    task.message = "Waiting for the task worker".into();
}
fn finish(task: &mut ScheduledTask, status: &str, message: &str) {
    let time = now();
    task.status = status.into();
    task.finished_at = Some(time);
    task.current_title = None;
    task.message = message.into();
    task.next_run = task
        .config
        .enabled
        .then_some(time + task.config.interval_hours * 3600);
    task.history.insert(
        0,
        TaskHistory {
            finished_at: time,
            status: status.into(),
            processed: task.processed,
            updated: task.updated,
            failed: task.failed,
            needs_matching: task.needs_matching,
        },
    );
    task.history.truncate(5);
}

fn builtin_tasks() -> Vec<ScheduledTask> {
    [
        ("missing_credits", "Fetch Missing Cast & Crew", 24),
        ("refresh_credits", "Refresh Outdated Cast & Crew", 168),
        ("imdb_refresh", "Refresh IMDb Data", 168),
        ("missing_metadata", "Find Missing Metadata", 24),
    ]
    .into_iter()
    .map(|(kind, name, interval_hours)| ScheduledTask {
        id: kind.into(),
        config: TaskConfig {
            name: name.into(),
            kind: kind.into(),
            providers: vec!["anilist".into(), "mal".into(), "tvdb".into(), "tmdb".into()],
            enabled: false,
            interval_hours,
            stale_days: 30,
        },
        status: "idle".into(),
        next_run: None,
        started_at: None,
        finished_at: None,
        processed: 0,
        total: 0,
        updated: 0,
        skipped: 0,
        failed: 0,
        needs_matching: 0,
        current_title: None,
        message: "Ready to run".into(),
        issues: vec![],
        history: vec![],
    })
    .collect()
}

impl Runtime {
    pub fn scheduled_tasks(&self) -> Result<Vec<ScheduledTask>, RuntimeError> {
        let raw = self.server_store()?.get_setting(KEY)?;
        if raw.is_empty() {
            return Ok(builtin_tasks());
        }
        let mut saved: Vec<ScheduledTask> = serde_json::from_str(&raw)
            .map_err(|e| invalid(format!("Could not read scheduled tasks: {e}")))?;
        for task in builtin_tasks() {
            if !saved.iter().any(|t| t.id == task.id) {
                saved.push(task);
            }
        }
        Ok(saved)
    }
    fn change_tasks<T>(
        &self,
        change: impl FnOnce(&mut Vec<ScheduledTask>) -> Result<T, RuntimeError>,
    ) -> Result<T, RuntimeError> {
        let _lock = self
            .task_settings_lock
            .lock()
            .map_err(|_| invalid("Task settings are busy"))?;
        let mut tasks = self.scheduled_tasks()?;
        let before = serde_json::to_string(&tasks).map_err(|e| invalid(e.to_string()))?;
        let result = change(&mut tasks)?;
        let after = serde_json::to_string(&tasks).map_err(|e| invalid(e.to_string()))?;
        if before != after {
            self.server_store()?.set_setting(KEY, &after)?;
        }
        Ok(result)
    }
    pub fn save_scheduled_task(
        &self,
        id: Option<&str>,
        config: TaskConfig,
    ) -> Result<ScheduledTask, RuntimeError> {
        let id =
            id.ok_or_else(|| invalid("Tasks are built in; custom tasks cannot be created."))?;
        if id == "imdb_refresh" && config.enabled && !self.imdb_status()?.enabled {
            return Err(invalid("Enable IMDb in Settings → Database first."));
        }
        if !(1..=8760).contains(&config.interval_hours) || !(1..=3650).contains(&config.stale_days)
        {
            return Err(invalid(
                "Choose an interval of 1–8760 hours and a refresh age of 1–3650 days.",
            ));
        }
        self.change_tasks(|tasks| {
            let task = tasks
                .iter_mut()
                .find(|t| t.id == id)
                .ok_or_else(|| invalid("Task not found"))?;
            if active(task) {
                return Err(invalid(
                    "Cancel the current run before editing its schedule.",
                ));
            }
            task.config.enabled = config.enabled;
            task.config.interval_hours = config.interval_hours;
            task.config.stale_days = config.stale_days;
            task.next_run = config
                .enabled
                .then_some(now() + config.interval_hours * 3600);
            Ok(task.clone())
        })
    }
    pub fn task_action(&self, id: &str, action: &str) -> Result<(), RuntimeError> {
        if id == "imdb_refresh" && action == "run" && !self.imdb_status()?.enabled {
            return Err(invalid("Enable IMDb in Settings → Database first."));
        }
        self.change_tasks(|tasks| {
            let task = tasks
                .iter_mut()
                .find(|t| t.id == id)
                .ok_or_else(|| invalid("Task not found"))?;
            match action {
                "run" if !active(task) => {
                    if id == "imdb_refresh" {
                        self.imdb_cancel
                            .store(false, std::sync::atomic::Ordering::Relaxed);
                    }
                    queue(task);
                }
                "cancel" if active(task) => {
                    if id == "imdb_refresh" {
                        self.imdb_cancel
                            .store(true, std::sync::atomic::Ordering::Relaxed);
                    }
                    task.status = "stopping".into();
                    task.message = "Cancellation requested".into();
                }
                _ => {
                    return Err(invalid(
                        "Action is unavailable while the task is in this state.",
                    ));
                }
            }
            Ok(())
        })
    }
    pub(crate) fn update_task(
        &self,
        id: &str,
        change: impl FnOnce(&mut ScheduledTask),
    ) -> Result<(), RuntimeError> {
        self.change_tasks(|tasks| {
            if let Some(task) = tasks.iter_mut().find(|t| t.id == id) {
                change(task);
            }
            Ok(())
        })
    }
    pub(crate) fn cancelled(&self, id: &str) -> Result<bool, RuntimeError> {
        Ok(self
            .scheduled_tasks()?
            .iter()
            .find(|t| t.id == id)
            .is_none_or(|t| t.status == "stopping"))
    }
    /// Executes one checkpoint at a time. Persisted running tasks resume after restart.
    pub async fn scheduled_task_tick(&self) -> Result<(), RuntimeError> {
        let Ok(_worker) = self.task_worker.try_lock() else {
            return Ok(());
        };
        let task = self.change_tasks(|tasks| {
            for t in tasks.iter_mut() {
                if !active(t) && t.config.enabled && t.next_run.is_some_and(|at| at <= now()) {
                    if t.id == "imdb_refresh" {
                        self.imdb_cancel
                            .store(false, std::sync::atomic::Ordering::Relaxed);
                    }
                    queue(t);
                }
                if t.status == "stopping" {
                    finish(t, "cancelled", "Cancelled; saved credits were kept.");
                }
            }
            // Finish the active run before starting another queued task.
            Ok(tasks
                .iter()
                .find(|t| t.status == "running")
                .or_else(|| tasks.iter().find(|t| t.status == "queued"))
                .cloned())
        })?;
        let Some(task) = task else {
            return Ok(());
        };
        let result = if task.id == "imdb_refresh" {
            let result = self.refresh_imdb().await;
            if result.is_ok() {
                self.update_task(&task.id, |t| {
                    let message = t.message.clone();
                    if t.status == "stopping" {
                        finish(t, "cancelled", "IMDb refresh cancelled");
                    } else {
                        finish(t, "completed", &message);
                    }
                })?;
            }
            result
        } else {
            self.task_step(&task).await
        };
        if let Err(error) = result {
            self.update_task(&task.id, |t| {
                if t.status == "stopping" {
                    finish(t, "cancelled", "Cancelled; saved credits were kept.");
                } else {
                    finish(t, "failed", &error.to_string());
                }
            })?;
        }
        Ok(())
    }
    async fn task_step(&self, task: &ScheduledTask) -> Result<(), RuntimeError> {
        let config = &task.config;
        let key = format!("task_inventory:{}", task.id);
        if task.status == "queued" {
            self.update_task(&task.id, |t| {
                t.message = "Scanning applicable libraries across connected servers".into();
            })?;
            let mut items = Vec::new();
            let mut seen = HashSet::new();
            let servers = self.list_servers()?;
            if servers.is_empty() {
                return Err(invalid("Connect a media server before running this task."));
            }
            for server in servers {
                let libraries = self
                    .get_libraries(server.id)
                    .await?
                    .ok_or_else(|| invalid("Media server no longer exists"))?
                    .map_err(invalid)?;
                let token = self
                    .server_store()?
                    .decrypted_token(server.id)?
                    .unwrap_or_default();
                for library in libraries
                    .iter()
                    .filter(|l| l.anime || l.library_type == posterview_contracts::LibraryType::Show || l.library_type == posterview_contracts::LibraryType::Movie)
                {
                    if self.cancelled(&task.id)? {
                        return Ok(());
                    }
                    for movie in if library.anime && library.library_type == posterview_contracts::LibraryType::Other { vec![false, true] } else { vec![library.library_type == posterview_contracts::LibraryType::Movie] } {
                        let inventory = posterview_infra_media_servers::get_video_inventory(
                            posterview_infra_media_servers::ConnectionConfig {
                                server_type: server.server_type.clone(),
                                base_url: &server.base_url,
                                token: &token,
                            },
                            &library.id,
                            movie,
                        )
                        .await
                        .map_err(invalid)?;
                        self.record_library_items(server.id, &library.id, inventory.iter().map(|item| item.id.clone()))?;
                        for item in inventory {
                            if matches!(item.item_type, ItemType::Show | ItemType::Movie)
                                && seen.insert((server.id, item.id.clone()))
                            {
                                items.push(WorkItem {
                                    server_id: server.id,
                                    id: item.id,
                                    title: item.title,
                                });
                            }
                        }
                    }
                }
            }
            self.server_store()?.set_setting(
                &key,
                &serde_json::to_string(&items).map_err(|e| invalid(e.to_string()))?,
            )?;
            self.update_task(&task.id, |t| {
                if t.status != "stopping" {
                    t.status = "running".into();
                    t.total = items.len();
                    t.message = "Fetching saved and linked credits".into();
                }
            })?;
            return Ok(());
        }
        let items: Vec<WorkItem> =
            serde_json::from_str(&self.server_store()?.get_setting(&key)?)
                .map_err(|_| invalid("Task inventory is unavailable. Run the task again."))?;
        let Some(item) = items.get(task.processed) else {
            self.update_task(&task.id, |t| {
                finish(
                    t,
                    if t.failed > 0 || t.needs_matching > 0 || !t.issues.is_empty() {
                        "completed_with_issues"
                    } else {
                        "completed"
                    },
                    "Run finished. Review any issues below.",
                )
            })?;
            return Ok(());
        };
        self.update_task(&task.id, |t| t.current_title = Some(item.title.clone()))?;
        if config.kind == "missing_metadata" {
            let fetched = self.find_missing_metadata(item.server_id, &item.id, Some(&task.id)).await;
            if self.cancelled(&task.id)? { return Ok(()); }
            self.update_task(&task.id, |t| {
                t.processed += 1;
                match fetched {
                    Ok(result) => {
                        let updated = !result.filled.is_empty() || result.credits_added > 0;
                        t.updated += usize::from(updated); t.skipped += usize::from(!updated && result.issues.is_empty());
                        t.needs_matching += usize::from(result.needs_matching);
                        t.failed += usize::from(!result.needs_matching && result.issues.iter().any(|issue| !issue.contains("Jikan temporarily unavailable")));
                        for message in result.issues { if t.issues.len() < 200 { t.issues.push(TaskIssue { server_id: item.server_id, item_id: item.id.clone(), title: item.title.clone(), message, needs_matching: result.needs_matching }); } }
                    },
                    Err(e) => { t.failed += 1; if t.issues.len() < 200 { t.issues.push(TaskIssue { server_id: item.server_id, item_id: item.id.clone(), title: item.title.clone(), message: e.to_string(), needs_matching: false }); } }
                }
            })?;
            return Ok(());
        }

        let mut issues = Vec::new();
        let mut updated = false;
        let detail = match self
            .get_item_detail(item.server_id, &item.id)
            .await?
            .ok_or_else(|| invalid("Media server no longer exists"))?
        {
            Ok(detail) => detail,
            Err(error) => {
                self.update_task(&task.id, |t| {
                    t.processed += 1;
                    t.failed += 1;
                    if t.issues.len() < 200 {
                        t.issues.push(TaskIssue {
                            server_id: item.server_id,
                            item_id: item.id.clone(),
                            title: item.title.clone(),
                            message: error,
                            needs_matching: false,
                        });
                    }
                })?;
                return Ok(());
            }
        };
        let saved = self.series_credits(item.server_id, &item.id)?;
        let settings = self.credit_provider_settings()?;
        for provider in &config.providers {
            if !detail.anime && ["anilist", "mal"].contains(&provider.as_str()) { continue; }
            if (provider == "tmdb" && !settings.tmdb_configured)
                || (provider == "tvdb" && !settings.tvdb_configured)
            {
                continue;
            }
            if self.cancelled(&task.id)? {
                return Ok(());
            }
            let sources = saved
                .sources
                .iter()
                .filter(|s| &s.provider == provider)
                .collect::<Vec<_>>();
            let mut ids = sources
                .iter()
                .filter(|source| {
                    if config.kind == "missing_credits" {
                        source.credits.is_empty()
                    } else {
                        source
                            .fetched_at
                            .as_deref()
                            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                            .is_none_or(|date| {
                                date.timestamp() <= now() - config.stale_days * 86400
                            })
                    }
                })
                .map(|s| s.external_id.clone())
                .collect::<Vec<_>>();
            if sources.is_empty() {
                let id = detail.external_ids.get(provider).or_else(|| {
                    if provider == "mal" {
                        detail.external_ids.get("myanimelist")
                    } else {
                        None
                    }
                });
                if let Some(id) = id.filter(|id| posterview_infra_artwork::valid_credit_id(id)) {
                    ids.push(id.clone());
                }
            }
            ids.sort();
            ids.dedup();
            for id in ids {
                let mut last_error = None;
                for attempt in 0..3 {
                    if self.cancelled(&task.id)? {
                        return Ok(());
                    }
                    match tokio::time::timeout(
                        std::time::Duration::from_secs(90),
                        self.import_credits(item.server_id, &item.id, provider, &id),
                    )
                    .await
                    {
                        Ok(Ok(_)) => {
                            updated = true;
                            last_error = None;
                            break;
                        }
                        Ok(Err(e)) => last_error = Some(e.to_string()),
                        Err(_) => last_error = Some("Provider timed out".into()),
                    }
                    if last_error
                        .as_deref()
                        .is_some_and(|e| ["401", "403", "404"].iter().any(|code| e.contains(code)))
                    {
                        break;
                    }
                    if attempt < 2 {
                        tokio::time::sleep(std::time::Duration::from_secs(5 * (attempt + 1))).await;
                    }
                }
                if let Some(message) = last_error {
                    issues.push(TaskIssue {
                        server_id: item.server_id,
                        item_id: item.id.clone(),
                        title: item.title.clone(),
                        message: format!("{provider}: {message}"),
                        needs_matching: false,
                    });
                }
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            }
        }
        if saved.sources.is_empty() && !updated && issues.is_empty() {
            issues.push(TaskIssue { server_id: item.server_id, item_id: item.id.clone(), title: item.title.clone(), message: "No usable linked provider ID. Match this title in Edit Metadata → Provider matching or configure its provider credentials.".into(), needs_matching: true });
        }
        self.update_task(&task.id, |t| {
            t.processed += 1;
            t.updated += usize::from(updated);
            t.failed += usize::from(issues.iter().any(|i| !i.needs_matching));
            t.needs_matching += usize::from(issues.iter().any(|i| i.needs_matching));
            t.skipped += usize::from(!updated && issues.is_empty());
            t.issues.extend(issues);
            t.issues.truncate(200);
        })?;
        Ok(())
    }
}
