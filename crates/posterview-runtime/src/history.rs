// Legacy artwork history is no longer recorded; retain purge for migration/cleanup.
use crate::{Runtime, RuntimeError};
impl Runtime {
    pub fn discard_artwork_history(&self) -> Result<usize, RuntimeError> {
        let paths = self.server_store()?.purge_history(0)?;
        let count = paths.len();
        for path in paths {
            // Only delete legacy backups under the application's history directory.
            let path = std::path::PathBuf::from(path);
            if path.parent() == Some(self.data_dir.join("history").as_path()) && !path.is_symlink() {
                let _ = std::fs::remove_file(path);
            }
        }
        let directory=self.data_dir.join("history");
        if directory.is_dir() && !directory.is_symlink() {
            for entry in std::fs::read_dir(directory)? {
                let entry=entry?;
                if entry.file_type()?.is_file() {std::fs::remove_file(entry.path())?;}
            }
        }
        Ok(count)
    }
}
