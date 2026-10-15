//! Server-side viewer permissions. UI visibility is never an authorization boundary.
use crate::{AppState, AuthState, HttpError};
use axum::{
    Json,
    body::to_bytes,
    extract::Request,
    http::{Method, StatusCode, header},
    response::{IntoResponse, Response},
};
use posterview_contracts::{UserAccount, UserRole, native::NativeCatalogEntry};
use posterview_infra_sqlite::ServerStore;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

fn denied() -> HttpError {
    HttpError {
        status: StatusCode::FORBIDDEN,
        detail: "You do not have access to this resource".into(),
    }
}
fn library_allowed(user: &UserAccount, library: &str) -> bool {
    user.role == UserRole::Admin
        || user.permissions.all_libraries
        || user.permissions.library_ids.iter().any(|id| id == library)
}
fn decode(segment: &str) -> Result<String, HttpError> {
    let mut result = Vec::new();
    let bytes = segment.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let pair = bytes.get(index + 1..index + 3).ok_or_else(denied)?;
            let hex = std::str::from_utf8(pair).map_err(|_| denied())?;
            result.push(u8::from_str_radix(hex, 16).map_err(|_| denied())?);
            index += 3;
        } else {
            result.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(result).map_err(|_| denied())
}
fn segments(path: &str) -> Result<Vec<String>, HttpError> {
    path.trim_start_matches('/')
        .split('/')
        .map(decode)
        .collect()
}
fn rating_age(rating: &str) -> Option<u8> {
    let normalized = rating.trim().to_ascii_uppercase().replace(' ', "");
    let normalized = normalized
        .strip_prefix("USA:")
        .or_else(|| normalized.strip_prefix("US:"))
        .unwrap_or(&normalized);
    match normalized {
        "G" | "TV-Y" | "TV-G" => Some(0),
        "PG" => Some(6),
        "TV-Y7" | "TV-Y7-FV" => Some(7),
        "TV-PG" => Some(10),
        "PG-13" => Some(13),
        "TV-14" => Some(14),
        "R" => Some(17),
        "NC-17" | "TV-MA" => Some(18),
        _ => None,
    }
}
fn permitted_rating(
    user: &UserAccount,
    item: &NativeCatalogEntry,
    ancestors: impl Iterator<Item = NativeCatalogEntry>,
) -> bool {
    let permissions = &user.permissions;
    let ceiling = match item.kind.as_str() {
        "series" | "season" | "episode" => {
            permissions.max_tv_rating.as_deref().and_then(rating_age)
        }
        "movie" => permissions.max_movie_rating.as_deref().and_then(rating_age),
        _ => [
            permissions.max_movie_rating.as_deref(),
            permissions.max_tv_rating.as_deref(),
        ]
        .into_iter()
        .flatten()
        .filter_map(rating_age)
        .min(),
    };
    let Some(ceiling) = ceiling else {
        return true;
    };
    let mut highest = None;
    for entry in std::iter::once(item.clone()).chain(ancestors) {
        let rating = ["mpaa", "content_rating", "certification"]
            .into_iter()
            .filter_map(|key| entry.metadata.get(key).and_then(Value::as_str))
            .filter_map(rating_age)
            .max();
        let rating = if entry.metadata.get("adult").and_then(Value::as_bool) == Some(true) {
            Some(18)
        } else {
            rating
        };
        highest = highest.into_iter().chain(rating).max();
    }
    highest.map_or(permissions.allow_unrated, |age| age <= ceiling)
}
fn item_allowed(
    store: &ServerStore,
    user: &UserAccount,
    library: &str,
    item: &str,
) -> Result<bool, HttpError> {
    if user.role == UserRole::Admin {
        return Ok(true);
    }
    if !library_allowed(user, library) {
        return Ok(false);
    }
    let Some(entry) = store
        .native_catalog_item(library, item)
        .map_err(|_| denied())?
    else {
        return Ok(false);
    };
    let mut ancestors = Vec::new();
    let mut path = entry.parent_path.clone();
    let mut visited = HashSet::new();
    while let Some(parent) = path {
        if !visited.insert(parent.clone()) {
            return Ok(false);
        }
        let Some(ancestor) = store
            .native_catalog_path(library, &parent)
            .map_err(|_| denied())?
        else {
            break;
        };
        path = ancestor.parent_path.clone();
        ancestors.push(ancestor);
    }
    if permitted_rating(user, &entry, ancestors.into_iter()) {
        return Ok(true);
    }
    // Keep unrated navigation containers when a descendant is permitted. The
    // descendant policy includes this container's rating, so a blocked parent
    // can never be reopened through a lower-rated child.
    if matches!(
        entry.kind.as_str(),
        "folder" | "series" | "season" | "book_series"
    ) {
        let catalog = store.native_catalog(library).map_err(|_| denied())?;
        return Ok(catalog_allowed(user, &catalog).contains(item));
    }
    Ok(false)
}

