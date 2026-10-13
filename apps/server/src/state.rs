//! Shared application composition. Feature modules receive state; they do not start workers.
use crate::{
    auth::AuthState, login_backdrop::LoginBackdrop, metadata::MetadataStore,
    playback::PlaybackStore, reader::ReaderStore,
};
use posterview_runtime::Runtime;
use std::{path::PathBuf, sync::Arc};

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) active_native_scans: Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
    pub(crate) maintenance_lock: Arc<tokio::sync::Mutex<()>>,
    pub(crate) running_maintenance_task: Arc<std::sync::Mutex<Option<String>>>,
    pub(crate) runtime: Arc<Runtime>,
    pub(crate) auth: AuthState,
    pub(crate) login_backdrop: LoginBackdrop,
    pub(crate) metadata: Arc<MetadataStore>,
    pub(crate) reader: Arc<ReaderStore>,
    pub(crate) playback: Arc<PlaybackStore>,
}
impl AppState {
    pub(crate) fn new(runtime: Arc<Runtime>, auth: AuthState, media_dir: PathBuf) -> Self {
        Self {
            active_native_scans: Default::default(),
            maintenance_lock: Default::default(),
            running_maintenance_task: Default::default(),
            login_backdrop: LoginBackdrop::new(runtime.data_dir()),
            reader: Arc::new(ReaderStore::new(
                media_dir.clone(),
                runtime.data_dir().join("reader.sqlite"),
            )),
            metadata: Arc::new(MetadataStore::new(media_dir)),
            playback: Arc::new(PlaybackStore::new(runtime.data_dir())),
            runtime,
            auth,
        }
    }
}

pub(crate) fn spawn_backdrop_refresh(state: &AppState) {
    let cache = state.login_backdrop.clone();
    let runtime = Arc::clone(&state.runtime);
    tokio::spawn(async move {
        cache.refresh(&runtime).await;
    });
}
