//! Isolated, worker-free fixtures shared by server feature tests.
use crate::{AppState, AuthState};
use std::{path::Path, sync::Arc};

pub(crate) fn state(directory: &Path) -> AppState {
    let media = directory.join("media");
    std::fs::create_dir_all(&media).unwrap();
    let runtime = Arc::new(posterview_runtime::Runtime::new(directory.join("config")));
    runtime.initialize().unwrap();
    AppState::new(runtime, AuthState::for_tests(""), media)
}
