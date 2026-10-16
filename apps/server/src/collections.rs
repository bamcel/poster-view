//! Curated cross-library collections. Every projection applies viewer permissions.
use crate::{AppState, HttpError};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use posterview_contracts::{
    UserAccount, UserRole,
    collections::{Collection, CollectionMember, CollectionMemberRef, CollectionRecord},
    native::NativeCatalogEntry,
};
use posterview_infra_sqlite::{ServerStore, StoreError};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/collections", get(list).post(create))
        .route(
            "/api/collections/{id}",
            get(detail).put(update).delete(delete),
        )
        .route("/api/collections/{id}/members", post(add_members))
        .route(
            "/api/collections/preferences/{library}",
            get(preference).put(save_preference),
        )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    title: String,
    #[serde(default)]
    overview: String,
    ordering: String,
    members: Vec<CollectionMemberRef>,
    revision: Option<i64>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Addition {
    revision: i64,
    members: Vec<CollectionMemberRef>,
}
#[derive(Serialize)]
struct Added {
    collection: Collection,
    added: usize,
    existing: usize,
}
#[derive(Deserialize, Default)]
struct Scope {
    library_id: Option<String>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Preference {
    group_collections: bool,
}

fn error(error: StoreError) -> HttpError {
    match error {
        StoreError::Validation(detail) => HttpError::bad_request(detail),
        StoreError::RevisionConflict => HttpError {
            status: StatusCode::CONFLICT,
            detail: "Collection changed. Reload before saving.".into(),
        },
        error => {
            tracing::error!(%error, "Collection storage failed");
            HttpError {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                detail: "Unable to load or save collections.".into(),
            }
        }
    }
}
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, HttpError> + Send + 'static,
) -> Result<T, HttpError> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|_| HttpError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            detail: "Collection operation failed.".into(),
        })?
}
fn admin(state: &AppState, headers: &HeaderMap) -> Result<UserAccount, HttpError> {
    let user = state.auth.request_user(headers)?;
    if user.role != UserRole::Admin {
        return Err(HttpError {
            status: StatusCode::FORBIDDEN,
            detail: "Administrator access required.".into(),
        });
    }
    Ok(user)
}
fn library_allowed(user: &UserAccount, library: &str) -> bool {
    user.role == UserRole::Admin
        || user.permissions.all_libraries
        || user.permissions.library_ids.iter().any(|id| id == library)
}

