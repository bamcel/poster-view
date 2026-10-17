//! Readable names with NFO-backed identity and legacy directory compatibility.
use super::{HttpError, err};
use serde_json::Value;
use std::io::Read;
use std::path::{Path, PathBuf};
use xmltree::{Element, XMLNode};

fn nfo_identity(directory: &Path, channel: bool) -> Result<Option<String>, HttpError> {
    let metadata = match std::fs::symlink_metadata(directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(err(error)),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(err(
            "YouTube directories must be real directories, not symbolic links.",
        ));
    }
    let mut identity = None;
    for entry in std::fs::read_dir(directory).map_err(err)? {
        let entry = entry.map_err(err)?;
        if !entry
            .path()
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("nfo"))
        {
            continue;
        }
        let metadata = std::fs::symlink_metadata(entry.path()).map_err(err)?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(err("YouTube NFO files must not be symbolic links."));
        }
        const MAX_NFO: u64 = 4 * 1024 * 1024;
        if metadata.len() > MAX_NFO {
            return Err(err("YouTube NFO exceeds the metadata size limit."));
        }
        let mut bytes = Vec::new();
        std::fs::File::open(entry.path())
            .map_err(err)?
            .take(MAX_NFO + 1)
            .read_to_end(&mut bytes)
            .map_err(err)?;
        if bytes.len() as u64 > MAX_NFO {
            return Err(err("YouTube NFO exceeds the metadata size limit."));
        }
        let document = Element::parse(bytes.as_slice()).map_err(err)?;
        if document.name != if channel { "tvshow" } else { "episodedetails" } {
            continue;
        }
        let mut values = Vec::new();
        if let Some(value) = document
            .get_child("youtube")
            .and_then(|yt| yt.get_child(if channel { "channel_id" } else { "video_id" }))
            .and_then(Element::get_text)
        {
            values.push(value.to_string());
        }
        if !channel {
            for node in &document.children {
                if let XMLNode::Element(element) = node
                    && element.name == "uniqueid"
                    && element
                        .attributes
                        .get("type")
                        .is_some_and(|kind| kind == "youtube")
                    && let Some(value) = element.get_text()
                {
                    values.push(value.to_string());
                }
            }
        }
        for value in values {
            if !super::downloader::valid_id(&value) {
                return Err(err(
                    "Existing YouTube NFO contains an invalid identity; preserving it.",
                ));
            }
            if identity.as_ref().is_some_and(|current| current != &value) {
                return Err(err(
                    "Conflicting YouTube identities in existing NFO files; preserving them.",
                ));
            }
            identity = Some(value);
        }
    }
    Ok(identity)
}

pub(super) fn video_identity(directory: &Path) -> Result<Option<String>, HttpError> {
    nfo_identity(directory, false)
}

fn folder_component(
    parent: &Path,
    id: &str,
    title: &str,
    channel: bool,
) -> Result<String, HttpError> {
    let mut matched = None;
    if parent.exists() {
        let metadata = std::fs::symlink_metadata(parent).map_err(err)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(err("YouTube parent directory must not be a symbolic link."));
        }
        for entry in std::fs::read_dir(parent).map_err(err)? {
            let entry = entry.map_err(err)?;
            let kind = entry.file_type().map_err(err)?;
            if kind.is_symlink() {
                continue;
            }
            if !kind.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let identity = nfo_identity(&entry.path(), channel)?;
            if identity.as_deref() == Some(id) || (name == id && identity.is_none()) {
                if matched.is_some() {
                    return Err(err(
                        "Multiple directories identify the same YouTube item; resolve the duplicate before retrying.",
                    ));
                }
                matched = Some(name);
            } else if name == id && identity.is_some() {
                return Err(err(
                    "Legacy YouTube directory has a conflicting NFO identity; preserving it.",
                ));
            }
        }
    }
    if let Some(name) = matched {
        return Ok(name);
    }
    let mut preferred = readable_title(title);
    if preferred == "Untitled video" && channel {
        preferred = "Untitled channel".into();
    }
    for index in 1..=10000 {
        let name = if index == 1 {
            preferred.clone()
        } else {
            format!("{preferred} ({index})")
        };
        let path = parent.join(&name);
        match std::fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(name),
            Err(error) => return Err(err(error)),
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                if std::fs::read_dir(&path).map_err(err)?.next().is_none() {
                    return Ok(name);
                }
            }
            Ok(_) => {}
        }
    }
    Err(err("Too many duplicate YouTube folder names."))
}

