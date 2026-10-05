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
        let _refresh_guard = RefreshGuard(Arc::clone(&self.refreshing));
        let cache = self.clone();
        let data_dir = runtime.data_dir().to_path_buf();
        match tokio::task::spawn_blocking(move || cache.refresh_inner(&data_dir)).await {
            Ok(Ok(())) => {},
            Ok(Err(error)) => tracing::warn!(%error, "could not refresh the login poster backdrop"),
            Err(error) => tracing::warn!(%error, "login poster backdrop task interrupted"),
        }
    }

    fn refresh_inner(&self, data_dir: &Path) -> Result<(), String> {
        let media_root = std::env::var_os("POSTERVIEW_MEDIA_DIR").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/media"));
        self.refresh_native(data_dir, &media_root)
    }

    fn refresh_native(&self, data_dir: &Path, media_root: &Path) -> Result<(), String> {
        fs::create_dir_all(&*self.root).map_err(|error| error.to_string())?;
        let store = posterview_infra_sqlite::ServerStore::new(data_dir);
        let mut references = Vec::new();
        for library in shuffled(store.native_libraries().map_err(|error| error.to_string())?) {
            let entries = store.native_catalog(&library.id).map_err(|error| error.to_string())?;
            references.extend(shuffled(entries).into_iter()
                .filter(|entry| entry.available && entry.parent_path.is_none())
                .filter_map(|entry| entry.artwork.into_iter().find(|art| art.kind == "poster"))
                .filter_map(|art| local_poster(data_dir, media_root, &art.path))
                .take(POSTERS_PER_ROW));
        }
        references = shuffled(references);
        let row_count = if references.is_empty() { 0 } else { MAX_ROWS.min((references.len() / 2).max(1)) };
        if row_count == 0 {
            return self.save_manifest(&BackdropManifest::default());
        }
        let mut rows = vec![
            BackdropRow {
                posters: Vec::new()
            };
            row_count
        ];
        let mut successful = 0;
        for reference in references.into_iter().take(row_count * POSTERS_PER_ROW) {
            let Ok(metadata) = fs::metadata(&reference) else { continue; };
            if metadata.len() > 20 * 1024 * 1024 { continue; }
            let Ok(bytes) = fs::read(&reference) else { continue; };
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
            let row_index = successful % row_count;
            let name = format!("row-{row_index}-poster-{}", rows[row_index].posters.len());
            fs::write(self.root.join(format!("{name}.jpg")), encoded)
                .map_err(|error| error.to_string())?;
            rows[row_index].posters.push(name);
            successful += 1;
            if successful >= row_count * 2 && successful.is_multiple_of(row_count) {
                // Publish progressively once every mixed row has enough posters to animate.
                self.save_manifest(&BackdropManifest { rows: rows.clone() })?;
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

fn local_poster(data_dir: &Path, media_root: &Path, artwork: &str) -> Option<PathBuf> {
    let (root, relative) = if let Some(name) = artwork.strip_prefix("@managed/") {
        (data_dir.join("native-artwork"), PathBuf::from(name))
    } else {
        (media_root.to_path_buf(), PathBuf::from(artwork))
    };
    if relative.is_absolute() || relative.components().any(|part| !matches!(part, std::path::Component::Normal(_))) { return None; }
    let root = root.canonicalize().ok()?;
    let path = root.join(relative).canonicalize().ok()?;
    (path.starts_with(root) && path.is_file()).then_some(path)
}

fn shuffled<T>(mut values: Vec<T>) -> Vec<T> {
    for index in (1..values.len()).rev() {
        let swap = (uuid::Uuid::new_v4().as_u128() % (index as u128 + 1)) as usize;
        values.swap(index, swap);
    }
    values
}

struct RefreshGuard(Arc<AtomicBool>);

impl Drop for RefreshGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
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

    #[tokio::test]
    async fn collage_uses_native_posters_without_connected_servers() {
        use posterview_contracts::native::{NativeLibraryInput, NativeLibraryType, AnimeContent, NativeArtwork};
        let temp = tempfile::tempdir().unwrap();
        let state = crate::native::scan_tests::state(temp.path());
        let media = temp.path().join("media");
        for name in ["One", "Two"] {
            fs::create_dir_all(media.join(name)).unwrap();
            fs::write(media.join(name).join(format!("{name}.mkv")), b"fixture").unwrap();
            image::RgbImage::from_pixel(8, 12, image::Rgb([100, 20, 40])).save(media.join(name).join("poster.jpg")).unwrap();
        }
        let store = posterview_infra_sqlite::ServerStore::new(state.runtime.data_dir());
        let library = store.save_native_library(None, &NativeLibraryInput {name:"Movies".into(), library_type:NativeLibraryType::Movies, anime_content:AnimeContent::Both, paths:vec!["One".into(),"Two".into()], revision:None, options: posterview_contracts::native::NativeLibraryOptions {fetch_missing:false,..Default::default()} }).unwrap();
        crate::native::run_scan(state.clone(),library.clone()).await.unwrap();
        let cache = LoginBackdrop::new(state.runtime.data_dir());
        cache.refresh_native(state.runtime.data_dir(), &media).unwrap();
        assert_eq!(cache.manifest().rows.iter().map(|row|row.posters.len()).sum::<usize>(),2);
        assert!(local_poster(state.runtime.data_dir(), &media, "../outside.jpg").is_none());
        // Saved manual posters must also work without a media-side copy.
        let managed = state.runtime.data_dir().join("native-artwork");
        fs::create_dir_all(&managed).unwrap();
        fs::copy(media.join("One/poster.jpg"),managed.join("manual.jpg")).unwrap();
        let entry = store.native_catalog(&library.id).unwrap().into_iter().find(|e|e.kind=="movie").unwrap();
        store.save_native_artwork(&library.id,&entry.id,&NativeArtwork {kind:"poster".into(),path:"@managed/manual.jpg".into(),source:"manual".into()}).unwrap();
        assert!(local_poster(state.runtime.data_dir(), &media, "@managed/manual.jpg").is_some());
        cache.refresh_native(state.runtime.data_dir(), &media).unwrap();
        assert!(!cache.manifest().rows.is_empty());
    }

    #[test]
    fn shuffled_preserves_every_value() {
        let mut values = shuffled((0..100).collect::<Vec<_>>());
        values.sort_unstable();
        assert_eq!(values, (0..100).collect::<Vec<_>>());
    }
}
