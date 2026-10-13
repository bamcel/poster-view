use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeLibraryType {
    Movies,
    Shows,
    Anime,
    Books,
    Youtube,
}

impl NativeLibraryType {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Movies => "movies",
            Self::Shows => "shows",
            Self::Anime => "anime",
            Self::Books => "books",
            Self::Youtube => "youtube",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnimeContent {
    Both,
    Shows,
    Movies,
}

impl AnimeContent {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Both => "both",
            Self::Shows => "shows",
            Self::Movies => "movies",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeLibraryInput {
    pub name: String,
    pub library_type: NativeLibraryType,
    pub anime_content: AnimeContent,
    /// Paths relative to the configured media mount. Empty means the mount itself.
    pub paths: Vec<String>,
    pub revision: Option<i64>,
    #[serde(default)]
    pub options: NativeLibraryOptions,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeLibrary {
    pub id: String,
    pub name: String,
    pub library_type: NativeLibraryType,
    pub anime_content: AnimeContent,
    pub paths: Vec<String>,
    pub revision: i64,
    pub options: NativeLibraryOptions,
    pub created_at: String,
    pub updated_at: String,
}

impl NativeLibrary {
    pub fn allows_adult_metadata(&self) -> bool {
        self.library_type == NativeLibraryType::Books || self.options.allow_adult_metadata
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct NativeLibraryOptions {
    // Accept older stored options, but never expose or use the retired integration.
    #[serde(rename = "server_sync", skip_serializing)]
    pub legacy_server_sync: serde_json::Value,
    pub youtube_mode: String,
    pub youtube_channels: Vec<String>,
    pub read_nfo: bool,
    pub save_nfo: bool,
    pub local_artwork: bool,
    pub show_missing_files: bool,
    pub show_missing_specials: bool,
    pub save_artwork: bool,
    pub fetch_missing: bool,
    pub metadata_language: String,
    pub certification_country: String,
    pub image_language: String,
    pub prefer_embedded_titles: bool,
    pub real_time_monitor: bool,
    pub sample_ignore_mb: u32,
    pub allow_adult_metadata: bool,
    pub metadata_providers: std::collections::BTreeMap<String, Vec<String>>,
    pub image_providers: std::collections::BTreeMap<String, Vec<String>>,
    pub image_types: Vec<String>,
}
impl Default for NativeLibraryOptions {
    fn default() -> Self {
        Self {
            legacy_server_sync: serde_json::Value::Null,
            youtube_mode: "single_channel".into(),
            youtube_channels: Vec::new(),
            read_nfo: true,
            save_nfo: false,
            local_artwork: true,
            show_missing_files: true,
            show_missing_specials: false,
            save_artwork: false,
            fetch_missing: true,
            metadata_language: "en".into(),
            certification_country: "US".into(),
            image_language: "en".into(),
            prefer_embedded_titles: false,
            real_time_monitor: false,
            sample_ignore_mb: 300,
            allow_adult_metadata: false,
            metadata_providers: Default::default(),
            image_providers: Default::default(),
            image_types: ["poster", "backdrop", "thumb", "logo", "banner"]
                .into_iter()
                .map(String::from)
                .collect(),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeArtwork {
    pub kind: String,
    pub path: String,
    pub source: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeCatalogEntry {
    pub id: String,
    pub path: String,
    pub kind: String,
    pub parent_path: Option<String>,
    pub title: String,
    pub metadata: serde_json::Value,
    pub artwork: Vec<NativeArtwork>,
    pub files: Vec<serde_json::Value>,
    pub nfo_path: Option<String>,
    pub nfo_xml: Option<String>,
    pub available: bool,
    pub revision: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct NativeScanStatus {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<NativeScanProgress>,
    pub status: String,
    pub count: usize,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeScanProgress {
    pub phase: String,
    pub processed: usize,
    pub total: Option<usize>,
    pub current: String,
}

#[cfg(test)]
mod compatibility_tests {
    #[test]
    fn retired_sync_options_are_accepted_but_not_exposed() {
        let options: super::NativeLibraryOptions = serde_json::from_value(serde_json::json!({
            "server_sync":{"enabled":true,"mode":"two_way","server_id":1},
            "save_nfo":true,
        }))
        .unwrap();
        assert!(options.save_nfo);
        assert!(
            serde_json::to_value(&options)
                .unwrap()
                .get("server_sync")
                .is_none()
        );
        assert!(
            serde_json::from_value::<super::NativeLibraryOptions>(
                serde_json::json!({"unexpected_option":true})
            )
            .is_err()
        );
    }
}
