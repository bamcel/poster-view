use crate::{Runtime, RuntimeError};
use flate2::read::GzDecoder;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::{BufRead, BufReader, Read},
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::io::AsyncWriteExt;

const SNAPSHOT: &str = "imdb_snapshot_v1";
const ENABLED: &str = "imdb_enabled";
const BASICS: &str = "tconst\ttitleType\tprimaryTitle\toriginalTitle\tisAdult\tstartYear\tendYear\truntimeMinutes\tgenres";
const RATINGS: &str = "tconst\taverageRating\tnumVotes";
fn err(e: impl std::fmt::Display) -> RuntimeError {
    RuntimeError::Watchdog(e.to_string())
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct Snapshot {
    file: String,
    updated_at: i64,
    titles: u64,
    ratings: u64,
}
#[derive(Serialize)]
pub struct ImdbStatus {
    pub enabled: bool,
    pub ready: bool,
    pub updated_at: Option<i64>,
    pub titles: u64,
    pub ratings: u64,
}
#[derive(Debug, Serialize)]
pub struct ImdbTitle {
    pub id: String,
    pub title_type: String,
    pub title: String,
    pub original_title: String,
    pub year: Option<i64>,
    pub end_year: Option<i64>,
    pub runtime_minutes: Option<i64>,
    pub genres: Vec<String>,
    pub rating: Option<f64>,
    pub votes: Option<i64>,
}
fn valid_id(id: &str) -> bool {
    id.starts_with("tt")
        && (9..=14).contains(&id.len())
        && id[2..].bytes().all(|b| b.is_ascii_digit())
}
fn check_cancel(cancel: &AtomicBool) -> Result<(), RuntimeError> {
    if cancel.load(Ordering::Relaxed) {
        Err(err("IMDb refresh cancelled"))
    } else {
        Ok(())
    }
}
impl Runtime {
    fn imdb_snapshot(&self) -> Result<Snapshot, RuntimeError> {
        let raw = self.server_store()?.get_setting(SNAPSHOT)?;
        if raw.is_empty() {
            return Ok(Snapshot::default());
        }
        let snapshot: Snapshot = serde_json::from_str(&raw).map_err(err)?;
        if !snapshot.file.starts_with("snapshot-")
            || !snapshot.file.ends_with(".sqlite")
            || snapshot.file.contains(['/', '\\'])
        {
            return Err(err("Invalid IMDb snapshot"));
        }
        Ok(snapshot)
    }
    pub fn imdb_status(&self) -> Result<ImdbStatus, RuntimeError> {
        let snapshot = self.imdb_snapshot()?;
        Ok(ImdbStatus {
            enabled: self.server_store()?.get_setting(ENABLED)? == "true",
            ready: !snapshot.file.is_empty()
                && self.data_dir.join("imdb").join(&snapshot.file).is_file(),
            updated_at: (snapshot.updated_at > 0).then_some(snapshot.updated_at),
            titles: snapshot.titles,
            ratings: snapshot.ratings,
        })
    }
    pub fn set_imdb_enabled(&self, enabled: bool) -> Result<ImdbStatus, RuntimeError> {
        let _guard = self
            .imdb_data_lock
            .lock()
            .map_err(|_| err("IMDb database is busy"))?;
        self.server_store()?
            .set_setting(ENABLED, if enabled { "true" } else { "false" })?;
        if !enabled {
            self.imdb_cancel.store(true, Ordering::Relaxed);
            self.update_task("imdb_refresh", |t| {
                t.config.enabled = false;
                t.next_run = None;
                if ["queued", "running"].contains(&t.status.as_str()) {
                    t.status = "stopping".into();
                }
            })?;
        }
        self.imdb_status()
    }
    pub fn imdb_lookup(&self, query: &str) -> Result<Vec<ImdbTitle>, RuntimeError> {
        let _guard = self
            .imdb_data_lock
            .lock()
            .map_err(|_| err("IMDb database is busy"))?;
        let status = self.imdb_status()?;
        if !status.enabled || !status.ready {
            return Ok(vec![]);
        }
        let query = query.trim();
        if query.len() < 2 || query.len() > 200 {
            return Err(err(
                "Enter an IMDb title ID or at least two title characters (maximum 200).",
            ));
        }
        let snapshot = self.imdb_snapshot()?;
        let db = Connection::open_with_flags(
            self.data_dir.join("imdb").join(snapshot.file),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(err)?;
        let columns = "SELECT t.id,t.kind,t.title,t.original_title,t.year,t.end_year,t.runtime,t.genres,r.rating,r.votes FROM titles t LEFT JOIN ratings r ON r.id=t.id";
        let (sql, value) = if valid_id(query) {
            (format!("{columns} WHERE t.id=?1"), query.into())
        } else {
            (
                format!(
                    "{columns} WHERE t.title LIKE ?1 ESCAPE '\\' ORDER BY t.title COLLATE NOCASE LIMIT 20"
                ),
                format!(
                    "{}%",
                    query
                        .replace('\\', "\\\\")
                        .replace('%', "\\%")
                        .replace('_', "\\_")
                ),
            )
        };
        let mut stmt = db.prepare(&sql).map_err(err)?;
        stmt.query_map([value], |r| {
            Ok(ImdbTitle {
                id: r.get(0)?,
                title_type: r.get(1)?,
                title: r.get(2)?,
                original_title: r.get(3)?,
                year: r.get(4)?,
                end_year: r.get(5)?,
                runtime_minutes: r.get(6)?,
                genres: r
                    .get::<_, String>(7)?
                    .split(',')
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .collect(),
                rating: r.get(8)?,
                votes: r.get(9)?,
            })
        })
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)
    }
    pub(crate) async fn refresh_imdb(&self) -> Result<(), RuntimeError> {
        if !self.imdb_status()?.enabled {
            return Err(err("Enable IMDb in Settings → Database before refreshing."));
        }
        let root = self.data_dir.join("imdb");
        std::fs::create_dir_all(&root)?;
        {
            let _guard = self
                .imdb_data_lock
                .lock()
                .map_err(|_| err("IMDb database is busy"))?;
            cleanup_staging(&root, &self.imdb_snapshot()?.file)?;
        }
        let stage = tempfile::Builder::new()
            .prefix("staging-")
            .tempdir_in(&root)?;
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(30))
            .read_timeout(std::time::Duration::from_secs(60))
            .timeout(std::time::Duration::from_secs(7200))
            .build()
            .map_err(err)?;
        for (index, name) in ["title.basics.tsv.gz", "title.ratings.tsv.gz"]
            .iter()
            .enumerate()
        {
            check_cancel(&self.imdb_cancel)?;
            self.update_task("imdb_refresh", |t| {
                if t.status != "stopping" {
                    t.status = "running".into();
                }
                t.total = 3;
                t.processed = index;
                t.message = format!("Downloading IMDb {name}");
            })?;
            let mut response = client
                .get(format!("https://datasets.imdbws.com/{name}"))
                .send()
                .await
                .map_err(err)?
                .error_for_status()
                .map_err(err)?;
            let expected = response.content_length();
            let mut file = tokio::fs::File::create(stage.path().join(name)).await?;
            let mut size = 0u64;
            let mut last_report = 0;
            while let Some(chunk) = response.chunk().await.map_err(err)? {
                check_cancel(&self.imdb_cancel)?;
                size += chunk.len() as u64;
                if size > 2 * 1024 * 1024 * 1024 {
                    return Err(err("IMDb download exceeded the 2 GiB per-file limit"));
                }
                file.write_all(&chunk).await?;
                if size - last_report >= 8 * 1024 * 1024 {
                    last_report = size;
                    self.update_task("imdb_refresh", |t| {
                        t.message = format!(
                            "Downloading {name}: {} MiB{}",
                            size / 1048576,
                            expected
                                .map(|n| format!(" / {} MiB", n / 1048576))
                                .unwrap_or_default()
                        )
                    })?;
                }
            }
            file.flush().await?;
            if size == 0 || expected.is_some_and(|n| n != size) {
                return Err(err("Incomplete IMDb download; previous data kept"));
            }
        }
        self.update_task("imdb_refresh", |t| {
            t.processed = 2;
            t.message = "Building local IMDb title and rating index".into();
        })?;
        let cancel = Arc::clone(&self.imdb_cancel);
        // The staging directory moves with the blocking worker, including on async cancellation.
        let (stage, titles, ratings) = tokio::task::spawn_blocking(move || {
            let (titles, ratings) = build_index(stage.path(), &cancel)?;
            Ok::<_, RuntimeError>((stage, titles, ratings))
        })
        .await
        .map_err(err)??;
        let _guard = self
            .imdb_data_lock
            .lock()
            .map_err(|_| err("IMDb database is busy"))?;
        check_cancel(&self.imdb_cancel)?;
        if !self.imdb_status()?.enabled {
            return Err(err("IMDb source was disabled"));
        }
        let previous = self.imdb_snapshot()?;
        let file = format!("snapshot-{}.sqlite", uuid::Uuid::new_v4());
        std::fs::rename(stage.path().join("index.sqlite"), root.join(&file))?;
        let snapshot = Snapshot {
            file: file.clone(),
            titles,
            ratings,
            updated_at: chrono::Utc::now().timestamp(),
        };
        if let Err(error) = self
            .server_store()?
            .set_setting(SNAPSHOT, &serde_json::to_string(&snapshot).map_err(err)?)
        {
            let _ = std::fs::remove_file(root.join(file));
            return Err(error.into());
        }
        if !previous.file.is_empty() {
            let _ = std::fs::remove_file(root.join(previous.file));
        }
        self.update_task("imdb_refresh", |t| {
            t.processed = 3;
            t.updated = titles as usize;
            t.message = format!("Indexed {titles} IMDb titles and {ratings} ratings");
        })?;
        Ok(())
    }
}

