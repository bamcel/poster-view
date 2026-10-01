use crate::AppState;
use posterview_contracts::native::{NativeArtwork, NativeCatalogEntry};
use posterview_infra_media_servers::{ConnectionConfig, find_artwork_item, set_image};

pub(crate) async fn push(
    state: &AppState,
    entry: &NativeCatalogEntry,
    art: &NativeArtwork,
) -> String {
    let servers = match state.runtime.list_servers() {
        Ok(servers) => servers,
        Err(_) => return " Connected-server lookup failed.".into(),
    };
    if servers.is_empty() {
        return String::new();
    }
    let Some(name) = art.path.strip_prefix("@managed/") else {
        return " Server synchronization requires managed artwork.".into();
    };
    let path = state.runtime.data_dir().join("native-artwork").join(name);
    let ext = path
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_string();
    let animated = ["gif", "webm"].contains(&ext.as_str());
    let path = if animated {
        path.with_file_name(format!(
            "{}.still.png",
            name.trim_end_matches(&format!(".{ext}"))
        ))
    } else {
        path
    };
    let bytes = match tokio::fs::read(&path).await {
        Ok(bytes) => bytes,
        Err(_) => {
            return " Artwork saved locally, but server upload could not read the image.".into();
        }
    };
    let mime = if animated || ext == "png" {
        "image/png"
    } else if ext == "webp" {
        "image/webp"
    } else {
        "image/jpeg"
    };
    let target = if art.kind == "backdrop" {
        "background"
    } else {
        &art.kind
    };
    let db = posterview_infra_sqlite::ServerStore::new(state.runtime.data_dir());
    let mut messages = Vec::new();
    for server in servers {
        let token = match db.decrypted_token(server.id) {
            Ok(Some(token)) => token,
            _ => {
                messages.push(format!("{}: credentials unavailable.", server.name));
                continue;
            }
        };
        let config = ConnectionConfig {
            server_type: server.server_type,
            base_url: &server.base_url,
            token: &token,
        };
        let operation = async {
            let id = find_artwork_item(
                config.clone(),
                &entry.path,
                &entry.kind,
                &entry.metadata["identifiers"],
            )
            .await?;
            set_image(config, &id, target, &bytes, mime).await
        };
        let result = tokio::time::timeout(std::time::Duration::from_secs(45), operation).await;
        messages.push(match result {
            Ok(Ok(())) => format!(
                "{}: artwork updated{}.",
                server.name,
                if animated { " (static preview)" } else { "" }
            ),
            Ok(Err(error)) => format!("{}: {error}", server.name),
            Err(_) => format!("{}: artwork synchronization timed out.", server.name),
        });
    }
    format!(" {}", messages.join(" "))
}