struct Catalog {
    names: HashMap<String, String>,
    items: HashMap<(String, String), NativeCatalogEntry>,
}
impl Catalog {
    fn load(
        store: &ServerStore,
        user: &UserAccount,
        records: &[CollectionRecord],
    ) -> Result<Self, HttpError> {
        let needed: HashSet<_> = records
            .iter()
            .flat_map(|record| {
                record
                    .members
                    .iter()
                    .map(|member| member.library_id.as_str())
            })
            .collect();
        let mut result = Self {
            names: HashMap::new(),
            items: HashMap::new(),
        };
        for library in store.native_libraries().map_err(error)? {
            if !needed.contains(library.id.as_str()) || !library_allowed(user, &library.id) {
                continue;
            }
            let entries = store.native_catalog_summaries(&library.id).map_err(error)?;
            let allowed = crate::access::catalog_allowed(user, &entries);
            result.names.insert(library.id.clone(), library.name);
            for entry in entries {
                if matches!(entry.kind.as_str(), "movie" | "series")
                    && (user.role == UserRole::Admin || allowed.contains(&entry.id))
                {
                    result
                        .items
                        .insert((library.id.clone(), entry.id.clone()), entry);
                }
            }
        }
        Ok(result)
    }
    fn project(&self, record: CollectionRecord, user: &UserAccount) -> Option<Collection> {
        let total = record.members.len();
        let mut members: Vec<_> = record
            .members
            .into_iter()
            .filter_map(|member| {
                let entry = self
                    .items
                    .get(&(member.library_id.clone(), member.item_id.clone()))?
                    .clone();
                Some(CollectionMember {
                    library_name: self.names.get(&member.library_id)?.clone(),
                    library_id: member.library_id,
                    item_id: member.item_id,
                    entry,
                })
            })
            .collect();
        if members.is_empty() && user.role != UserRole::Admin {
            return None;
        }
        let overview = if members.len() == total {
            record.overview
        } else {
            String::new()
        };
        if record.ordering != "custom" {
            members.sort_by(|a, b| {
                let title = || {
                    sort_title(&a.entry)
                        .cmp(&sort_title(&b.entry))
                        .then_with(|| a.item_id.cmp(&b.item_id))
                        .then_with(|| a.library_id.cmp(&b.library_id))
                };
                if record.ordering == "release" {
                    release(&a.entry).cmp(&release(&b.entry)).then_with(title)
                } else {
                    title()
                }
            });
        }
        Some(Collection {
            id: record.id,
            title: record.title,
            overview,
            ordering: record.ordering,
            revision: record.revision,
            created_at: record.created_at,
            updated_at: record.updated_at,
            members,
        })
    }
}
fn sort_title(entry: &NativeCatalogEntry) -> String {
    entry
        .metadata
        .get("sorttitle")
        .and_then(serde_json::Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(&entry.title)
        .to_lowercase()
}
fn release(entry: &NativeCatalogEntry) -> String {
    for key in ["premiered", "release_date", "aired"] {
        if let Some(date) = entry.metadata.get(key).and_then(serde_json::Value::as_str) {
            if chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_ok() {
                return date.into();
            }
        }
    }
    let year = entry
        .metadata
        .get("year")
        .and_then(|value| value.as_i64().or_else(|| value.as_str()?.parse().ok()))
        .filter(|year| (1..=9999).contains(year));
    year.map(|year| format!("{year:04}-12-31"))
        .unwrap_or_else(|| "9999-12-31".into())
}
fn project_one(
    store: &ServerStore,
    user: &UserAccount,
    record: CollectionRecord,
) -> Result<Collection, HttpError> {
    Catalog::load(store, user, std::slice::from_ref(&record))?
        .project(record, user)
        .ok_or_else(HttpError::not_found)
}
async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(scope): Query<Scope>,
) -> Result<Json<Vec<Collection>>, HttpError> {
    let user = state.auth.request_user(&headers)?;
    let dir = state.runtime.data_dir().to_owned();
    Ok(Json(
        blocking(move || {
            let store = ServerStore::new(dir);
            let mut records = store.collections().map_err(error)?;
            // Library grids need only their own members, not every other library's summaries.
            if let Some(library) = &scope.library_id {
                for record in &mut records {
                    record
                        .members
                        .retain(|member| &member.library_id == library);
                    record.overview.clear();
                }
                records.retain(|record| !record.members.is_empty());
            }
            let catalog = Catalog::load(&store, &user, &records)?;
            let mut results: Vec<_> = records
                .into_iter()
                .filter_map(|record| catalog.project(record, &user))
                .collect();
            results
                .sort_by_key(|collection| (collection.title.to_lowercase(), collection.id.clone()));
            Ok(results)
        })
        .await?,
    ))
}
async fn detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Collection>, HttpError> {
    let user = state.auth.request_user(&headers)?;
    let dir = state.runtime.data_dir().to_owned();
    Ok(Json(
        blocking(move || {
            let store = ServerStore::new(dir);
            project_one(
                &store,
                &user,
                store
                    .collection(&id)
                    .map_err(error)?
                    .ok_or_else(HttpError::not_found)?,
            )
        })
        .await?,
    ))
}
async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<Input>,
) -> Result<(StatusCode, Json<Collection>), HttpError> {
    let user = admin(&state, &headers)?;
    let dir = state.runtime.data_dir().to_owned();
    let collection = blocking(move || {
        let store = ServerStore::new(dir);
        let record = store
            .create_collection(
                &input.title,
                &input.overview,
                &input.ordering,
                &input.members,
            )
            .map_err(error)?;
        project_one(&store, &user, record)
    })
    .await?;
    Ok((StatusCode::CREATED, Json(collection)))
}
async fn update(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<Input>,
) -> Result<Json<Collection>, HttpError> {
    let user = admin(&state, &headers)?;
    let revision = input
        .revision
        .ok_or_else(|| HttpError::bad_request("A collection revision is required."))?;
    let dir = state.runtime.data_dir().to_owned();
    Ok(Json(
        blocking(move || {
            let store = ServerStore::new(dir);
            let record = store
                .update_collection(
                    &id,
                    revision,
                    &input.title,
                    &input.overview,
                    &input.ordering,
                    &input.members,
                )
                .map_err(error)?
                .ok_or_else(HttpError::not_found)?;
            project_one(&store, &user, record)
        })
        .await?,
    ))
}
async fn add_members(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<Addition>,
) -> Result<Json<Added>, HttpError> {
    let user = admin(&state, &headers)?;
    let dir = state.runtime.data_dir().to_owned();
    Ok(Json(
        blocking(move || {
            let store = ServerStore::new(dir);
            let (record, added, existing) = store
                .add_collection_members(&id, input.revision, &input.members)
                .map_err(error)?
                .ok_or_else(HttpError::not_found)?;
            Ok(Added {
                collection: project_one(&store, &user, record)?,
                added,
                existing,
            })
        })
        .await?,
    ))
}
async fn delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<StatusCode, HttpError> {
    admin(&state, &headers)?;
    let dir = state.runtime.data_dir().to_owned();
    blocking(move || {
        if ServerStore::new(dir)
            .delete_collection(&id)
            .map_err(error)?
        {
            Ok(StatusCode::NO_CONTENT)
        } else {
            Err(HttpError::not_found())
        }
    })
    .await
}
fn preference_user(
    state: &AppState,
    headers: &HeaderMap,
    library: &str,
) -> Result<UserAccount, HttpError> {
    let user = state.auth.request_user(headers)?;
    if !library_allowed(&user, library) {
        return Err(HttpError::not_found());
    }
    Ok(user)
}
async fn preference(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(library): Path<String>,
) -> Result<Json<Preference>, HttpError> {
    let user = preference_user(&state, &headers, &library)?;
    let dir = state.runtime.data_dir().to_owned();
    Ok(Json(
        blocking(move || {
            let store = ServerStore::new(dir);
            if !store
                .native_libraries()
                .map_err(error)?
                .iter()
                .any(|item| item.id == library)
            {
                return Err(HttpError::not_found());
            }
            Ok(Preference {
                group_collections: store
                    .collection_grouping(&user.id, &library)
                    .map_err(error)?,
            })
        })
        .await?,
    ))
}
async fn save_preference(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(library): Path<String>,
    Json(input): Json<Preference>,
) -> Result<Json<Preference>, HttpError> {
    let user = preference_user(&state, &headers, &library)?;
    let dir = state.runtime.data_dir().to_owned();
    blocking(move || {
        let store = ServerStore::new(dir);
        if !store
            .native_libraries()
            .map_err(error)?
            .iter()
            .any(|item| item.id == library)
        {
            return Err(HttpError::not_found());
        }
        store
            .set_collection_grouping(&user.id, &library, input.group_collections)
            .map_err(error)?;
        Ok(Json(input))
    })
    .await
}

#[cfg(test)]
mod tests;
