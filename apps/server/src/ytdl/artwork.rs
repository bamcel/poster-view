//! Channel-owned artwork, separate from video thumbnails.
use super::{HttpError, err};
use serde_json::Value;
use std::{
    io::{Cursor, Write},
    path::Path,
    time::Duration,
};

const MAX_BYTES: usize = 20 * 1024 * 1024;

fn banner_url(channel: &Value) -> Option<reqwest::Url> {
    channel["thumbnails"]
        .as_array()?
        .iter()
        .filter_map(|thumbnail| {
            let url = reqwest::Url::parse(thumbnail["url"].as_str()?).ok()?;
            let host = url.host_str()?;
            if url.scheme() != "https"
                || url.port_or_known_default() != Some(443)
                || !url.username().is_empty()
                || url.password().is_some()
                || !(host == "yt3.googleusercontent.com" || host == "yt3.ggpht.com")
            {
                return None;
            }
            let width = thumbnail["width"].as_u64().unwrap_or(0);
            let height = thumbnail["height"].as_u64().unwrap_or(0);
            let id = thumbnail["id"].as_str().unwrap_or_default();
            if !(id.contains("banner") || height > 0 && width > height.saturating_mul(2)) {
                return None;
            }
            Some((
                (id.contains("uncropped"), width.saturating_mul(height)),
                url,
            ))
        })
        .max_by_key(|(rank, _)| *rank)
        .map(|(_, url)| url)
}

fn has_banner(directory: &Path) -> Result<bool, HttpError> {
    for entry in std::fs::read_dir(directory).map_err(err)? {
        let path = entry.map_err(err)?.path();
        let stem = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if stem == "banner" {
            return Ok(true);
        }
    }
    Ok(false)
}

fn persist(directory: &Path, bytes: &[u8]) -> Result<(), HttpError> {
    if has_banner(directory)? {
        return Ok(());
    }
    let reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(err)?;
    let (width, height) = reader.into_dimensions().map_err(err)?;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 64_000_000 {
        return Err(err("Channel banner exceeds artwork dimensions."));
    }
    let image =
        image::DynamicImage::ImageRgb8(image::load_from_memory(bytes).map_err(err)?.to_rgb8());
    let mut encoded = Cursor::new(Vec::new());
    image
        .write_to(&mut encoded, image::ImageFormat::Jpeg)
        .map_err(err)?;
    let temporary = directory.join(format!(".channel-banner-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(err)?;
        file.write_all(encoded.get_ref()).map_err(err)?;
        file.sync_all().map_err(err)?;
        // Linking publishes a complete image atomically without replacing existing artwork.
        if !has_banner(directory)? {
            match std::fs::hard_link(&temporary, directory.join("banner.jpg")) {
                Ok(()) => (),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
                Err(error) => return Err(err(error)),
            }
        }
        Ok(())
    })();
    let _ = std::fs::remove_file(temporary);
    result
}

pub(super) async fn download(directory: &Path, channel: &Value) -> Result<(), HttpError> {
    if has_banner(directory)? {
        return Ok(());
    }
    let Some(url) = banner_url(channel) else {
        return Ok(());
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(err)?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(err)?
        .error_for_status()
        .map_err(err)?;
    if response
        .content_length()
        .is_some_and(|length| length > MAX_BYTES as u64)
    {
        return Err(err("Channel banner exceeds 20 MB."));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(err)? {
        if bytes.len().saturating_add(chunk.len()) > MAX_BYTES {
            return Err(err("Channel banner exceeds 20 MB."));
        }
        bytes.extend_from_slice(&chunk);
    }
    persist(directory, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn selects_uncropped_banner_and_rejects_avatar_and_untrusted_urls() {
        let value = json!({"thumbnails":[
            {"url":"https://yt3.googleusercontent.com/avatar", "width":900,"height":900},
            {"url":"https://yt3.googleusercontent.com/banner", "width":2000,"height":300},
            {"url":"https://yt3.ggpht.com/full", "id":"banner_uncropped", "width":2500,"height":1400},
            {"url":"https://example.com/wrong", "id":"banner_uncropped", "width":9000,"height":9000}
        ]});
        assert_eq!(banner_url(&value).unwrap().path(), "/full");
        assert!(banner_url(&json!({"thumbnails":[{"url":"https://yt3.googleusercontent.com/avatar","width":900,"height":900}]})).is_none());
    }
    #[test]
    fn saves_full_image_without_replacing_custom_artwork_and_rejects_invalid_data() {
        let directory = tempfile::tempdir().unwrap();
        assert!(persist(directory.path(), b"invalid image").is_err());
        let mut image = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(256, 64)
            .write_to(&mut image, image::ImageFormat::Png)
            .unwrap();
        persist(directory.path(), image.get_ref()).unwrap();
        assert_eq!(
            image::open(directory.path().join("banner.jpg"))
                .unwrap()
                .width(),
            256
        );
        std::fs::write(directory.path().join("banner.jpg"), b"custom").unwrap();
        persist(directory.path(), image.get_ref()).unwrap();
        assert_eq!(
            std::fs::read(directory.path().join("banner.jpg")).unwrap(),
            b"custom"
        );
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn preserves_existing_banner_formats_and_backdrops() {
        for name in ["banner.jpg", "banner.png", "banner.webp", "Banner.JPEG"] {
            let directory = tempfile::tempdir().unwrap();
            std::fs::write(directory.path().join(name), b"custom banner").unwrap();
            persist(directory.path(), b"not decoded when banner exists").unwrap();
            assert_eq!(
                std::fs::read(directory.path().join(name)).unwrap(),
                b"custom banner"
            );
            assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
        }

        let directory = tempfile::tempdir().unwrap();
        for name in ["backdrop.jpg", "fanart.jpg", "background.png"] {
            std::fs::write(directory.path().join(name), name.as_bytes()).unwrap();
        }
        let mut image = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(256, 64)
            .write_to(&mut image, image::ImageFormat::Png)
            .unwrap();
        persist(directory.path(), image.get_ref()).unwrap();
        let saved = image::open(directory.path().join("banner.jpg")).unwrap();
        assert_eq!((saved.width(), saved.height()), (256, 64));
        for name in ["backdrop.jpg", "fanart.jpg", "background.png"] {
            assert_eq!(
                std::fs::read(directory.path().join(name)).unwrap(),
                name.as_bytes()
            );
        }
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 4);
    }
}
