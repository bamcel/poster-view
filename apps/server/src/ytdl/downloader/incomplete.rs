//! Remove only folders and sidecars owned by an unfinished video worker.
use super::{HttpError, err};
use std::{
    collections::HashSet,
    ffi::OsString,
    path::{Path, PathBuf},
};

pub(super) struct IncompleteFolder {
    path: PathBuf,
    parent: PathBuf,
    files: HashSet<OsString>,
    published: bool,
}

impl IncompleteFolder {
    pub(super) fn create(parent: &Path, name: &str) -> Result<Option<Self>, HttpError> {
        if Path::new(name).components().count() != 1
            || !matches!(
                Path::new(name).components().next(),
                Some(std::path::Component::Normal(_))
            )
        {
            return Err(err("Invalid video folder name."));
        }
        let parent = parent.canonicalize().map_err(err)?;
        let path = parent.join(name);
        match std::fs::create_dir(&path) {
            Ok(()) => Ok(Some(Self {
                path,
                parent,
                files: HashSet::new(),
                published: false,
            })),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(None),
            Err(error) => Err(err(error)),
        }
    }

    pub(super) fn track(&mut self, name: impl Into<OsString>) {
        self.files.insert(name.into());
    }

    pub(super) fn published(&mut self) {
        self.published = true;
    }

    fn cleanup(&self) -> std::io::Result<()> {
        // Never follow a replacement link or descend into another directory.
        if std::fs::symlink_metadata(&self.path)?
            .file_type()
            .is_symlink()
            || self.path.canonicalize()? != self.path
            || self
                .path
                .parent()
                .and_then(|p| p.canonicalize().ok())
                .as_ref()
                != Some(&self.parent)
        {
            return Ok(());
        }
        let entries = std::fs::read_dir(&self.path)?.collect::<Result<Vec<_>, _>>()?;
        if entries.iter().any(|entry| {
            !self.files.contains(&entry.file_name())
                || entry.file_type().map_or(true, |kind| !kind.is_file())
        }) {
            // Someone added data we do not own. Preserve the whole folder.
            return Ok(());
        }
        for entry in entries {
            std::fs::remove_file(entry.path())?;
        }
        std::fs::remove_dir(&self.path)
    }
}

impl Drop for IncompleteFolder {
    fn drop(&mut self) {
        if !self.published
            && let Err(error) = self.cleanup()
            && error.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!(path=%self.path.display(), %error, "Unfinished YTDL video folder could not be cleaned up");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unfinished_owned_sidecars_are_removed_but_channel_and_completed_media_stay() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("tvshow.nfo"), "channel").unwrap();
        let completed = temp.path().join("Completed");
        std::fs::create_dir(&completed).unwrap();
        std::fs::write(completed.join("video.mkv"), "finished video").unwrap();
        for name in ["First active", "Second active"] {
            let mut folder = IncompleteFolder::create(temp.path(), name)
                .unwrap()
                .unwrap();
            for file in ["video.nfo", "video.jpg", "video.en.srt"] {
                folder.track(file);
                std::fs::write(folder.path.join(file), "sidecar").unwrap();
            }
            drop(folder);
            assert!(!temp.path().join(name).exists());
        }
        assert_eq!(
            std::fs::read_to_string(completed.join("video.mkv")).unwrap(),
            "finished video"
        );
        assert!(temp.path().join("tvshow.nfo").exists());
    }

    #[test]
    fn existing_folders_and_newly_published_videos_are_preserved() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join("Existing")).unwrap();
        assert!(
            IncompleteFolder::create(temp.path(), "Existing")
                .unwrap()
                .is_none()
        );
        let mut folder = IncompleteFolder::create(temp.path(), "New")
            .unwrap()
            .unwrap();
        std::fs::write(folder.path.join("video.mkv"), "finished").unwrap();
        folder.published();
        drop(folder);
        assert!(temp.path().join("Existing").exists());
        assert!(temp.path().join("New/video.mkv").exists());
    }

    #[test]
    fn unrelated_files_subfolders_and_traversal_are_preserved() {
        let temp = tempfile::tempdir().unwrap();
        for (name, directory) in [("Foreign file", false), ("Foreign directory", true)] {
            let mut folder = IncompleteFolder::create(temp.path(), name)
                .unwrap()
                .unwrap();
            folder.track("video.nfo");
            std::fs::write(folder.path.join("video.nfo"), "owned").unwrap();
            if directory {
                std::fs::create_dir(folder.path.join("foreign")).unwrap();
            } else {
                std::fs::write(folder.path.join("foreign"), "not owned").unwrap();
            }
            drop(folder);
            assert!(temp.path().join(name).join("foreign").exists());
            assert!(temp.path().join(name).join("video.nfo").exists());
        }
        assert!(IncompleteFolder::create(temp.path(), "../outside").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn replacement_links_never_remove_external_files() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("video.nfo"), "external").unwrap();
        let mut folder = IncompleteFolder::create(temp.path(), "Video")
            .unwrap()
            .unwrap();
        folder.track("video.nfo");
        std::fs::remove_dir(temp.path().join("Video")).unwrap();
        std::os::unix::fs::symlink(outside.path(), temp.path().join("Video")).unwrap();
        drop(folder);
        assert_eq!(
            std::fs::read_to_string(outside.path().join("video.nfo")).unwrap(),
            "external"
        );
    }
}
