use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UserRole {
    Admin,
    User,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct UserPermissions {
    pub all_libraries: bool,
    pub library_ids: Vec<String>,
    pub max_movie_rating: Option<String>,
    pub max_tv_rating: Option<String>,
    pub allow_unrated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserAccount {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub role: UserRole,
    pub enabled: bool,
    pub permissions: UserPermissions,
    pub revision: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UserCreate {
    pub username: String,
    pub display_name: String,
    pub password: String,
    pub role: UserRole,
    #[serde(default = "enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub permissions: UserPermissions,
}
fn enabled() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UserUpdate {
    pub revision: i64,
    pub username: String,
    pub display_name: String,
    pub role: UserRole,
    pub enabled: bool,
    pub permissions: UserPermissions,
    pub password: Option<String>,
}