pub(super) fn folder_names(
    root: &Path,
    channel_id: &str,
    video_id: &str,
    channel_name: &str,
    video_title: &str,
) -> Result<(String, String), HttpError> {
    if !super::downloader::valid_id(channel_id) || !super::downloader::valid_id(video_id) {
        return Err(err("Invalid YouTube identity."));
    }
    let channels = root.to_path_buf();
    let channel = folder_component(&channels, channel_id, channel_name, true)?;
    let video = folder_component(&channels.join(&channel), video_id, video_title, false)?;
    Ok((channel, video))
}

fn readable_title(raw: &str) -> String {
    let filtered = raw
        .chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
        })
        .collect::<String>();
    let collapsed = filtered.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut result = String::new();
    for c in collapsed.trim_matches([' ', '.']).chars() {
        if result.len() + c.len_utf8() > 140 {
            break;
        }
        result.push(c);
    }
    let result = result.trim_end_matches([' ', '.']);
    if result.is_empty() {
        "Untitled video".into()
    } else {
        let device = result
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        if [
            "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
            "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
        ]
        .contains(&device.as_str())
        {
            format!("_{result}")
        } else {
            result.into()
        }
    }
}

pub(super) fn stem(info: &Value, convention: &str) -> Result<String, HttpError> {
    let id = info["id"].as_str().unwrap_or_default();
    if !super::downloader::valid_id(id) {
        return Err(err("Invalid video identity."));
    }
    let title = readable_title(info["title"].as_str().unwrap_or_default());
    let readable = format!("{title} [{id}]");
    match convention {
        "id" => Ok(id.into()),
        "title" => Ok(title),
        "title_id" => Ok(readable),
        "date_title" | "date_title_id" => {
            let date = info["upload_date"]
                .as_str()
                .and_then(|s| chrono::NaiveDate::parse_from_str(s, "%Y%m%d").ok())
                .map(|d| d.format("%Y-%m-%d").to_string())
                .unwrap_or_else(|| "undated".into());
            let basename = if convention == "date_title" {
                title
            } else {
                readable
            };
            Ok(format!("{date} - {basename}"))
        }
        _ => Err(err("Invalid filename convention.")),
    }
}

pub(super) fn existing_media(directory: &Path) -> Result<Option<PathBuf>, HttpError> {
    let mut files = std::fs::read_dir(directory)
        .map_err(err)?
        .filter_map(Result::ok)
        .filter(|entry| {
            entry.file_type().is_ok_and(|kind| kind.is_file())
                && entry
                    .path()
                    .extension()
                    .and_then(|s| s.to_str())
                    .is_some_and(|ext| {
                        ["mp4", "mkv", "webm"].contains(&ext.to_ascii_lowercase().as_str())
                    })
        })
        .map(|e| e.path())
        .collect::<Vec<_>>();
    files.sort();
    if files.len() > 1 {
        return Err(err(
            "This video directory contains multiple media files; preserve them and resolve the duplicate before retrying.",
        ));
    }
    Ok(files.pop())
}

