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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeLibrary {
    pub id: String,
    pub name: String,
    pub library_type: NativeLibraryType,
    pub anime_content: AnimeContent,
    pub paths: Vec<String>,
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
}
