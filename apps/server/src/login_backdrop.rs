use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use image::{ImageEncoder, codecs::jpeg::JpegEncoder};
use posterview_runtime::Runtime;
use serde::{Deserialize, Serialize};

const MAX_ROWS: usize = 5;
const POSTERS_PER_ROW: usize = 14;

#[derive(Clone, Default, Deserialize, Serialize)]
pub struct BackdropManifest {
    pub rows: Vec<BackdropRow>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct BackdropRow {
    pub posters: Vec<String>,
}

#[derive(Clone)]
pub struct LoginBackdrop {
    root: Arc<PathBuf>,
    refreshing: Arc<AtomicBool>,
}

impl LoginBackdrop {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            root: Arc::new(data_dir.join("login-backdrop")),
            refreshing: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn manifest(&self) -> BackdropManifest {
        fs::read(self.root.join("manifest.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    pub fn image(&self, name: &str) -> Option<Vec<u8>> {
        if !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return None;
        }
        let allowed: HashSet<String> = self
            .manifest()
            .rows
            .into_iter()
            .flat_map(|row| row.posters)
            .collect();
        allowed
            .contains(name)
            .then(|| fs::read(self.root.join(format!("{name}.jpg"))).ok())
            .flatten()
    }

    pub async fn refresh(&self, runtime: &Runtime) {
        if self.refreshing.swap(true, Ordering::AcqRel) {
            return;
        }
        if let Err(error) = self.refresh_inner(runtime).await {
            tracing::warn!(%error, "could not refresh the login poster backdrop");
        }
        self.refreshing.store(false, Ordering::Release);
    }

    async fn refresh_inner(&self, runtime: &Runtime) -> Result<(), String> {
        fs::create_dir_all(&*self.root).map_err(|error| error.to_string())?;
        let servers = runtime.list_servers().map_err(|error| error.to_string())?;
        let Some(server) = servers
            .iter()
            .find(|server| server.is_default)
            .or_else(|| servers.first())
        else {
            return self.save_manifest(&BackdropManifest::default());
        };
        let libraries = runtime
            .get_libraries(server.id)
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "server disappeared".to_owned())??;
        let mut rows = Vec::new();
        for (row_index, library) in shuffled(libraries).into_iter().take(MAX_ROWS).enumerate() {
            let items = match runtime.get_items(server.id, &library.id, true).await {
                Ok(Some(Ok(items))) => items,
                Ok(Some(Err(error))) => {
                    tracing::warn!(library_id = %library.id, %error, "skipping a library while refreshing the login backdrop");
                    continue;
                }
                Ok(None) => break,
                Err(error) => {
                    tracing::warn!(library_id = %library.id, %error, "skipping a library while refreshing the login backdrop");
                    continue;
                }
            };
            let mut posters = Vec::new();
            for (poster_index, reference) in shuffled(items)
                .into_iter()
                .filter_map(|item| item.poster)
                .take(POSTERS_PER_ROW)
                .enumerate()
            {
                let Ok(Some(Ok((bytes, _)))) = runtime.fetch_image(server.id, &reference).await
                else {
                    continue;
                };
                let Ok(image) = image::load_from_memory(&bytes) else {
                    continue;
                };
                let image = image.thumbnail(280, 420).to_rgb8();
                let mut encoded = Vec::new();
                JpegEncoder::new_with_quality(&mut encoded, 68)
                    .write_image(
                        image.as_raw(),
                        image.width(),
                        image.height(),
                        image::ExtendedColorType::Rgb8,
                    )
                    .map_err(|error| error.to_string())?;
                let name = format!("row-{row_index}-poster-{poster_index}");
                fs::write(self.root.join(format!("{name}.jpg")), encoded)
                    .map_err(|error| error.to_string())?;
                posters.push(name);
            }
            if posters.len() >= 2 {
                rows.push(BackdropRow { posters });
            }
        }
        self.save_manifest(&BackdropManifest { rows })
    }

    fn save_manifest(&self, manifest: &BackdropManifest) -> Result<(), String> {
        let temporary = self.root.join("manifest.tmp");
        fs::write(
            &temporary,
            serde_json::to_vec(manifest).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        fs::rename(temporary, self.root.join("manifest.json"))
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}

fn shuffled<T>(mut values: Vec<T>) -> Vec<T> {
    values.sort_by_key(|_| uuid::Uuid::new_v4());
    values
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_manifest_images_can_be_read() {
        let data = tempfile::tempdir().unwrap();
        let cache = LoginBackdrop::new(data.path());
        fs::create_dir_all(&*cache.root).unwrap();
        fs::write(cache.root.join("allowed.jpg"), b"image").unwrap();
        fs::write(cache.root.join("unlisted.jpg"), b"private").unwrap();
        fs::write(
            cache.root.join("manifest.json"),
            serde_json::to_vec(&BackdropManifest {
                rows: vec![BackdropRow {
                    posters: vec!["allowed".to_owned()],
                }],
            })
            .unwrap(),
        )
        .unwrap();
        assert_eq!(cache.image("allowed"), Some(b"image".to_vec()));
        assert!(cache.image("unlisted").is_none());
        assert!(cache.image("../allowed").is_none());
    }
}
