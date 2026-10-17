use crate::{ServerStore, StoreError};
use posterview_contracts::jobs::{
    BackgroundJobRecord, BackgroundJobSpec, JobCheckpoint, JobOutcome,
};
use rusqlite::{Connection, OptionalExtension, Row, TransactionBehavior, params};
use serde_json::Value;

const COLUMNS: &str = "id,kind,title,resource_key,dedupe_key,payload,status,attempt,max_attempts,available_at,created_at,updated_at,error,result,lease,(SELECT count(*) FROM background_job_checkpoints c WHERE c.job_id=background_jobs.id)";

pub(crate) fn migrate(db: &Connection) -> Result<(), StoreError> {
    let tx = db.unchecked_transaction()?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL DEFAULT(datetime('now')));")?;
    let applied: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=6)",
        [],
        |r| r.get(0),
    )?;
    if !applied {
        tx.execute_batch("CREATE TABLE background_jobs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,title TEXT NOT NULL,resource_key TEXT NOT NULL,dedupe_key TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('queued','running','cancelling','cancelled','completed','failed')),attempt INTEGER NOT NULL DEFAULT 0,max_attempts INTEGER NOT NULL,available_at INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,error TEXT,result TEXT,lease TEXT);
        CREATE UNIQUE INDEX background_jobs_queued_dedupe ON background_jobs(kind,dedupe_key) WHERE status='queued';
        CREATE INDEX background_jobs_ready ON background_jobs(status,available_at,created_at);
        CREATE TABLE background_job_checkpoints(job_id TEXT NOT NULL REFERENCES background_jobs(id) ON DELETE CASCADE,key TEXT NOT NULL,signature TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(job_id,key));
        INSERT INTO schema_migrations(version,name) VALUES(6,'durable_background_jobs');")?;
    }
    tx.commit()?;
    Ok(())
}
fn invalid(message: &str) -> StoreError {
    StoreError::Validation(message.into())
}
fn json(value: &Value, limit: usize) -> Result<String, StoreError> {
    let text = serde_json::to_string(value).map_err(|_| invalid("Invalid job data."))?;
    if text.len() > limit {
        return Err(invalid("Job data exceeds the supported size."));
    }
    Ok(text)
}
fn decode(row: &Row<'_>, index: usize) -> rusqlite::Result<Value> {
    let value: String = row.get(index)?;
    serde_json::from_str(&value).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(index, rusqlite::types::Type::Text, Box::new(e))
    })
}
fn record(row: &Row<'_>) -> rusqlite::Result<BackgroundJobRecord> {
    Ok(BackgroundJobRecord {
        id: row.get(0)?,
        kind: row.get(1)?,
        title: row.get(2)?,
        resource_key: row.get(3)?,
        dedupe_key: row.get(4)?,
        payload: decode(row, 5)?,
        status: row.get(6)?,
        attempt: row.get(7)?,
        max_attempts: row.get(8)?,
        available_at: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        error: row.get(12)?,
        result: if row.get::<_, Option<String>>(13)?.is_some() {
            Some(decode(row, 13)?)
        } else {
            None
        },
        lease: row.get(14)?,
        checkpoint_count: row.get(15)?,
    })
}
fn get(db: &Connection, id: &str) -> Result<Option<BackgroundJobRecord>, StoreError> {
    Ok(db
        .query_row(
            &format!("SELECT {COLUMNS} FROM background_jobs WHERE id=?1"),
            [id],
            record,
        )
        .optional()?)
}
fn merge_scan(mut old: Value, new: &Value) -> Result<Value, StoreError> {
    let Some(dst) = old.as_object_mut() else {
        return Err(invalid("Invalid scan job data."));
    };
    let Some(src) = new.as_object() else {
        return Err(invalid("Invalid scan job data."));
    };
    for (key, value) in src {
        match key.as_str() {
            "manual" | "force_metadata" => {
                let enabled = dst.get(key).and_then(Value::as_bool).unwrap_or(false)
                    || value.as_bool().unwrap_or(false);
                dst.insert(key.clone(), Value::Bool(enabled));
            }
            "scopes" => {
                let merged = match (dst.get(key), value) {
                    (Some(Value::Array(a)), Value::Array(b)) => {
                        let mut all = a.clone();
                        for entry in b {
                            if !all.contains(entry) {
                                all.push(entry.clone());
                            }
                        }
                        Value::Array(all)
                    }
                    _ => Value::Null,
                };
                dst.insert(key.clone(), merged);
            }
            _ => {
                if dst.get(key) != Some(value) {
                    return Err(invalid("Conflicting queued job data."));
                }
            }
        }
    }
    Ok(old)
}
// This receipt was persisted atomically with collection metadata. Preserve it
// across cancellation, error finalization and manual retries to prevent replay.
fn applied_collection_receipt(job: &BackgroundJobRecord) -> Option<&Value> {
    if job.kind != "collection_metadata" {
        return None;
    }
    job.result.as_ref().filter(|receipt| {
        let applied = receipt["applied_collection_id"].as_str();
        applied.is_some_and(|id| !id.is_empty())
            && applied == job.payload["collection_id"].as_str()
            && receipt["revision"]
                .as_u64()
                .is_some_and(|revision| revision > 0)
    })
}
impl ServerStore {
    pub fn enqueue_background_job(
        &self,
        spec: &BackgroundJobSpec,
        now: i64,
    ) -> Result<BackgroundJobRecord, StoreError> {
        for (text, max) in [
            (&spec.kind, 80),
            (&spec.title, 240),
            (&spec.resource_key, 512),
            (&spec.dedupe_key, 512),
        ] {
            if text.trim().is_empty() || text.len() > max {
                return Err(invalid("Invalid job fields."));
            }
        }
        if !(1..=20).contains(&spec.max_attempts) {
            return Err(invalid("Invalid job retry limit."));
        }
        let payload = json(&spec.payload, 8 * 1024 * 1024)?;
        let mut db = self.write_connection()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute("DELETE FROM background_jobs WHERE status IN ('completed','failed','cancelled') AND id NOT IN (SELECT id FROM background_jobs WHERE status IN ('completed','failed','cancelled') ORDER BY updated_at DESC,id LIMIT 200)", [])?;
        let existing=tx.query_row(&format!("SELECT {COLUMNS} FROM background_jobs WHERE kind=?1 AND dedupe_key=?2 AND status='queued'"),params![spec.kind,spec.dedupe_key],record).optional()?;
        if let Some(existing) = existing {
            if existing.resource_key != spec.resource_key {
                return Err(invalid("Conflicting queued job resource."));
            }
            let merged = if spec.kind == "native_scan" {
                merge_scan(existing.payload.clone(), &spec.payload)?
            } else if existing.payload == spec.payload {
                existing.payload.clone()
            } else {
                return Err(invalid("Conflicting queued job data."));
            };
            tx.execute(
                "UPDATE background_jobs SET payload=?2,updated_at=?3 WHERE id=?1",
                params![existing.id, json(&merged, 8 * 1024 * 1024)?, now],
            )?;
            let result = get(&tx, &existing.id)?.ok_or_else(|| invalid("Job is unavailable."))?;
            tx.commit()?;
            return Ok(result);
        }
        let active:i64=tx.query_row("SELECT count(*) FROM background_jobs WHERE status IN ('queued','running','cancelling')",[],|r|r.get(0))?;
        if active >= 128 {
            return Err(invalid("Background job queue is full."));
        }
        let id = uuid::Uuid::new_v4().to_string();
        tx.execute("INSERT INTO background_jobs(id,kind,title,resource_key,dedupe_key,payload,status,max_attempts,available_at,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,'queued',?7,?8,?8,?8)",params![id,spec.kind,spec.title,spec.resource_key,spec.dedupe_key,payload,spec.max_attempts,now])?;
        let result = get(&tx, &id)?.ok_or_else(|| invalid("Job is unavailable."))?;
        tx.commit()?;
        Ok(result)
    }
    pub fn claim_background_job(
        &self,
        now: i64,
    ) -> Result<Option<BackgroundJobRecord>, StoreError> {
        let mut db = self.write_connection()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let id:Option<String>=tx.query_row("SELECT id FROM background_jobs j WHERE status='queued' AND available_at<=?1 AND NOT EXISTS(SELECT 1 FROM background_jobs busy WHERE busy.resource_key=j.resource_key AND busy.status IN ('running','cancelling')) ORDER BY created_at,id LIMIT 1",[now],|r|r.get(0)).optional()?;
        let Some(id) = id else { return Ok(None) };
        tx.execute("UPDATE background_jobs SET status='running',attempt=attempt+1,lease=?2,updated_at=?3 WHERE id=?1",params![id,uuid::Uuid::new_v4().to_string(),now])?;
        let result = get(&tx, &id)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn background_jobs(&self) -> Result<Vec<BackgroundJobRecord>, StoreError> {
        let db = self.connection()?;
        let mut stmt=db.prepare(&format!("SELECT {COLUMNS} FROM background_jobs ORDER BY CASE WHEN status IN ('running','cancelling','queued') THEN 0 ELSE 1 END,updated_at DESC LIMIT 200"))?;
        Ok(stmt.query_map([], record)?.collect::<Result<Vec<_>, _>>()?)
    }
    pub fn background_job(&self, id: &str) -> Result<Option<BackgroundJobRecord>, StoreError> {
        get(&self.connection()?, id)
    }
    pub fn finish_background_job(
        &self,
        id: &str,
        lease: &str,
        outcome: &JobOutcome,
        now: i64,
    ) -> Result<bool, StoreError> {
        if !matches!(
            outcome.status.as_str(),
            "completed" | "failed" | "cancelled" | "queued"
        ) {
            return Err(invalid("Invalid job outcome."));
        }
        if outcome.error.as_ref().is_some_and(|e| e.len() > 2048) {
            return Err(invalid("Job error exceeds the supported size."));
        }
        let result = outcome
            .result
            .as_ref()
            .map(|v| json(v, 1024 * 1024))
            .transpose()?;
        let mut db = self.write_connection()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = get(&tx, id)?;
        let Some(current) = current.filter(|j| {
            j.lease.as_deref() == Some(lease)
                && matches!(j.status.as_str(), "running" | "cancelling")
        }) else {
            return Ok(false);
        };
        let result = if let Some(receipt) = applied_collection_receipt(&current) {
            Some(json(receipt, 1024 * 1024)?)
        } else {
            result
        };
        let mut status = if current.status == "cancelling" {
            "cancelled"
        } else {
            outcome.status.as_str()
        };
        // A follow-up may already occupy the dedupe key; don't resurrect a second queued job.
        if status == "queued" {
            let queued:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM background_jobs WHERE kind=?1 AND dedupe_key=?2 AND status='queued')",params![current.kind,current.dedupe_key],|r|r.get(0))?;
            if queued || current.attempt >= current.max_attempts {
                status = "failed";
            }
        }
        tx.execute("UPDATE background_jobs SET status=?3,error=?4,result=?5,available_at=?6,updated_at=?7,lease=NULL WHERE id=?1 AND lease=?2",params![id,lease,status,outcome.error,result,outcome.retry_at.unwrap_or(now),now])?;
        tx.commit()?;
        Ok(true)
    }
    pub fn request_background_job_cancel(
        &self,
        id: &str,
        now: i64,
    ) -> Result<Option<BackgroundJobRecord>, StoreError> {
        let mut db = self.write_connection()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute("UPDATE background_jobs SET status=CASE status WHEN 'queued' THEN 'cancelled' ELSE 'cancelling' END,updated_at=?2 WHERE id=?1 AND status IN ('queued','running')",params![id,now])?;
        let result = get(&tx, id)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn retry_background_job(
        &self,
        id: &str,
        now: i64,
    ) -> Result<Option<BackgroundJobRecord>, StoreError> {
        let mut db = self.write_connection()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(job) = get(&tx, id)? {
            if matches!(job.status.as_str(), "failed" | "cancelled") {
                let active:i64=tx.query_row("SELECT count(*) FROM background_jobs WHERE status IN ('queued','running','cancelling')",[],|r|r.get(0))?;
                if active >= 128 {
                    return Err(invalid("Background job queue is full."));
                }
                let duplicate:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM background_jobs WHERE kind=?1 AND dedupe_key=?2 AND status='queued')",params![job.kind,job.dedupe_key],|r|r.get(0))?;
                if duplicate {
                    return Err(invalid("An equivalent job is already queued."));
                }
                let receipt = applied_collection_receipt(&job)
                    .map(|value| json(value, 1024 * 1024))
                    .transpose()?;
                tx.execute("UPDATE background_jobs SET status='queued',attempt=0,lease=NULL,error=NULL,result=?3,available_at=?2,updated_at=?2 WHERE id=?1",params![id,now,receipt])?;
            }
        }
        let result = get(&tx, id)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn recover_background_jobs(&self, now: i64) -> Result<usize, StoreError> {
        let mut db = self.write_connection()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        // Recover deterministically, respecting a follow-up already queued for this dedupe key.
        let jobs = {
            let mut stmt=tx.prepare(&format!("SELECT {COLUMNS} FROM background_jobs WHERE status IN ('running','cancelling') ORDER BY created_at,id"))?;
            stmt.query_map([], record)?.collect::<Result<Vec<_>, _>>()?
        };
        for job in &jobs {
            let followup=tx.query_row(&format!("SELECT {COLUMNS} FROM background_jobs WHERE kind=?1 AND dedupe_key=?2 AND status='queued'"),params![job.kind,job.dedupe_key],record).optional()?;
            let queued = followup.is_some();
            if job.status == "running"
                && job.kind == "native_scan"
                && let Some(followup) = followup
            {
                // Keep the follow-up ID stable for existing waiters. Move reusable signed
                // checkpoints forward instead of throwing away completed enrichment work.
                let payload = merge_scan(job.payload.clone(), &followup.payload)?;
                tx.execute(
                    "UPDATE background_jobs SET payload=?2,updated_at=?3 WHERE id=?1",
                    params![followup.id, json(&payload, 8 * 1024 * 1024)?, now],
                )?;
                let (count,bytes):(i64,i64)=tx.query_row("SELECT count(*),coalesce(sum(length(value)),0) FROM (SELECT key,value FROM background_job_checkpoints WHERE job_id=?1 UNION ALL SELECT old.key,old.value FROM background_job_checkpoints old WHERE old.job_id=?2 AND NOT EXISTS(SELECT 1 FROM background_job_checkpoints newer WHERE newer.job_id=?1 AND newer.key=old.key))",params![followup.id,job.id],|r|Ok((r.get(0)?,r.get(1)?)))?;
                if count <= 100_000 && bytes <= 256 * 1024 * 1024 {
                    tx.execute("INSERT OR IGNORE INTO background_job_checkpoints(job_id,key,signature,value) SELECT ?1,key,signature,value FROM background_job_checkpoints WHERE job_id=?2",params![followup.id,job.id])?;
                }
            }
            let status = if job.status == "cancelling" {
                "cancelled"
            } else if job.attempt < job.max_attempts && !queued {
                "queued"
            } else {
                "failed"
            };
            tx.execute("UPDATE background_jobs SET status=?2,lease=NULL,available_at=?3,updated_at=?3,error=CASE WHEN ?2='failed' THEN 'Interrupted job could not be resumed.' ELSE NULL END WHERE id=?1",params![job.id,status,now])?;
        }
        tx.commit()?;
        Ok(jobs.len())
    }
    pub fn save_job_checkpoint(
        &self,
        id: &str,
        lease: &str,
        checkpoint: &JobCheckpoint,
        now: i64,
    ) -> Result<bool, StoreError> {
        if checkpoint.key.is_empty()
            || checkpoint.key.len() > 512
            || checkpoint.signature.len() > 2048
        {
            return Err(invalid("Invalid checkpoint fields."));
        }
        let value = json(&checkpoint.value, 16 * 1024 * 1024)?;
        let mut db = self.write_connection()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let valid:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM background_jobs WHERE id=?1 AND lease=?2 AND status IN ('running','cancelling'))",params![id,lease],|r|r.get(0))?;
        if !valid {
            return Ok(false);
        }
        let (count, bytes): (i64,i64) = tx.query_row("SELECT count(*),coalesce(sum(length(value)),0) FROM background_job_checkpoints WHERE job_id=?1 AND key<>?2",params![id,checkpoint.key],|r|Ok((r.get(0)?,r.get(1)?)))?;
        if count >= 100_000 || bytes + value.len() as i64 > 256 * 1024 * 1024 {
            return Err(invalid("Job checkpoints exceed the supported size."));
        }
        tx.execute("INSERT INTO background_job_checkpoints(job_id,key,signature,value) VALUES(?1,?2,?3,?4) ON CONFLICT(job_id,key) DO UPDATE SET signature=excluded.signature,value=excluded.value",params![id,checkpoint.key,checkpoint.signature,value])?;
        tx.execute(
            "UPDATE background_jobs SET updated_at=?2 WHERE id=?1",
            params![id, now],
        )?;
        tx.commit()?;
        Ok(true)
    }
    pub fn job_checkpoints(&self, id: &str) -> Result<Vec<JobCheckpoint>, StoreError> {
        let db = self.connection()?;
        let mut stmt=db.prepare("SELECT key,signature,value FROM background_job_checkpoints WHERE job_id=?1 ORDER BY key")?;
        Ok(stmt
            .query_map([id], |r| {
                Ok(JobCheckpoint {
                    key: r.get(0)?,
                    signature: r.get(1)?,
                    value: decode(r, 2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn store() -> (tempfile::TempDir, ServerStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = ServerStore::new(dir.path());
        store.initialize().unwrap();
        migrate(&store.connection().unwrap()).unwrap();
        (dir, store)
    }
    fn spec(key: &str) -> BackgroundJobSpec {
        BackgroundJobSpec {
            kind: "test".into(),
            title: "Test job".into(),
            resource_key: key.into(),
            dedupe_key: key.into(),
            payload: json!({}),
            max_attempts: 3,
        }
    }
    fn outcome(status: &str) -> JobOutcome {
        JobOutcome {
            status: status.into(),
            error: None,
            result: None,
            retry_at: None,
        }
    }
    #[test]
    fn migration_is_idempotent_and_enqueue_is_bounded() {
        let (_dir, s) = store();
        migrate(&s.connection().unwrap()).unwrap();
        let first = s.enqueue_background_job(&spec("a"), 10).unwrap();
        assert_eq!(
            s.enqueue_background_job(&spec("a"), 11).unwrap().id,
            first.id
        );
        let mut changed = spec("a");
        changed.payload = json!({"different":true});
        assert!(s.enqueue_background_job(&changed, 12).is_err());
        for i in 1..128 {
            s.enqueue_background_job(&spec(&format!("job-{i}")), 12)
                .unwrap();
        }
        assert!(s.enqueue_background_job(&spec("overflow"), 12).is_err());
    }
    #[test]
    fn claims_are_atomic_and_exclude_running_resources() {
        let (_dir, s) = store();
        let first = s.enqueue_background_job(&spec("a"), 10).unwrap();
        let claimed = s.claim_background_job(10).unwrap().unwrap();
        assert_eq!(first.id, claimed.id);
        let follow = s.enqueue_background_job(&spec("a"), 11).unwrap();
        assert_ne!(first.id, follow.id);
        assert!(s.claim_background_job(11).unwrap().is_none());
        let other = s.enqueue_background_job(&spec("b"), 12).unwrap();
        let s = std::sync::Arc::new(s);
        let handles = (0..4)
            .map(|_| {
                let s = s.clone();
                std::thread::spawn(move || s.claim_background_job(12).unwrap().map(|j| j.id))
            })
            .collect::<Vec<_>>();
        let results = handles
            .into_iter()
            .filter_map(|h| h.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(results, vec![other.id]);
    }
    #[test]
    fn checkpoint_resume_fences_old_workers_and_cancel_wins() {
        let (_dir, s) = store();
        let job = s.enqueue_background_job(&spec("a"), 10).unwrap();
        let claimed = s.claim_background_job(10).unwrap().unwrap();
        let lease = claimed.lease.unwrap();
        let cp = JobCheckpoint {
            key: "item".into(),
            signature: "v1".into(),
            value: json!({"title":"Saved"}),
        };
        assert!(s.save_job_checkpoint(&job.id, &lease, &cp, 11).unwrap());
        assert_eq!(s.recover_background_jobs(12).unwrap(), 1);
        assert!(
            !s.finish_background_job(&job.id, &lease, &outcome("completed"), 13)
                .unwrap()
        );
        assert!(!s.save_job_checkpoint(&job.id, &lease, &cp, 13).unwrap());
        let resumed = s.claim_background_job(12).unwrap().unwrap();
        assert_eq!(resumed.attempt, 2);
        assert_eq!(resumed.checkpoint_count, 1);
        assert_eq!(s.job_checkpoints(&job.id).unwrap()[0].value, cp.value);
        assert_eq!(
            s.request_background_job_cancel(&job.id, 14)
                .unwrap()
                .unwrap()
                .status,
            "cancelling"
        );
        assert!(
            s.finish_background_job(
                &job.id,
                resumed.lease.as_deref().unwrap(),
                &outcome("completed"),
                15
            )
            .unwrap()
        );
        assert_eq!(
            s.background_job(&job.id).unwrap().unwrap().status,
            "cancelled"
        );
        let retry = s.retry_background_job(&job.id, 16).unwrap().unwrap();
        assert_eq!(retry.attempt, 0);
        assert_eq!(retry.checkpoint_count, 1);
    }
    #[test]
    fn recovery_honors_attempt_limits_and_pending_cancellation() {
        let (_dir, s) = store();
        let mut one = spec("a");
        one.max_attempts = 1;
        let a = s.enqueue_background_job(&one, 1).unwrap();
        s.claim_background_job(1).unwrap();
        let b = s.enqueue_background_job(&spec("b"), 2).unwrap();
        s.claim_background_job(2).unwrap();
        s.request_background_job_cancel(&b.id, 3).unwrap();
        assert_eq!(s.recover_background_jobs(4).unwrap(), 2);
        assert_eq!(s.background_job(&a.id).unwrap().unwrap().status, "failed");
        assert_eq!(
            s.background_job(&b.id).unwrap().unwrap().status,
            "cancelled"
        );
    }
    #[test]
    fn native_scan_requests_coalesce_scope_and_force_flags() {
        let (_dir, s) = store();
        let mut a = spec("library");
        a.kind = "native_scan".into();
        a.payload =
            json!({"library_id":"library","scopes":["a"],"manual":false,"force_metadata":true});
        let first = s.enqueue_background_job(&a, 1).unwrap();
        a.payload =
            json!({"library_id":"library","scopes":["b","a"],"manual":true,"force_metadata":false});
        let merged = s.enqueue_background_job(&a, 2).unwrap();
        assert_eq!(merged.id, first.id);
        assert_eq!(
            merged.payload,
            json!({"library_id":"library","scopes":["a","b"],"manual":true,"force_metadata":true})
        );
        a.payload["scopes"] = Value::Null;
        assert!(s.enqueue_background_job(&a, 3).unwrap().payload["scopes"].is_null());
    }
    #[test]
    fn recovery_transfers_signed_native_checkpoints_and_unions_followup_scope() {
        let (_dir, s) = store();
        let mut request = spec("library");
        request.kind = "native_scan".into();
        request.payload =
            json!({"library_id":"library","scopes":["first"],"manual":false,"force_metadata":true});
        let interrupted = s.enqueue_background_job(&request, 1).unwrap();
        let claimed = s.claim_background_job(1).unwrap().unwrap();
        let checkpoint = JobCheckpoint {
            key: "entry".into(),
            signature: "signature".into(),
            value: json!({"title":"Already fetched"}),
        };
        s.save_job_checkpoint(
            &interrupted.id,
            claimed.lease.as_deref().unwrap(),
            &checkpoint,
            2,
        )
        .unwrap();
        request.payload = json!({"library_id":"library","scopes":["second"],"manual":true,"force_metadata":false});
        let followup = s.enqueue_background_job(&request, 3).unwrap();
        s.recover_background_jobs(4).unwrap();
        let resumed = s.claim_background_job(4).unwrap().unwrap();
        assert_eq!(resumed.id, followup.id);
        assert_eq!(resumed.checkpoint_count, 1);
        assert_eq!(
            resumed.payload,
            json!({"library_id":"library","scopes":["first","second"],"manual":true,"force_metadata":true})
        );
        let saved = s.job_checkpoints(&followup.id).unwrap();
        assert_eq!(saved[0].signature, checkpoint.signature);
        assert_eq!(saved[0].value, checkpoint.value);
        assert!(
            !s.save_job_checkpoint(
                &interrupted.id,
                claimed.lease.as_deref().unwrap(),
                &checkpoint,
                5
            )
            .unwrap()
        );
    }
    #[test]
    fn committed_collection_receipt_survives_late_cancel_retry_and_restart() {
        let (_dir, s) = store();
        let mut request = spec("collection");
        request.kind = "collection_metadata".into();
        request.payload = json!({"collection_id":"collection"});
        let job = s.enqueue_background_job(&request, 1).unwrap();
        let claimed = s.claim_background_job(1).unwrap().unwrap();
        let receipt = json!({"applied_collection_id":"collection","revision":2});
        // Simulate the receipt written in the same transaction as the metadata.
        s.connection()
            .unwrap()
            .execute(
                "UPDATE background_jobs SET result=?2 WHERE id=?1",
                params![job.id, receipt.to_string()],
            )
            .unwrap();
        s.request_background_job_cancel(&job.id, 2).unwrap();
        assert!(
            s.finish_background_job(
                &job.id,
                claimed.lease.as_deref().unwrap(),
                &outcome("cancelled"),
                3
            )
            .unwrap()
        );
        assert_eq!(
            s.background_job(&job.id).unwrap().unwrap().result,
            Some(receipt.clone())
        );
        assert_eq!(
            s.retry_background_job(&job.id, 4).unwrap().unwrap().result,
            Some(receipt.clone())
        );
        s.claim_background_job(4).unwrap();
        s.recover_background_jobs(5).unwrap();
        let resumed = s.claim_background_job(5).unwrap().unwrap();
        assert_eq!(resumed.result, Some(receipt.clone()));
        s.finish_background_job(
            &job.id,
            resumed.lease.as_deref().unwrap(),
            &outcome("failed"),
            6,
        )
        .unwrap();
        assert_eq!(
            s.background_job(&job.id).unwrap().unwrap().result,
            Some(receipt)
        );
    }
    #[test]
    fn recovery_with_a_queued_followup_does_not_break_deduplication() {
        let (_dir, s) = store();
        let first = s.enqueue_background_job(&spec("a"), 1).unwrap();
        s.claim_background_job(1).unwrap();
        let follow = s.enqueue_background_job(&spec("a"), 2).unwrap();
        s.recover_background_jobs(3).unwrap();
        assert_eq!(
            s.background_job(&first.id).unwrap().unwrap().status,
            "failed"
        );
        assert_eq!(s.claim_background_job(3).unwrap().unwrap().id, follow.id);
    }
}

#[cfg(test)]
mod retention_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn terminal_retention_cascades_checkpoints_without_removing_active_work() {
        let dir = tempfile::tempdir().unwrap();
        let store = ServerStore::new(dir.path());
        store.initialize().unwrap();
        migrate(&store.connection().unwrap()).unwrap();
        let job = store
            .enqueue_background_job(
                &BackgroundJobSpec {
                    kind: "test".into(),
                    title: "Test".into(),
                    resource_key: "a".into(),
                    dedupe_key: "a".into(),
                    payload: json!({}),
                    max_attempts: 2,
                },
                0,
            )
            .unwrap();
        let running = store.claim_background_job(0).unwrap().unwrap();
        store
            .save_job_checkpoint(
                &job.id,
                running.lease.as_deref().unwrap(),
                &JobCheckpoint {
                    key: "saved".into(),
                    signature: "v1".into(),
                    value: json!({}),
                },
                0,
            )
            .unwrap();
        store
            .finish_background_job(
                &job.id,
                running.lease.as_deref().unwrap(),
                &JobOutcome {
                    status: "completed".into(),
                    error: None,
                    result: None,
                    retry_at: None,
                },
                0,
            )
            .unwrap();
        let db = store.connection().unwrap();
        for i in 1..=201 {
            db.execute("INSERT INTO background_jobs(id,kind,title,resource_key,dedupe_key,payload,status,max_attempts,available_at,created_at,updated_at) VALUES(?1,'test','Test','x',?1,'{}','completed',2,0,?2,?2)",params![format!("old-{i}"),i]).unwrap();
        }
        store
            .enqueue_background_job(
                &BackgroundJobSpec {
                    kind: "test".into(),
                    title: "Active".into(),
                    resource_key: "b".into(),
                    dedupe_key: "b".into(),
                    payload: json!({}),
                    max_attempts: 2,
                },
                202,
            )
            .unwrap();
        assert!(store.background_job(&job.id).unwrap().is_none());
        assert!(store.job_checkpoints(&job.id).unwrap().is_empty());
        let count: i64 = db
            .query_row("SELECT count(*) FROM background_jobs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 201);
    }
}
