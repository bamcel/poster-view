use std::{net::SocketAddr, path::PathBuf};

#[derive(Debug, Clone)]
pub struct ServerConfig {
    pub bind: SocketAddr,
    pub data_dir: PathBuf,
    pub ui_dir: PathBuf,
    pub password: Option<String>,
    pub username: String,
    pub auth_enabled: bool,
    pub secure_cookies: bool,
}

impl ServerConfig {
    pub fn from_env() -> anyhow::Result<Self> {
        let bind = std::env::var("POSTERVIEW_BIND")
            .unwrap_or_else(|_| "0.0.0.0:7979".to_owned())
            .parse()?;
        let data_dir = std::env::var_os("POSTERVIEW_DATA_DIR")
            .map_or_else(|| PathBuf::from("data"), PathBuf::from);
        let ui_dir = std::env::var_os("POSTERVIEW_UI_DIR")
            .map_or_else(|| PathBuf::from("frontend/dist"), PathBuf::from);
        let password = std::env::var("POSTERVIEW_PASSWORD")
            .ok()
            .filter(|value| !value.trim().is_empty());
        let secure_cookies = std::env::var("POSTERVIEW_SECURE_COOKIES")
            .is_ok_and(|value| matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes"));
        let username = std::env::var("POSTERVIEW_USERNAME")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map_or_else(|| "admin".to_owned(), |value| value.trim().to_owned());
        Ok(Self {
            auth_enabled: match std::env::var("POSTERVIEW_AUTH_ENABLED") {
                Ok(value) => match value.trim().to_ascii_lowercase().as_str() {
                    "true" => true,
                    "false" => false,
                    _ => anyhow::bail!("POSTERVIEW_AUTH_ENABLED must be true or false"),
                },
                Err(std::env::VarError::NotPresent) => true,
                Err(error) => return Err(error.into()),
            },
            bind,
            data_dir,
            ui_dir,
            password,
            username,
            secure_cookies,
        })
    }
}