fn catalog_allowed(user: &UserAccount, catalog: &[NativeCatalogEntry]) -> HashSet<String> {
    let by_path: HashMap<_, _> = catalog
        .iter()
        .map(|entry| (entry.path.as_str(), entry))
        .collect();
    let mut allowed = HashSet::new();
    for entry in catalog {
        let mut path = entry.parent_path.as_deref();
        let mut ancestors = Vec::new();
        let mut seen = HashSet::new();
        let mut cycle = false;
        while let Some(parent) = path {
            if !seen.insert(parent) {
                cycle = true;
                break;
            }
            let Some(ancestor) = by_path.get(parent) else {
                break;
            };
            ancestors.push((*ancestor).clone());
            path = ancestor.parent_path.as_deref();
        }
        if !cycle && permitted_rating(user, entry, ancestors.clone().into_iter()) {
            allowed.insert(entry.id.clone());
            for ancestor in ancestors {
                if matches!(
                    ancestor.kind.as_str(),
                    "folder" | "series" | "season" | "book_series"
                ) {
                    allowed.insert(ancestor.id);
                }
            }
        }
    }
    allowed
}
pub(crate) fn require_item(
    state: &AppState,
    user: &UserAccount,
    library: &str,
    item: &str,
) -> Result<(), HttpError> {
    if item_allowed(
        &ServerStore::new(state.runtime.data_dir()),
        user,
        library,
        item,
    )? {
        Ok(())
    } else {
        Err(denied())
    }
}
pub(crate) fn allows_item(state: &AppState, user: &UserAccount, library: &str, item: &str) -> bool {
    require_item(state, user, library, item).is_ok()
}

pub(crate) fn authorize_request(
    auth: &AuthState,
    user: &UserAccount,
    request: &Request,
) -> Result<(), HttpError> {
    if user.role == UserRole::Admin {
        return Ok(());
    }
    let parts = segments(request.uri().path())?;
    let p: Vec<&str> = parts.iter().map(String::as_str).collect();
    let method = request.method();
    let get = *method == Method::GET;
    let personal_write = get || *method == Method::PUT;
    let allowed = match p.as_slice() {
        ["api", "auth", "activity"] => *method == Method::POST,
        ["api", "appearance", "settings"]
        | ["api", "plugins", "artwork"]
        | ["api", "transcoding", "settings"]
        | ["api", "playback", "capabilities"] => get,
        ["api", "library-display"] | ["api", "playback", "preferences"] => personal_write,
        ["api", "native", "libraries"] => get,
        [
            "api",
            "native",
            "libraries",
            library,
            "items" | "previews" | "scan",
        ] => get && library_allowed(user, library),
        [
            "api",
            "native",
            "libraries",
            library,
            "items",
            item,
            "artwork",
            _,
        ] => {
            get && item_allowed(
                &ServerStore::new(auth.data_dir().ok_or_else(denied)?),
                user,
                library,
                item,
            )?
        }
        ["api", "watch", "history" | "continue"] => get,
        ["api", "watch", "libraries", library, "rules"] => {
            personal_write && library_allowed(user, library)
        }
        ["api", "watch", "libraries", library, "states"] => get && library_allowed(user, library),
        ["api", "playback", "track-selections"] => *method == Method::DELETE,
        ["api", "watch", "native", _, _] => personal_write,
        ["api", "watch", "native", _, _, "series-tracks"] => personal_write,
        ["api", "watch", "native", _, _, "begin"] => *method == Method::POST,
        ["api", "watch", "native", _, _, "progress"] => *method == Method::PUT,
        ["api", "playback", "native", _, _] => get,
        ["api", "playback", "native", _, _, "sessions"] => *method == Method::POST,
        ["api", "playback", "native", _, _, "subtitles" | "fonts", _] => get,
        ["api", "playback", "sessions", _] => *method == Method::DELETE,
        ["api", "playback", "sessions", _, "seek" | "heartbeat"] => *method == Method::POST,
        ["api", "playback", "sessions", _, "stream"]
        | ["api", "playback", "sessions", _, "hls", _, _] => get,
        ["api", "reader", "native", _, _] => get,
        ["api", "reader", "books", _, "state"] => personal_write,
        ["api", "reader", "books", _] | ["api", "reader", "books", _, "file" | "entry"] => get, // Resource handlers check book ownership and item permissions.
        _ => false,
    };
    if allowed { Ok(()) } else { Err(denied()) }
}

