//! Personal library rankings. Every request rechecks library and title access.
use crate::{AppState, HttpError};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use posterview_contracts::{
    UserAccount, UserRole,
    native::{NativeCatalogEntry, NativeLibraryType},
    pairwise::*,
};
use posterview_infra_sqlite::ServerStore;
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

mod model;
#[cfg(test)]
mod tests;

const KEY: &str = "plugin-pairwise";
pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/plugins/pairwise", get(settings).put(save_settings))
        .route("/api/rankings/libraries", get(libraries))
        .route("/api/rankings/{library}", get(detail))
        .route("/api/rankings/{library}/actions", post(action))
}
fn problem(status: StatusCode, detail: &str) -> HttpError {
    HttpError {
        status,
        detail: detail.into(),
    }
}
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, HttpError> + Send + 'static,
) -> Result<T, HttpError> {
    tokio::task::spawn_blocking(f).await.map_err(|_| {
        problem(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Ranking operation failed.",
        )
    })?
}
fn configuration(store: &ServerStore) -> Result<PairwiseSettings, HttpError> {
    let raw = store.get_setting(KEY)?;
    if raw.is_empty() {
        Ok(PairwiseSettings::default())
    } else {
        serde_json::from_str(&raw).map_err(|_| {
            problem(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Unable to load ranking settings.",
            )
        })
    }
}
fn enabled(store: &ServerStore) -> Result<(), HttpError> {
    if configuration(store)?.enabled {
        Ok(())
    } else {
        Err(problem(
            StatusCode::FORBIDDEN,
            "PairWise Ranking is disabled.",
        ))
    }
}
async fn settings(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<PairwiseSettings>, HttpError> {
    state.auth.request_user(&headers)?;
    blocking(move || configuration(&ServerStore::new(state.runtime.data_dir())).map(Json)).await
}
async fn save_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<PairwiseSettings>,
) -> Result<Json<PairwiseSettings>, HttpError> {
    if state.auth.request_user(&headers)?.role != UserRole::Admin {
        return Err(problem(
            StatusCode::FORBIDDEN,
            "Administrator access required.",
        ));
    }
    blocking(move || {
        let raw = serde_json::to_string(&input).map_err(|_| {
            problem(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Unable to save ranking settings.",
            )
        })?;
        ServerStore::new(state.runtime.data_dir()).set_setting(KEY, &raw)?;
        Ok(Json(input))
    })
    .await
}
fn library_allowed(user: &UserAccount, id: &str) -> bool {
    user.role == UserRole::Admin
        || user.permissions.all_libraries
        || user
            .permissions
            .library_ids
            .iter()
            .any(|library| library == id)
}
fn eligible_type(kind: NativeLibraryType) -> bool {
    matches!(
        kind,
        NativeLibraryType::Movies
            | NativeLibraryType::Shows
            | NativeLibraryType::Mixed
            | NativeLibraryType::Anime
    )
}
fn catalog(
    store: &ServerStore,
    user: &UserAccount,
    library: &str,
) -> Result<Vec<NativeCatalogEntry>, HttpError> {
    if !library_allowed(user, library)
        || !store
            .native_libraries()?
            .iter()
            .any(|item| item.id == library && eligible_type(item.library_type))
    {
        return Err(problem(StatusCode::NOT_FOUND, "Ranking library not found."));
    }
    let entries = store.native_catalog_summaries(library)?;
    let allowed = crate::access::catalog_allowed(user, &entries);
    Ok(entries
        .into_iter()
        .filter(|entry| {
            allowed.contains(&entry.id)
                && entry.available
                && entry.metadata["missing"] != true
                && matches!(entry.kind.as_str(), "series" | "movie")
        })
        .collect())
}
async fn libraries(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<RankingLibrary>>, HttpError> {
    let user = state.auth.request_user(&headers)?;
    blocking(move || {
        let store = ServerStore::new(state.runtime.data_dir());
        enabled(&store)?;
        let mut result = Vec::new();
        for library in store.native_libraries()? {
            if eligible_type(library.library_type) && library_allowed(&user, &library.id) {
                result.push(RankingLibrary {
                    title_count: catalog(&store, &user, &library.id)?.len(),
                    id: library.id,
                    name: library.name,
                });
            }
        }
        Ok(Json(result))
    })
    .await
}
fn event_visible(event: &RankingEvent, visible: &HashSet<String>) -> bool {
    visible.contains(&event.left_id)
        && event
            .right_id
            .as_ref()
            .is_none_or(|id| visible.contains(id))
}
fn excluded(board: &RankingBoard, visible: &HashSet<String>) -> HashSet<String> {
    let mut result = HashSet::new();
    for event in &board.events {
        if visible.contains(&event.left_id) {
            match event.outcome.as_str() {
                "exclude" => {
                    result.insert(event.left_id.clone());
                }
                "allow" => {
                    result.remove(&event.left_id);
                }
                _ => {}
            }
        }
    }
    result
}
fn comparisons(board: &RankingBoard, active: &HashSet<String>) -> Vec<model::Comparison> {
    let mut latest = HashMap::new();
    for event in &board.events {
        let Some(right) = &event.right_id else {
            continue;
        };
        if !active.contains(&event.left_id) || !active.contains(right) {
            continue;
        }
        let outcome = match event.outcome.as_str() {
            "left" => model::Outcome::Left,
            "right" => model::Outcome::Right,
            "tie" => model::Outcome::Tie,
            _ => continue,
        };
        let mut key = [event.left_id.clone(), right.clone()];
        key.sort();
        latest.insert(
            key,
            model::Comparison {
                left: event.left_id.clone(),
                right: right.clone(),
                outcome,
            },
        );
    }
    let mut result: Vec<_> = latest.into_iter().collect();
    result.sort_by(|a, b| a.0.cmp(&b.0));
    result
        .into_iter()
        .map(|(_, comparison)| comparison)
        .collect()
}
fn pair_valid(pair: &RankingPair, active: &HashSet<String>) -> bool {
    pair.left_id != pair.right_id
        && active.contains(&pair.left_id)
        && active.contains(&pair.right_id)
}
fn choose(board: &mut RankingBoard, active: &HashSet<String>) {
    let mut ids: Vec<_> = active.iter().cloned().collect();
    ids.sort();
    board.pair = model::choose_pair(
        &ids,
        &comparisons(board, active),
        &board.recent,
        Uuid::new_v4().as_u128() as u64,
    )
    .map(|[left_id, right_id]| RankingPair {
        token: Uuid::new_v4().to_string(),
        left_id,
        right_id,
    });
}
fn view(
    library: String,
    revision: i64,
    entries: Vec<NativeCatalogEntry>,
    board: &RankingBoard,
) -> RankingView {
    let visible: HashSet<_> = entries.iter().map(|entry| entry.id.clone()).collect();
    let excluded_titles = excluded(board, &visible);
    let active: HashSet<_> = visible.difference(&excluded_titles).cloned().collect();
    let mut ids: Vec<_> = active.iter().cloned().collect();
    ids.sort();
    let comparisons = comparisons(board, &active);
    let mut ratings: HashMap<_, _> = model::rank(&ids, &comparisons)
        .into_iter()
        .map(|rating| (rating.id.clone(), rating))
        .collect();
    let titles: Vec<_> = entries
        .into_iter()
        .map(|entry| {
            let rating = ratings.remove(&entry.id);
            RankingTitle {
                excluded: excluded_titles.contains(&entry.id),
                score: rating.as_ref().and_then(|r| r.score),
                rank: rating.as_ref().and_then(|r| r.rank),
                comparisons: rating.as_ref().map_or(0, |r| r.comparisons),
                provisional: rating.as_ref().is_none_or(|r| r.provisional),
                entry,
            }
        })
        .collect();
    RankingView {
        library_id: library,
        revision,
        decision_count: comparisons.len(),
        ranked_count: titles.iter().filter(|t| t.comparisons > 0).count(),
        excluded_count: excluded_titles.len(),
        titles,
        pair: board
            .pair
            .as_ref()
            .filter(|pair| pair_valid(pair, &active))
            .cloned(),
        can_undo: board
            .events
            .last()
            .is_some_and(|event| event_visible(event, &visible)),
    }
}
async fn detail(
    State(state): State<AppState>,
    Path(library): Path<String>,
    headers: HeaderMap,
) -> Result<Json<RankingView>, HttpError> {
    let user = state.auth.request_user(&headers)?;
    blocking(move || {
        let store = ServerStore::new(state.runtime.data_dir());
        enabled(&store)?;
        let entries = catalog(&store, &user, &library)?;
        let (revision, board) = store.pairwise_board(&user.id, &library)?;
        Ok(Json(view(library, revision, entries, &board)))
    })
    .await
}
async fn action(
    State(state): State<AppState>,
    Path(library): Path<String>,
    headers: HeaderMap,
    Json(input): Json<RankingAction>,
) -> Result<Json<RankingView>, HttpError> {
    let user = state.auth.request_user(&headers)?;
    blocking(move || {
        let store = ServerStore::new(state.runtime.data_dir());
        enabled(&store)?;
        let entries = catalog(&store, &user, &library)?;
        let (revision, mut board) = store.pairwise_board(&user.id, &library)?;
        if revision != input.revision {
            return Err(problem(
                StatusCode::CONFLICT,
                "Ranking changed. Refresh and try again.",
            ));
        }
        let visible: HashSet<_> = entries.iter().map(|entry| entry.id.clone()).collect();
        apply(&mut board, &input, &visible)?;
        let revision = store.save_pairwise_board(&user.id, &library, revision, &board)?;
        Ok(Json(view(library, revision, entries, &board)))
    })
    .await
}
fn apply(
    board: &mut RankingBoard,
    input: &RankingAction,
    visible: &HashSet<String>,
) -> Result<(), HttpError> {
    let excluded_titles = excluded(board, visible);
    let active: HashSet<_> = visible.difference(&excluded_titles).cloned().collect();
    let pair = board
        .pair
        .as_ref()
        .filter(|pair| pair_valid(pair, &active))
        .cloned();
    let require_pair = || -> Result<RankingPair, HttpError> {
        pair.clone()
            .filter(|pair| input.token.as_deref() == Some(pair.token.as_str()))
            .ok_or_else(|| {
                problem(
                    StatusCode::CONFLICT,
                    "This comparison changed. Refresh and try again.",
                )
            })
    };
    match input.action.as_str() {
        "start" => {
            if pair.is_none() {
                choose(board, &active);
            }
            return Ok(());
        }
        "skip" => {
            let pair = require_pair()?;
            board.recent.push([pair.left_id, pair.right_id]);
            if board.recent.len() > 16 {
                board.recent.remove(0);
            }
        }
        "left" | "right" | "tie" => {
            let pair = require_pair()?;
            if board.events.len() >= 100_000 {
                return Err(problem(
                    StatusCode::BAD_REQUEST,
                    "Ranking history limit reached.",
                ));
            }
            board.events.push(RankingEvent {
                left_id: pair.left_id.clone(),
                right_id: Some(pair.right_id.clone()),
                outcome: input.action.clone(),
                pair: Some(pair.clone()),
            });
            board.recent.push([pair.left_id, pair.right_id]);
            if board.recent.len() > 16 {
                board.recent.remove(0);
            }
        }
        "exclude" | "allow" => {
            let id = input
                .item_id
                .as_ref()
                .filter(|id| visible.contains(*id))
                .ok_or_else(|| problem(StatusCode::NOT_FOUND, "Ranking title not found."))?;
            if input.token.is_some() {
                require_pair()?;
            }
            if board.events.len() >= 100_000 {
                return Err(problem(
                    StatusCode::BAD_REQUEST,
                    "Ranking history limit reached.",
                ));
            }
            board.events.push(RankingEvent {
                left_id: id.clone(),
                right_id: None,
                outcome: input.action.clone(),
                pair: pair.clone(),
            });
        }
        "undo" => {
            if !board
                .events
                .last()
                .is_some_and(|event| event_visible(event, visible))
            {
                return Err(problem(
                    StatusCode::BAD_REQUEST,
                    "No decision available to undo.",
                ));
            }
            let event = board.events.pop().expect("checked last event");
            let restored_excluded = excluded(board, visible);
            let restored_active = visible.difference(&restored_excluded).cloned().collect();
            if let Some(mut pair) = event.pair.filter(|pair| pair_valid(pair, &restored_active)) {
                pair.token = Uuid::new_v4().to_string();
                board.pair = Some(pair);
                return Ok(());
            }
        }
        _ => return Err(problem(StatusCode::BAD_REQUEST, "Unknown ranking action.")),
    }
    let excluded = excluded(board, visible);
    choose(board, &visible.difference(&excluded).cloned().collect());
    Ok(())
}
