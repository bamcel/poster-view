//! Durable application work. Payloads and leases are internal, never API projections.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackgroundJobSpec {
    pub kind: String,
    pub title: String,
    pub resource_key: String,
    pub dedupe_key: String,
    pub payload: Value,
    pub max_attempts: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackgroundJobRecord {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub resource_key: String,
    pub dedupe_key: String,
    pub payload: Value,
    pub status: String,
    pub attempt: u32,
    pub max_attempts: u32,
    pub available_at: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub error: Option<String>,
    pub result: Option<Value>,
    pub lease: Option<String>,
    pub checkpoint_count: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobCheckpoint {
    pub key: String,
    pub signature: String,
    pub value: Value,
}
#[derive(Debug, Clone)]
pub struct JobOutcome {
    pub status: String,
    pub error: Option<String>,
    pub result: Option<Value>,
    pub retry_at: Option<i64>,
}
