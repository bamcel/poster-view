use crate::{Runtime, RuntimeError};
use chrono::Utc;
use posterview_contracts::ItemType;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

const KEY: &str = "scheduled_tasks_v1";

#[cfg(test)]
mod tests {
    use super::*;
    fn setup(runtime: &Runtime) -> TaskConfig {
        runtime.initialize().unwrap();
        let server = runtime
            .create_server(&posterview_contracts::ServerCreate {
                name: "Test".into(),
                server_type: posterview_contracts::ServerType::Emby,
                base_url: "http://localhost:1".into(),
                token: "test".into(),
                is_default: false,
                nfo_metadata_enabled: false,
            })
            .unwrap();
        TaskConfig {
            name: "Credits".into(),
            server_id: server.id,
            library_ids: vec!["tv".into()],
            kind: "missing_credits".into(),
            providers: vec!["anilist".into()],
            enabled: false,
            interval_hours: 24,
            stale_days: 30,
        }
    }
    #[tokio::test]
    async fn task_queue_survives_restart_and_cancel_keeps_history() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = Runtime::new(dir.path());
        let config = setup(&runtime);
        let task = runtime.save_scheduled_task(None, config.clone()).unwrap();
        runtime.task_action(&task.id, "run").unwrap();
        assert!(runtime.task_action(&task.id, "run").is_err());
        assert!(runtime.save_scheduled_task(Some(&task.id), config).is_err());
        drop(runtime);
        let runtime = Runtime::new(dir.path());
        runtime.initialize().unwrap();
        assert_eq!(runtime.scheduled_tasks().unwrap()[0].status, "queued");
        runtime.task_action(&task.id, "cancel").unwrap();
        runtime.scheduled_task_tick().await.unwrap();
        let saved = &runtime.scheduled_tasks().unwrap()[0];
        assert_eq!(saved.status, "cancelled");
        assert_eq!(saved.history.len(), 1);
        runtime.task_action(&task.id, "delete").unwrap();
        assert!(runtime.scheduled_tasks().unwrap().is_empty());
    }
    #[tokio::test]
    async fn running_checkpoint_resumes_and_reschedules_without_rescanning() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = Runtime::new(dir.path());
        let mut config = setup(&runtime);
        config.enabled = true;
        let task = runtime.save_scheduled_task(None, config).unwrap();
        runtime
            .update_task(&task.id, |t| {
                t.status = "running".into();
                t.processed = 3;
                t.total = 3;
            })
            .unwrap();
        runtime
            .server_store()
            .unwrap()
            .set_setting(&format!("task_inventory:{}", task.id), "[]")
            .unwrap();
        drop(runtime);
        let runtime = Runtime::new(dir.path());
        runtime.initialize().unwrap();
        runtime.scheduled_task_tick().await.unwrap();
        let saved = &runtime.scheduled_tasks().unwrap()[0];
        assert_eq!(saved.status, "completed");
        assert_eq!(saved.processed, 3);
        assert!(saved.next_run.unwrap() > now());
    }
    #[test]
    fn task_rejects_unsupported_work_and_unconfigured_provider() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = Runtime::new(dir.path());
        let mut config = setup(&runtime);
        config.kind = "publish_nfo".into();
        assert!(runtime.save_scheduled_task(None, config.clone()).is_err());
        config.kind = "missing_credits".into();
        config.providers = vec!["tmdb".into()];
        assert!(runtime.save_scheduled_task(None, config.clone()).is_err());
        config.providers = vec!["anilist".into()];
        config.library_ids.clear();
        assert!(runtime.save_scheduled_task(None, config).is_err());
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
    pub server_id: i64,
    pub library_ids: Vec<String>,
    pub kind: String,
    pub providers: Vec<String>,
    pub enabled: bool,
    pub interval_hours: i64,
    pub stale_days: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TaskIssue {
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
    id: String,
    title: String,
}
fn active(task: &ScheduledTask) -> bool {
    ["queued", "running", "stopping"].contains(&task.status.as_str())
}
fn queue(task: &mut ScheduledTask) {
    task.status = "queued".into();
    task.started_at = None;
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

impl Runtime {
    pub fn scheduled_tasks(&self) -> Result<Vec<ScheduledTask>, RuntimeError> {
        let raw = self.server_store()?.get_setting(KEY)?;
        if raw.is_empty() {
            return Ok(Vec::new());
        }
        serde_json::from_str(&raw)
            .map_err(|e| invalid(format!("Could not read scheduled tasks: {e}")))
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
        if config.name.trim().is_empty()
            || config.name.len() > 100
            || config.library_ids.is_empty()
            || config.library_ids.len() > 100
            || config
                .library_ids
                .iter()
                .any(|s| s.is_empty() || s.len() > 512)
            || !["missing_credits", "refresh_credits"].contains(&config.kind.as_str())
            || config.providers.is_empty()
            || config.providers.len() > 4
            || config
                .providers
                .iter()
                .any(|p| !posterview_infra_artwork::valid_credit_provider(p))
            || !(1..=8760).contains(&config.interval_hours)
            || !(1..=3650).contains(&config.stale_days)
        {
            return Err(invalid(
                "Choose a name, libraries, providers, interval (1–8760 hours), and refresh age (1–3650 days).",
            ));
        }
        if self.get_server(config.server_id)?.is_none() {
            return Err(invalid("Media server no longer exists."));
        }
        let settings = self.credit_provider_settings()?;
        if config.providers.iter().any(|p| {
            (p == "tmdb" && !settings.tmdb_configured) || (p == "tvdb" && !settings.tvdb_configured)
        }) {
            return Err(invalid(
                "Configure the selected TMDB/TVDB provider credentials first.",
            ));
        }
        self.change_tasks(|tasks| {
            if let Some(id) = id {
                let task = tasks
                    .iter_mut()
                    .find(|t| t.id == id)
                    .ok_or_else(|| invalid("Task not found"))?;
                if active(task) {
                    return Err(invalid("Cancel the current run before editing this task."));
                }
                task.next_run = config
                    .enabled
                    .then_some(now() + config.interval_hours * 3600);
                task.config = config;
                return Ok(task.clone());
            }
            if tasks.len() >= 100 {
                return Err(invalid("Maximum of 100 scheduled tasks reached."));
            }
            let task = ScheduledTask {
                id: uuid::Uuid::new_v4().to_string(),
                next_run: config
                    .enabled
                    .then_some(now() + config.interval_hours * 3600),
                config,
                status: "idle".into(),
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
                issues: Vec::new(),
                history: Vec::new(),
            };
            tasks.push(task.clone());
            Ok(task)
        })
    }
    pub fn task_action(&self, id: &str, action: &str) -> Result<(), RuntimeError> {
        self.change_tasks(|tasks| {
            let task = tasks
                .iter_mut()
                .find(|t| t.id == id)
                .ok_or_else(|| invalid("Task not found"))?;
            match action {
                "run" if !active(task) => queue(task),
                "cancel" if active(task) => {
                    task.status = "stopping".into();
                    task.message = "Cancellation requested".into();
                }
                "delete" if !active(task) => {
                    tasks.retain(|t| t.id != id);
                    self.server_store()?
                        .set_setting(&format!("task_inventory:{id}"), "")?;
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
    fn update_task(
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
    fn cancelled(&self, id: &str) -> Result<bool, RuntimeError> {
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
        let result = self.task_step(&task).await;
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
                t.message = "Scanning selected TV libraries".into();
            })?;
            let libraries = self
                .get_libraries(config.server_id)
                .await?
                .ok_or_else(|| invalid("Media server no longer exists"))?
                .map_err(invalid)?;
            let mut items = Vec::new();
            let mut seen = HashSet::new();
            for library in &config.library_ids {
                if self.cancelled(&task.id)? {
                    return Ok(());
                }
                if !libraries.iter().any(|l| {
                    &l.id == library && l.library_type == posterview_contracts::LibraryType::Show
                }) {
                    return Err(invalid(
                        "A selected TV library is missing or has changed type. Edit this task's libraries.",
                    ));
                }
                let server = self
                    .get_server(config.server_id)?
                    .ok_or_else(|| invalid("Media server no longer exists"))?;
                let token = self
                    .server_store()?
                    .decrypted_token(config.server_id)?
                    .unwrap_or_default();
                let inventory = posterview_infra_media_servers::get_series_inventory(
                    posterview_infra_media_servers::ConnectionConfig {
                        server_type: server.server_type,
                        base_url: &server.base_url,
                        token: &token,
                    },
                    library,
                )
                .await
                .map_err(invalid)?;
                for item in inventory {
                    if item.item_type == ItemType::Show && seen.insert(item.id.clone()) {
                        items.push(WorkItem {
                            id: item.id,
                            title: item.title,
                        });
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
                    t.started_at = Some(now());
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
                    if t.failed > 0 || t.needs_matching > 0 {
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
        let mut issues = Vec::new();
        let mut updated = false;
        let detail = match self
            .get_item_detail(config.server_id, &item.id)
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
        let saved = self.series_credits(config.server_id, &item.id)?;
        for provider in &config.providers {
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
                } else {
                    issues.push(TaskIssue {
                        item_id: item.id.clone(),
                        title: item.title.clone(),
                        message: format!(
                            "{provider}: no linked ID. Match this series in Sources & matching."
                        ),
                        needs_matching: true,
                    });
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
                        self.import_credits(config.server_id, &item.id, provider, &id),
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
                        item_id: item.id.clone(),
                        title: item.title.clone(),
                        message: format!("{provider}: {message}"),
                        needs_matching: false,
                    });
                }
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            }
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
