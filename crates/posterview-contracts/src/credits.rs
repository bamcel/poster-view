use serde::{Deserialize, Serialize};

/// A provider-scoped credit. Language describes the performance, never UI text.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Credit {
    pub person_id: String,
    pub name: String,
    pub image: Option<String>,
    pub person_url: Option<String>,
    pub character_id: Option<String>,
    pub character: Option<String>,
    pub character_image: Option<String>,
    pub category: String,
    pub role: String,
    pub language: Option<String>,
    pub dub_group: Option<String>,
    pub notes: Option<String>,
    pub order: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreditSource {
    pub provider: String,
    pub external_id: String,
    pub title: String,
    pub source_url: String,
    pub original_language: Option<String>,
    pub fetched_at: Option<String>,
    pub credits: Vec<Credit>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SeriesCredits {
    pub catalog_id: Option<String>,
    pub original_language: Option<String>,
    pub sources: Vec<CreditSource>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreditSearchResult {
    pub id: String,
    pub title: String,
    pub year: Option<i64>,
    pub image: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreditProviderSettings {
    pub tmdb_configured: bool,
    pub tvdb_configured: bool,
}