pub(crate) async fn filter_response(
    auth: &AuthState,
    user: &UserAccount,
    path: &str,
    mut response: Response,
) -> Response {
    let artwork = segments(path).is_ok_and(|parts| {
        let parts: Vec<_> = parts.iter().map(String::as_str).collect();
        matches!(
            parts.as_slice(),
            ["api", "native", "libraries", _, "items", _, "artwork", _]
        )
    }) && matches!(response.status(), StatusCode::OK | StatusCode::NOT_MODIFIED);
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        if artwork {
            "private, no-cache, must-revalidate"
        } else {
            "private, no-store"
        }
        .parse()
        .expect("constant header"),
    );
    response
        .headers_mut()
        .append(header::VARY, "Cookie".parse().expect("constant header"));
    if !artwork {
        response.headers_mut().remove(header::ETAG);
        response.headers_mut().remove(header::LAST_MODIFIED);
    }
    if user.role == UserRole::Admin {
        return response;
    }
    if !response.status().is_success() {
        return response;
    }
    let Ok(parts) = segments(path) else {
        return denied().into_response();
    };
    let p: Vec<&str> = parts.iter().map(String::as_str).collect();
    let filter = matches!(
        p.as_slice(),
        ["api", "native", "libraries"]
            | [
                "api",
                "native",
                "libraries",
                _,
                "items" | "previews" | "scan"
            ]
            | ["api", "plugins", "artwork"]
    );
    if !filter {
        return response;
    }
    let (mut head, body) = response.into_parts();
    let Ok(bytes) = to_bytes(body, 64 * 1024 * 1024).await else {
        return denied().into_response();
    };
    let Ok(mut value) = serde_json::from_slice::<Value>(&bytes) else {
        return denied().into_response();
    };
    match p.as_slice() {
        ["api", "native", "libraries"] => {
            let Some(list) = value.as_array_mut() else {
                return denied().into_response();
            };
            list.retain(|v| {
                v.get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| library_allowed(user, id))
            });
        }
        ["api", "native", "libraries", library, "items" | "previews"] => {
            let Some(dir) = auth.data_dir() else {
                return denied().into_response();
            };
            let store = ServerStore::new(dir);
            let Ok(catalog) = store.native_catalog(library) else {
                return denied().into_response();
            };
            let allowed = catalog_allowed(user, &catalog);
            let Some(list) = value.as_array_mut() else {
                return denied().into_response();
            };
            list.retain(|v| {
                v.get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| allowed.contains(id))
            });
        }
        ["api", "native", "libraries", _, "scan"] => {
            value = serde_json::json!({"status": "idle", "count": 0, "warnings": [], "progress": null, "manual_queued": false, "show_progress": false, "artwork_revision": value.get("artwork_revision").cloned().unwrap_or(Value::Null)});
        }
        ["api", "plugins", "artwork"] => {
            let Some(settings) = value.as_object_mut() else {
                return denied().into_response();
            };
            for key in ["enabled", "poster_edit", "backdrop_edit"] {
                settings.insert(key.into(), Value::Bool(false));
            }
        }
        _ => unreachable!(),
    }
    head.headers.remove(header::CONTENT_LENGTH);
    head.headers.remove(header::ETAG);
    Response::from_parts(head, Json(value).into_response().into_body())
}

