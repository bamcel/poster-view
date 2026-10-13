use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
    sync::{Arc, RwLock},
    time::{Duration, Instant},
};

use axum::{
    http::{HeaderMap, HeaderValue, header},
    response::{IntoResponse, Response},
};
use posterview_contracts::{UserAccount, UserPermissions, UserRole};
use posterview_infra_sqlite::ServerStore;
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use tracing::warn;

const COOKIE_NAME: &str = "posterview_session";

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SecuritySettings {
    pub idle_timeout_minutes: Option<u32>,
    pub local_network_bypass: bool,
    #[serde(default = "enabled_by_default")]
    pub login_backdrop_enabled: bool,
}

const fn enabled_by_default() -> bool {
    true
}

impl SecuritySettings {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self
            .idle_timeout_minutes
            .is_some_and(|minutes| !(1..=1440).contains(&minutes))
        {
            return Err("Inactivity timeout must be between 1 and 1440 minutes.");
        }
        Ok(())
    }
}

impl Default for SecuritySettings {
    fn default() -> Self {
        Self {
            idle_timeout_minutes: None,
            local_network_bypass: false,
            login_backdrop_enabled: true,
        }
    }
}

#[derive(Clone)]
pub struct AuthState {
    auth_enabled: bool,
    username: Arc<str>,
    password: Option<Arc<str>>,
    sessions: Arc<RwLock<HashMap<String, Instant>>>,
    identities: Arc<RwLock<HashMap<String, (String, i64)>>>,
    login_workers: Arc<tokio::sync::Semaphore>,
    data_dir: Option<PathBuf>,
    secure_cookie: bool,
    settings: Arc<RwLock<SecuritySettings>>,
    settings_path: Option<PathBuf>,
}

