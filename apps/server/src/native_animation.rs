//! Animated originals plus static fallbacks. Video audio never reaches a client.
use crate::AppState;
use std::{
    fs,
    io::Cursor,
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

pub(crate) fn is_webm(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0x1a, 0x45, 0xdf, 0xa3])
        && bytes[..bytes.len().min(4096)]
            .windows(7)
            .any(|v| v == b"\x42\x82\x84webm")
}
pub(crate) fn is_animated(bytes: &[u8]) -> bool {
    is_webm(bytes) || bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")
}
fn run(command: &mut Command) -> Result<(), String> {
    let mut child = command
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Animated WebM artwork requires ffmpeg and ffprobe.".to_string())?;
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            return if status.success() {
                Ok(())
            } else {
                Err("Unable to validate or prepare animated artwork.".into())
            };
        }
        if start.elapsed() > Duration::from_secs(30) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Animated artwork processing timed out.".into());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}
pub(crate) fn prepare(bytes: &[u8]) -> Result<(Vec<u8>, Vec<u8>, &'static str), String> {
    if bytes.len() > 20 * 1024 * 1024 {
        return Err("Artwork exceeds 20 MB.".into());
    }
    if !is_webm(bytes) {
        let mut reader = image::ImageReader::new(Cursor::new(bytes))
            .with_guessed_format()
            .map_err(|_| "Invalid artwork.")?;
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(8192);
        limits.max_image_height = Some(8192);
        limits.max_alloc = Some(256 * 1024 * 1024);
        reader.limits(limits);
        let image = reader
            .decode()
            .map_err(|_| "Invalid or oversized animated image.")?;
        let mut still = Cursor::new(Vec::new());
        image
            .thumbnail(1920, 1920)
            .write_to(&mut still, image::ImageFormat::Png)
            .map_err(|e| e.to_string())?;
        return Ok((bytes.to_vec(), still.into_inner(), "gif"));
    }
    let dir = tempfile::tempdir().map_err(|e| e.to_string())?;
    let input = dir.path().join("input.webm");
    let output = dir.path().join("silent.webm");
    let probe = dir.path().join("probe.json");
    let still = dir.path().join("still.png");
    fs::write(&input, bytes).map_err(|e| e.to_string())?;
    run(Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-show_entries",
            "stream=codec_type,codec_name,width,height:format=duration",
            "-of",
            "json",
        ])
        .arg(&input)
        .stdout(Stdio::from(
            fs::File::create(&probe).map_err(|e| e.to_string())?,
        )))?;
    let data: serde_json::Value =
        serde_json::from_slice(&fs::read(&probe).map_err(|e| e.to_string())?)
            .map_err(|_| "Invalid WebM metadata.")?;
    let streams = data["streams"]
        .as_array()
        .ok_or("WebM has no video stream.")?;
    let video = streams
        .iter()
        .find(|s| s["codec_type"] == "video")
        .ok_or("WebM has no video stream.")?;
    if !["vp8", "vp9", "av1"].contains(&video["codec_name"].as_str().unwrap_or(""))
        || video["width"].as_u64().unwrap_or(0) == 0
        || video["height"].as_u64().unwrap_or(0) == 0
        || video["width"]
            .as_u64()
            .unwrap_or(u64::MAX)
            .saturating_mul(video["height"].as_u64().unwrap_or(u64::MAX))
            > 16_000_000
    {
        return Err("Use VP8, VP9, or AV1 WebM artwork up to 16 megapixels.".into());
    }
    let duration = data["format"]["duration"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .ok_or("WebM artwork must have a finite duration.")?;
    if !duration.is_finite() || duration <= 0.0 || duration > 120.0 {
        return Err("WebM artwork must be at most two minutes long.".into());
    }
    let audio = streams.iter().any(|s| s["codec_type"] == "audio");
    if audio {
        run(Command::new("ffmpeg")
            .args([
                "-v",
                "error",
                "-nostdin",
                "-y",
                "-protocol_whitelist",
                "file,pipe",
                "-i",
            ])
            .arg(&input)
            .args([
                "-map",
                "0:v:0",
                "-c:v",
                "copy",
                "-an",
                "-sn",
                "-dn",
                "-map_metadata",
                "-1",
                "-f",
                "webm",
            ])
            .arg(&output)
            .stdout(Stdio::null()))?;
    }
    let silent = if audio { &output } else { &input };
    run(Command::new("ffmpeg")
        .args([
            "-v",
            "error",
            "-nostdin",
            "-y",
            "-protocol_whitelist",
            "file,pipe",
            "-i",
        ])
        .arg(silent)
        .args([
            "-map",
            "0:v:0",
            "-frames:v",
            "1",
            "-an",
            "-vf",
            "scale=w='min(1920,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease",
        ])
        .arg(&still)
        .stdout(Stdio::null()))?;
    let clean = fs::read(silent).map_err(|e| e.to_string())?;
    if clean.len() > 20 * 1024 * 1024 {
        return Err("Prepared artwork exceeds 20 MB.".into());
    }
    Ok((clean, fs::read(still).map_err(|e| e.to_string())?, "webm"))
}
/// Cache a sanitized local original and its first frame without modifying user files.
pub(crate) fn local(
    state: &AppState,
    path: &Path,
    bytes: &[u8],
    still: bool,
) -> Result<Vec<u8>, String> {
    use std::hash::{Hash, Hasher};
    static CACHE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _lock = CACHE_LOCK
        .lock()
        .map_err(|_| "Animated artwork cache interrupted.")?;
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hash);
    bytes.hash(&mut hash);
    let dir = state.runtime.data_dir().join("native-animation-cache");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let key = format!("{:x}", hash.finish());
    let original = dir.join(format!("{key}.original"));
    let frame = dir.join(format!("{key}.png"));
    if !original.exists() || !frame.exists() {
        let (clean, fallback, _) = prepare(bytes)?;
        fs::write(&frame, fallback).map_err(|e| e.to_string())?;
        fs::write(&original, clean).map_err(|e| e.to_string())?;
    }
    fs::read(if still { frame } else { original }).map_err(|e| e.to_string())
}

