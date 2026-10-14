use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UserRole {
    Admin,
    User,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct UserPermissions {
    pub all_libraries: bool,
    pub library_ids: Vec<String>,
    pub max_movie_rating: Option<String>,
    pub max_tv_rating: Option<String>,
    pub allow_unrated: bool,
    pub max_playback_streams: u32,
}
impl Default for UserPermissions {
    fn default() -> Self {
        Self {
            all_libraries: false,
            library_ids: Vec::new(),
            max_movie_rating: None,
            max_tv_rating: None,
            allow_unrated: false,
            max_playback_streams: 5,
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_permissions_default_to_five_streams_and_zero_stays_unlimited() {
        let legacy: UserPermissions = serde_json::from_str(r#"{"all_libraries":true}"#).unwrap();
        assert_eq!(legacy.max_playback_streams, 5);
        assert!(legacy.all_libraries);
        let unlimited: UserPermissions =
            serde_json::from_str(r#"{"max_playback_streams":0}"#).unwrap();
        assert_eq!(unlimited.max_playback_streams, 0);
    }
}