impl AuthState {
    pub fn load(
        data_dir: &Path,
        _configured_password: Option<&str>,
        username: &str,
        secure_cookie: bool,
    ) -> std::io::Result<Self> {
        if username.trim().is_empty() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Username cannot be empty",
            ));
        }
        std::fs::create_dir_all(data_dir)?;
        let settings_path = data_dir.join("security-settings.json");
        let settings: SecuritySettings = match std::fs::read(&settings_path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(std::io::Error::other)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                SecuritySettings::default()
            }
            Err(error) => return Err(error),
        };
        settings.validate().map_err(std::io::Error::other)?;
        let store = ServerStore::new(data_dir);
        store.initialize().map_err(std::io::Error::other)?;
        Ok(Self {
            identities: Default::default(),
            login_workers: Arc::new(tokio::sync::Semaphore::new(4)),
            data_dir: Some(data_dir.to_owned()),
            auth_enabled: true,
            username: username.trim().into(),
            password: Some(Arc::from("")),
            sessions: Arc::new(RwLock::new(HashMap::new())),
            secure_cookie,
            settings: Arc::new(RwLock::new(settings)),
            settings_path: Some(settings_path),
        })
    }

    #[cfg(test)]
    pub fn for_tests(password: &str) -> Self {
        Self {
            identities: Default::default(),
            login_workers: Arc::new(tokio::sync::Semaphore::new(4)),
            data_dir: None,
            auth_enabled: true,
            username: "admin".into(),
            password: (!password.is_empty()).then(|| Arc::from(password.to_owned())),
            sessions: Arc::new(RwLock::new(HashMap::new())),
            secure_cookie: false,
            settings: Arc::new(RwLock::new(SecuritySettings::default())),
            settings_path: None,
        }
    }

    pub fn authenticated(&self, headers: &HeaderMap) -> bool {
        self.authenticated_at(headers, Instant::now())
    }

    fn authenticated_at(&self, headers: &HeaderMap, now: Instant) -> bool {
        if (!self.auth_enabled || self.password.is_none()) && !self.individual_login_required() {
            return true;
        }
        let Some(token) = cookie(headers, COOKIE_NAME) else {
            return false;
        };
        let timeout = self.security_settings().idle_timeout_minutes;
        let Ok(mut sessions) = self.sessions.write() else {
            return false;
        };
        sessions.retain(|_, last_activity| !expired(*last_activity, timeout, now));
        sessions.contains_key(token) && self.session_user(token).is_some()
    }

    pub(crate) fn login_permit(&self) -> Option<tokio::sync::OwnedSemaphorePermit> {
        self.login_workers.clone().try_acquire_owned().ok()
    }

    pub(crate) fn data_dir(&self) -> Option<&Path> {
        self.data_dir.as_deref()
    }

    pub(crate) fn setup_required(&self) -> bool {
        self.data_dir.as_ref().is_some_and(|dir| {
            ServerStore::new(dir)
                .users()
                .map(|users| users.is_empty())
                .unwrap_or(false)
        })
    }

    // Once viewer accounts exist, signing out must never reveal administrator access.
    // Storage failures require login rather than silently restoring bypass privileges.
    fn individual_login_required(&self) -> bool {
        self.data_dir.as_ref().is_some_and(|dir| {
            ServerStore::new(dir)
                .users()
                .map(|users| {
                    users
                        .iter()
                        .any(|user| user.enabled && user.role == UserRole::User)
                })
                .unwrap_or(true)
        })
    }

    fn bootstrap(&self) -> Option<UserAccount> {
        if let Some(dir) = &self.data_dir {
            return ServerStore::new(dir)
                .users()
                .ok()?
                .into_iter()
                .find(|u| u.enabled && u.role == UserRole::Admin);
        }
        Some(UserAccount {
            id: self.username.to_string(),
            username: self.username.to_string(),
            display_name: self.username.to_string(),
            role: UserRole::Admin,
            enabled: true,
            permissions: UserPermissions {
                all_libraries: true,
                allow_unrated: true,
                ..Default::default()
            },
            revision: 1,
            created_at: String::new(),
        })
    }
    fn session_user(&self, token: &str) -> Option<UserAccount> {
        let identities = self.identities.read().ok()?;
        let (id, revision) = identities.get(token)?;
        let user = if let Some(dir) = &self.data_dir {
            ServerStore::new(dir).user(id).ok()??
        } else {
            self.bootstrap()?
        };
        (user.enabled && user.revision == *revision).then_some(user)
    }
    pub(crate) fn principal(
        &self,
        headers: &HeaderMap,
        peer: Option<SocketAddr>,
    ) -> Option<UserAccount> {
        if self.setup_required() {
            return None;
        }
        if cookie(headers, COOKIE_NAME).is_some() {
            if !self.authenticated(headers) {
                return None;
            }
            return self.session_user(cookie(headers, COOKIE_NAME)?);
        }
        if ((!self.auth_enabled || self.password.is_none()) && !self.individual_login_required())
            || self.local_bypass(peer)
        {
            self.bootstrap()
        } else {
            None
        }
    }
    pub(crate) fn request_user(
        &self,
        headers: &HeaderMap,
    ) -> Result<UserAccount, crate::HttpError> {
        if cookie(headers, COOKIE_NAME).is_some() {
            return self
                .principal(headers, None)
                .ok_or_else(|| crate::HttpError::unauthorized("Authentication required."));
        }
        // HTTP middleware already verified the peer for a configured local bypass.
        // Synthetic fixtures do not carry a persistent account database.
        if self.data_dir.is_some()
            && (self.individual_login_required()
                || (self.auth_enabled
                    && self.password.is_some()
                    && !self.security_settings().local_network_bypass))
        {
            return Err(crate::HttpError::unauthorized("Authentication required."));
        }
        self.bootstrap()
            .ok_or_else(|| crate::HttpError::unauthorized("Authentication required."))
    }

    pub fn security_settings(&self) -> SecuritySettings {
        self.settings
            .read()
            .expect("security settings lock poisoned")
            .clone()
    }

    pub fn with_authentication(mut self, enabled: bool) -> Self {
        self.auth_enabled = enabled;
        if !enabled {
            warn!(
                "Administrator login is disabled for admin-only installations; enabled viewer accounts still require individual login"
            );
        }
        self
    }

    pub fn password_required(&self, peer: Option<SocketAddr>) -> bool {
        self.setup_required()
            || self.individual_login_required()
            || (self.auth_enabled && !self.local_bypass(peer))
    }

    pub fn username(&self) -> &str {
        &self.username
    }

    pub fn set_security_settings(&self, settings: SecuritySettings) -> std::io::Result<()> {
        settings.validate().map_err(std::io::Error::other)?;
        let mut current = self
            .settings
            .write()
            .map_err(|_| std::io::Error::other("security settings lock poisoned"))?;
        if let Some(path) = &self.settings_path {
            let temp = path.with_extension("tmp");
            std::fs::write(&temp, serde_json::to_vec_pretty(&settings)?)?;
            std::fs::rename(&temp, path)?;
        }
        *current = settings;
        Ok(())
    }

    // Deliberately use the TCP peer, never client-controlled Forwarded headers.
    // A private reverse proxy therefore qualifies when this opt-in is enabled.
    pub fn local_bypass(&self, peer: Option<SocketAddr>) -> bool {
        self.security_settings().local_network_bypass
            && !self.setup_required()
            && !self.individual_login_required()
            && peer.is_some_and(|peer| is_local(peer.ip()))
    }

    pub fn activity(&self, headers: &HeaderMap) -> bool {
        self.activity_at(headers, Instant::now())
    }

    fn activity_at(&self, headers: &HeaderMap, now: Instant) -> bool {
        let timeout = self.security_settings().idle_timeout_minutes;
        let Some(token) = cookie(headers, COOKIE_NAME) else {
            return false;
        };
        let Ok(mut sessions) = self.sessions.write() else {
            return false;
        };
        sessions.retain(|_, last_activity| !expired(*last_activity, timeout, now));
        if let Some(last_activity) = sessions.get_mut(token) {
            *last_activity = now;
            return true;
        }
        false
    }

    pub fn login(&self, username: &str, candidate: &str) -> Option<(String, HeaderValue)> {
        if candidate.len() > 1024 {
            return None;
        }
        let user = if let Some(dir) = &self.data_dir {
            ServerStore::new(dir)
                .verify_user(username, candidate)
                .ok()??
        } else {
            let password = self.password.as_deref()?;
            let credentials_match = self.username.as_bytes().ct_eq(username.as_bytes())
                & password.as_bytes().ct_eq(candidate.as_bytes());
            if credentials_match.unwrap_u8() != 1 {
                return None;
            }
            self.bootstrap()?
        };
        let token = uuid::Uuid::new_v4().simple().to_string();
        let timeout = self.security_settings().idle_timeout_minutes;
        let mut sessions = self.sessions.write().ok()?;
        let now = Instant::now();
        sessions.retain(|_, last_activity| !expired(*last_activity, timeout, now));
        sessions.insert(token.clone(), now);
        self.identities
            .write()
            .ok()?
            .insert(token.clone(), (user.id, user.revision));
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
            if let Ok(mut identities) = self.identities.write() {
                identities.remove(token);
            }
        }
        HeaderValue::from_static(
            "posterview_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
        )
    }
}

