use serde::{Serialize, de::DeserializeOwned};
use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    io,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

const METADATA_DIR: &str = "metadata";
const IMAGE_DIR: &str = "images";

#[derive(Debug)]
pub struct ArtworkCache {
    root: PathBuf,
    lock: Mutex<()>,
}

#[derive(Debug, serde::Deserialize, Serialize)]
struct Envelope<T> {
    #[serde(default)]
    key: String,
    cached_at: u64,
    accessed_at: u64,
    value: T,
}

#[derive(Debug, serde::Deserialize, Serialize)]
struct ImageMeta {
    #[serde(default)]
    key: String,
    cached_at: u64,
    accessed_at: u64,
    content_type: String,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct CacheUsage {
    pub bytes: u64,
    pub files: usize,
}

impl ArtworkCache {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            root: data_dir.join("artwork-cache"),
            lock: Mutex::new(()),
        }
    }

    pub fn initialize(&self) -> io::Result<()> {
        fs::create_dir_all(self.root.join(METADATA_DIR))?;
        fs::create_dir_all(self.root.join(IMAGE_DIR))
    }

    pub fn get_json<T: DeserializeOwned + Serialize>(&self, key: &str, ttl_days: i64) -> Option<T> {
        let _guard = self.lock.lock().ok()?;
        let path = self.metadata_path(key);
        let bytes = fs::read(&path).ok()?;
        let mut envelope: Envelope<T> = serde_json::from_slice(&bytes).ok()?;
        if expired(envelope.cached_at, ttl_days) {
            let _ = fs::remove_file(path);
            return None;
        }
        envelope.accessed_at = now();
        if let Ok(updated) = serde_json::to_vec(&envelope) {
            let _ = atomic_write(&path, &updated);
        }
        Some(envelope.value)
    }

    pub fn has_fresh_json(&self, key: &str, ttl_days: i64) -> bool {
        let Ok(_guard) = self.lock.lock() else {
            return false;
        };
        let path = self.metadata_path(key);
        let Ok(bytes) = fs::read(&path) else {
            return false;
        };
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            return false;
        };
        let cached_at = value
            .get("cached_at")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        if expired(cached_at, ttl_days) {
            let _ = fs::remove_file(path);
            return false;
        }
        true
    }

    pub fn put_json<T: Serialize>(
        &self,
        key: &str,
        value: &T,
        max_mb: i64,
        ttl_days: i64,
    ) -> io::Result<()> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| io::Error::other("cache lock poisoned"))?;
        self.initialize()?;
        let timestamp = now();
        let bytes = serde_json::to_vec(&Envelope {
            key: key.to_owned(),
            cached_at: timestamp,
            accessed_at: timestamp,
            value,
        })?;
        atomic_write(&self.metadata_path(key), &bytes)?;
        self.prune_locked(max_mb, ttl_days)?;
        Ok(())
    }

    pub fn get_image(&self, key: &str, ttl_days: i64) -> Option<(Vec<u8>, String)> {
        let _guard = self.lock.lock().ok()?;
        let (data_path, meta_path) = self.image_paths(key);
        let mut meta: ImageMeta = serde_json::from_slice(&fs::read(&meta_path).ok()?).ok()?;
        if expired(meta.cached_at, ttl_days) {
            let _ = fs::remove_file(data_path);
            let _ = fs::remove_file(meta_path);
            return None;
        }
        let bytes = fs::read(data_path).ok()?;
        meta.accessed_at = now();
        if let Ok(updated) = serde_json::to_vec(&meta) {
            let _ = atomic_write(&meta_path, &updated);
        }
        Some((bytes, meta.content_type))
    }

    pub fn put_image(
        &self,
        key: &str,
        bytes: &[u8],
        content_type: &str,
        max_mb: i64,
        ttl_days: i64,
    ) -> io::Result<()> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| io::Error::other("cache lock poisoned"))?;
        self.initialize()?;
        let (data_path, meta_path) = self.image_paths(key);
        let timestamp = now();
        atomic_write(&data_path, bytes)?;
        atomic_write(
            &meta_path,
            &serde_json::to_vec(&ImageMeta {
                key: key.to_owned(),
                cached_at: timestamp,
                accessed_at: timestamp,
                content_type: content_type.to_owned(),
            })?,
        )?;
        self.prune_locked(max_mb, ttl_days)?;
        Ok(())
    }

    pub fn usage(&self) -> io::Result<CacheUsage> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| io::Error::other("cache lock poisoned"))?;
        usage_for(&self.root)
    }

    pub fn clear(&self) -> io::Result<CacheUsage> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| io::Error::other("cache lock poisoned"))?;
        let usage = usage_for(&self.root)?;
        if self.root.exists() {
            fs::remove_dir_all(&self.root)?;
        }
        self.initialize()?;
        Ok(usage)
    }

    pub fn prune(&self, max_mb: i64, ttl_days: i64) -> io::Result<()> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| io::Error::other("cache lock poisoned"))?;
        self.prune_locked(max_mb, ttl_days)
    }

    pub fn remove_matching(&self, pattern: &str) -> io::Result<CacheUsage> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| io::Error::other("cache lock poisoned"))?;
        let mut removed = CacheUsage::default();
        for entry in cache_entries(&self.root)? {
            if entry.key.contains(pattern) {
                removed.bytes += entry.bytes;
                removed.files += 1;
                remove_entry(&entry);
            }
        }
        Ok(removed)
    }

    fn prune_locked(&self, max_mb: i64, ttl_days: i64) -> io::Result<()> {
        let mut entries = cache_entries(&self.root)?;
        for entry in &entries {
            if expired(entry.accessed_at.max(entry.cached_at), ttl_days) {
                remove_entry(entry);
            }
        }
        entries = cache_entries(&self.root)?;
        let limit = max_mb.max(0) as u64 * 1024 * 1024;
        let mut used = entries.iter().map(|entry| entry.bytes).sum::<u64>();
        entries.sort_by_key(|entry| entry.accessed_at);
        for entry in entries {
            if used <= limit {
                break;
            }
            remove_entry(&entry);
            used = used.saturating_sub(entry.bytes);
        }
        Ok(())
    }

    fn metadata_path(&self, key: &str) -> PathBuf {
        self.root
            .join(METADATA_DIR)
            .join(format!("{:016x}.json", hash(key)))
    }

    fn image_paths(&self, key: &str) -> (PathBuf, PathBuf) {
        let stem = format!("{:016x}", hash(key));
        (
            self.root.join(IMAGE_DIR).join(format!("{stem}.bin")),
            self.root.join(IMAGE_DIR).join(format!("{stem}.json")),
        )
    }
}

