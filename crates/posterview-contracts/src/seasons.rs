use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct EpisodeDetail {
    pub id: String,
    pub title: String,
    pub index: Option<i64>,
    pub index_end: Option<i64>,
    pub image: Option<String>,
    pub summary: Option<String>,
    pub aired: Option<String>,
    pub runtime_minutes: Option<i64>,
    pub rating: Option<f64>,
    pub directors: Vec<String>,
    pub writers: Vec<String>,
    pub cast: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SeasonDetail {
    pub id: String,
    pub series_id: String,
    pub title: String,
    pub index: Option<i64>,
    pub poster: Option<String>,
    pub background: Option<String>,
    pub summary: Option<String>,
    pub episodes: Vec<EpisodeDetail>,
}
