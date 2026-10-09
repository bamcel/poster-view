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
    if entry.kind=="book" && entry.metadata["missing"]==true {
        let parent=entry.parent_path.as_ref().ok_or("Missing book has no series folder.")?;
        let (label,number)=if let Some(n)=entry.metadata["volume"].as_u64() {("volume",n)} else if let Some(n)=entry.metadata["chapter"].as_u64() {("chapter",n)} else {return Err("Missing book has no volume or chapter number.".into());};
        return Ok((format!("{parent}/.posterview-missing-artwork"),format!("{label}-{number:02}-{name}")));
    }
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

fn sidecar_name(entry:&NativeCatalogEntry,directory:&Path,name:String)->Result<String,String>{
    // A flat movie folder needs filename-prefixed sidecars to avoid title collisions.
    Ok(if entry.kind == "movie"
        && fs::read_dir(directory)
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
    })
}

/// Keep the managed original authoritative; write a correctly encoded, atomic sidecar copy.
/// Automatic scans never replace a user's existing media-folder image.
pub(crate) fn write(
    state: &AppState,
    entry: &NativeCatalogEntry,
    art: &NativeArtwork,
    replace: bool,
) -> Result<(), String> {
    if art.kind.ends_with("-animated") || art.path.ends_with(".gif") || art.path.ends_with(".webm") { return Ok(()); }
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
    if entry.kind=="book" && entry.metadata["missing"]==true {
        let parent=state.metadata.directory(entry.parent_path.as_deref().ok_or("Missing book has no series folder.")?,true).map_err(|e|e.detail)?;
        let pending=parent.join(".posterview-missing-artwork");
        match fs::symlink_metadata(&pending) {
            Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir()=>return Err("Missing artwork folder must be a regular directory.".into()),
            Ok(_)=>{},
            Err(e) if e.kind()==std::io::ErrorKind::NotFound=>fs::create_dir(&pending).map_err(|e|e.to_string())?,
            Err(e)=>return Err(e.to_string()),
        }
    }
    let directory = state
        .metadata
        .directory(&folder, true)
        .map_err(|e| e.detail)?;
    let name = sidecar_name(entry, &directory, name)?;
    let animated = managed.ends_with(".gif") || managed.ends_with(".webm");
    let name = if animated {
        Path::new(&name)
            .with_extension(Path::new(managed).extension().unwrap())
            .to_string_lossy()
            .into_owned()
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
    let mut encoded = Cursor::new(Vec::new());
    if animated {
        encoded = Cursor::new(bytes);
    } else {
        let reader = image::ImageReader::new(Cursor::new(&bytes))
            .with_guessed_format()
            .map_err(|e| e.to_string())?;
        let (width, height) = reader.into_dimensions().map_err(|e| e.to_string())?;
        if u64::from(width) * u64::from(height) > 64_000_000 {
            return Err("Artwork exceeds 64 megapixels.".into());
        }
        let image = image::load_from_memory(&bytes).map_err(|e| e.to_string())?;
        if target.extension().is_some_and(|e| e == "png") {
            image
                .write_to(&mut encoded, image::ImageFormat::Png)
                .map_err(|e| e.to_string())?;
        } else {
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut encoded, 95)
                .encode_image(&image.to_rgb8())
                .map_err(|e| e.to_string())?;
        }
    }
    if fs::read(&target).ok().as_deref() == Some(encoded.get_ref().as_slice()) {
        shared_artwork_permissions(&fs::File::open(&target).map_err(|e| e.to_string())?, &target)?;
        return Ok(());
    }
    let mut temp = tempfile::NamedTempFile::new_in(&directory).map_err(|e| e.to_string())?;
    use std::io::Write;
    temp.write_all(encoded.get_ref())
        .map_err(|e| e.to_string())?;
    shared_artwork_permissions(temp.as_file(), &target)?;
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

/// Remove only the recorded static sidecar, retaining a managed backup for recovery.
pub(crate) fn remove_static(state:&AppState,library:&str,entry:&NativeCatalogEntry,kind:&str)->Result<(),String>{
    let Some(art)=entry.artwork.iter().find(|a|a.kind==kind)else{return Ok(());};
    if art.path.ends_with(".gif")||art.path.ends_with(".webm"){
      let mut animated=art.clone();animated.kind=format!("{kind}-animated");
      posterview_infra_sqlite::ServerStore::new(state.runtime.data_dir()).save_native_artwork(library,&entry.id,&animated).map_err(|e|e.to_string())?;
      return Ok(());
    }
    if art.path.starts_with("@managed/"){
      let mut backup=art.clone();backup.kind=format!("{kind}-previous");
      posterview_infra_sqlite::ServerStore::new(state.runtime.data_dir()).save_native_artwork(library,&entry.id,&backup).map_err(|e|e.to_string())?;
    }
    let root=match state.metadata.directory("",true){Ok(root)=>root,Err(_) if art.path.starts_with("@managed/")=>return Ok(()),Err(e)=>return Err(e.detail)};
    let recorded=if art.path.starts_with("@managed/"){None}else{Some(root.join(&art.path))};
    let (folder,name)=destination(entry,kind)?;
    let directory=match state.metadata.directory(&folder,true){Ok(directory)=>directory,Err(_) if art.path.starts_with("@managed/")=>return Ok(()),Err(e)=>return Err(e.detail)};
    let name=sidecar_name(entry,&directory,name)?;
    let target=recorded.unwrap_or_else(||directory.join(name));
    if !target.exists(){return Ok(());}
    let parent=target.parent().ok_or("Invalid artwork path.")?;
    if !parent.canonicalize().map_err(|e|e.to_string())?.starts_with(&root)||std::fs::symlink_metadata(&target).map_err(|e|e.to_string())?.is_symlink(){return Err("Unsafe artwork path.".into());}
    let bytes=std::fs::read(&target).map_err(|e|e.to_string())?;
    let managed=crate::native_provider::store_image(state,&bytes)?;
    posterview_infra_sqlite::ServerStore::new(state.runtime.data_dir()).save_native_artwork(library,&entry.id,&NativeArtwork{kind:format!("{kind}-previous"),path:managed,source:"manual".into()}).map_err(|e|e.to_string())?;
    crate::native_monitor::own_write(&target,||std::fs::remove_file(&target).map_err(|e|e.to_string()))
}

// NamedTempFile defaults to 0600 on Unix. Media sidecars must remain readable
// by connected servers running with another container UID or GID.
fn shared_artwork_permissions(file: &fs::File, target: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(target).map(|m| m.permissions().mode() & 0o777).unwrap_or(0o644);
        file.set_permissions(fs::Permissions::from_mode(mode | 0o444)).map_err(|e| e.to_string())?;
    }
    #[cfg(not(unix))]
    let _ = (file, target);
    Ok(())
}

