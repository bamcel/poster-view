use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeLibraryType {
    Movies,
    Shows,
    Anime,
    Books,
}

impl NativeLibraryType {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Movies => "movies",
            Self::Shows => "shows",
            Self::Anime => "anime",
            Self::Books => "books",
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
    pub server_sync: NativeServerSync,
    pub read_nfo: bool,
    pub save_nfo: bool,
    pub local_artwork: bool,
    pub show_missing_files: bool,
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
            server_sync: NativeServerSync::default(),
            read_nfo: true,
            save_nfo: false,
            local_artwork: true,
            show_missing_files: true,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct NativeServerSync {
    pub enabled: bool,
    pub mode: String,
    #[serde(default="sync_all_servers")]
    pub push_to_all: bool,
    pub push_server_ids: Vec<i64>,
    pub server_id: Option<i64>,
    pub library_id: String,
    pub override_locked: bool,
    pub write_nfo: bool,
}

fn sync_all_servers()->bool{true}

impl Default for NativeServerSync {fn default()->Self{Self{enabled:false,mode:"two_way".into(),push_to_all:true,push_server_ids:Vec::new(),server_id:None,library_id:String::new(),override_locked:false,write_nfo:false}}}
