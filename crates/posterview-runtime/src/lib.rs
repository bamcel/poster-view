mod artwork;
mod artwork_cache;
mod history;

use std::{
    path::{Path, PathBuf},
    sync::{OnceLock, atomic::AtomicBool},
};

use posterview_contracts::{
    ApplyResult, ConnectionTest, HealthResponse, ImageTarget, ItemDetail, Library, MediaItem,
    PosterSearchResults, Server, ServerCreate, ServerUpdate, StatusResponse,
};
use posterview_infra_artwork::ArtworkService;
use posterview_infra_media_servers::{
    ConnectionConfig, fetch_image, get_item_detail, get_items, get_libraries, set_image,
    test_connection,
};
use posterview_infra_sqlite::{ServerStore, StoreError};
use thiserror::Error;

use artwork_cache::ArtworkCache;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
const ARTWORK_PROVIDERS: [&str; 5] = ["posterdb", "fanart", "tvdb", "anilist", "mediux"];

#[derive(Debug)]
pub struct Runtime {
    data_dir: PathBuf,
    servers: OnceLock<ServerStore>,
    artwork: ArtworkService,
    artwork_cache: ArtworkCache,
    watchdog_running: AtomicBool,
}

#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("PosterView runtime has not been initialized")]
    NotInitialized,
    #[error("{0}")]
    Watchdog(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl Runtime {
    #[must_use]
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        let data_dir = data_dir.into();
        Self {
            artwork_cache: ArtworkCache::new(&data_dir),
            data_dir,
            servers: OnceLock::new(),
            artwork: ArtworkService::default(),
            watchdog_running: AtomicBool::new(false),
        }
    }

    pub fn initialize(&self) -> Result<(), RuntimeError> {
        let store = ServerStore::new(&self.data_dir);
        store.initialize()?;
        self.artwork_cache.initialize()?;
        let _ = self.servers.set(store);
        Ok(())
    }

    #[must_use]
    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    #[must_use]
    pub const fn health(&self) -> HealthResponse {
        HealthResponse {
            status: "ok",
            version: VERSION,
        }
    }

    #[must_use]
    pub fn status(&self) -> StatusResponse {
        StatusResponse {
            name: "PosterView",
            version: VERSION,
            backend: "rust",
            data_dir: self.data_dir.display().to_string(),
        }
    }

    pub fn list_servers(&self) -> Result<Vec<Server>, RuntimeError> {
        Ok(self.server_store()?.list_servers()?)
    }

    pub fn get_server(&self, id: i64) -> Result<Option<Server>, RuntimeError> {
        Ok(self.server_store()?.get_server(id)?)
    }

    pub fn create_server(&self, input: &ServerCreate) -> Result<Server, RuntimeError> {
        Ok(self.server_store()?.create_server(input)?)
    }

    pub fn update_server(
        &self,
        id: i64,
        input: &ServerUpdate,
    ) -> Result<Option<Server>, RuntimeError> {
        Ok(self.server_store()?.update_server(id, input)?)
    }

    pub fn delete_server(&self, id: i64) -> Result<bool, RuntimeError> {
        Ok(self.server_store()?.delete_server(id)?)
    }

    pub async fn test_adhoc_server(&self, input: &ServerCreate) -> ConnectionTest {
        connection_test(ConnectionConfig {
            server_type: input.server_type,
            base_url: &input.base_url,
            token: &input.token,
        })
        .await
    }

    pub async fn test_saved_server(&self, id: i64) -> Result<Option<ConnectionTest>, RuntimeError> {
        let Some(server) = self.server_store()?.get_server(id)? else {
            return Ok(None);
        };
        let token = self
            .server_store()?
            .decrypted_token(id)?
            .unwrap_or_default();
        Ok(Some(
            connection_test(ConnectionConfig {
                server_type: server.server_type,
                base_url: &server.base_url,
                token: &token,
            })
            .await,
        ))
    }

    pub async fn get_libraries(
        &self,
        id: i64,
    ) -> Result<Option<Result<Vec<Library>, String>>, RuntimeError> {
        let Some(server) = self.server_store()?.get_server(id)? else {
            return Ok(None);
        };
        let token = self
            .server_store()?
            .decrypted_token(id)?
            .unwrap_or_default();
        Ok(Some(
            get_libraries(ConnectionConfig {
                server_type: server.server_type,
                base_url: &server.base_url,
                token: &token,
            })
            .await,
        ))
    }

    pub async fn get_items(
        &self,
        id: i64,
        library_id: &str,
        group_collections: bool,
    ) -> Result<Option<Result<Vec<MediaItem>, String>>, RuntimeError> {
        let Some(server) = self.server_store()?.get_server(id)? else {
            return Ok(None);
        };
        let token = self
            .server_store()?
            .decrypted_token(id)?
            .unwrap_or_default();
        Ok(Some(
            get_items(
                ConnectionConfig {
                    server_type: server.server_type,
                    base_url: &server.base_url,
                    token: &token,
                },
                library_id,
                group_collections,
            )
            .await,
        ))
    }

    pub async fn fetch_image(
        &self,
        id: i64,
        reference: &str,
    ) -> Result<Option<Result<(Vec<u8>, String), String>>, RuntimeError> {
        let Some(server) = self.server_store()?.get_server(id)? else {
            return Ok(None);
        };
        let token = self
            .server_store()?
            .decrypted_token(id)?
            .unwrap_or_default();
        Ok(Some(
            fetch_image(
                ConnectionConfig {
                    server_type: server.server_type,
                    base_url: &server.base_url,
                    token: &token,
                },
                reference,
            )
            .await,
        ))
    }

    pub async fn get_item_detail(
        &self,
        id: i64,
        item_id: &str,
    ) -> Result<Option<Result<ItemDetail, String>>, RuntimeError> {
        let Some(server) = self.server_store()?.get_server(id)? else {
            return Ok(None);
        };
        let token = self
            .server_store()?
            .decrypted_token(id)?
            .unwrap_or_default();
        Ok(Some(
            get_item_detail(
                ConnectionConfig {
                    server_type: server.server_type,
                    base_url: &server.base_url,
                    token: &token,
                },
                item_id,
            )
            .await,
        ))
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn apply_image(
        &self,
        server_id: i64,
        item_id: &str,
        target: &ImageTarget,
        data: &[u8],
        content_type: &str,
        provider: &str,
        item_title: &str,
    ) -> Result<Option<ApplyResult>, RuntimeError> {
        let Some(server) = self.server_store()?.get_server(server_id)? else {
            return Ok(None);
        };
        let token = self
            .server_store()?
            .decrypted_token(server_id)?
            .unwrap_or_default();
        if let Err(message) = set_image(
            ConnectionConfig {
                server_type: server.server_type,
                base_url: &server.base_url,
                token: &token,
            },
            item_id,
            target.as_str(),
            data,
            content_type,
        )
        .await
        {
            return Ok(Some(ApplyResult {
                ok: false,
                message: format!("Upload failed: {message}"),
            }));
        }
        self.record_history(
            server_id,
            item_id,
            target,
            data,
            content_type,
            provider,
            item_title,
        )?;
        Ok(Some(ApplyResult {
            ok: true,
            message: if provider == "manual" {
                "Applied your image successfully.".to_owned()
            } else {
                format!("Updated {} successfully.", target.as_str())
            },
        }))
    }

    pub(crate) fn server_store(&self) -> Result<&ServerStore, RuntimeError> {
        self.servers.get().ok_or(RuntimeError::NotInitialized)
    }
}

pub(crate) fn parse_nonnegative(value: &str, fallback: i64) -> i64 {
    value.parse::<i64>().unwrap_or(fallback).max(0)
}

fn watchdog_inventory_diff(
    previous: &std::collections::BTreeMap<String, String>,
    current: &std::collections::BTreeMap<String, String>,
) -> (std::collections::HashSet<String>, Vec<(String, String)>) {
    let added = current
        .keys()
        .filter(|key| !previous.contains_key(*key))
        .cloned()
        .collect();
    let removed = previous
        .iter()
        .filter(|(key, _)| !current.contains_key(*key))
        .map(|(key, title)| (key.clone(), title.clone()))
        .collect();
    (added, removed)
}

fn posterdb_top_three(mut results: PosterSearchResults) -> PosterSearchResults {
    for category in &mut results.categories {
        category.results.truncate(3);
        category.count = category.results.len();
    }
    results
}

fn optional_setting(value: String) -> Option<String> {
    (!value.is_empty()).then_some(value)
}

async fn connection_test(config: ConnectionConfig<'_>) -> ConnectionTest {
    match test_connection(config).await {
        Ok((server_name, version)) => ConnectionTest {
            ok: true,
            message: "Connected successfully.".to_owned(),
            server_name: Some(server_name),
            version: Some(version),
        },
        Err(message) => ConnectionTest {
            ok: false,
            message,
            server_name: None,
            version: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::{Runtime, posterdb_top_three, watchdog_inventory_diff};
    use posterview_contracts::{PosterCategory, PosterSearchResults, PosterTitleResult};
    use std::collections::BTreeMap;

    #[test]
    fn watchdog_inventory_finds_only_added_and_removed_items() {
        let previous = BTreeMap::from([
            ("1:kept".to_owned(), "Kept".to_owned()),
            ("1:removed".to_owned(), "Removed".to_owned()),
        ]);
        let current = BTreeMap::from([
            ("1:kept".to_owned(), "Kept".to_owned()),
            ("1:new".to_owned(), "New".to_owned()),
        ]);

        let (added, removed) = watchdog_inventory_diff(&previous, &current);
        assert_eq!(added, ["1:new".to_owned()].into_iter().collect());
        assert_eq!(
            removed,
            vec![("1:removed".to_owned(), "Removed".to_owned())]
        );
    }

    #[test]
    fn watchdog_checkpoint_is_due_even_when_scheduling_is_disabled() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let runtime = Runtime::new(directory.path());
        runtime.initialize().expect("initialize runtime");
        runtime
            .server_store()
            .expect("server store")
            .set_setting("artwork_watchdog_checkpoint", "1:item")
            .expect("save checkpoint");
        assert!(runtime.watchdog_due().expect("watchdog status"));
    }

    #[test]
    fn posterdb_prewarm_keeps_three_results_without_changing_full_searches() {
        let full = PosterSearchResults {
            term: "House".to_owned(),
            categories: vec![PosterCategory {
                name: "Shows".to_owned(),
                count: 5,
                results: (1..=5)
                    .map(|id| PosterTitleResult {
                        title: format!("House {id}"),
                        url: format!("/posters/{id}"),
                        media_id: id.to_string(),
                    })
                    .collect(),
            }],
        };

        let cached = posterdb_top_three(full.clone());
        assert_eq!(cached.categories[0].count, 3);
        assert_eq!(cached.categories[0].results.len(), 3);
        assert_eq!(full.categories[0].results.len(), 5);
    }

    #[test]
    fn posterdb_search_preview_reads_the_prewarmed_result() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let runtime = Runtime::new(directory.path());
        runtime.initialize().expect("initialize runtime");
        let preview = PosterSearchResults {
            term: "Roseanne".to_owned(),
            categories: vec![PosterCategory {
                name: "Shows".to_owned(),
                count: 2,
                results: (1..=2)
                    .map(|id| PosterTitleResult {
                        title: format!("Roseanne {id}"),
                        url: format!("/posters/{id}"),
                        media_id: id.to_string(),
                    })
                    .collect(),
            }],
        };
        let settings = runtime
            .artwork_cache_settings()
            .expect("artwork cache settings");
        runtime
            .artwork_cache
            .put_json(
                "posterdb-prewarm-search:roseanne",
                &preview,
                settings.max_mb,
                settings.ttl_days,
            )
            .expect("store preview");

        let cached = runtime
            .posterdb_search_preview("  ROSEANNE ")
            .expect("read preview")
            .expect("preview exists");
        assert_eq!(cached, preview);
    }
}
