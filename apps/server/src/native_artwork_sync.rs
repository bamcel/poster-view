use crate::AppState;
use posterview_contracts::native::{NativeArtwork, NativeCatalogEntry};
pub(crate) async fn push(
    state: &AppState,
    library: &str,
    entry: &NativeCatalogEntry,
    art: &NativeArtwork,
) -> String {
    crate::native_sync::changed(
        state,
        library,
        &entry.id,
        serde_json::json!({}),
        Some(&art.kind),
    )
    .await
}
