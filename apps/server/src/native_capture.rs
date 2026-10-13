//! Generate missing still thumbnails from local videos, without network access.
use crate::AppState;
use posterview_contracts::native::{NativeArtwork, NativeCatalogEntry, NativeLibrary};
use std::{
    fs,
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

fn eligible(library: &NativeLibrary, entry: &NativeCatalogEntry) -> bool {
    entry.available
        && matches!(entry.kind.as_str(), "episode" | "movie")
        && entry.metadata["missing"] != true
        && entry.metadata["_identify_replace_artwork"] != true
        && entry.metadata["_image_capture_attempted"] != true
        && library
            .options
            .image_types
            .iter()
            .any(|kind| kind == "thumb")
        && library
            .options
            .image_providers
            .get(&entry.kind)
            .is_some_and(|providers| providers.iter().any(|provider| provider == "capture"))
        && !entry
            .artwork
            .iter()
            .any(|art| matches!(art.kind.as_str(), "thumb" | "landscape"))
        && !entry.files.is_empty()
}

fn offset(info: &serde_json::Value) -> f64 {
    let duration = &info["format"]["duration"];
    duration
        .as_f64()
        .or_else(|| {
            duration
                .as_str()
                .and_then(|value| value.parse::<f64>().ok())
        })
        .filter(|seconds| seconds.is_finite() && *seconds > 0.0)
        .map_or(10.0, |seconds| seconds * 0.1)
}

fn extract(file: &Path, seconds: f64) -> Result<Vec<u8>, String> {
    let temp = tempfile::tempdir().map_err(|error| error.to_string())?;
    let target = temp.path().join("frame.jpg");
    let deadline = Instant::now() + Duration::from_secs(30);
    for position in [seconds, 0.0] {
        let mut child = Command::new("ffmpeg").args([
            "-nostdin", "-v", "error", "-y", "-protocol_whitelist", "file,pipe",
            "-threads", "1", "-ss", &format!("{position:.3}"), "-i",
        ]).arg(file).args([
            "-map", "0:V:0", "-an", "-sn", "-threads", "1", "-filter_threads", "1",
            "-vf", "scale=w='trunc(min(min(iw*sar,1280),720*dar)/2)*2':h='trunc(ow/dar/2)*2',setsar=1,thumbnail=24",
            "-frames:v", "1", "-q:v", "2",
        ]).arg(&target).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            .spawn().map_err(|_| "Image Capture requires ffmpeg.".to_string())?;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(25))
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("Video frame capture timed out or was interrupted.".into());
                }
            }
        };
        if status.success()
            && let Ok(bytes) = fs::read(&target)
            && !bytes.is_empty()
        {
            return Ok(bytes);
        }
        let _ = fs::remove_file(&target);
        if position == 0.0 {
            break;
        }
    }
    Err("Unable to extract a video frame.".into())
}

pub(crate) async fn capture(
    state: &AppState,
    library: &NativeLibrary,
    entry: &mut NativeCatalogEntry,
) -> Result<bool, String> {
    if !eligible(library, entry) {
        return Ok(false);
    }
    entry.metadata["_image_capture_attempted"] = serde_json::json!(true);
    let file = entry
        .files
        .iter()
        .find(|file| file["path"].is_string())
        .ok_or("Video file is unavailable.")?;
    let relative = file["path"].as_str().unwrap().to_string();
    let seconds = offset(&file["media_info"]);
    let state = state.clone();
    let path = tokio::task::spawn_blocking(move || {
        crate::workers::blocking(|| {
            let root = state
                .metadata
                .directory("", true)
                .map_err(|_| "Media folder is unavailable.")?;
            let file = root
                .join(relative)
                .canonicalize()
                .map_err(|_| "Video file is unavailable.")?;
            if !file.starts_with(&root) || !file.is_file() {
                return Err("Video file must be inside the media folder.".into());
            }
            let bytes = extract(&file, seconds)?;
            crate::native_provider::store_image(&state, &bytes)
        })
    })
    .await
    .map_err(|_| "Image Capture worker was interrupted.".to_string())??;
    entry.artwork.push(NativeArtwork {
        kind: "thumb".into(),
        path,
        source: "capture".into(),
    });
    // A newly generated image must be exported even if the media file was unchanged.
    if let Some(metadata) = entry.metadata.as_object_mut() {
        metadata.remove("_scan_unchanged");
    }
    Ok(true)
}

