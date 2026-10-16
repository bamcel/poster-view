//! Curated collections reference native media without changing its library or path.
use crate::native::NativeCatalogEntry;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct CollectionMetadata {
    pub provider: String,
    pub provider_id: String,
    pub poster_url: String,
    pub backdrop_url: String,
    pub locks: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CollectionMemberRef {
    pub library_id: String,
    pub item_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionRecord {
    pub id: String,
    pub title: String,
    pub overview: String,
    pub ordering: String,
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
    pub members: Vec<CollectionMemberRef>,
    #[serde(default)]
    pub metadata: CollectionMetadata,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionMember {
    pub library_id: String,
    pub item_id: String,
    pub library_name: String,
    pub entry: NativeCatalogEntry,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Collection {
    pub id: String,
    pub title: String,
    pub overview: String,
    pub ordering: String,
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
    pub members: Vec<CollectionMember>,
    #[serde(default)]
    pub metadata: CollectionMetadata,
}
