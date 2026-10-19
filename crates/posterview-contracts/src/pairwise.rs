//! Per-account library preference ranking contracts.
use crate::native::NativeCatalogEntry;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PairwiseSettings {
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RankingLibrary {
    pub id: String,
    pub name: String,
    pub title_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RankingTitle {
    pub entry: NativeCatalogEntry,
    pub score: Option<f64>,
    pub rank: Option<usize>,
    pub comparisons: usize,
    pub provisional: bool,
    pub excluded: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RankingPair {
    pub token: String,
    pub left_id: String,
    pub right_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RankingView {
    pub library_id: String,
    pub revision: i64,
    pub decision_count: usize,
    pub ranked_count: usize,
    pub excluded_count: usize,
    pub titles: Vec<RankingTitle>,
    pub pair: Option<RankingPair>,
    pub can_undo: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RankingAction {
    pub revision: i64,
    pub action: String,
    pub token: Option<String>,
    pub item_id: Option<String>,
}

/// Private stored decisions are projected through current access rules before
/// any ranking, history count, or active pair is sent to a client.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RankingBoard {
    #[serde(default)]
    pub events: Vec<RankingEvent>,
    #[serde(default)]
    pub pair: Option<RankingPair>,
    #[serde(default)]
    pub recent: Vec<[String; 2]>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RankingEvent {
    pub left_id: String,
    pub right_id: Option<String>,
    pub outcome: String,
    pub pair: Option<RankingPair>,
}
