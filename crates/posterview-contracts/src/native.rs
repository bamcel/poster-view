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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct NativeLibraryOptions {
    pub read_nfo: bool,
    pub save_nfo: bool,
    pub local_artwork: bool,
    pub fetch_missing: bool,
}
impl Default for NativeLibraryOptions {
    fn default() -> Self {
        Self {
            read_nfo: true,
            save_nfo: false,
            local_artwork: true,
            fetch_missing: true,
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
    pub status: String,
    pub count: usize,
    pub warnings: Vec<String>,
}