#[cfg(test)]
mod tests {
    use super::*;
    use posterview_contracts::UserPermissions;
    fn user() -> UserAccount {
        UserAccount {
            id: "child".into(),
            username: "child".into(),
            display_name: "Child".into(),
            role: UserRole::User,
            enabled: true,
            permissions: UserPermissions {
                max_movie_rating: Some("PG-13".into()),
                max_tv_rating: Some("TV-PG".into()),
                ..Default::default()
            },
            revision: 1,
            created_at: String::new(),
        }
    }
    fn item(kind: &str, metadata: Value) -> NativeCatalogEntry {
        NativeCatalogEntry {
            id: "a".into(),
            path: "a".into(),
            kind: kind.into(),
            parent_path: None,
            title: "A".into(),
            metadata,
            artwork: vec![],
            files: vec![],
            nfo_path: None,
            nfo_xml: None,
            available: true,
            revision: 1,
        }
    }
    #[test]
    fn ratings_use_certification_and_inherit_the_strictest_parent() {
        let user = user();
        assert!(permitted_rating(
            &user,
            &item("movie", serde_json::json!({"mpaa":"US:PG-13"})),
            std::iter::empty()
        ));
        assert!(!permitted_rating(
            &user,
            &item("movie", serde_json::json!({"rating": 4})),
            std::iter::empty()
        ));
        assert!(!permitted_rating(
            &user,
            &item("episode", serde_json::json!({"mpaa":"TV-Y"})),
            [item("series", serde_json::json!({"mpaa":"TV-MA"}))].into_iter()
        ));
        assert!(permitted_rating(
            &user,
            &item("episode", Value::Null),
            [item("series", serde_json::json!({"mpaa":"TV-PG"}))].into_iter()
        ));
    }
    #[test]
    fn unrated_policy_does_not_bypass_known_adult_ratings() {
        let mut user = user();
        user.permissions.allow_unrated = true;
        assert!(permitted_rating(
            &user,
            &item("movie", Value::Null),
            std::iter::empty()
        ));
        assert!(!permitted_rating(
            &user,
            &item("movie", serde_json::json!({"adult": true})),
            std::iter::empty()
        ));
        assert!(!permitted_rating(
            &user,
            &item("movie", serde_json::json!({"mpaa":"R"})),
            std::iter::empty()
        ));
    }
    #[test]
    fn allowed_children_keep_navigation_containers_but_not_restricted_siblings() {
        let user = user();
        let mut parent = item("series", Value::Null);
        parent.id = "series".into();
        parent.path = "Show".into();
        let mut child = item("episode", serde_json::json!({"mpaa": "TV-PG"}));
        child.id = "safe".into();
        child.path = "Show/safe".into();
        child.parent_path = Some("Show".into());
        let mut sibling = child.clone();
        sibling.id = "adult".into();
        sibling.path = "Show/adult".into();
        sibling.metadata = serde_json::json!({"mpaa": "TV-MA"});
        let permitted = catalog_allowed(&user, &[parent.clone(), child.clone(), sibling.clone()]);
        assert!(permitted.contains("series") && permitted.contains("safe"));
        assert!(!permitted.contains("adult"));
        parent.metadata = serde_json::json!({"mpaa":"TV-MA"});
        assert!(catalog_allowed(&user, &[parent, child, sibling]).is_empty());
    }
    #[test]
    fn viewer_can_clear_own_saved_track_selections() {
        let auth = AuthState::for_tests("");
        let user = user();
        let request = Request::builder()
            .method(Method::DELETE)
            .uri("/api/playback/track-selections")
            .body(axum::body::Body::empty())
            .unwrap();
        assert!(authorize_request(&auth, &user, &request).is_ok());
        let request = Request::builder()
            .method(Method::POST)
            .uri("/api/playback/track-selections")
            .body(axum::body::Body::empty())
            .unwrap();
        assert!(authorize_request(&auth, &user, &request).is_err());
    }
    #[test]
    fn viewer_can_manage_own_series_track_preferences() {
        let auth = AuthState::for_tests("");
        let user = user();
        for method in [Method::GET, Method::PUT] {
            let request = Request::builder()
                .method(method)
                .uri("/api/watch/native/library/episode/series-tracks")
                .body(axum::body::Body::empty())
                .unwrap();
            assert!(authorize_request(&auth, &user, &request).is_ok());
        }
        let request = Request::builder()
            .method(Method::DELETE)
            .uri("/api/watch/native/library/episode/series-tracks")
            .body(axum::body::Body::empty())
            .unwrap();
        assert!(authorize_request(&auth, &user, &request).is_err());
    }
    #[test]
    fn viewer_routes_are_default_deny_even_for_read_only_admin_apis() {
        let auth = AuthState::for_tests("");
        let user = user();
        for path in [
            "/api/users",
            "/api/security/settings",
            "/api/metadata/document",
            "/api/servers",
            "/api/new-admin-route",
        ] {
            assert!(
                authorize_request(
                    &auth,
                    &user,
                    &Request::builder()
                        .uri(path)
                        .body(axum::body::Body::empty())
                        .unwrap()
                )
                .is_err()
            );
        }
        assert!(
            authorize_request(
                &auth,
                &user,
                &Request::builder()
                    .uri("/api/watch/history")
                    .body(axum::body::Body::empty())
                    .unwrap()
            )
            .is_ok()
        );
        assert!(
            authorize_request(
                &auth,
                &user,
                &Request::builder()
                    .method(Method::PUT)
                    .uri("/api/appearance/settings")
                    .body(axum::body::Body::empty())
                    .unwrap()
            )
            .is_err()
        );
    }