pub(crate) async fn fill_missing(
    state: &AppState,
    library: &NativeLibrary,
    entries: &mut [NativeCatalogEntry],
    warnings: &mut Vec<String>,
) {
    if !library
        .options
        .image_types
        .iter()
        .any(|kind| kind == "thumb")
        || !["episode", "movie"].iter().any(|kind| {
            library
                .options
                .image_providers
                .get(*kind)
                .is_some_and(|providers| providers.iter().any(|provider| provider == "capture"))
        })
        || !crate::plugins::artwork_enabled(state)
    {
        return;
    }
    let mut pending = entries
        .iter()
        .enumerate()
        .filter(|(_, entry)| eligible(library, entry))
        .map(|(index, _)| index)
        .collect::<Vec<_>>()
        .into_iter();
    let total = pending.len();
    if total == 0 {
        return;
    }
    let mut progress = crate::native_progress::Reporter::new(state, &library.id);
    let mut jobs = tokio::task::JoinSet::new();
    let mut completed = 0;
    progress.report("capturing", 0, Some(total), entries.len(), "", true);
    loop {
        while jobs.len() < crate::workers::media_limit() {
            let Some(index) = pending.next() else {
                break;
            };
            let state = state.clone();
            let library = library.clone();
            let mut entry = entries[index].clone();
            jobs.spawn(async move {
                let result = capture(&state, &library, &mut entry).await;
                (index, entry, result)
            });
        }
        let Some(result) = jobs.join_next().await else {
            break;
        };
        match result {
            Ok((index, entry, result)) => {
                if let Err(error) = result {
                    warnings.push(format!("{} (Image Capture): {error}", entry.title));
                }
                progress.report(
                    "capturing",
                    completed + 1,
                    Some(total),
                    entries.len(),
                    &entry.title,
                    true,
                );
                entries[index] = entry;
            }
            Err(error) => warnings.push(format!("Image Capture worker interrupted: {error}")),
        }
        completed += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use posterview_contracts::native::{
        AnimeContent, NativeLibraryInput, NativeLibraryOptions, NativeLibraryType,
    };
    use serde_json::json;

    fn library() -> NativeLibrary {
        let mut options = NativeLibraryOptions {
            fetch_missing: false,
            save_artwork: true,
            ..Default::default()
        };
        options
            .image_providers
            .insert("episode".into(), vec!["capture".into()]);
        options
            .image_providers
            .insert("movie".into(), vec!["capture".into()]);
        NativeLibrary {
            id: "test".into(),
            name: "Test".into(),
            library_type: NativeLibraryType::Shows,
            anime_content: AnimeContent::Both,
            paths: vec!["Shows".into()],
            revision: 1,
            options,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }
    fn episode() -> NativeCatalogEntry {
        NativeCatalogEntry {
            id: "episode".into(),
            path: "Shows/Test/Season 1/Test.S01E01.mkv".into(),
            kind: "episode".into(),
            parent_path: Some("Shows/Test/Season 1".into()),
            title: "Episode 1".into(),
            metadata: json!({}),
            artwork: vec![],
            files: vec![json!({"path":"Shows/Test/Season 1/Test.S01E01.mkv"})],
            nfo_path: None,
            nfo_xml: None,
            available: true,
            revision: 1,
        }
    }
    #[test]
    fn capture_is_opt_in_and_preserves_existing_images_and_tvdb_replacements() {
        let mut library = library();
        let mut entry = episode();
        assert!(eligible(&library, &entry));
        library.options.image_providers.clear();
        assert!(!eligible(&library, &entry));
        library = self::library();
        library.options.image_types.clear();
        assert!(!eligible(&library, &entry));
        library = self::library();
        entry.metadata["missing"] = json!(true);
        assert!(!eligible(&library, &entry));
        entry.metadata = json!({"_identify_replace_artwork":true});
        assert!(!eligible(&library, &entry));
        entry.metadata = json!({});
        for kind in ["thumb", "landscape"] {
            entry.artwork = vec![NativeArtwork {
                kind: kind.into(),
                path: "existing.jpg".into(),
                source: "manual".into(),
            }];
            assert!(!eligible(&library, &entry));
        }
    }
    #[test]
    fn seek_uses_ten_percent_and_handles_unknown_or_invalid_durations() {
        assert_eq!(offset(&json!({"format":{"duration":"1200"}})), 120.0);
        assert_eq!(offset(&json!({"format":{"duration":0.5}})), 0.05);
        for duration in [json!(null), json!("NaN"), json!(-1)] {
            assert_eq!(offset(&json!({"format":{"duration":duration}})), 10.0);
        }
    }
    #[tokio::test]
    async fn captured_thumbnail_survives_scans_and_saves_a_matching_sidecar() {
        if Command::new("ffmpeg")
            .arg("-version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_err()
        {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        let file = temp
            .path()
            .join("media/Shows/Test/Season 1/Test.S01E01.mkv");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        assert!(
            Command::new("ffmpeg")
                .args([
                    "-nostdin",
                    "-v",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "color=c=red:s=1600x900:r=24:d=0.5",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "ultrafast",
                    "-threads",
                    "1"
                ])
                .arg(&file)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap()
                .success()
        );
        let db = posterview_infra_sqlite::ServerStore::new(state.runtime.data_dir());
        let template = library();
        let library = db
            .save_native_library(
                None,
                &NativeLibraryInput {
                    name: template.name,
                    library_type: template.library_type,
                    anime_content: template.anime_content,
                    paths: template.paths,
                    options: template.options,
                    revision: None,
                },
            )
            .unwrap();
        let result = crate::native::run_scan(state.clone(), library.clone())
            .await
            .unwrap();
        assert!(result.warnings.is_empty(), "{:?}", result.warnings);
        let entry = db
            .native_catalog(&library.id)
            .unwrap()
            .into_iter()
            .find(|entry| entry.kind == "episode")
            .unwrap();
        let art = entry
            .artwork
            .iter()
            .find(|art| art.kind == "thumb")
            .unwrap();
        assert_eq!(art.source, "capture");
        let image = image::open(
            state
                .runtime
                .data_dir()
                .join("native-artwork")
                .join(art.path.strip_prefix("@managed/").unwrap()),
        )
        .unwrap();
        assert_eq!((image.width(), image.height()), (1280, 720));
        assert!(image.to_rgb8().pixels().next().unwrap()[0] > 200);
        let sidecar = file.with_file_name(format!(
            "{}-thumb.jpg",
            file.file_stem().unwrap().to_string_lossy()
        ));
        let before = fs::read(&sidecar).unwrap();
        let count = fs::read_dir(state.runtime.data_dir().join("native-artwork"))
            .unwrap()
            .count();
        crate::native::run_scan(state.clone(), library)
            .await
            .unwrap();
        assert_eq!(fs::read(sidecar).unwrap(), before);
        assert_eq!(
            fs::read_dir(state.runtime.data_dir().join("native-artwork"))
                .unwrap()
                .count(),
            count
        );
    }
    #[tokio::test]
    async fn a_file_outside_the_media_mount_is_rejected_without_capture() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        let outside = temp.path().join("outside.mkv");
        fs::write(&outside, b"not media").unwrap();
        let mut entry = episode();
        entry.files = vec![json!({"path":outside})];
        assert!(
            capture(&state, &library(), &mut entry)
                .await
                .unwrap_err()
                .contains("inside the media folder")
        );
        assert!(entry.artwork.is_empty());
    }
}
