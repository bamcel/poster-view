use std::{
    collections::HashSet,
    path::Path,
    sync::{Arc, RwLock},
};

use axum::{
    http::{HeaderMap, HeaderValue, header},
    response::{IntoResponse, Response},
};
use subtle::ConstantTimeEq;
use tracing::warn;

const COOKIE_NAME: &str = "posterview_session";

#[derive(Clone)]
pub struct AuthState {
    password: Option<Arc<str>>,
    sessions: Arc<RwLock<HashSet<String>>>,
    secure_cookie: bool,
}

impl AuthState {
    pub fn load(
        data_dir: &Path,
        configured_password: Option<&str>,
        secure_cookie: bool,
    ) -> std::io::Result<Self> {
        let password = if let Some(password) = configured_password {
            if password.trim().is_empty() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "POSTERVIEW_PASSWORD cannot be empty",
                ));
            }
            password.to_owned()
        } else {
            std::fs::create_dir_all(data_dir)?;
            let path = data_dir.join("admin-password.txt");
            if path.exists() {
                std::fs::read_to_string(path)?.trim().to_owned()
            } else {
                let password = format!(
                    "{}{}",
                    uuid::Uuid::new_v4().simple(),
                    uuid::Uuid::new_v4().simple()
                );
                std::fs::write(&path, format!("{password}\n"))?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
                }
                warn!(path = %path.display(), "Generated the PosterView administrator password; retrieve it from this file");
                password
            }
        };
        Ok(Self {
            password: Some(password.into()),
            sessions: Arc::new(RwLock::new(HashSet::new())),
            secure_cookie,
        })
    }

    #[cfg(test)]
    pub fn for_tests(password: &str) -> Self {
        Self {
            password: (!password.is_empty()).then(|| Arc::from(password.to_owned())),
            sessions: Arc::new(RwLock::new(HashSet::new())),
            secure_cookie: false,
        }
    }

    pub fn authenticated(&self, headers: &HeaderMap) -> bool {
        if self.password.is_none() {
            return true;
        }
        let Some(token) = cookie(headers, COOKIE_NAME) else {
            return false;
        };
        self.sessions
            .read()
            .is_ok_and(|sessions| sessions.contains(token))
    }

    pub fn login(&self, candidate: &str) -> Option<(String, HeaderValue)> {
        let password = self.password.as_deref()?;
        if password.as_bytes().ct_eq(candidate.as_bytes()).unwrap_u8() != 1 {
            return None;
        }
        let token = uuid::Uuid::new_v4().simple().to_string();
        self.sessions.write().ok()?.insert(token.clone());
        let secure = if self.secure_cookie { "; Secure" } else { "" };
        let value = HeaderValue::from_str(&format!(
            "{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Strict{secure}"
        ))
        .ok()?;
        Some((token, value))
    }

    pub fn logout(&self, headers: &HeaderMap) -> HeaderValue {
        if let Some(token) = cookie(headers, COOKIE_NAME)
            && let Ok(mut sessions) = self.sessions.write()
        {
            sessions.remove(token);
        }
        HeaderValue::from_static(
            "posterview_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
        )
    }
}

pub fn unauthorized() -> Response {
    (
        axum::http::StatusCode::UNAUTHORIZED,
        [(header::CONTENT_TYPE, "application/json")],
        r#"{"detail":"Authentication required."}"#,
    )
        .into_response()
}

fn cookie<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .filter_map(|part| part.trim().split_once('='))
        .find_map(|(key, value)| (key == name).then_some(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_run_password_is_persisted_and_reused() {
        let directory = tempfile::tempdir().unwrap();
        let first = AuthState::load(directory.path(), None, false).unwrap();
        let password =
            std::fs::read_to_string(directory.path().join("admin-password.txt")).unwrap();
        assert!(password.trim().len() >= 32);
        assert!(first.login(password.trim()).is_some());

        let second = AuthState::load(directory.path(), None, false).unwrap();
        assert!(second.login(password.trim()).is_some());
    }
}