pub(super) fn sidecar_name(staging_name: &str, id: &str, stem: &str) -> Option<String> {
    staging_name
        .strip_prefix(&format!("{id}."))
        .filter(|suffix| {
            !suffix.is_empty()
                && !suffix.contains(".part")
                && !["mp4", "mkv", "webm"]
                    .iter()
                    .any(|ext| suffix.eq_ignore_ascii_case(ext))
        })
        .map(|suffix| format!("{stem}.{suffix}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn readable_folders_preserve_identity_and_avoid_collisions() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        assert_eq!(
            folder_names(root, "UCid", "vid", "A: Channel", "CON").unwrap(),
            ("A Channel".into(), "_CON".into())
        );
        let channel = root.join("A Channel");
        let video = channel.join("Original title");
        std::fs::create_dir_all(&video).unwrap();
        std::fs::write(
            channel.join("tvshow.nfo"),
            "<tvshow><youtube><channel_id>UCid</channel_id></youtube></tvshow>",
        )
        .unwrap();
        std::fs::write(video.join("Original title.nfo"), "<episodedetails><youtube><video_id>vid</video_id></youtube><uniqueid type=\"youtube\">vid</uniqueid></episodedetails>").unwrap();
        assert_eq!(
            folder_names(root, "UCid", "vid", "Changed channel", "Changed video").unwrap(),
            ("A Channel".into(), "Original title".into())
        );
        assert_eq!(video_identity(&video).unwrap().as_deref(), Some("vid"));
        assert_eq!(
            folder_names(root, "UCid", "another", "Changed channel", "Original title")
                .unwrap()
                .1,
            "Original title (2)"
        );
        std::fs::create_dir_all(root.join("Unidentified")).unwrap();
        std::fs::write(root.join("Unidentified/file"), "keep").unwrap();
        assert_eq!(
            folder_names(root, "other", "new", "Unidentified", "...").unwrap(),
            ("Unidentified (2)".into(), "Untitled video".into())
        );
    }
    #[test]
    fn legacy_folders_are_reused_but_conflicting_nfos_are_preserved() {
        let temp = tempfile::tempdir().unwrap();
        let channel = temp.path().join("UClegacy");
        let video = channel.join("legacy");
        std::fs::create_dir_all(&video).unwrap();
        assert_eq!(
            folder_names(temp.path(), "UClegacy", "legacy", "New name", "New title").unwrap(),
            ("UClegacy".into(), "legacy".into())
        );
        std::fs::write(video.join("episode.nfo"), "<episodedetails><youtube><video_id>wrong</video_id></youtube><uniqueid type=\"youtube\">legacy</uniqueid></episodedetails>").unwrap();
        assert!(video_identity(&video).is_err());
        assert!(folder_names(temp.path(), "UClegacy", "legacy", "New name", "New title").is_err());
    }
    #[cfg(unix)]
    #[test]
    fn symbolic_links_are_not_followed() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let channel = temp.path().join("Channel");
        std::fs::create_dir_all(&channel).unwrap();
        std::os::unix::fs::symlink(outside.path(), channel.join("Video")).unwrap();
        assert_eq!(
            folder_names(temp.path(), "channel", "video", "Channel", "Video")
                .unwrap()
                .0,
            "Channel (2)"
        );
        assert!(video_identity(&channel.join("Video")).is_err());
    }
    #[cfg(windows)]
    #[test]
    fn symbolic_links_are_not_followed_on_windows() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let channels = temp.path().join("selected-root");
        // Creating symlinks requires Windows developer mode or elevation.
        if std::os::windows::fs::symlink_dir(outside.path(), &channels).is_err() {
            return;
        }
        assert!(folder_names(&channels, "channel", "video", "Channel", "Video").is_err());
        assert!(video_identity(&channels).is_err());
    }
    #[test]
    fn readable_names_are_unicode_and_os_safe() {
        let v = json!({"id":"vid_1","title":"  世界 <hello>: /\\?*\" |  end...  ","upload_date":"20260203"});
        assert_eq!(stem(&v, "id").unwrap(), "vid_1");
        assert_eq!(stem(&v, "title").unwrap(), "世界 hello end");
        assert_eq!(
            stem(&v, "date_title").unwrap(),
            "2026-02-03 - 世界 hello end"
        );
        assert_eq!(stem(&v, "title_id").unwrap(), "世界 hello end [vid_1]");
        assert_eq!(
            stem(&v, "date_title_id").unwrap(),
            "2026-02-03 - 世界 hello end [vid_1]"
        );
        assert_eq!(
            stem(
                &json!({"id":"vid","title":"...","upload_date":"20260231"}),
                "date_title_id"
            )
            .unwrap(),
            "undated - Untitled video [vid]"
        );
    }
    #[test]
    fn title_only_avoids_reserved_device_names() {
        assert_eq!(
            stem(&json!({"id":"vid","title":"CON"}), "title").unwrap(),
            "_CON"
        );
        assert_eq!(
            stem(&json!({"id":"vid","title":"NUL.txt"}), "title").unwrap(),
            "_NUL.txt"
        );
    }
    #[test]
    fn truncation_preserves_utf8_and_identity() {
        let name = stem(
            &json!({"id":"identity","title":"界".repeat(150)}),
            "title_id",
        )
        .unwrap();
        assert!(name.ends_with(" [identity]"));
        assert!(name.len() <= 151);
        assert!(stem(&json!({"id":"../x"}), "id").is_err());
    }
    #[test]
    fn sidecars_keep_languages_and_extensions() {
        assert_eq!(
            sidecar_name("vid.en.vtt", "vid", "Title [vid]").unwrap(),
            "Title [vid].en.vtt"
        );
        assert_eq!(
            sidecar_name("vid.jpg", "vid", "Title [vid]").unwrap(),
            "Title [vid].jpg"
        );
        assert!(sidecar_name("vid.mkv", "vid", "Title [vid]").is_none());
    }
    #[test]
    fn retries_find_old_and_readable_files_without_renaming() {
        let temp = tempfile::tempdir().unwrap();
        let old = temp.path().join("vid.mp4");
        std::fs::write(&old, "original").unwrap();
        assert_eq!(existing_media(temp.path()).unwrap(), Some(old.clone()));
        std::fs::remove_file(old).unwrap();
        let readable = temp.path().join("2026-02-03 - Title [vid].MKV");
        std::fs::write(&readable, "original").unwrap();
        assert_eq!(existing_media(temp.path()).unwrap(), Some(readable));
        std::fs::write(temp.path().join("another.mp4"), "duplicate").unwrap();
        assert!(existing_media(temp.path()).is_err());
    }
}