pub(crate) fn byte_range(range: &str, total: usize) -> Option<(usize, usize)> {
    let (start, end) = range.strip_prefix("bytes=")?.split_once('-')?;
    if total == 0 {
        return None;
    }
    if start.is_empty() {
        let suffix = end.parse::<usize>().ok()?;
        return (suffix > 0).then_some((total.saturating_sub(suffix), total - 1));
    }
    let start = start.parse::<usize>().ok()?;
    let end = if end.is_empty() {
        total - 1
    } else {
        end.parse::<usize>().ok()?.min(total - 1)
    };
    (start <= end && start < total).then_some((start, end))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ranges_are_bounded() {
        assert_eq!(byte_range("bytes=1-3", 10), Some((1, 3)));
        assert_eq!(byte_range("bytes=8-", 10), Some((8, 9)));
        assert_eq!(byte_range("bytes=-2", 10), Some((8, 9)));
        assert_eq!(byte_range("bytes=0-100", 10), Some((0, 9)));
        assert_eq!(byte_range("bytes=10-", 10), None);
        assert_eq!(byte_range("bytes=0-1,3-4", 10), None);
    }
    fn gif() -> Vec<u8> {
        let mut bytes = Vec::new();
        let mut encoder = image::codecs::gif::GifEncoder::new(&mut bytes);
        encoder
            .set_repeat(image::codecs::gif::Repeat::Infinite)
            .unwrap();
        encoder
            .encode_frame(image::Frame::new(image::RgbaImage::from_pixel(
                2,
                2,
                image::Rgba([255, 0, 0, 255]),
            )))
            .unwrap();
        drop(encoder);
        bytes
    }
    #[test]
    fn gif_original_and_static_fallback_are_stored_separately() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::native::scan_tests::state(temp.path());
        let bytes = gif();
        let path = crate::native_provider::store_image(&state, &bytes).unwrap();
        assert!(path.ends_with(".gif"));
        let name = path.strip_prefix("@managed/").unwrap();
        let dir = state.runtime.data_dir().join("native-artwork");
        assert_eq!(fs::read(dir.join(name)).unwrap(), bytes);
        let fallback = dir.join(format!("{}.still.png", name.trim_end_matches(".gif")));
        assert_eq!(
            image::guess_format(&fs::read(fallback).unwrap()).unwrap(),
            image::ImageFormat::Png
        );
        assert!(prepare(b"GIF89a invalid").is_err());
    }
    #[tokio::test]
    async fn animated_artwork_serves_original_and_fallback_for_all_native_types() {
        use posterview_contracts::native::*;
        let temp = tempfile::tempdir().unwrap();
        let state = crate::native::scan_tests::state(temp.path());
        fs::create_dir_all(temp.path().join("media/Shows/Example")).unwrap();
        let db = posterview_infra_sqlite::ServerStore::new(state.runtime.data_dir());
        let library = db
            .save_native_library(
                None,
                &NativeLibraryInput {
                    name: "Shows".into(),
                    library_type: NativeLibraryType::Shows,
                    anime_content: AnimeContent::Both,
                    paths: vec!["Shows".into()],
                    revision: None,
                    options: Default::default(),
                },
            )
            .unwrap();
        let entry = NativeCatalogEntry {
            id: "".into(),
            path: "Shows/Example".into(),
            kind: "series".into(),
            parent_path: None,
            title: "Example".into(),
            metadata: serde_json::json!({}),
            artwork: vec![],
            files: vec![],
            nfo_path: None,
            nfo_xml: None,
            available: true,
            revision: 1,
        };
        db.ingest_native_catalog(&library.id, library.revision, &[entry])
            .unwrap();
        let entry = db.native_catalog(&library.id).unwrap().remove(0);
        let bytes = gif();
        let managed = crate::native_provider::store_image(&state, &bytes).unwrap();
        for (kind, filename) in [
            ("poster", "poster.gif"),
            ("backdrop", "fanart.gif"),
            ("banner", "banner.gif"),
            ("logo", "clearlogo.gif"),
            ("landscape", "landscape.gif"),
            ("thumb", "landscape.gif"),
            ("disc", "disc.gif"),
        ] {
            let art = NativeArtwork {
                kind: kind.into(),
                path: managed.clone(),
                source: "manual".into(),
            };
            db.save_native_artwork(&library.id, &entry.id, &art)
                .unwrap();
            crate::native_artwork::write(&state, &entry, &art, true).unwrap();
            assert_eq!(
                fs::read(temp.path().join("media/Shows/Example").join(filename)).unwrap(),
                bytes
            );
            let (status, headers, original) = crate::native::artwork(
                axum::extract::State(state.clone()),
                axum::extract::Path((library.id.clone(), entry.id.clone(), kind.into())),
                axum::extract::Query(Default::default()),
                Default::default(),
            )
            .await
            .unwrap();
            assert_eq!(status, axum::http::StatusCode::OK);
            assert_eq!(headers[axum::http::header::CONTENT_TYPE], "image/gif");
            assert_eq!(original, bytes);
            let (_, headers, frame) = crate::native::artwork(
                axum::extract::State(state.clone()),
                axum::extract::Path((library.id.clone(), entry.id.clone(), kind.into())),
                axum::extract::Query([("still".into(), "1".into())].into_iter().collect()),
                Default::default(),
            )
            .await
            .unwrap();
            assert_eq!(headers[axum::http::header::CONTENT_TYPE], "image/png");
            assert_eq!(
                image::guess_format(&frame).unwrap(),
                image::ImageFormat::Png
            );
        }
    }
    #[test]
    fn webm_audio_is_removed_and_local_original_is_untouched() {
        if Command::new("ffmpeg")
            .arg("-version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_err()
        {
            eprintln!("FFmpeg unavailable; WebM integration requires the Docker runtime.");
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let input = temp.path().join("with-audio.webm");
        run(Command::new("ffmpeg")
            .args([
                "-v",
                "error",
                "-nostdin",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=red:s=32x48:d=1",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=1",
                "-c:v",
                "libvpx-vp9",
                "-c:a",
                "libopus",
                "-shortest",
            ])
            .arg(&input)
            .stdout(Stdio::null()))
        .unwrap();
        let bytes = fs::read(&input).unwrap();
        let (clean, still, ext) = prepare(&bytes).unwrap();
        assert_eq!(ext, "webm");
        assert!(is_webm(&clean));
        assert_eq!(
            image::guess_format(&still).unwrap(),
            image::ImageFormat::Png
        );
        let output = temp.path().join("silent.webm");
        fs::write(&output, &clean).unwrap();
        let result = Command::new("ffprobe")
            .args([
                "-v",
                "error",
                "-show_entries",
                "stream=codec_type",
                "-of",
                "json",
            ])
            .arg(&output)
            .output()
            .unwrap();
        let data: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
        assert!(
            data["streams"]
                .as_array()
                .unwrap()
                .iter()
                .all(|s| s["codec_type"] == "video")
        );
        assert_eq!(prepare(&clean).unwrap().0, clean);
        let state = crate::native::scan_tests::state(temp.path());
        let cached = local(&state, &input, &bytes, false).unwrap();
        assert_eq!(prepare(&cached).unwrap().0, cached);
        assert_eq!(local(&state, &input, &bytes, false).unwrap(), cached);
        assert_eq!(local(&state, &input, &bytes, true).unwrap(), still);
        assert_eq!(fs::read(&input).unwrap(), bytes);
    }
}