#[derive(Debug)]
struct CacheEntry {
    key: String,
    paths: Vec<PathBuf>,
    bytes: u64,
    cached_at: u64,
    accessed_at: u64,
}

fn cache_entries(root: &Path) -> io::Result<Vec<CacheEntry>> {
    let mut entries = Vec::new();
    let metadata = root.join(METADATA_DIR);
    if metadata.exists() {
        for item in fs::read_dir(metadata)? {
            let path = item?.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let bytes = fs::read(&path)?;
            let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or_default();
            entries.push(CacheEntry {
                key: value
                    .get("key")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                bytes: bytes.len() as u64,
                cached_at: value
                    .get("cached_at")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0),
                accessed_at: value
                    .get("accessed_at")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0),
                paths: vec![path],
            });
        }
    }
    let images = root.join(IMAGE_DIR);
    if images.exists() {
        for item in fs::read_dir(&images)? {
            let meta_path = item?.path();
            if meta_path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let stem = meta_path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or_default();
            let data_path = images.join(format!("{stem}.bin"));
            let meta_bytes = fs::read(&meta_path)?;
            let meta: ImageMeta = serde_json::from_slice(&meta_bytes).unwrap_or(ImageMeta {
                key: String::new(),
                cached_at: 0,
                accessed_at: 0,
                content_type: String::new(),
            });
            let data_bytes = fs::metadata(&data_path)
                .map(|value| value.len())
                .unwrap_or(0);
            entries.push(CacheEntry {
                key: meta.key,
                paths: vec![data_path, meta_path],
                bytes: data_bytes + meta_bytes.len() as u64,
                cached_at: meta.cached_at,
                accessed_at: meta.accessed_at,
            });
        }
    }
    Ok(entries)
}

fn usage_for(root: &Path) -> io::Result<CacheUsage> {
    let entries = cache_entries(root)?;
    Ok(CacheUsage {
        bytes: entries.iter().map(|entry| entry.bytes).sum(),
        files: entries.len(),
    })
}

fn remove_entry(entry: &CacheEntry) {
    for path in &entry.paths {
        let _ = fs::remove_file(path);
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let temp = path.with_extension("tmp");
    fs::write(&temp, bytes)?;
    if path.exists() {
        fs::remove_file(path)?;
    }
    fs::rename(temp, path)
}

fn hash(value: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    value.hash(&mut hasher);
    hasher.finish()
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs())
}

fn expired(cached_at: u64, ttl_days: i64) -> bool {
    ttl_days <= 0 || now().saturating_sub(cached_at) > ttl_days as u64 * 86_400
}

#[cfg(test)]
mod tests {
    use super::ArtworkCache;

    #[test]
    fn stores_reads_and_clears_json_and_images() {
        let temp = tempfile::tempdir().expect("temp directory");
        let cache = ArtworkCache::new(temp.path());
        cache.initialize().expect("initialize cache");
        cache
            .put_json("result", &vec!["poster"], 250, 30)
            .expect("store json");
        assert_eq!(
            cache.get_json::<Vec<String>>("result", 30),
            Some(vec!["poster".to_owned()])
        );
        cache
            .put_image("image", b"jpeg", "image/jpeg", 250, 30)
            .expect("store image");
        assert_eq!(
            cache.get_image("image", 30),
            Some((b"jpeg".to_vec(), "image/jpeg".to_owned()))
        );
        assert!(cache.usage().expect("usage").bytes > 0);
        let cleared = cache.clear().expect("clear");
        assert!(cleared.bytes > 0);
        assert_eq!(cache.usage().expect("empty usage").bytes, 0);
    }
}