fn cleanup_staging(root: &Path, current: &str) -> Result<(), RuntimeError> {
    let root = root.canonicalize()?;
    for entry in std::fs::read_dir(&root)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if kind.is_symlink() || name == current {
            continue;
        }
        let staging = kind.is_dir() && name.starts_with("staging-");
        let retired = kind.is_file() && name.starts_with("snapshot-") && name.ends_with(".sqlite");
        if staging || retired {
            let target = entry.path().canonicalize()?;
            if !target.starts_with(&root) {
                return Err(err("IMDb cleanup path is outside its data directory"));
            }
            if staging {
                std::fs::remove_dir_all(target)?;
            } else {
                std::fs::remove_file(target)?;
            }
        }
    }
    Ok(())
}

fn rows(
    path: &Path,
    header: &str,
    cancel: &AtomicBool,
    mut visit: impl FnMut(&[&str]) -> Result<(), RuntimeError>,
) -> Result<u64, RuntimeError> {
    let mut reader = BufReader::new(GzDecoder::new(File::open(path)?));
    let mut line = String::new();
    reader.by_ref().take(1024 * 1024).read_line(&mut line)?;
    if line.trim_end() != header {
        return Err(err("IMDb dataset columns changed; previous data kept"));
    }
    let mut count = 0u64;
    let mut bytes = 0u64;
    loop {
        check_cancel(cancel)?;
        line.clear();
        let n = reader.by_ref().take(1024 * 1024).read_line(&mut line)?;
        if n == 0 {
            break;
        }
        bytes += n as u64;
        if n >= 1024 * 1024 || bytes > 8 * 1024 * 1024 * 1024 {
            return Err(err("IMDb dataset exceeded import limits"));
        }
        let columns = line
            .trim_end_matches(['\r', '\n'])
            .split('\t')
            .collect::<Vec<_>>();
        if columns.len() != header.split('\t').count() {
            return Err(err("Malformed IMDb dataset row"));
        }
        visit(&columns)?;
        count += 1;
    }
    if count == 0 {
        return Err(err("IMDb dataset was empty; previous data kept"));
    }
    Ok(count)
}
fn number(value: &str) -> Result<Option<i64>, RuntimeError> {
    if value == "\\N" {
        Ok(None)
    } else {
        value.parse::<i64>().map(Some).map_err(err)
    }
}
fn build_index(root: &Path, cancel: &AtomicBool) -> Result<(u64, u64), RuntimeError> {
    let mut db = Connection::open(root.join("index.sqlite")).map_err(err)?;
    db.execute_batch("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; CREATE TABLE titles(id TEXT PRIMARY KEY,kind TEXT NOT NULL,title TEXT NOT NULL,original_title TEXT NOT NULL,year INTEGER,end_year INTEGER,runtime INTEGER,genres TEXT NOT NULL); CREATE TABLE ratings(id TEXT PRIMARY KEY,rating REAL NOT NULL,votes INTEGER NOT NULL);").map_err(err)?;
    let tx = db.transaction().map_err(err)?;
    let titles = {
        let mut insert = tx
            .prepare("INSERT INTO titles VALUES(?1,?2,?3,?4,?5,?6,?7,?8)")
            .map_err(err)?;
        rows(&root.join("title.basics.tsv.gz"), BASICS, cancel, |v| {
            if !valid_id(v[0]) {
                return Err(err("Invalid IMDb title ID"));
            }
            insert
                .execute(params![
                    v[0],
                    v[1],
                    v[2],
                    v[3],
                    number(v[5])?,
                    number(v[6])?,
                    number(v[7])?,
                    if v[8] == "\\N" { "" } else { v[8] }
                ])
                .map_err(err)?;
            Ok(())
        })?
    };
    let ratings = {
        let mut insert = tx
            .prepare("INSERT INTO ratings VALUES(?1,?2,?3)")
            .map_err(err)?;
        rows(&root.join("title.ratings.tsv.gz"), RATINGS, cancel, |v| {
            let rating: f64 = v[1].parse().map_err(err)?;
            let votes: i64 = v[2].parse().map_err(err)?;
            if !valid_id(v[0])
                || !rating.is_finite()
                || !(0.0..=10.0).contains(&rating)
                || votes < 0
            {
                return Err(err("Invalid IMDb rating"));
            }
            insert.execute(params![v[0], rating, votes]).map_err(err)?;
            Ok(())
        })?
    };
    check_cancel(cancel)?;
    tx.execute_batch("CREATE INDEX titles_search ON titles(title COLLATE NOCASE)")
        .map_err(err)?;
    tx.commit().map_err(err)?;
    let ok: Option<String> = db
        .query_row("PRAGMA quick_check", [], |r| r.get(0))
        .optional()
        .map_err(err)?;
    if ok.as_deref() != Some("ok") {
        return Err(err("IMDb index failed validation"));
    }
    Ok((titles, ratings))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    fn gzip(path: &Path, text: &str) {
        let mut output = flate2::write::GzEncoder::new(
            File::create(path).unwrap(),
            flate2::Compression::default(),
        );
        output.write_all(text.as_bytes()).unwrap();
        output.finish().unwrap();
    }
    fn fixture(root: &Path) {
        gzip(
            &root.join("title.basics.tsv.gz"),
            &format!(
                "{BASICS}\ntt0000001\tmovie\tExample Film\tOriginal Film\t0\t2020\t\\N\t110\tDrama,Comedy\ntt0000002\ttvSeries\tExample Series\tExample Series\t0\t2021\t2023\t\\N\t\\N\n"
            ),
        );
        gzip(
            &root.join("title.ratings.tsv.gz"),
            &format!("{RATINGS}\ntt0000001\t8.2\t1234\n"),
        );
    }
    #[test]
    fn local_source_import_lookup_nulls_and_disable() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = Runtime::new(dir.path());
        runtime.initialize().unwrap();
        assert!(!runtime.imdb_status().unwrap().enabled);
        assert!(runtime.task_action("imdb_refresh", "run").is_err());
        let root = dir.path().join("imdb");
        std::fs::create_dir(&root).unwrap();
        fixture(&root);
        let (titles, ratings) = build_index(&root, &AtomicBool::new(false)).unwrap();
        assert_eq!((titles, ratings), (2, 1));
        std::fs::rename(root.join("index.sqlite"), root.join("snapshot-test.sqlite")).unwrap();
        runtime
            .server_store()
            .unwrap()
            .set_setting(
                SNAPSHOT,
                &serde_json::to_string(&Snapshot {
                    file: "snapshot-test.sqlite".into(),
                    updated_at: 123,
                    titles,
                    ratings,
                })
                .unwrap(),
            )
            .unwrap();
        runtime.set_imdb_enabled(true).unwrap();
        let found = runtime.imdb_lookup("tt0000001").unwrap();
        assert_eq!(found[0].rating, Some(8.2));
        assert_eq!(found[0].genres, vec!["Drama", "Comedy"]);
        assert_eq!(runtime.imdb_lookup("Example").unwrap().len(), 2);
        let series = runtime.imdb_lookup("tt0000002").unwrap();
        assert!(series[0].rating.is_none());
        assert!(series[0].runtime_minutes.is_none());
        assert!(series[0].genres.is_empty());
        assert!(runtime.imdb_lookup("Ex%").unwrap().is_empty());
        assert!(runtime.imdb_lookup("' OR 1=1--").unwrap().is_empty());
        let broken = tempfile::Builder::new()
            .prefix("staging-")
            .tempdir_in(&root)
            .unwrap();
        fixture(broken.path());
        gzip(&broken.path().join("title.ratings.tsv.gz"), "bad header\n");
        assert!(build_index(broken.path(), &AtomicBool::new(false)).is_err());
        assert_eq!(
            runtime.imdb_lookup("tt0000001").unwrap()[0].rating,
            Some(8.2)
        );
        let abandoned = broken.keep();
        cleanup_staging(&root, "snapshot-test.sqlite").unwrap();
        assert!(!abandoned.exists());
        assert!(root.join("snapshot-test.sqlite").exists());
        runtime.task_action("imdb_refresh", "run").unwrap();
        runtime.set_imdb_enabled(false).unwrap();
        assert_eq!(
            runtime
                .scheduled_tasks()
                .unwrap()
                .iter()
                .find(|t| t.id == "imdb_refresh")
                .unwrap()
                .status,
            "stopping"
        );
        assert!(runtime.imdb_lookup("tt0000001").unwrap().is_empty());
        assert!(runtime.imdb_status().unwrap().ready);
    }
    #[test]
    fn rejects_invalid_ratings_changed_headers_and_cancellation() {
        let dir = tempfile::tempdir().unwrap();
        fixture(dir.path());
        gzip(
            &dir.path().join("title.ratings.tsv.gz"),
            &format!("{RATINGS}\ntt0000001\tNaN\t12\n"),
        );
        assert!(build_index(dir.path(), &AtomicBool::new(false)).is_err());
        let other = tempfile::tempdir().unwrap();
        fixture(other.path());
        assert!(build_index(other.path(), &AtomicBool::new(true)).is_err());
        let malformed = tempfile::tempdir().unwrap();
        fixture(malformed.path());
        gzip(
            &malformed.path().join("title.basics.tsv.gz"),
            "unexpected\n",
        );
        assert!(build_index(malformed.path(), &AtomicBool::new(false)).is_err());
    }
}
