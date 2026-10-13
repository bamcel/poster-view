//! Readable filenames do not participate in video identity or directory placement.
use super::{HttpError, err};
use serde_json::Value;
use std::path::{Path, PathBuf};

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
