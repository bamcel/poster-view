use serde::{Deserialize, Serialize};

/// Kept byte-for-byte compatible with the current FastAPI health response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub version: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StatusResponse {
    pub name: &'static str,
    pub version: &'static str,
    pub backend: &'static str,
    pub data_dir: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ApiErrorResponse {
    pub detail: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ServerType {
    Plex,
    Jellyfin,
    Emby,
}

impl ServerType {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Plex => "plex",
            Self::Jellyfin => "jellyfin",
            Self::Emby => "emby",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ServerCreate {
    pub name: String,
    #[serde(rename = "type")]
    pub server_type: ServerType,
    pub base_url: String,
    pub token: String,
    #[serde(default)]
    pub is_default: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct ServerUpdate {
    pub name: Option<String>,
    #[serde(rename = "type")]
    pub server_type: Option<ServerType>,
    pub base_url: Option<String>,
    pub token: Option<String>,
    pub is_default: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Server {
    pub id: i64,
    pub name: String,
    #[serde(rename = "type")]
    pub server_type: ServerType,
    pub base_url: String,
    pub is_default: bool,
    pub has_token: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConnectionTest {
    pub ok: bool,
    pub message: String,
    pub server_name: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LibraryType {
    Movie,
    Show,
    Collection,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Library {
    pub id: String,
    pub title: String,
    #[serde(rename = "type")]
    pub library_type: LibraryType,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ItemType {
    Movie,
    Show,
    Collection,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MediaItem {
    pub id: String,
    pub title: String,
    pub year: Option<i64>,
    #[serde(rename = "type")]
    pub item_type: ItemType,
    pub poster: Option<String>,
    pub background: Option<String>,
    pub added_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Season {
    pub id: String,
    pub title: String,
    pub index: Option<i64>,
    pub poster: Option<String>,
    pub episode_count: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ItemDetail {
    pub id: String,
    pub title: String,
    pub year: Option<i64>,
    #[serde(rename = "type")]
    pub item_type: ItemType,
    pub poster: Option<String>,
    pub background: Option<String>,
    pub added_at: Option<String>,
    pub summary: Option<String>,
    pub season_count: Option<i64>,
    pub seasons: Vec<Season>,
    pub external_ids: std::collections::BTreeMap<String, String>,
    pub logo: Option<String>,
    pub members: Vec<MediaItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageTarget {
    Poster,
    Background,
    Logo,
}

impl ImageTarget {
    #[must_use]
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Poster => "poster",
            Self::Background => "background",
            Self::Logo => "logo",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ApplyRequest {
    pub server_id: i64,
    pub item_id: String,
    #[serde(default = "default_image_target")]
    pub target: ImageTarget,
    #[serde(default = "default_provider")]
    pub provider: String,
    pub download_url: String,
    #[serde(default)]
    pub item_title: String,
}

fn default_image_target() -> ImageTarget {
    ImageTarget::Poster
}

fn default_provider() -> String {
    "posterdb".to_owned()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ApplyResult {
    pub ok: bool,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ApplyHistoryEntry {
    pub id: i64,
    pub server_id: i64,
    pub server_name: String,
    pub item_id: String,
    pub item_title: String,
    pub target: ImageTarget,
    pub provider: String,
    pub applied_at: String,
    pub thumb_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct HistorySettings {
    #[serde(default)]
    pub purge_days: i64,
    #[serde(default = "default_history_max_entries")]
    pub max_entries: i64,
}

const fn default_history_max_entries() -> i64 {
    50
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HistoryPurgeResult {
    pub purged: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct ArtworkItem {
    pub id: String,
    pub provider: String,
    #[serde(rename = "type")]
    pub artwork_type: String,
    pub kind: String,
    pub season_number: Option<i64>,
    pub title: Option<String>,
    pub lang: Option<String>,
    pub likes: Option<i64>,
    pub thumb_url: String,
    pub download_url: String,
    pub applyable: bool,
    pub source_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct ArtworkResults {
    pub provider: String,
    pub item_title: Option<String>,
    pub items: Vec<ArtworkItem>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct ArtworkSearchResult {
    pub id: String,
    pub name: String,
    pub year: Option<String>,
    pub thumb_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct ArtworkSearchResults {
    pub provider: String,
    pub results: Vec<ArtworkSearchResult>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ArtworkProviderInfo {
    pub name: String,
    pub label: String,
    pub configured: bool,
    pub needs_key: bool,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ArtworkSettings {
    pub fanart_configured: bool,
    pub tvdb_configured: bool,
    pub default_provider: String,
    pub enabled_providers: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct ArtworkSettingsUpdate {
    pub fanart_api_key: Option<String>,
    pub tvdb_api_key: Option<String>,
    pub tvdb_pin: Option<String>,
    pub default_provider: Option<String>,
    pub enabled_providers: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct ArtworkProviderTestRequest {
    pub provider: String,
    pub fanart_api_key: Option<String>,
    pub tvdb_api_key: Option<String>,
    pub tvdb_pin: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ArtworkProviderTestResult {
    pub ok: bool,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct ArtworkCacheSettings {
    #[serde(default = "default_artwork_cache_max_mb")]
    pub max_mb: i64,
    #[serde(default = "default_artwork_cache_ttl_days")]
    pub ttl_days: i64,
    #[serde(default)]
    pub watchdog_enabled: bool,
    #[serde(default = "default_watchdog_interval_hours")]
    pub watchdog_interval_hours: i64,
}

const fn default_artwork_cache_max_mb() -> i64 {
    250
}

const fn default_artwork_cache_ttl_days() -> i64 {
    30
}

const fn default_watchdog_interval_hours() -> i64 {
    24
}

impl Default for ArtworkCacheSettings {
    fn default() -> Self {
        Self {
            max_mb: default_artwork_cache_max_mb(),
            ttl_days: default_artwork_cache_ttl_days(),
            watchdog_enabled: false,
            watchdog_interval_hours: default_watchdog_interval_hours(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ArtworkCacheStatus {
    pub max_mb: i64,
    pub ttl_days: i64,
    pub used_bytes: u64,
    pub file_count: usize,
    pub watchdog_enabled: bool,
    pub watchdog_interval_hours: i64,
    pub watchdog_running: bool,
    pub watchdog_last_run: Option<String>,
    pub watchdog_last_message: Option<String>,
    pub watchdog_progress_current: usize,
    pub watchdog_progress_total: usize,
    pub watchdog_current_title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ArtworkCacheClearResult {
    pub cleared_bytes: u64,
    pub cleared_files: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ArtworkRefreshRequest {
    pub server_id: i64,
    pub item_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ArtworkRefreshResult {
    pub ok: bool,
    pub message: String,
    pub providers_warmed: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct PosterDbCredentials {
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub password: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PosterDbStatus {
    pub configured: bool,
    pub email: String,
    pub logged_in: bool,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct PosterAsset {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub season_number: Option<i64>,
    pub thumb_url: String,
    pub download_url: String,
    pub set_size: Option<i64>,
    pub set_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct PosterSet {
    pub set_url: String,
    pub title: Option<String>,
    pub posters: Vec<PosterAsset>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct PosterTitleResult {
    pub title: String,
    pub url: String,
    pub media_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct PosterCategory {
    pub name: String,
    pub count: usize,
    pub results: Vec<PosterTitleResult>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct PosterSearchResults {
    pub term: String,
    pub categories: Vec<PosterCategory>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct VerifyTitlesRequest {
    pub ids: Vec<String>,
}
