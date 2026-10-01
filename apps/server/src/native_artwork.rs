use crate::AppState;
use posterview_contracts::native::{NativeArtwork, NativeCatalogEntry};
use std::{fs, io::Cursor, path::Path};

fn destination(entry: &NativeCatalogEntry, kind: &str) -> Result<(String, String), String> {
    let name = match kind {
        "poster" => "poster.jpg",
        "backdrop" => "fanart.jpg",
        "landscape" | "thumb" => "landscape.jpg",
        "logo" => "clearlogo.png",
        "banner" => "banner.jpg",
        "disc" => "disc.png",
        _ => return Err("Unknown artwork type.".into()),
    };
    if entry.kind == "season" {
        let parent = entry
            .parent_path
            .as_ref()
            .ok_or("Season has no series folder.")?;
        let season = entry.metadata["season"]
            .as_u64()
            .ok_or("Season has no number.")?;
        return Ok((parent.clone(), format!("season{season:02}-{name}")));
    }
    if ["series", "book_series"].contains(&entry.kind.as_str()) {
        return Ok((entry.path.clone(), name.into()));
    }
    let path = Path::new(&entry.path);
    let folder = path
        .parent()
        .ok_or("Media has no parent folder.")?
        .to_string_lossy()
        .replace('\\', "/");
    if entry.kind == "episode" || entry.kind == "book" {
        let stem = path
            .file_stem()
            .ok_or("Media has no filename.")?
            .to_string_lossy();
        return Ok((
            folder,
            if ["thumb", "landscape", "poster"].contains(&kind) {
                format!("{stem}.jpg")
            } else {
                format!("{stem}-{name}")
            },
        ));
    }
    Ok((folder, name.into()))
}

/// Keep the managed original authoritative; write a correctly encoded, atomic sidecar copy.
/// Automatic scans never replace a user's existing media-folder image.
pub(crate) fn write(
    state: &AppState,
    entry: &NativeCatalogEntry,
    art: &NativeArtwork,
    replace: bool,
) -> Result<(), String> {
    let Some(managed) = art.path.strip_prefix("@managed/") else {
        return Ok(());
    };
    if !matches!(
        (
            Path::new(managed).components().next(),
            Path::new(managed).components().nth(1)
        ),
        (Some(std::path::Component::Normal(_)), None)
    ) || managed.contains(['/', '\\'])
    {
        return Err("Invalid managed artwork path.".into());
    }
    let (folder, name) = destination(entry, &art.kind)?;
    let directory = state
        .metadata
        .directory(&folder, true)
        .map_err(|e| e.detail)?;
    // A flat movie folder needs filename-prefixed sidecars to avoid title collisions.
    let name = if entry.kind == "movie"
        && fs::read_dir(&directory)
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .filter(|f| {
                f.file_type().is_ok_and(|t| t.is_file())
                    && f.path().extension().is_some_and(|e| {
                        matches!(
                            e.to_string_lossy().to_ascii_lowercase().as_str(),
                            "mkv"
                                | "mp4"
                                | "avi"
                                | "mov"
                                | "m4v"
                                | "webm"
                                | "ts"
                                | "mpg"
                                | "mpeg"
                                | "m2ts"
                        )
                    })
            })
            .take(2)
            .count()
            > 1
    {
        format!(
            "{}-{name}",
            Path::new(&entry.path)
                .file_stem()
                .ok_or("Media has no filename.")?
                .to_string_lossy()
        )
    } else {
        name
    };
    let target = directory.join(name);
    match fs::symlink_metadata(&target) {
        Ok(meta) => {
            if !meta.is_file()
                || meta.file_type().is_symlink()
                || target.canonicalize().map_err(|e| e.to_string())?.parent()
                    != Some(directory.as_path())
            {
                return Err(
                    "Artwork destination must be a regular file in the media folder.".into(),
                );
            }
            if !replace {
                return Ok(());
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    let bytes = fs::read(
        state
            .runtime
            .data_dir()
            .join("native-artwork")
            .join(managed),
    )
    .map_err(|e| e.to_string())?;
    if bytes.len() > 20 * 1024 * 1024 {
        return Err("Artwork exceeds 20 MB.".into());
    }
    let reader = image::ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let (width, height) = reader.into_dimensions().map_err(|e| e.to_string())?;
    if u64::from(width) * u64::from(height) > 64_000_000 {
        return Err("Artwork exceeds 64 megapixels.".into());
    }
    let image = image::load_from_memory(&bytes).map_err(|e| e.to_string())?;
    let mut encoded = Cursor::new(Vec::new());
    if target.extension().is_some_and(|e| e == "png") {
        image
            .write_to(&mut encoded, image::ImageFormat::Png)
            .map_err(|e| e.to_string())?;
    } else {
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut encoded, 95)
            .encode_image(&image.to_rgb8())
            .map_err(|e| e.to_string())?;
    }
    if fs::read(&target).ok().as_deref() == Some(encoded.get_ref().as_slice()) {
        return Ok(());
    }
    let mut temp = tempfile::NamedTempFile::new_in(&directory).map_err(|e| e.to_string())?;
    use std::io::Write;
    temp.write_all(encoded.get_ref())
        .map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    crate::native_monitor::own_write(&target, || {
        if replace {
            temp.persist(&target).map_err(|e| e.to_string())?;
        } else if let Err(e) = temp.persist_noclobber(&target) {
            if e.error.kind() != std::io::ErrorKind::AlreadyExists {
                return Err(e.to_string());
            }
        }
        Ok(())
    })?;
    Ok(())
}
