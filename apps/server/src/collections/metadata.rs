//! Explicit administrator-selected collection metadata and exact native member matching.
use super::{MetadataCandidate, admin, blocking, error, project_one};
use crate::{AppState, HttpError};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::HeaderMap,
    routing::{get, post, put},
};
use posterview_contracts::{
    collections::{Collection, CollectionMember, CollectionMemberRef, CollectionMetadata},
    native::{NativeCatalogEntry, NativeLibraryType},
};
use posterview_infra_sqlite::{ServerStore, StoreError};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

const MAX_PROVIDER_MEMBERS: usize = 1000;
const MAX_MATCHES: usize = 1000;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/collections/metadata/search", get(search))
        .route("/api/collections/{id}/metadata/preview", post(preview))
        .route("/api/collections/{id}/metadata/apply", post(apply))
        .route("/api/collections/{id}/metadata/locks", put(locks))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Search {
    provider: String,
    query: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Selection {
    provider: String,
    provider_id: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Apply {
    revision: i64,
    provider: String,
    provider_id: String,
    locks: Vec<String>,
    #[serde(default)]
    add_members: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Locks {
    revision: i64,
    locks: Vec<String>,
}
#[derive(Serialize)]
struct Preview {
    metadata: MetadataCandidate,
    matches: Vec<CollectionMember>,
    unmatched: usize,
}

fn provider(value: &str) -> Result<(), HttpError> {
    if matches!(value, "tmdb" | "tvdb") {
        Ok(())
    } else {
        Err(HttpError::bad_request(
            "Choose TMDB or TVDB collection metadata.",
        ))
    }
}
fn numeric_id(value: &str) -> Option<String> {
    if value.is_empty() || value.len() > 19 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value
        .parse::<u64>()
        .ok()
        .filter(|id| *id > 0)
        .map(|id| id.to_string())
}
fn selection(provider_name: &str, id: &str) -> Result<(), HttpError> {
    provider(provider_name)?;
    numeric_id(id)
        .ok_or_else(|| HttpError::bad_request("Choose a valid provider collection ID."))?;
    Ok(())
}
fn valid_locks(values: &[String]) -> Result<(), HttpError> {
    if values.len() > 4
        || values
            .iter()
            .any(|field| !matches!(field.as_str(), "title" | "overview" | "poster" | "backdrop"))
        || values.iter().collect::<HashSet<_>>().len() != values.len()
    {
        return Err(HttpError::bad_request(
            "Metadata locks must be unique title, overview, poster or backdrop fields.",
        ));
    }
    Ok(())
}
fn valid_revision(revision: i64) -> Result<(), HttpError> {
    if revision < 1 {
        return Err(HttpError::bad_request(
            "A current collection revision is required.",
        ));
    }
    Ok(())
}
async fn require_collection(
    state: &AppState,
    id: &str,
    revision: Option<i64>,
) -> Result<(), HttpError> {
    if id.is_empty() || id.len() > 128 || id.chars().any(char::is_control) {
        return Err(HttpError::bad_request("Invalid collection ID."));
    }
    let directory = state.runtime.data_dir().to_owned();
    let id = id.to_owned();
    blocking(move || {
        let record = ServerStore::new(directory)
            .collection(&id)
            .map_err(error)?
            .ok_or_else(HttpError::not_found)?;
        if revision.is_some_and(|revision| revision != record.revision) {
            return Err(error(StoreError::RevisionConflict));
        }
        Ok(())
    })
    .await
}

async fn search(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(input): Query<Search>,
) -> Result<Json<Vec<MetadataCandidate>>, HttpError> {
    admin(&state, &headers)?;
    provider(&input.provider)?;
    let query = input.query.trim();
    if query.is_empty() || query.chars().count() > 200 || query.chars().any(char::is_control) {
        return Err(HttpError::bad_request(
            "Enter a collection name, slug or ID of 1–200 characters.",
        ));
    }
    Ok(Json(
        super::providers::search(&state, &input.provider, query).await?,
    ))
}

async fn preview(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<Selection>,
) -> Result<Json<Preview>, HttpError> {
    admin(&state, &headers)?;
    selection(&input.provider, &input.provider_id)?;
    require_collection(&state, &id, None).await?;
    let details = super::providers::details(&state, &input.provider, &input.provider_id).await?;
    let directory = state.runtime.data_dir().to_owned();
    let (matches, unmatched) = blocking(move || {
        match_native(
            &ServerStore::new(directory),
            &input.provider,
            &details.members,
        )
    })
    .await?;
    Ok(Json(Preview {
        metadata: details.metadata,
        matches,
        unmatched,
    }))
}

async fn apply(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<Apply>,
) -> Result<Json<Collection>, HttpError> {
    let user = admin(&state, &headers)?;
    selection(&input.provider, &input.provider_id)?;
    valid_revision(input.revision)?;
    valid_locks(&input.locks)?;
    require_collection(&state, &id, Some(input.revision)).await?;
    let record = crate::jobs::enqueue(
        &state,
        posterview_contracts::jobs::BackgroundJobSpec {
            kind: "collection_metadata".into(),
            title: "Collection metadata".into(),
            resource_key: format!("collection:{id}"),
            dedupe_key: uuid::Uuid::new_v4().to_string(),
            payload: serde_json::json!({"collection_id":id,"input":input}),
            max_attempts: 3,
        },
    )
    .await?;
    crate::jobs::wait(&state, &record.id).await?;
    let directory = state.runtime.data_dir().to_owned();
    blocking(move || {
        let store = ServerStore::new(directory);
        let record = store
            .collection(&id)
            .map_err(error)?
            .ok_or_else(HttpError::not_found)?;
        project_one(&store, &user, record).map(Json)
    })
    .await
}

pub(crate) async fn execute_background_job(
    state: AppState,
    context: crate::jobs::JobContext,
) -> Result<serde_json::Value, HttpError> {
    context.check()?;
    let id = context.record.payload["collection_id"]
        .as_str()
        .ok_or_else(|| HttpError::bad_request("Invalid collection task."))?
        .to_owned();
    let input: Apply = serde_json::from_value(context.record.payload["input"].clone())
        .map_err(|_| HttpError::bad_request("Invalid collection task."))?;
    selection(&input.provider, &input.provider_id)?;
    valid_revision(input.revision)?;
    valid_locks(&input.locks)?;
    if let Some(receipt) = context
        .record
        .result
        .as_ref()
        .filter(|receipt| receipt["applied_collection_id"].as_str() == Some(id.as_str()))
    {
        return Ok(receipt.clone());
    }
    require_collection(&state, &id, Some(input.revision)).await?;
    context.check()?;
    // Refetch the chosen provider record; never trust client-supplied metadata or memberships.
    let details = super::providers::details(&state, &input.provider, &input.provider_id).await?;
    let directory = state.runtime.data_dir().to_owned();
    blocking(move || {
        let store = ServerStore::new(directory);
        let members = if input.add_members {
            match_native(&store, &input.provider, &details.members)?
                .0
                .into_iter()
                .map(|member| CollectionMemberRef {
                    library_id: member.library_id,
                    item_id: member.item_id,
                })
                .collect()
        } else {
            Vec::new()
        };
        let metadata = CollectionMetadata {
            provider: details.metadata.provider,
            provider_id: details.metadata.provider_id,
            poster_url: details.metadata.poster_url,
            backdrop_url: details.metadata.backdrop_url,
            locks: input.locks.clone(),
        };
        context.check()?;
        let update = posterview_contracts::collections::CollectionMetadataUpdate {
            id: id.clone(),
            revision: input.revision,
            metadata,
            title: details.metadata.title,
            overview: details.metadata.overview,
            locks: input.locks,
            members,
        };
        let lease = context
            .record
            .lease
            .as_deref()
            .ok_or_else(|| HttpError::bad_request("Invalid collection task lease."))?;
        let record = store
            .apply_collection_metadata_for_job(&context.record.id, lease, &update)
            .map_err(error)?
            .ok_or_else(HttpError::not_found)?;
        Ok(serde_json::json!({"applied_collection_id":record.id,"revision":record.revision}))
    })
    .await
}
async fn locks(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<Locks>,
) -> Result<Json<Collection>, HttpError> {
    let user = admin(&state, &headers)?;
    valid_revision(input.revision)?;
    valid_locks(&input.locks)?;
    require_collection(&state, &id, Some(input.revision)).await?;
    let directory = state.runtime.data_dir().to_owned();
    blocking(move || {
        let store = ServerStore::new(directory);
        let record = store
            .save_collection_metadata_locks(&id, input.revision, &input.locks)
            .map_err(error)?
            .ok_or_else(HttpError::not_found)?;
        project_one(&store, &user, record).map(Json)
    })
    .await
}

fn available_match(entry: &NativeCatalogEntry, provider: &str, kind: &str, id: &str) -> bool {
    let value = &entry.metadata["identifiers"][provider];
    let native_id = value
        .as_str()
        .and_then(numeric_id)
        .or_else(|| value.as_u64().filter(|id| *id > 0).map(|id| id.to_string()));
    entry.available
        && matches!(entry.kind.as_str(), "movie" | "series")
        && entry.kind == kind
        && entry.metadata["missing"] != true
        && native_id.as_deref() == numeric_id(id).as_deref()
        && native_id.is_some()
}
fn match_native(
    store: &ServerStore,
    provider: &str,
    requested: &[super::providers::ProviderMember],
) -> Result<(Vec<CollectionMember>, usize), HttpError> {
    if requested.len() > MAX_PROVIDER_MEMBERS {
        return Err(HttpError::bad_gateway(
            "The provider collection contains too many members.",
        ));
    }
    let mut libraries = store.native_libraries().map_err(error)?;
    libraries.retain(|library| {
        matches!(
            library.library_type,
            NativeLibraryType::Movies
                | NativeLibraryType::Shows
                | NativeLibraryType::Anime
                | NativeLibraryType::Mixed
        )
    });
    libraries.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then_with(|| left.id.cmp(&right.id))
    });
    let mut native = Vec::new();
    for library in libraries {
        for entry in store.native_catalog_summaries(&library.id).map_err(error)? {
            if matches!(entry.kind.as_str(), "movie" | "series")
                && entry.available
                && entry.metadata["missing"] != true
            {
                native.push(CollectionMember {
                    library_id: library.id.clone(),
                    library_name: library.name.clone(),
                    item_id: entry.id.clone(),
                    entry,
                });
            }
        }
    }
    let mut seen_requested = HashSet::new();
    let mut seen_native = HashSet::new();
    let mut matches = Vec::new();
    let mut unmatched = 0;
    for member in requested {
        let Some(id) = numeric_id(&member.provider_id) else {
            return Err(HttpError::bad_gateway(
                "The provider returned an invalid member ID.",
            ));
        };
        if !matches!(member.kind.as_str(), "movie" | "series") {
            return Err(HttpError::bad_gateway(
                "The provider returned an unsupported member type.",
            ));
        }
        if !seen_requested.insert((member.kind.clone(), id.clone())) {
            continue;
        }
        let mut found = false;
        for candidate in &native {
            if available_match(&candidate.entry, provider, &member.kind, &id) {
                found = true;
                if seen_native.insert((candidate.library_id.clone(), candidate.item_id.clone())) {
                    matches.push(candidate.clone());
                }
                if matches.len() > MAX_MATCHES {
                    return Err(HttpError::bad_request(
                        "Too many matching local titles. Add members manually.",
                    ));
                }
            }
        }
        if !found {
            unmatched += 1;
        }
    }
    Ok((matches, unmatched))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, StatusCode, header},
    };
    use posterview_contracts::{
        UserCreate, UserPermissions, UserRole,
        native::{AnimeContent, NativeLibraryInput},
    };
    use serde_json::{Value, json};
    use tower::ServiceExt;

    fn task_context(collection_id: &str, revision: i64) -> crate::jobs::JobContext {
        crate::jobs::JobContext {
            record: posterview_contracts::jobs::BackgroundJobRecord {
                id: "test-task".into(),
                kind: "collection_metadata".into(),
                title: "Collection metadata".into(),
                resource_key: format!("collection:{collection_id}"),
                dedupe_key: "test-task".into(),
                payload: json!({"collection_id":collection_id,"input":{"provider":"tmdb","provider_id":"42","revision":revision,"locks":[],"add_members":false}}),
                status: "running".into(),
                attempt: 1,
                max_attempts: 3,
                available_at: 0,
                created_at: 0,
                updated_at: 0,
                error: None,
                result: None,
                lease: Some("test-lease".into()),
                checkpoint_count: 0,
            },
            cancelled: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    #[tokio::test]
    async fn recovered_apply_receipt_skips_stale_revision_and_provider_fetch() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        let mut context = task_context("already-applied", 1);
        let receipt = json!({"applied_collection_id":"already-applied","revision":2});
        context.record.result = Some(receipt.clone());
        assert_eq!(
            execute_background_job(state, context).await.unwrap(),
            receipt
        );
    }

    #[tokio::test]
    async fn worker_checks_cancellation_and_revision_before_provider_fetch() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        let store = ServerStore::new(state.runtime.data_dir());
        let collection = store
            .create_collection("Local collection", "", "release", &[])
            .unwrap();
        let context = task_context(&collection.id, 99);
        assert_eq!(
            execute_background_job(state.clone(), context)
                .await
                .unwrap_err()
                .status,
            StatusCode::CONFLICT
        );
        let context = task_context(&collection.id, 1);
        context
            .cancelled
            .store(true, std::sync::atomic::Ordering::Release);
        assert_eq!(
            execute_background_job(state, context)
                .await
                .unwrap_err()
                .status,
            StatusCode::CONFLICT
        );
        assert_eq!(
            store.collection(&collection.id).unwrap().unwrap().revision,
            1
        );
    }

    fn entry(path: &str, kind: &str, id: Value) -> NativeCatalogEntry {
        NativeCatalogEntry {
            id: String::new(),
            path: path.into(),
            kind: kind.into(),
            parent_path: None,
            title: "Same title is not sufficient".into(),
            metadata: json!({"identifiers":{"tmdb":id}}),
            artwork: vec![],
            files: vec![],
            nfo_path: None,
            nfo_xml: None,
            available: true,
            revision: 1,
        }
    }
    fn member(kind: &str, id: &str) -> super::super::providers::ProviderMember {
        super::super::providers::ProviderMember {
            kind: kind.into(),
            provider_id: id.into(),
        }
    }
    #[test]
    fn matching_requires_exact_kind_provider_and_positive_id() {
        let mut local = entry("Movies/Film", "movie", json!(42));
        assert!(available_match(&local, "tmdb", "movie", "42"));
        assert!(available_match(&local, "tmdb", "movie", "00042"));
        assert!(!available_match(&local, "tmdb", "series", "42"));
        assert!(!available_match(&local, "tvdb", "movie", "42"));
        assert!(!available_match(&local, "tmdb", "movie", "43"));
        local.metadata["identifiers"]["tmdb"] = json!("https://example.com/42");
        assert!(!available_match(&local, "tmdb", "movie", "42"));
        local.metadata["identifiers"]["tmdb"] = json!("42");
        local.metadata["missing"] = json!(true);
        assert!(!available_match(&local, "tmdb", "movie", "42"));
        local.metadata["missing"] = json!(false);
        local.available = false;
        assert!(!available_match(&local, "tmdb", "movie", "42"));
    }
    #[test]
    fn catalog_matching_deduplicates_and_never_creates_missing_titles() {
        let temp = tempfile::tempdir().unwrap();
        let store = ServerStore::new(temp.path());
        store.initialize().unwrap();
        let library = store
            .save_native_library(
                None,
                &NativeLibraryInput {
                    name: "Movies".into(),
                    library_type: NativeLibraryType::Movies,
                    anime_content: AnimeContent::Both,
                    paths: vec!["Movies".into()],
                    options: Default::default(),
                    revision: None,
                },
            )
            .unwrap();
        let mut missing = entry("Movies/Missing", "movie", json!(44));
        missing.metadata["missing"] = json!(true);
        store
            .ingest_native_catalog(
                &library.id,
                library.revision,
                &[
                    entry("Movies/One", "movie", json!(42)),
                    entry("Movies/WrongKind", "series", json!(43)),
                    missing,
                ],
            )
            .unwrap();
        let requested = [
            member("movie", "42"),
            member("movie", "42"),
            member("movie", "43"),
            member("movie", "44"),
            member("movie", "45"),
        ];
        let (matches, unmatched) = match_native(&store, "tmdb", &requested).unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(unmatched, 3);
        assert_eq!(matches[0].entry.path, "Movies/One");
        assert_eq!(matches[0].library_id, library.id);
        assert_eq!(store.native_catalog(&library.id).unwrap().len(), 3);
        assert!(match_native(&store, "tmdb", &[member("episode", "42")]).is_err());
        assert!(match_native(&store, "tmdb", &[member("movie", "../42")]).is_err());
    }
    #[test]
    fn inputs_and_locks_are_bounded_and_strict() {
        for value in [
            "",
            "0",
            "-1",
            "1?other=2",
            "../42",
            "https://example.com",
            "18446744073709551615",
        ] {
            assert!(selection("tmdb", value).is_err());
        }
        assert!(selection("unsupported", "42").is_err());
        assert!(valid_revision(0).is_err());
        assert!(valid_locks(&["title".into(), "title".into()]).is_err());
        assert!(valid_locks(&["provider".into()]).is_err());
        assert!(
            valid_locks(&[
                "title".into(),
                "overview".into(),
                "poster".into(),
                "backdrop".into()
            ])
            .is_ok()
        );
        assert!(serde_json::from_value::<Apply>(json!({"provider":"tmdb","provider_id":"42","revision":1,"locks":[],"title":"forged"})).is_err());
    }
    #[tokio::test]
    async fn endpoints_require_admin_and_reject_bad_or_stale_requests_before_fetching() {
        let temp = tempfile::tempdir().unwrap();
        let mut state = crate::test_support::state(temp.path());
        let store = ServerStore::new(state.runtime.data_dir());
        store.bootstrap_user("admin", "admin-password").unwrap();
        store
            .create_user(&UserCreate {
                username: "viewer".into(),
                display_name: "Viewer".into(),
                password: "viewer-password".into(),
                role: UserRole::User,
                enabled: true,
                permissions: UserPermissions::default(),
            })
            .unwrap();
        state.auth =
            crate::AuthState::load(state.runtime.data_dir(), None, "admin", false).unwrap();
        let (_, admin_cookie) = state.auth.login("admin", "admin-password").unwrap();
        let (_, viewer_cookie) = state.auth.login("viewer", "viewer-password").unwrap();
        let admin_cookie = admin_cookie.to_str().unwrap();
        let viewer_cookie = viewer_cookie.to_str().unwrap();
        let collection = store
            .create_collection("Local collection", "", "release", &[])
            .unwrap();
        let app = routes().with_state(state);
        let request = |method: &str, url: &str, body: Value, cookie: &str| {
            Request::builder()
                .method(method)
                .uri(url)
                .header(header::COOKIE, cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap()
        };
        let endpoints = [
            (
                "GET",
                "/api/collections/metadata/search?provider=tmdb&query=Example".to_string(),
                Value::Null,
            ),
            (
                "POST",
                format!("/api/collections/{}/metadata/preview", collection.id),
                json!({"provider":"tmdb","provider_id":"42"}),
            ),
            (
                "POST",
                format!("/api/collections/{}/metadata/apply", collection.id),
                json!({"provider":"tmdb","provider_id":"42","revision":1,"locks":[],"add_members":true}),
            ),
            (
                "PUT",
                format!("/api/collections/{}/metadata/locks", collection.id),
                json!({"revision":1,"locks":[]}),
            ),
        ];
        for (method, url, body) in endpoints {
            assert_eq!(
                app.clone()
                    .oneshot(request(method, &url, body.clone(), viewer_cookie))
                    .await
                    .unwrap()
                    .status(),
                StatusCode::FORBIDDEN
            );
            assert_eq!(
                app.clone()
                    .oneshot(request(method, &url, body, "posterview_session=invalid"))
                    .await
                    .unwrap()
                    .status(),
                StatusCode::UNAUTHORIZED
            );
        }
        let preview = format!("/api/collections/{}/metadata/preview", collection.id);
        assert_eq!(
            app.clone()
                .oneshot(request(
                    "POST",
                    &preview,
                    json!({"provider":"tmdb","provider_id":"../42"}),
                    admin_cookie
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            app.clone()
                .oneshot(request(
                    "POST",
                    "/api/collections/nonexistent/metadata/preview",
                    json!({"provider":"tmdb","provider_id":"42"}),
                    admin_cookie
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        let apply = format!("/api/collections/{}/metadata/apply", collection.id);
        assert_eq!(
            app.clone()
                .oneshot(request(
                    "POST",
                    &apply,
                    json!({"provider":"tmdb","provider_id":"42","revision":99,"locks":[]}),
                    admin_cookie
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::CONFLICT
        );
        let locks = format!("/api/collections/{}/metadata/locks", collection.id);
        assert_eq!(
            app.oneshot(request(
                "PUT",
                &locks,
                json!({"revision":1,"locks":["provider"]}),
                admin_cookie
            ))
            .await
            .unwrap()
            .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            store.collection(&collection.id).unwrap().unwrap().revision,
            1
        );
    }
}