#[cfg(all(test, unix))]
mod permission_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn unchanged_sidecars_can_be_repaired_without_rewriting_contents() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("season01-poster.jpg");
        fs::write(&target, b"same poster").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
        shared_artwork_permissions(&fs::File::open(&target).unwrap(), &target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"same poster");
        assert_eq!(fs::metadata(&target).unwrap().permissions().mode() & 0o777, 0o644);
    }

    #[test]
    fn atomic_sidecars_are_readable_by_other_container_users() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("poster.jpg");
        for existing in [None, Some(0o600), Some(0o640), Some(0o664)] {
            if let Some(mode) = existing {
                fs::write(&target, b"old").unwrap();
                fs::set_permissions(&target, fs::Permissions::from_mode(mode)).unwrap();
            }
            let temporary = tempfile::NamedTempFile::new_in(directory.path()).unwrap();
            shared_artwork_permissions(temporary.as_file(), &target).unwrap();
            temporary.persist(&target).unwrap();
            let permissions = fs::metadata(&target).unwrap().permissions().mode() & 0o777;
            assert_eq!(permissions, existing.unwrap_or(0o644) | 0o444);
        }
    }
}

/// The media-folder file remains authoritative; this mirror is never a manual artwork override.
pub(crate) fn managed_local_copy(state:&AppState,path:&Path)->Result<std::path::PathBuf,String> {
    let canonical=path.canonicalize().map_err(|e|e.to_string())?;let path=canonical.as_path();
    let metadata=fs::metadata(path).map_err(|e|e.to_string())?;
    if metadata.len()>20*1024*1024 {return Err("Artwork exceeds 20 MB.".into());}
    let modified=metadata.modified().map_err(|e|e.to_string())?.duration_since(std::time::UNIX_EPOCH).map_err(|e|e.to_string())?.as_nanos();
    let mut hash=std::hash::DefaultHasher::new();std::hash::Hash::hash(&path,&mut hash);
    let prefix=format!("{:x}-",std::hash::Hasher::finish(&hash));
    let directory=state.runtime.data_dir().join("local-artwork-cache");fs::create_dir_all(&directory).map_err(|e|e.to_string())?;
    let target=directory.join(format!("{prefix}{}-{modified}.art",metadata.len()));
    if target.is_file() {return Ok(target);}
    let bytes=fs::read(path).map_err(|e|e.to_string())?;
    if !crate::native_animation::is_webm(&bytes) && !matches!(image::guess_format(&bytes),Ok(image::ImageFormat::Png|image::ImageFormat::Jpeg|image::ImageFormat::WebP|image::ImageFormat::Gif)) {return Err("Unsupported local artwork.".into());}
    let temporary=directory.join(format!("{}.tmp",uuid::Uuid::new_v4()));
    fs::write(&temporary,&bytes).map_err(|e|e.to_string())?;
    if let Err(error)=fs::rename(&temporary,&target) {let _=fs::remove_file(&temporary);if !target.is_file(){return Err(error.to_string());}}
    // Keep one version per source, without walking the media library.
    if let Ok(files)=fs::read_dir(&directory) {for file in files.flatten() {if file.path()!=target && file.file_name().to_string_lossy().starts_with(&prefix) {let _=fs::remove_file(file.path());}}}
    Ok(target)
}