    #[tokio::test]
    async fn admin_media_must_revalidate_across_account_switches() {
        let mut admin = user();
        admin.role = UserRole::Admin;
        let response = Response::builder()
            .header(header::CACHE_CONTROL, "public, max-age=3600")
            .header(header::ETAG, "old")
            .header(header::LAST_MODIFIED, "old")
            .body(axum::body::Body::empty())
            .unwrap();
        let response = filter_response(
            &AuthState::for_tests(""),
            &admin,
            "/api/native/libraries/a/items/b/artwork/poster",
            response,
        )
        .await;
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "private, no-cache, must-revalidate"
        );
        assert_eq!(response.headers()[header::ETAG], "old");
        assert_eq!(response.headers()[header::LAST_MODIFIED], "old");
        assert_eq!(response.headers()[header::VARY], "Cookie");
    }
    #[tokio::test]
    async fn failed_artwork_and_non_artwork_keep_no_store() {
        let mut admin = user();
        admin.role = UserRole::Admin;
        for (path, status) in [
            (
                "/api/native/libraries/a/items/b/artwork/poster",
                StatusCode::NOT_FOUND,
            ),
            ("/api/native/libraries/a/items", StatusCode::OK),
            ("/api/playback/native/a/b", StatusCode::OK),
        ] {
            let response = Response::builder()
                .status(status)
                .header(header::ETAG, "old")
                .header(header::LAST_MODIFIED, "old")
                .body(axum::body::Body::empty())
                .unwrap();
            let response = filter_response(&AuthState::for_tests(""), &admin, path, response).await;
            assert_eq!(
                response.headers()[header::CACHE_CONTROL],
                "private, no-store"
            );
            assert!(response.headers().get(header::ETAG).is_none());
            assert!(response.headers().get(header::LAST_MODIFIED).is_none());
        }
    }
    #[tokio::test]
    async fn router_filters_catalogs_and_rejects_direct_and_admin_access() {
        use posterview_contracts::{
            UserCreate,
            native::{AnimeContent, NativeLibraryInput, NativeLibraryType},
        };
        use tower::ServiceExt;
        let temp = tempfile::tempdir().unwrap();
        let mut state = crate::test_support::state(temp.path());
        let store = ServerStore::new(state.runtime.data_dir());
        state.auth = AuthState::load(
            state.runtime.data_dir(),
            Some("admin-password"),
            "admin",
            false,
        )
        .unwrap();
        store.bootstrap_user("admin", "admin-password").unwrap();
        let library = store
            .save_native_library(
                None,
                &NativeLibraryInput {
                    name: "Movies".into(),
                    library_type: NativeLibraryType::Movies,
                    anime_content: AnimeContent::Both,
                    paths: vec!["Movies".into()],
                    revision: None,
                    options: Default::default(),
                },
            )
            .unwrap();
        let hidden = store
            .save_native_library(
                None,
                &NativeLibraryInput {
                    name: "Private".into(),
                    library_type: NativeLibraryType::Movies,
                    anime_content: AnimeContent::Both,
                    paths: vec!["Private".into()],
                    revision: None,
                    options: Default::default(),
                },
            )
            .unwrap();
        let mut safe = item("movie", serde_json::json!({"mpaa": "PG"}));
        safe.id = "safe".into();
        safe.path = "Movies/safe.mkv".into();
        let mut adult = item("movie", serde_json::json!({"mpaa": "R"}));
        adult.id = "adult".into();
        adult.path = "Movies/adult.mkv".into();
        store
            .ingest_native_catalog(&library.id, library.revision, &[safe, adult])
            .unwrap();
        let safe_id = store
            .native_catalog_path(&library.id, "Movies/safe.mkv")
            .unwrap()
            .unwrap()
            .id;
        let adult_id = store
            .native_catalog_path(&library.id, "Movies/adult.mkv")
            .unwrap()
            .unwrap()
            .id;
        let mut image = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgba8(2, 2)
            .write_to(&mut image, image::ImageFormat::Png)
            .unwrap();
        let artwork_path = crate::native_provider::store_image(&state, image.get_ref()).unwrap();
        store
            .save_native_artwork(
                &library.id,
                &adult_id,
                &posterview_contracts::native::NativeArtwork {
                    kind: "poster".into(),
                    path: artwork_path,
                    source: "manual".into(),
                },
            )
            .unwrap();
        let mut permissions = user().permissions;
        permissions.library_ids = vec![library.id.clone()];
        store
            .create_user(&UserCreate {
                username: "viewer".into(),
                display_name: "Viewer".into(),
                password: "viewer-password".into(),
                role: UserRole::User,
                enabled: true,
                permissions,
            })
            .unwrap();
        let (_, cookie) = state.auth.login("viewer", "viewer-password").unwrap();
        let (_, admin_cookie) = state.auth.login("admin", "admin-password").unwrap();
        let app = crate::routes::system::public()
            .merge(crate::routes::protected(state.auth.clone()))
            .with_state(state);
        let artwork_url = format!(
            "/api/native/libraries/{}/items/{}/artwork/poster",
            library.id, adult_id
        );
        let cached = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(&artwork_url)
                    .header(header::COOKIE, &admin_cookie)
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(cached.status(), StatusCode::OK);
        assert_eq!(
            cached.headers()[header::CACHE_CONTROL],
            "private, no-cache, must-revalidate"
        );
        let tag = cached.headers()[header::ETAG].clone();
        assert!(
            !to_bytes(cached.into_body(), usize::MAX)
                .await
                .unwrap()
                .is_empty()
        );
        let unchanged = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(&artwork_url)
                    .header(header::COOKIE, &admin_cookie)
                    .header(header::IF_NONE_MATCH, &tag)
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unchanged.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(unchanged.headers()[header::ETAG], tag);
        assert_eq!(
            unchanged.headers()[header::CACHE_CONTROL],
            "private, no-cache, must-revalidate"
        );
        assert_eq!(unchanged.headers()[header::VARY], "Cookie");
        assert!(
            to_bytes(unchanged.into_body(), usize::MAX)
                .await
                .unwrap()
                .is_empty()
        );
        for (account, expected) in [
            (Some(cookie.to_str().unwrap()), StatusCode::FORBIDDEN),
            (None, StatusCode::UNAUTHORIZED),
        ] {
            let mut request = Request::builder()
                .uri(&artwork_url)
                .header(header::IF_NONE_MATCH, &tag);
            if let Some(account) = account {
                request = request.header(header::COOKIE, account);
            }
            let response = app
                .clone()
                .oneshot(request.body(axum::body::Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
            assert_eq!(
                response.headers()[header::CACHE_CONTROL],
                "private, no-store"
            );
            assert!(response.headers().get(header::ETAG).is_none());
        }
        for path in [
            "/api/users".to_owned(),
            format!(
                "/api/native/libraries/{}/items/{}/artwork/poster",
                library.id, adult_id
            ),
            format!("/api/native/libraries/{}/items", hidden.id),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(path)
                        .header(header::COOKIE, cookie.clone())
                        .body(axum::body::Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
        }
        for (path, expected) in [
            ("/api/native/libraries".to_owned(), library.id.as_str()),
            (
                format!("/api/native/libraries/{}/items", library.id),
                safe_id.as_str(),
            ),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(path)
                        .header(header::COOKIE, cookie.clone())
                        .body(axum::body::Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                response.headers()[header::CACHE_CONTROL],
                "private, no-store"
            );
            let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            let rows: Vec<Value> = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0]["id"], expected);
        }
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/playback/preferences")
                    .header(header::COOKIE, cookie)
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
}