fn expired(last_activity: Instant, timeout: Option<u32>, now: Instant) -> bool {
    timeout.is_some_and(|minutes| {
        now.duration_since(last_activity) >= Duration::from_secs(u64::from(minutes) * 60)
    })
}

fn is_local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => ip.is_private() || ip.is_loopback() || ip.is_link_local(),
        IpAddr::V6(ip) => ip
            .to_ipv4_mapped()
            .map(|ip| is_local(IpAddr::V4(ip)))
            .unwrap_or_else(|| {
                ip.is_loopback() || ip.is_unique_local() || ip.is_unicast_link_local()
            }),
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
    fn viewer_accounts_override_network_and_disabled_authentication_bypasses() {
        use posterview_contracts::UserCreate;
        let directory = tempfile::tempdir().unwrap();
        let auth = AuthState::load(directory.path(), Some("password"), "admin", false).unwrap();
        ServerStore::new(directory.path())
            .bootstrap_user("admin", "password")
            .unwrap();
        auth.set_security_settings(SecuritySettings {
            local_network_bypass: true,
            ..Default::default()
        })
        .unwrap();
        let peer = Some("192.168.1.2:1234".parse().unwrap());
        assert!(auth.principal(&HeaderMap::new(), peer).is_some());
        assert!(!auth.password_required(peer));
        let store = ServerStore::new(directory.path());
        let viewer = store
            .create_user(&UserCreate {
                username: "viewer".into(),
                display_name: "Viewer".into(),
                password: "password123".into(),
                role: UserRole::User,
                enabled: true,
                permissions: Default::default(),
            })
            .unwrap();
        assert!(!auth.local_bypass(peer));
        assert!(auth.password_required(peer));
        assert!(auth.principal(&HeaderMap::new(), peer).is_none());
        assert!(auth.request_user(&HeaderMap::new()).is_err());
        let disabled = auth.clone().with_authentication(false);
        assert!(disabled.password_required(peer));
        assert!(disabled.principal(&HeaderMap::new(), peer).is_none());
        let (_, cookie) = disabled.login("viewer", "password123").unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, cookie);
        assert_eq!(disabled.principal(&headers, peer).unwrap().id, viewer.id);
        store.delete_user(&viewer.id).unwrap();
        assert!(!disabled.password_required(peer));
        assert!(disabled.principal(&HeaderMap::new(), peer).is_some());
    }

    #[test]
    fn account_storage_errors_never_enable_network_bypass() {
        let directory = tempfile::tempdir().unwrap();
        let auth = AuthState::load(directory.path(), Some("password"), "admin", false).unwrap();
        ServerStore::new(directory.path())
            .bootstrap_user("admin", "password")
            .unwrap();
        auth.set_security_settings(SecuritySettings {
            local_network_bypass: true,
            ..Default::default()
        })
        .unwrap();
        let store = ServerStore::new(directory.path());
        // Missing account table models an unreadable/corrupt account database.
        rusqlite::Connection::open(directory.path().join("posterview.db"))
            .unwrap()
            .execute("DROP TABLE users", [])
            .unwrap();
        assert!(store.users().is_err());
        let peer = Some("192.168.1.2:1234".parse().unwrap());
        assert!(auth.password_required(peer));
        assert!(!auth.local_bypass(peer));
        assert!(auth.principal(&HeaderMap::new(), peer).is_none());
    }

    #[test]
    fn concurrent_password_checks_are_bounded_across_auth_clones() {
        let auth = AuthState::for_tests("password");
        let clone = auth.clone();
        let mut permits: Vec<_> = (0..4).map(|_| auth.login_permit().unwrap()).collect();
        assert!(clone.login_permit().is_none());
        drop(permits.pop());
        assert!(clone.login_permit().is_some());
        drop(permits);
        assert_eq!(auth.login_workers.available_permits(), 4);
    }

    #[test]
    fn users_have_distinct_sessions_and_edits_revoke_them_without_bypass() {
        use posterview_contracts::{UserCreate, UserUpdate};
        let directory = tempfile::tempdir().unwrap();
        let auth = AuthState::load(directory.path(), Some("password"), "admin", false).unwrap();
        ServerStore::new(directory.path())
            .bootstrap_user("admin", "password")
            .unwrap();
        let store = ServerStore::new(directory.path());
        let user = store
            .create_user(&UserCreate {
                username: "viewer".into(),
                display_name: "Viewer".into(),
                password: "password123".into(),
                role: UserRole::User,
                enabled: true,
                permissions: Default::default(),
            })
            .unwrap();
        auth.set_security_settings(SecuritySettings {
            local_network_bypass: true,
            ..Default::default()
        })
        .unwrap();
        let (_, admin_cookie) = auth.login("admin", "password").unwrap();
        let (_, user_cookie) = auth.login("viewer", "password123").unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, user_cookie);
        let peer = Some("192.168.1.2:1234".parse().unwrap());
        assert_eq!(auth.principal(&headers, peer).unwrap().role, UserRole::User);
        store
            .update_user(
                &user.id,
                &UserUpdate {
                    revision: user.revision,
                    username: user.username,
                    display_name: user.display_name,
                    role: UserRole::User,
                    enabled: false,
                    permissions: user.permissions,
                    password: None,
                },
            )
            .unwrap();
        assert!(auth.principal(&headers, peer).is_none());
        assert!(auth.request_user(&headers).is_err());
        headers.insert(header::COOKIE, admin_cookie);
        assert_eq!(
            auth.principal(&headers, peer).unwrap().role,
            UserRole::Admin
        );
        store.delete_user(&user.id).unwrap();
        assert!(auth.login("viewer", "password123").is_none());
    }

    #[test]
    fn login_requires_the_configured_username_and_password() {
        let directory = tempfile::tempdir().unwrap();
        let auth = AuthState::load(directory.path(), Some("password"), "curator", false).unwrap();
        ServerStore::new(directory.path())
            .bootstrap_user("curator", "password")
            .unwrap();
        assert!(auth.login("curator", "password").is_some());
        assert!(auth.login("admin", "password").is_none());
        assert!(auth.login("CURATOR", "password").is_some());
        assert!(auth.login("curator", "wrong").is_none());
        assert!(auth.login("", "password").is_none());
        assert!(AuthState::load(directory.path(), Some("password"), " ", false).is_err());
    }

    #[test]
    fn local_bypass_is_opt_in_and_uses_only_local_peers() {
        let auth = AuthState::for_tests("password");
        let lan = Some("192.168.1.5:1234".parse().unwrap());
        assert!(!auth.local_bypass(lan));
        auth.set_security_settings(SecuritySettings {
            local_network_bypass: true,
            idle_timeout_minutes: None,
            login_backdrop_enabled: true,
        })
        .unwrap();
        for address in [
            "192.168.1.5:1234",
            "10.0.0.2:80",
            "172.18.0.5:80",
            "127.0.0.1:80",
            "[::1]:80",
            "[fd00::1]:80",
            "[::ffff:192.168.1.5]:80",
        ] {
            assert!(
                auth.local_bypass(Some(address.parse().unwrap())),
                "{address}"
            );
        }
        for address in ["8.8.8.8:80", "100.64.0.2:80", "[2606:4700::1111]:80"] {
            assert!(
                !auth.local_bypass(Some(address.parse().unwrap())),
                "{address}"
            );
        }
        assert!(!auth.local_bypass(None));
    }

    #[test]
    fn inactivity_expires_sessions_but_background_checks_do_not_extend_them() {
        let auth = AuthState::for_tests("password");
        auth.set_security_settings(SecuritySettings {
            idle_timeout_minutes: Some(1),
            local_network_bypass: false,
            login_backdrop_enabled: true,
        })
        .unwrap();
        let (token, value) = auth.login("admin", "password").unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, value);
        let logged_in_at = auth.sessions.read().unwrap()[&token];
        let active_at = logged_in_at + Duration::from_secs(30);
        assert!(auth.authenticated_at(&headers, active_at));
        assert_eq!(auth.sessions.read().unwrap()[&token], logged_in_at);
        assert!(auth.activity_at(&headers, active_at));
        assert_eq!(auth.sessions.read().unwrap()[&token], active_at);
        assert!(auth.authenticated_at(&headers, active_at + Duration::from_secs(59)));
        assert_eq!(auth.sessions.read().unwrap()[&token], active_at);
        let expired_at = active_at + Duration::from_secs(60);
        assert!(!auth.activity_at(&headers, expired_at));
        assert!(!auth.authenticated_at(&headers, expired_at));
        assert!(!auth.sessions.read().unwrap().contains_key(&token));

        let (token, value) = auth.login("admin", "password").unwrap();
        headers.insert(header::COOKIE, value);
        let logged_in_at = auth.sessions.read().unwrap()[&token];
        assert!(!auth.authenticated_at(&headers, logged_in_at + Duration::from_secs(60)));
        assert!(!auth.sessions.read().unwrap().contains_key(&token));
    }

    #[test]
    fn disabled_timeout_keeps_sessions_until_logout() {
        let auth = AuthState::for_tests("password");
        let (token, value) = auth.login("admin", "password").unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, value);
        let logged_in_at = auth.sessions.read().unwrap()[&token];
        let next_day = logged_in_at + Duration::from_secs(86400);
        assert!(auth.authenticated_at(&headers, next_day));
        assert_eq!(auth.sessions.read().unwrap()[&token], logged_in_at);
        assert!(auth.activity_at(&headers, next_day));
        assert_eq!(auth.sessions.read().unwrap()[&token], next_day);
        auth.logout(&headers);
        assert!(!auth.authenticated_at(&headers, next_day));
    }

    #[test]
    fn security_settings_survive_restarts_and_reject_invalid_values() {
        let directory = tempfile::tempdir().unwrap();
        let auth = AuthState::load(directory.path(), Some("password"), "admin", false).unwrap();
        ServerStore::new(directory.path())
            .bootstrap_user("admin", "password")
            .unwrap();
        auth.set_security_settings(SecuritySettings {
            idle_timeout_minutes: Some(20),
            local_network_bypass: true,
            login_backdrop_enabled: true,
        })
        .unwrap();
        let reloaded = AuthState::load(directory.path(), Some("password"), "admin", false).unwrap();
        assert_eq!(reloaded.security_settings().idle_timeout_minutes, Some(20));
        assert!(reloaded.security_settings().local_network_bypass);
        for minutes in [0, 1441] {
            assert!(
                reloaded
                    .set_security_settings(SecuritySettings {
                        idle_timeout_minutes: Some(minutes),
                        local_network_bypass: false,
                        login_backdrop_enabled: true,
                    })
                    .is_err()
            );
        }
        reloaded
            .set_security_settings(SecuritySettings::default())
            .unwrap();
        let reset = AuthState::load(directory.path(), Some("password"), "admin", false).unwrap();
        assert!(!reset.local_bypass(Some("192.168.1.5:80".parse().unwrap())));
        assert!(reset.login("admin", "password").is_some());
    }

    #[test]
    fn first_run_requires_setup_without_generating_or_migrating_legacy_credentials() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(
            directory.path().join("admin-password.txt"),
            "legacy-password",
        )
        .unwrap();
        let auth = AuthState::load(
            directory.path(),
            Some("configured-password"),
            "admin",
            false,
        )
        .unwrap();
        assert!(auth.setup_required());
        assert!(auth.login("admin", "configured-password").is_none());
        auth.set_security_settings(SecuritySettings {
            local_network_bypass: true,
            ..Default::default()
        })
        .unwrap();
        let peer = Some("192.168.1.2:1234".parse().unwrap());
        assert!(auth.password_required(peer));
        assert!(auth.principal(&HeaderMap::new(), peer).is_none());
        assert!(
            auth.clone()
                .with_authentication(false)
                .principal(&HeaderMap::new(), peer)
                .is_none()
        );
        let fresh = tempfile::tempdir().unwrap();
        AuthState::load(fresh.path(), None, "admin", false).unwrap();
        assert!(!fresh.path().join("admin-password.txt").exists());
    }
}