#[cfg(test)]
mod missing_book_tests {
    use super::*;
    #[test]
    fn missing_cover_is_saved_in_series_and_copied_to_arriving_filename() {
        let temp=tempfile::tempdir().unwrap();let state=crate::native::scan_tests::state(temp.path());
        let folder=temp.path().join("media/Books/Series");fs::create_dir_all(&folder).unwrap();
        let managed=state.runtime.data_dir().join("native-artwork");fs::create_dir_all(&managed).unwrap();
        image::DynamicImage::new_rgb8(8,12).save(managed.join("cover.png")).unwrap();
        let art=NativeArtwork{kind:"poster".into(),path:"@managed/cover.png".into(),source:"manual".into()};
        let mut entry=NativeCatalogEntry{id:"test".into(),path:"Books/Series/@missing-volume-12".into(),kind:"book".into(),parent_path:Some("Books/Series".into()),title:"Volume 12".into(),metadata:serde_json::json!({"volume":12,"missing":true}),artwork:vec![art.clone()],files:vec![],nfo_path:None,nfo_xml:None,available:true,revision:1};
        write(&state,&entry,&art,true).unwrap();
        let pending=folder.join(".posterview-missing-artwork/volume-12-poster.jpg");assert!(pending.is_file());assert_eq!(image::open(&pending).unwrap().width(),8);
        entry.path="Books/Series/Series Vol 12.cbz".into();entry.metadata["missing"]=serde_json::json!(false);
        fs::write(folder.join("Series Vol 12.cbz"),b"media").unwrap();
        write(&state,&entry,&art,false).unwrap();let sidecar=folder.join("Series Vol 12.jpg");assert_eq!(fs::read(&pending).unwrap(),fs::read(&sidecar).unwrap());
        fs::write(&sidecar,b"existing local cover").unwrap();write(&state,&entry,&art,false).unwrap();assert_eq!(fs::read(&sidecar).unwrap(),b"existing local cover");
    }
}
