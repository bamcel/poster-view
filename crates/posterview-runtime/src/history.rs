use std::collections::HashMap;

use posterview_contracts::{ApplyHistoryEntry, ApplyResult, HistorySettings, ImageTarget};
use posterview_infra_media_servers::{ConnectionConfig, set_image};
use posterview_infra_sqlite::HistoryRow;

use crate::{Runtime, RuntimeError, parse_nonnegative};

impl Runtime {
    pub fn history_settings(&self) -> Result<HistorySettings, RuntimeError> {
        let store = self.server_store()?;
        Ok(HistorySettings {
            purge_days: parse_nonnegative(&store.get_setting("history_purge_days")?, 0),
            max_entries: parse_nonnegative(&store.get_setting("history_max_entries")?, 50).max(1),
        })
    }

    pub fn set_history_settings(
        &self,
        settings: &HistorySettings,
    ) -> Result<HistorySettings, RuntimeError> {
        let store = self.server_store()?;
        store.set_setting(
            "history_purge_days",
            &settings.purge_days.max(0).to_string(),
        )?;
        store.set_setting(
            "history_max_entries",
            &settings.max_entries.max(1).to_string(),
        )?;
        delete_files(store.prune_history(settings.max_entries.max(1))?);
        self.history_settings()
    }

    pub fn list_history(
        &self,
        server_id: Option<i64>,
        item_id: Option<&str>,
        target: Option<&ImageTarget>,
        limit: Option<i64>,
    ) -> Result<Vec<ApplyHistoryEntry>, RuntimeError> {
        let store = self.server_store()?;
        let names = store
            .list_servers()?
            .into_iter()
            .map(|server| (server.id, server.name))
            .collect::<HashMap<_, _>>();
        Ok(store
            .list_history(server_id, item_id, target.map(ImageTarget::as_str), limit)?
            .into_iter()
            .map(|row| history_contract(row, &names))
            .collect())
    }

    pub fn history_image(&self, id: i64) -> Result<Option<(Vec<u8>, String)>, RuntimeError> {
        let Some(row) = self.server_store()?.get_history(id)? else {
            return Ok(None);
        };
        Ok(Some((std::fs::read(row.file_path)?, row.content_type)))
    }

    pub fn purge_history(&self, days: Option<i64>) -> Result<usize, RuntimeError> {
        let effective = days.unwrap_or(self.history_settings()?.purge_days);
        let paths = self.server_store()?.purge_history(effective)?;
        let count = paths.len();
        delete_files(paths);
        Ok(count)
    }

    pub async fn revert_history(&self, id: i64) -> Result<Option<ApplyResult>, RuntimeError> {
        let Some(row) = self.server_store()?.get_history(id)? else {
            return Ok(None);
        };
        let Some(server) = self.server_store()?.get_server(row.server_id)? else {
            return Ok(None);
        };
        let data = std::fs::read(&row.file_path)?;
        let target = parse_target(&row.target);
        let token = self
            .server_store()?
            .decrypted_token(row.server_id)?
            .unwrap_or_default();
        let config = ConnectionConfig {
            server_type: server.server_type,
            base_url: &server.base_url,
            token: &token,
        };
        let current_reference =
            posterview_infra_media_servers::get_item_detail(config.clone(), &row.item_id)
                .await
                .ok()
                .and_then(|detail| match target {
                    ImageTarget::Poster => detail.poster,
                    ImageTarget::Background => detail.background,
                    ImageTarget::Logo => detail.logo,
                });
        if let Err(message) = set_image(
            config,
            &row.item_id,
            target.as_str(),
            &data,
            &row.content_type,
        )
        .await
        {
            return Ok(Some(ApplyResult {
                ok: false,
                message: format!("Revert failed: {message}"),
            }));
        }
        self.invalidate_media_item_images(row.server_id, &row.item_id)?;
        if let Some(reference) = current_reference {
            self.cache_media_image(row.server_id, &reference, &data, &row.content_type);
        }
        self.record_history(
            row.server_id,
            &row.item_id,
            &target,
            &data,
            &row.content_type,
            &row.provider,
            &row.item_title,
        )?;
        Ok(Some(ApplyResult {
            ok: true,
            message: format!("Reverted {}.", target.as_str()),
        }))
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn record_history(
        &self,
        server_id: i64,
        item_id: &str,
        target: &ImageTarget,
        data: &[u8],
        content_type: &str,
        provider: &str,
        item_title: &str,
    ) -> Result<(), RuntimeError> {
        let history_dir = self.data_dir.join("history");
        std::fs::create_dir_all(&history_dir)?;
        let extension = match content_type {
            "image/jpeg" => "jpg",
            "image/png" => "png",
            "image/webp" => "webp",
            "image/avif" => "avif",
            "image/gif" => "gif",
            _ => "img",
        };
        let path = history_dir.join(format!("{}.{}", uuid::Uuid::new_v4().simple(), extension));
        std::fs::write(&path, data)?;
        self.server_store()?.insert_history(
            server_id,
            item_id,
            item_title,
            target.as_str(),
            &path.display().to_string(),
            content_type,
            provider,
        )?;
        let settings = self.history_settings()?;
        delete_files(self.server_store()?.prune_history(settings.max_entries)?);
        if settings.purge_days > 0 {
            delete_files(self.server_store()?.purge_history(settings.purge_days)?);
        }
        Ok(())
    }
}

fn parse_target(value: &str) -> ImageTarget {
    match value {
        "background" => ImageTarget::Background,
        "logo" => ImageTarget::Logo,
        _ => ImageTarget::Poster,
    }
}

fn history_contract(row: HistoryRow, server_names: &HashMap<i64, String>) -> ApplyHistoryEntry {
    ApplyHistoryEntry {
        id: row.id,
        server_id: row.server_id,
        server_name: server_names
            .get(&row.server_id)
            .cloned()
            .unwrap_or_default(),
        item_id: row.item_id,
        item_title: row.item_title,
        target: parse_target(&row.target),
        provider: row.provider,
        applied_at: row.applied_at,
        thumb_url: format!("/api/history/{}/image", row.id),
    }
}

fn delete_files(paths: Vec<String>) {
    for path in paths {
        let _ = std::fs::remove_file(path);
    }
}
