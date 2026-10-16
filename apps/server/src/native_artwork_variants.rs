//! Disposable display-sized copies. Original artwork remains authoritative.
use crate::AppState;
use image::{ImageFormat, ImageReader};
use posterview_infra_sqlite::ServerStore;
use std::{
    borrow::Cow,
    collections::{HashSet, hash_map::DefaultHasher},
    fs,
    hash::{Hash, Hasher},
    io::{Cursor, Read},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub(crate) const WIDTHS: [u32; 7] = [96, 192, 320, 480, 640, 1280, 1920];
const MAX_BYTES: u64 = 20 * 1024 * 1024;
const MAX_PIXELS: u64 = 40_000_000;

#[derive(Clone, Default)]
pub(crate) struct ArtworkVariants {
    directory: PathBuf,
    gate: Arc<Mutex<()>>,
}

impl ArtworkVariants {
    pub(crate) fn new(data_dir: &Path) -> Self {
        Self {
            directory: data_dir.join("artwork-variants"),
            gate: Arc::default(),
        }
    }

    fn destination(&self, source: &Path, width: u32) -> Result<PathBuf, String> {
        if !WIDTHS.contains(&width) {
            return Err("Unsupported artwork width.".into());
        }
        let canonical = source.canonicalize().map_err(|e| e.to_string())?;
        let metadata = fs::metadata(&canonical).map_err(|e| e.to_string())?;
        if !metadata.is_file() || metadata.len() > MAX_BYTES {
            return Err("Artwork exceeds 20 MB or is not a file.".into());
        }
        let modified = metadata
            .modified()
            .map_err(|e| e.to_string())?
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos();
        let mut hash = DefaultHasher::new();
        canonical.hash(&mut hash);
        metadata.len().hash(&mut hash);
        modified.hash(&mut hash);
        Ok(self
            .directory
            .join(format!("v1-{:016x}-{width}.art", hash.finish())))
    }

    pub(crate) fn cached(&self, source: &Path, width: u32) -> Option<PathBuf> {
        let target = self.destination(source, width).ok()?;
        fs::symlink_metadata(&target)
            .ok()
            .filter(|m| m.file_type().is_file() && m.len() > 0)
            .map(|_| target)
    }

    /// A busy generator immediately yields to the original-image fallback.
    /// Call this from a blocking worker, never the async request executor.
    pub(crate) fn generate(&self, source: &Path, width: u32) -> Result<Option<PathBuf>, String> {
        if let Some(cached) = self.cached(source, width) {
            return Ok(Some(cached));
        }
        let Ok(_guard) = self.gate.try_lock() else {
            return Ok(None);
        };
        let target = self.destination(source, width)?;
        let Some(decoded) = Self::decode(source)? else {
            return Ok(None);
        };
        self.publish(source, width, &target, &decoded)
    }

    fn decode(source: &Path) -> Result<Option<image::DynamicImage>, String> {
        let mut bytes = Vec::new();
        fs::File::open(source)
            .map_err(|e| e.to_string())?
            .take(MAX_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err("Artwork exceeds 20 MB.".into());
        }
        // WebM animation has its own validated still-image generation path.
        if bytes.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
            return Ok(None);
        }
        let format = image::guess_format(&bytes).map_err(|e| e.to_string())?;
        if !matches!(
            format,
            ImageFormat::Jpeg | ImageFormat::Png | ImageFormat::WebP | ImageFormat::Gif
        ) {
            return Ok(None);
        }
        let dimensions = ImageReader::with_format(Cursor::new(&bytes), format)
            .into_dimensions()
            .map_err(|e| e.to_string())?;
        if u64::from(dimensions.0) * u64::from(dimensions.1) > MAX_PIXELS {
            return Err("Artwork exceeds 40 million pixels.".into());
        }
        let mut reader = ImageReader::with_format(Cursor::new(&bytes), format);
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(32768);
        limits.max_image_height = Some(32768);
        limits.max_alloc = Some(256 * 1024 * 1024);
        reader.limits(limits);
        reader.decode().map(Some).map_err(|e| e.to_string())
    }

    fn publish(
        &self,
        source: &Path,
        width: u32,
        target: &Path,
        decoded: &image::DynamicImage,
    ) -> Result<Option<PathBuf>, String> {
        // Cap both axes: a narrow, very tall source must not retain a large
        // full-resolution allocation for each encoded output.
        let resized = if decoded.width() > width || decoded.height() > 1920 {
            Cow::Owned(decoded.resize(width, 1920, image::imageops::FilterType::Triangle))
        } else {
            Cow::Borrowed(decoded)
        };
        let rgba = resized.color().has_alpha().then(|| {
            resized
                .as_rgba8()
                .map(Cow::Borrowed)
                .unwrap_or_else(|| Cow::Owned(resized.to_rgba8()))
        });
        let mut encoded = Vec::new();
        if let Some(rgba) = rgba
            .as_ref()
            .filter(|rgba| rgba.pixels().any(|pixel| pixel[3] < 255))
        {
            image::codecs::webp::WebPEncoder::new_lossless(&mut encoded)
                .encode(
                    rgba,
                    rgba.width(),
                    rgba.height(),
                    image::ExtendedColorType::Rgba8,
                )
                .map_err(|e| e.to_string())?;
        } else {
            let rgb = resized
                .as_rgb8()
                .map(Cow::Borrowed)
                .unwrap_or_else(|| Cow::Owned(resized.to_rgb8()));
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut encoded, 82)
                .encode(
                    &rgb,
                    rgb.width(),
                    rgb.height(),
                    image::ExtendedColorType::Rgb8,
                )
                .map_err(|e| e.to_string())?;
        }
        // A changed source must never publish bytes under an older fingerprint.
        if self.destination(source, width)? != target {
            return Ok(None);
        }
        fs::create_dir_all(&self.directory).map_err(|e| e.to_string())?;
        let directory = fs::symlink_metadata(&self.directory).map_err(|e| e.to_string())?;
        if !directory.file_type().is_dir() {
            return Err("Artwork variant cache must be an ordinary directory.".into());
        }
        let temporary = self.directory.join(format!("{}.tmp", uuid::Uuid::new_v4()));
        let published = (|| {
            fs::write(&temporary, encoded).map_err(|e| e.to_string())?;
            match fs::rename(&temporary, target) {
                Ok(()) => Ok(()),
                Err(_) if target.is_file() => Ok(()),
                Err(error) => Err(error.to_string()),
            }
        })();
        let _ = fs::remove_file(&temporary);
        published?;
        Ok(Some(target.to_path_buf()))
    }

    fn generate_all(&self, source: &Path) -> Result<usize, String> {
        // Backfill is already on a dedicated worker. Wait here rather than
        // skipping widths if an on-demand request currently owns the decoder.
        let _guard = self
            .gate
            .lock()
            .map_err(|_| "Artwork generation interrupted.")?;
        let missing = WIDTHS
            .into_iter()
            .filter(|width| self.cached(source, *width).is_none())
            .map(|width| {
                self.destination(source, width)
                    .map(|target| (width, target))
            })
            .collect::<Result<Vec<_>, _>>()?;
        if missing.is_empty() {
            return Ok(0);
        }
        let Some(decoded) = Self::decode(source)? else {
            return Ok(0);
        };
        let mut generated = 0;
        for (width, target) in missing {
            if self.publish(source, width, &target, &decoded)?.is_some() {
                generated += 1;
            }
        }
        Ok(generated)
    }

    fn cleanup(&self, referenced: &HashSet<PathBuf>) -> Result<(), String> {
        match fs::symlink_metadata(&self.directory) {
            Ok(metadata) if !metadata.file_type().is_dir() => {
                return Err("Artwork variant cache must be an ordinary directory.".into());
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.to_string()),
            _ => (),
        }
        let entries = match fs::read_dir(&self.directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.to_string()),
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let owned = name
                .strip_prefix("v1-")
                .and_then(|name| name.strip_suffix(".art"))
                .and_then(|name| name.split_once('-'))
                .is_some_and(|(hash, width)| {
                    hash.len() == 16
                        && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
                        && width
                            .parse::<u32>()
                            .ok()
                            .is_some_and(|width| WIDTHS.contains(&width))
                });
            if !owned || referenced.contains(&path) || !entry.file_type().is_ok_and(|t| t.is_file())
            {
                continue;
            }
            let old = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|modified| SystemTime::now().duration_since(modified).ok())
                .is_some_and(|age| age >= Duration::from_secs(7 * 86400));
            if old {
                fs::remove_file(path).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }
}

/// The scheduled task and scan hooks share the same bounded generation gate.
pub(crate) fn backfill(state: &AppState) -> Result<usize, String> {
    let store = ServerStore::new(state.runtime.data_dir());
    let mut sources = HashSet::new();
    let mut referenced = HashSet::new();
    let mut generated = 0;
    for library in store.native_libraries().map_err(|e| e.to_string())? {
        for entry in store
            .native_catalog(&library.id)
            .map_err(|e| e.to_string())?
        {
            for artwork in entry.artwork {
                if artwork.kind.ends_with("-previous") || artwork.kind.ends_with("-edit-original") {
                    continue;
                }
                let source = match crate::native::artwork_source(state, &artwork, true) {
                    Ok(source) => source,
                    Err(error) => {
                        tracing::debug!(detail=%error.detail, "Artwork unavailable for optimization");
                        continue;
                    }
                };
                let source = match crate::native::artwork_variant_source(state, &source) {
                    Ok(source) => source,
                    Err(error) => {
                        tracing::warn!(%error, "Could not prepare artwork optimization source");
                        continue;
                    }
                };
                let Ok(source) = source.canonicalize() else {
                    continue;
                };
                if !sources.insert(source.clone()) {
                    continue;
                }
                for width in WIDTHS {
                    if let Ok(path) = state.artwork_variants.destination(&source, width) {
                        referenced.insert(path);
                    }
                }
                match state.artwork_variants.generate_all(&source) {
                    Ok(count) => generated += count,
                    Err(error) => {
                        tracing::warn!(%error, "Could not optimize artwork; original remains available")
                    }
                }
            }
        }
    }
    state.artwork_variants.cleanup(&referenced)?;
    Ok(generated)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(directory: &Path, width: u32, height: u32) -> PathBuf {
        let source = directory.join("original.png");
        image::RgbaImage::from_pixel(width, height, image::Rgba([100, 50, 20, 96]))
            .save(&source)
            .unwrap();
        source
    }

    #[test]
    fn resizes_preserving_transparency_original_and_aspect_ratio() {
        let dir = tempfile::tempdir().unwrap();
        let path = source(dir.path(), 640, 960);
        let original = fs::read(&path).unwrap();
        let cache = ArtworkVariants::new(dir.path());
        let result = cache.generate(&path, 320).unwrap().unwrap();
        let resized = image::load_from_memory(&fs::read(&result).unwrap())
            .unwrap()
            .to_rgba8();
        assert_eq!(resized.dimensions(), (320, 480));
        assert_eq!(resized.get_pixel(0, 0)[3], 96);
        assert_eq!(fs::read(&path).unwrap(), original);
        assert_eq!(cache.cached(&path, 320), Some(result));
    }

    #[test]
    fn never_upscales_and_rejects_unknown_widths() {
        let dir = tempfile::tempdir().unwrap();
        let path = source(dir.path(), 16, 24);
        let cache = ArtworkVariants::new(dir.path());
        let result = cache.generate(&path, 1920).unwrap().unwrap();
        let result = image::load_from_memory(&fs::read(result).unwrap()).unwrap();
        assert_eq!((result.width(), result.height()), (16, 24));
        assert!(cache.generate(&path, 999).is_err());
    }

    #[test]
    fn tall_artwork_has_bounded_output_and_preserves_aspect_ratio() {
        let dir = tempfile::tempdir().unwrap();
        let path = source(dir.path(), 240, 4800);
        let cache = ArtworkVariants::new(dir.path());
        let generated = cache.generate(&path, 1920).unwrap().unwrap();
        let result = image::load_from_memory(&fs::read(generated).unwrap()).unwrap();
        assert_eq!((result.width(), result.height()), (96, 1920));
        let generated = cache.generate(&path, 96).unwrap().unwrap();
        let result = image::load_from_memory(&fs::read(generated).unwrap()).unwrap();
        assert_eq!((result.width(), result.height()), (96, 1920));
    }

    #[test]
    fn source_changes_invalidate_cached_variants() {
        let dir = tempfile::tempdir().unwrap();
        let path = source(dir.path(), 16, 24);
        let cache = ArtworkVariants::new(dir.path());
        let first = cache.generate(&path, 96).unwrap().unwrap();
        source(dir.path(), 32, 48);
        assert!(cache.cached(&path, 96).is_none());
        let second = cache.generate(&path, 96).unwrap().unwrap();
        assert_ne!(first, second);
    }

    #[test]
    fn opaque_artwork_uses_compact_jpeg() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("photo.png");
        image::RgbImage::from_pixel(640, 960, image::Rgb([50, 100, 150]))
            .save(&path)
            .unwrap();
        let cache = ArtworkVariants::new(dir.path());
        let generated = cache.generate(&path, 320).unwrap().unwrap();
        assert_eq!(
            image::guess_format(&fs::read(generated).unwrap()).unwrap(),
            ImageFormat::Jpeg
        );
    }

    #[test]
    fn busy_generator_returns_fallback_but_cached_results_remain_available() {
        let dir = tempfile::tempdir().unwrap();
        let path = source(dir.path(), 16, 24);
        let cache = ArtworkVariants::new(dir.path());
        let cached = cache.generate(&path, 96).unwrap();
        let _busy = cache.gate.lock().unwrap();
        assert!(cache.clone().generate(&path, 320).unwrap().is_none());
        assert_eq!(cache.generate(&path, 96).unwrap(), cached);
    }

    #[test]
    fn rejects_malformed_and_oversized_images_without_writing_cache() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("invalid.png");
        let cache = ArtworkVariants::new(dir.path());
        fs::write(&path, b"invalid image").unwrap();
        assert!(cache.generate(&path, 96).is_err());
        fs::File::create(&path)
            .unwrap()
            .set_len(MAX_BYTES + 1)
            .unwrap();
        assert!(cache.generate(&path, 96).is_err());
        assert!(!cache.directory.exists());
    }

    #[test]
    fn rejects_excessive_dimensions_before_decoding_pixels() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("oversized.gif");
        let mut header = b"GIF89a".to_vec();
        header.extend_from_slice(&10_000_u16.to_le_bytes());
        header.extend_from_slice(&10_000_u16.to_le_bytes());
        header.extend_from_slice(&[0, 0, 0, 0x3b]);
        fs::write(&path, header).unwrap();
        assert!(
            ArtworkVariants::new(dir.path())
                .generate(&path, 96)
                .is_err()
        );
    }

    #[test]
    fn backfill_reuses_variants_and_cleanup_preserves_referenced_files_and_originals() {
        let dir = tempfile::tempdir().unwrap();
        let path = source(dir.path(), 32, 48);
        let cache = ArtworkVariants::new(dir.path());
        assert_eq!(cache.generate_all(&path).unwrap(), WIDTHS.len());
        assert_eq!(cache.generate_all(&path).unwrap(), 0);
        let keep = cache.cached(&path, 96).unwrap();
        let remove = cache.cached(&path, 192).unwrap();
        let old = SystemTime::now() - Duration::from_secs(8 * 86400);
        let unrelated = cache.directory.join("original.png");
        fs::write(&unrelated, b"not a cache variant").unwrap();
        for file in [&keep, &remove, &unrelated] {
            fs::OpenOptions::new()
                .write(true)
                .open(file)
                .unwrap()
                .set_times(fs::FileTimes::new().set_modified(old))
                .unwrap();
        }
        cache.cleanup(&HashSet::from([keep.clone()])).unwrap();
        assert!(keep.is_file());
        assert!(!remove.exists());
        assert!(path.is_file());
        assert!(unrelated.is_file());
        assert!(cache.cached(&path, 320).is_some());
    }
}
