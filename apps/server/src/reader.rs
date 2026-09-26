//! Read-only mounted-file reader. Archives are never extracted onto disk.
use crate::{AppState, HttpError};
use axum::{
    Json,
    extract::{Path, Query, Request, State},
    http::{HeaderValue, header},
    response::{IntoResponse, Response},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::{
    cmp::Ordering,
    fs::{self, File},
    io::Read,
    path::{Component, Path as FsPath, PathBuf},
    sync::Mutex,
};
use tower::ServiceExt;
use tower_http::services::ServeFile;
use xmltree::Element;
use zip::ZipArchive;

const MAX_ENTRY: u64 = 32 * 1024 * 1024;
const MAX_ENTRIES: usize = 10_000;
fn bad(message: impl Into<String>) -> HttpError {
    HttpError::bad_request(message)
}
fn failure(error: impl std::fmt::Display) -> HttpError {
    tracing::warn!(%error, "reader operation failed");
    bad("Unable to read this book. Check its format, mounted path, and permissions.")
}

pub(crate) struct ReaderStore {
    root: PathBuf,
    db: PathBuf,
    writes: Mutex<()>,
    info_slots: tokio::sync::Semaphore,
}
impl ReaderStore {
    pub fn new(root: PathBuf, db: PathBuf) -> Self {
        Self {
            root,
            db,
            writes: Mutex::new(()),
            info_slots: tokio::sync::Semaphore::new(4),
        }
    }
    fn db(&self) -> Result<Connection, HttpError> {
        let db = Connection::open(&self.db).map_err(failure)?;
        db.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(failure)?;
        db.execute_batch("CREATE TABLE IF NOT EXISTS reader_books (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL);
            CREATE TABLE IF NOT EXISTS reader_states (user TEXT NOT NULL, book TEXT NOT NULL, revision TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(user,book));
            CREATE TABLE IF NOT EXISTS library_display_preferences (user TEXT PRIMARY KEY, tracking_overlays INTEGER NOT NULL DEFAULT 1);
            CREATE TABLE IF NOT EXISTS reading_thresholds (user TEXT PRIMARY KEY, reading REAL NOT NULL, finished REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS colored_edition_preferences (user TEXT PRIMARY KEY, effect TEXT NOT NULL);").map_err(failure)?;
        Ok(db)
    }
    fn checked(&self, path: &FsPath) -> Result<PathBuf, HttpError> {
        let current = self.checked_location(path)?;
        if !current.is_file() || format(&current).is_none() {
            return Err(bad(
                "Choose a PDF, EPUB, or CBZ file inside the media mount.",
            ));
        }
        Ok(current)
    }
    fn checked_location(&self, path: &FsPath) -> Result<PathBuf, HttpError> {
        let root = self
            .root
            .canonicalize()
            .map_err(|_| bad("Mount your books under /media, or set POSTERVIEW_MEDIA_DIR."))?;
        if path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
        {
            return Err(bad("Invalid book path."));
        }
        let relative = path
            .strip_prefix(&self.root)
            .or_else(|_| path.strip_prefix(&root))
            .map_err(|_| bad("The server's book path must be inside PosterView's media mount."))?;
        let mut current = root.clone();
        for part in relative.components() {
            if !matches!(part, Component::Normal(_)) {
                return Err(bad("Invalid book path."));
            }
            current.push(part);
            let meta = fs::symlink_metadata(&current).map_err(failure)?;
            #[cfg(windows)]
            let linked = {
                use std::os::windows::fs::MetadataExt;
                meta.file_attributes() & 0x400 != 0
            };
            #[cfg(not(windows))]
            let linked = meta.file_type().is_symlink();
            if linked {
                return Err(bad(
                    "Linked files and folders cannot be read. Mount their real location.",
                ));
            }
        }
        let current = current.canonicalize().map_err(failure)?;
        if !current.starts_with(root) {
            return Err(bad(
                "Choose a PDF, EPUB, or CBZ file inside the media mount.",
            ));
        }
        Ok(current)
    }
    fn register(&self, path: &FsPath) -> Result<String, HttpError> {
        let path = self.checked(path)?;
        let db = self.db()?;
        let id = uuid::Uuid::new_v4().to_string();
        db.execute(
            "INSERT OR IGNORE INTO reader_books(id,path) VALUES (?1,?2)",
            params![id, path.to_string_lossy()],
        )
        .map_err(failure)?;
        db.query_row(
            "SELECT id FROM reader_books WHERE path=?1",
            [path.to_string_lossy()],
            |row| row.get(0),
        )
        .map_err(failure)
    }
    fn path(&self, id: &str) -> Result<PathBuf, HttpError> {
        let value: Option<String> = self
            .db()?
            .query_row("SELECT path FROM reader_books WHERE id=?1", [id], |row| {
                row.get(0)
            })
            .optional()
            .map_err(failure)?;
        self.checked(FsPath::new(&value.ok_or_else(|| {
            bad("Book not found. Open it from its library again.")
        })?))
    }
}
#[derive(Default, Serialize)]
pub(crate) struct BookInfo {
    colored_edition: bool,
    title: Option<String>,
    sort_title: Option<String>,
    status: Option<&'static str>,
}

impl ReaderStore {
    fn reading_status(&self, path: &FsPath, user: &str) -> Result<Option<&'static str>, HttpError> {
        let db = self.db()?;
        let (reading_threshold, finished_threshold) = thresholds(&db, user)?;
        let mut statement = db.prepare("SELECT b.path,s.revision,s.state FROM reader_states s JOIN reader_books b ON b.id=s.book WHERE s.user=?1").map_err(failure)?;
        let rows = statement
            .query_map([user], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    (r.get::<_, String>(1)?, r.get::<_, String>(2)?),
                ))
            })
            .map_err(failure)?;
        let states: std::collections::HashMap<_, _> =
            rows.collect::<Result<_, _>>().map_err(failure)?;
        let mut pending = vec![path.to_path_buf()];
        let (mut total, mut started, mut finished, mut visited) = (0, 0, 0, 0);
        let mut complete = true;
        while let Some(candidate) = pending.pop() {
            visited += 1;
            if visited > 20_000 {
                complete = false;
                break;
            }
            let Ok(candidate) = self.checked_location(&candidate) else {
                complete = false;
                continue;
            };
            if candidate.is_dir() {
                match fs::read_dir(&candidate) {
                    Ok(entries) => {
                        for entry in entries {
                            match entry {
                                Ok(entry) => pending.push(entry.path()),
                                Err(_) => complete = false,
                            }
                        }
                    }
                    Err(_) => complete = false,
                }
            } else if format(&candidate).is_some() {
                total += 1;
                if let Some((saved_revision, data)) =
                    states.get(candidate.to_string_lossy().as_ref())
                {
                    if revision(&candidate).ok().as_ref() == Some(saved_revision) {
                        let saved =
                            serde_json::from_str::<serde_json::Value>(data).unwrap_or_default();
                        let progress = saved["progress"].as_f64().unwrap_or_else(|| {
                            if saved["finished"] == true {
                                100.0
                            } else {
                                0.0
                            }
                        });
                        if progress >= reading_threshold {
                            started += 1;
                        }
                        if progress >= finished_threshold {
                            finished += 1;
                        }
                    }
                }
            }
        }
        Ok(if complete && total > 0 && finished == total {
            Some("Finished")
        } else if started > 0 {
            Some("Reading")
        } else {
            None
        })
    }
}

pub(crate) async fn info(
    State(state): State<AppState>,
    Path((server, item)): Path<(i64, String)>,
) -> Result<Json<BookInfo>, HttpError> {
    let _slot = state.reader.info_slots.acquire().await.map_err(failure)?;
    let source = crate::metadata::item_source(&state, server, &item).await?;
    let reader = state.reader.clone();
    let metadata = state.metadata.clone();
    let user = state.auth.username().to_owned();
    tokio::task::spawn_blocking(move || {
        let path = reader.checked_location(FsPath::new(&source))?;
        let mut info = BookInfo {
            status: reader.reading_status(&path, &user)?,
            ..BookInfo::default()
        };
        // Folder NFO describes the series, not each individual volume.
        if let Some(fields) = metadata.read_for_source(&source)? {
            info.colored_edition = fields.edition.trim().eq_ignore_ascii_case("Colored");
            if path.is_dir() {
                info.title =
                    (!fields.title.trim().is_empty()).then(|| fields.title.trim().to_owned());
                info.sort_title = (!fields.sort_title.trim().is_empty())
                    .then(|| fields.sort_title.trim().to_owned());
            }
        }
        Ok(Json(info))
    })
    .await
    .map_err(failure)?
}

fn format(path: &FsPath) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "pdf" => Some("pdf"),
        "epub" => Some("epub"),
        "cbz" => Some("cbz"),
        _ => None,
    }
}

#[cfg(test)]
mod status_tests {
    use super::*;
    #[test]
    fn colored_effect_defaults_off_and_persists_per_account() {
        let settings: DisplayPreferences =
            serde_json::from_str(r#"{"tracking_overlays":true}"#).unwrap();
        assert_eq!(settings.colored_effect, "off");
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("reader.sqlite");
        let store = ReaderStore::new(temp.path().into(), db_path.clone());
        store
            .db()
            .unwrap()
            .execute(
                "INSERT INTO colored_edition_preferences VALUES ('admin','badge')",
                [],
            )
            .unwrap();
        let reopened = ReaderStore::new(temp.path().into(), db_path);
        assert_eq!(
            reopened
                .db()
                .unwrap()
                .query_row(
                    "SELECT effect FROM colored_edition_preferences WHERE user='admin'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "badge"
        );
        assert_eq!(
            reopened
                .db()
                .unwrap()
                .query_row(
                    "SELECT effect FROM colored_edition_preferences WHERE user='other'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .optional()
                .unwrap(),
            None
        );
    }
    #[test]
    fn progress_is_user_scoped_and_new_volumes_reopen_a_series() {
        let temp = tempfile::tempdir().unwrap();
        let folder = temp.path().join("Series");
        fs::create_dir(&folder).unwrap();
        let path = folder.join("01.pdf");
        fs::write(&path, b"pdf").unwrap();
        let store = ReaderStore::new(temp.path().into(), temp.path().join("reader.sqlite"));
        let id = store.register(&path).unwrap();
        assert_eq!(store.reading_status(&folder, "admin").unwrap(), None);
        store
            .db()
            .unwrap()
            .execute(
                "INSERT INTO reader_states VALUES (?1,?2,?3,?4)",
                params!["admin", id, revision(&path).unwrap(), "{\"progress\":1.99}"],
            )
            .unwrap();
        assert_eq!(store.reading_status(&folder, "admin").unwrap(), None);
        store
            .db()
            .unwrap()
            .execute("UPDATE reader_states SET state=?1", ["{\"progress\":2}"])
            .unwrap();
        assert_eq!(
            store.reading_status(&folder, "admin").unwrap(),
            Some("Reading")
        );
        store
            .db()
            .unwrap()
            .execute("UPDATE reader_states SET state=?1", ["{\"progress\":98}"])
            .unwrap();
        assert_eq!(
            store.reading_status(&folder, "admin").unwrap(),
            Some("Finished")
        );
        assert_eq!(store.reading_status(&folder, "other").unwrap(), None);
        store
            .db()
            .unwrap()
            .execute("INSERT INTO reading_thresholds VALUES ('admin', 2, 99)", [])
            .unwrap();
        assert_eq!(
            store.reading_status(&folder, "admin").unwrap(),
            Some("Reading")
        );
        store
            .db()
            .unwrap()
            .execute("DELETE FROM reading_thresholds", [])
            .unwrap();
        fs::write(folder.join("02.cbz"), b"new").unwrap();
        assert_eq!(
            store.reading_status(&folder, "admin").unwrap(),
            Some("Reading")
        );
        fs::write(&path, b"replacement pdf").unwrap();
        assert_eq!(store.reading_status(&path, "admin").unwrap(), None);
    }
}
fn revision(path: &FsPath) -> Result<String, HttpError> {
    let meta = fs::metadata(path).map_err(failure)?;
    let time = meta
        .modified()
        .map_err(failure)?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(failure)?
        .as_nanos();
    Ok(format!("{}-{time}", meta.len()))
}
fn safe_entry(name: &str) -> bool {
    !name.is_empty()
        && !name.contains(['\\', ':', '\0'])
        && !name.starts_with('/')
        && name.split('/').all(|part| part != "..")
}
fn archive(path: &FsPath) -> Result<ZipArchive<File>, HttpError> {
    let mut zip = ZipArchive::new(File::open(path).map_err(failure)?).map_err(failure)?;
    if zip.len() > MAX_ENTRIES {
        return Err(bad("This archive exceeds the 10,000-entry reader limit."));
    }
    let mut total = 0u64;
    for index in 0..zip.len() {
        let entry = zip
            .by_index(index)
            .map_err(|_| bad("Encrypted or unsupported archives cannot be opened."))?;
        total = total.saturating_add(entry.size());
        if !safe_entry(entry.name())
            || entry.size() > MAX_ENTRY
            || total > 2 * 1024 * 1024 * 1024
            || entry.size()
                > entry
                    .compressed_size()
                    .saturating_mul(1000)
                    .max(1024 * 1024)
        {
            return Err(bad(
                "Archive contains unsafe paths or exceeds reader decompression limits.",
            ));
        }
    }
    Ok(zip)
}
fn read_entry(zip: &mut ZipArchive<File>, name: &str) -> Result<Vec<u8>, HttpError> {
    if !safe_entry(name) {
        return Err(bad("Invalid archive entry."));
    }
    let entry = zip.by_name(name).map_err(failure)?;
    if entry.size() > MAX_ENTRY {
        return Err(bad("Book resource exceeds 32 MB."));
    }
    let mut bytes = Vec::new();
    entry
        .take(MAX_ENTRY + 1)
        .read_to_end(&mut bytes)
        .map_err(failure)?;
    if bytes.len() as u64 > MAX_ENTRY {
        return Err(bad("Book resource exceeds 32 MB."));
    }
    Ok(bytes)
}
fn xml(bytes: &[u8]) -> Result<Element, HttpError> {
    if bytes.len() > 4 * 1024 * 1024
        || String::from_utf8_lossy(bytes)
            .to_ascii_uppercase()
            .contains("<!DOCTYPE")
    {
        return Err(bad("Unsupported EPUB XML document."));
    }
    Element::parse(bytes).map_err(failure)
}
fn descendants<'a>(element: &'a Element, name: &str, output: &mut Vec<&'a Element>) {
    if element.name == name {
        output.push(element);
    }
    for child in &element.children {
        if let Some(child) = child.as_element() {
            descendants(child, name, output);
        }
    }
}
fn elements<'a>(element: &'a Element, name: &str) -> Vec<&'a Element> {
    let mut out = Vec::new();
    descendants(element, name, &mut out);
    out
}
fn resolve_entry(base: &str, href: &str) -> Result<String, HttpError> {
    if href.contains(['\\', ':']) || href.starts_with('/') {
        return Err(bad("External EPUB resources are not supported."));
    }
    let mut parts: Vec<&str> = base.split('/').collect();
    parts.pop();
    for part in href.split('#').next().unwrap_or("").split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err(bad("Unsafe EPUB path."));
                }
            }
            _ => parts.push(part),
        }
    }
    let result = parts.join("/");
    if !safe_entry(&result) {
        return Err(bad("Unsafe EPUB path."));
    }
    Ok(result)
}
// Numeric runs sort by magnitude, so page 2 precedes page 10 without integer overflow.
fn natural(a: &str, b: &str) -> Ordering {
    let a = a.to_lowercase();
    let b = b.to_lowercase();
    let mut a = a.as_str();
    let mut b = b.as_str();
    while !a.is_empty() && !b.is_empty() {
        if a.as_bytes()[0].is_ascii_digit() && b.as_bytes()[0].is_ascii_digit() {
            let an = a.bytes().take_while(u8::is_ascii_digit).count();
            let bn = b.bytes().take_while(u8::is_ascii_digit).count();
            let av = a[..an].trim_start_matches('0');
            let bv = b[..bn].trim_start_matches('0');
            let order = av.len().cmp(&bv.len()).then_with(|| av.cmp(bv));
            if order != Ordering::Equal {
                return order;
            }
            a = &a[an..];
            b = &b[bn..];
        } else {
            let ac = a.chars().next().unwrap();
            let bc = b.chars().next().unwrap();
            let order = ac.cmp(&bc);
            if order != Ordering::Equal {
                return order;
            }
            a = &a[ac.len_utf8()..];
            b = &b[bc.len_utf8()..];
        }
    }
    a.len().cmp(&b.len())
}
#[derive(Serialize)]
pub(crate) struct Chapter {
    name: String,
    title: String,
}
#[derive(Serialize)]
pub(crate) struct Neighbor {
    id: String,
    title: String,
}
#[derive(Serialize)]
pub(crate) struct Manifest {
    id: String,
    title: String,
    format: String,
    revision: String,
    chapters: Vec<Chapter>,
    previous: Option<Neighbor>,
    next: Option<Neighbor>,
}
fn make_manifest(store: &ReaderStore, id: &str) -> Result<Manifest, HttpError> {
    let path = store.path(id)?;
    let kind = format(&path).unwrap();
    let mut chapters = Vec::new();
    if kind != "pdf" {
        let mut zip = archive(&path)?;
        if kind == "cbz" {
            let mut names: Vec<_> = zip
                .file_names()
                .filter(|name| {
                    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
                    !name.starts_with("__MACOSX/")
                        && ["jpg", "jpeg", "png", "webp", "gif"].contains(&ext.as_str())
                })
                .map(str::to_owned)
                .collect();
            names.sort_by(|a, b| natural(a, b).then_with(|| a.cmp(b)));
            chapters = names
                .into_iter()
                .enumerate()
                .map(|(i, name)| Chapter {
                    name,
                    title: format!("Page {}", i + 1),
                })
                .collect();
        } else {
            let container = xml(&read_entry(&mut zip, "META-INF/container.xml")?)?;
            let opf = elements(&container, "rootfile")
                .first()
                .and_then(|el| el.attributes.get("full-path"))
                .ok_or_else(|| bad("EPUB package is missing."))?
                .clone();
            let package = xml(&read_entry(&mut zip, &opf)?)?;
            let items = elements(&package, "item");
            for reference in elements(&package, "itemref") {
                if reference
                    .attributes
                    .get("linear")
                    .is_some_and(|v| v == "no")
                {
                    continue;
                }
                let item = items
                    .iter()
                    .find(|item| item.attributes.get("id") == reference.attributes.get("idref"))
                    .ok_or_else(|| bad("EPUB chapter is missing."))?;
                let href = item
                    .attributes
                    .get("href")
                    .ok_or_else(|| bad("EPUB chapter path is missing."))?;
                let name = resolve_entry(&opf, href)?;
                chapters.push(Chapter {
                    title: format!("Chapter {}", chapters.len() + 1),
                    name,
                });
            }
            // EPUB 2 NCX and EPUB 3 navigation labels, preserving spine reading order.
            for item in &items {
                let is_ncx = item
                    .attributes
                    .get("media-type")
                    .is_some_and(|v| v == "application/x-dtbncx+xml");
                let is_nav = item
                    .attributes
                    .get("properties")
                    .is_some_and(|v| v.split_whitespace().any(|p| p == "nav"));
                if !is_ncx && !is_nav {
                    continue;
                }
                let Some(href) = item.attributes.get("href") else {
                    continue;
                };
                let nav_path = resolve_entry(&opf, href)?;
                let nav = xml(&read_entry(&mut zip, &nav_path)?)?;
                let nodes = elements(&nav, if is_ncx { "navPoint" } else { "a" });
                for node in nodes {
                    let href = if is_ncx {
                        node.get_child("content")
                            .and_then(|c| c.attributes.get("src"))
                    } else {
                        node.attributes.get("href")
                    };
                    let text = if is_ncx {
                        node.get_child("navLabel")
                            .and_then(|c| c.get_child("text"))
                            .and_then(Element::get_text)
                    } else {
                        node.get_text()
                    };
                    if let (Some(href), Some(text)) = (href, text) {
                        let name = resolve_entry(&nav_path, href)?;
                        if let Some(chapter) = chapters.iter_mut().find(|c| c.name == name) {
                            chapter.title = text.to_string();
                        }
                    }
                }
            }
        }
        if chapters.is_empty() {
            return Err(bad(
                "No readable pages were found. This book may be encrypted or unsupported.",
            ));
        }
    }
    let mut siblings: Vec<PathBuf> = fs::read_dir(path.parent().unwrap())
        .map_err(failure)?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| format(p).is_some())
        .take(5000)
        .collect();
    siblings
        .sort_by(|a, b| natural(&a.to_string_lossy(), &b.to_string_lossy()).then_with(|| a.cmp(b)));
    let index = siblings.iter().position(|p| p == &path);
    let neighbor = |p: &PathBuf| {
        store.register(p).ok().map(|id| Neighbor {
            id,
            title: p
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
        })
    };
    Ok(Manifest {
        id: id.into(),
        title: path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        format: kind.into(),
        revision: revision(&path)?,
        chapters,
        previous: index
            .and_then(|i| i.checked_sub(1))
            .and_then(|i| siblings.get(i))
            .and_then(neighbor),
        next: index.and_then(|i| siblings.get(i + 1)).and_then(neighbor),
    })
}
pub(crate) async fn open(
    State(state): State<AppState>,
    Path((server, item)): Path<(i64, String)>,
) -> Result<Json<Manifest>, HttpError> {
    let detail = state
        .runtime
        .get_item_detail(server, &item)
        .await?
        .ok_or_else(|| bad("Book not found."))?
        .map_err(bad)?;
    let source = detail
        .source_path
        .ok_or_else(|| bad("This server did not provide a mounted file path for the book."))?;
    tokio::task::spawn_blocking(move || {
        let id = state.reader.register(FsPath::new(&source))?;
        make_manifest(&state.reader, &id).map(Json)
    })
    .await
    .map_err(failure)?
}
pub(crate) async fn manifest(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Manifest>, HttpError> {
    tokio::task::spawn_blocking(move || make_manifest(&state.reader, &id).map(Json))
        .await
        .map_err(failure)?
}
#[derive(Deserialize)]
pub(crate) struct ResourceQuery {
    revision: String,
    name: Option<String>,
}
fn current(store: &ReaderStore, id: &str, expected: &str) -> Result<PathBuf, HttpError> {
    let path = store.path(id)?;
    if revision(&path)? != expected {
        return Err(bad(
            "This file changed. Close and reopen the reader before continuing.",
        ));
    }
    Ok(path)
}
pub(crate) async fn file(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<ResourceQuery>,
    request: Request,
) -> Result<Response, HttpError> {
    let path = current(&state.reader, &id, &query.revision)?;
    if format(&path) != Some("pdf") {
        return Err(bad("Only PDF files are served directly."));
    }
    let response = ServeFile::new(path)
        .oneshot(request)
        .await
        .map_err(failure)?;
    let mut response = response.into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/pdf"),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response.headers_mut().insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("sandbox"),
    );
    Ok(response)
}
pub(crate) async fn entry(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<ResourceQuery>,
) -> Result<Response, HttpError> {
    tokio::task::spawn_blocking(move || {
        let path = current(&state.reader, &id, &query.revision)?;
        let name = query.name.ok_or_else(|| bad("Missing entry name."))?;
        let mut zip = archive(&path)?;
        let bytes = read_entry(&mut zip, &name)?;
        // Never serve archive HTML as executable same-origin content.
        let mime = match name
            .rsplit('.')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str()
        {
            "jpg" | "jpeg" => "image/jpeg",
            "png" => "image/png",
            "webp" => "image/webp",
            "gif" => "image/gif",
            _ => "text/plain; charset=utf-8",
        };
        if mime.starts_with("image/") && !mime.ends_with("gif") {
            let (width, height) = image::ImageReader::new(std::io::Cursor::new(&bytes))
                .with_guessed_format()
                .map_err(failure)?
                .into_dimensions()
                .map_err(failure)?;
            if u64::from(width) * u64::from(height) > 64_000_000 {
                return Err(bad("This image exceeds the reader's 64 megapixel limit."));
            }
        }
        Ok((
            [
                (header::CONTENT_TYPE, mime),
                (header::CACHE_CONTROL, "private, no-store"),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
                (
                    header::CONTENT_SECURITY_POLICY,
                    "default-src 'none'; sandbox",
                ),
            ],
            bytes,
        )
            .into_response())
    })
    .await
    .map_err(failure)?
}
#[derive(Serialize, Deserialize)]
pub(crate) struct SavedState {
    revision: String,
    data: serde_json::Value,
}
#[derive(Serialize, Deserialize)]
pub(crate) struct DisplayPreferences {
    #[serde(default = "default_effect")]
    colored_effect: String,
    tracking_overlays: bool,
    #[serde(default = "default_reading")]
    reading_threshold: f64,
    #[serde(default = "default_finished")]
    finished_threshold: f64,
}
fn default_effect() -> String {
    "off".into()
}
fn default_reading() -> f64 {
    2.0
}
fn default_finished() -> f64 {
    98.0
}
fn thresholds(db: &Connection, user: &str) -> Result<(f64, f64), HttpError> {
    Ok(db
        .query_row(
            "SELECT reading,finished FROM reading_thresholds WHERE user=?1",
            [user],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(failure)?
        .unwrap_or((2.0, 98.0)))
}
pub(crate) async fn load_display_preferences(
    State(state): State<AppState>,
) -> Result<Json<DisplayPreferences>, HttpError> {
    tokio::task::spawn_blocking(move || {
        let tracking_overlays = state
            .reader
            .db()?
            .query_row(
                "SELECT tracking_overlays FROM library_display_preferences WHERE user=?1",
                [state.auth.username()],
                |r| r.get::<_, bool>(0),
            )
            .optional()
            .map_err(failure)?
            .unwrap_or(true);
        let (reading_threshold, finished_threshold) =
            thresholds(&state.reader.db()?, state.auth.username())?;
        Ok(Json(DisplayPreferences {
            colored_effect: state
                .reader
                .db()?
                .query_row(
                    "SELECT effect FROM colored_edition_preferences WHERE user=?1",
                    [state.auth.username()],
                    |r| r.get::<_, String>(0),
                )
                .optional()
                .map_err(failure)?
                .unwrap_or_else(default_effect),
            tracking_overlays,
            reading_threshold,
            finished_threshold,
        }))
    })
    .await
    .map_err(failure)?
}
pub(crate) async fn save_display_preferences(
    State(state): State<AppState>,
    Json(settings): Json<DisplayPreferences>,
) -> Result<Json<DisplayPreferences>, HttpError> {
    if !["off", "shimmer", "badge"].contains(&settings.colored_effect.as_str()) {
        return Err(bad("Unknown colored edition effect."));
    }
    if !settings.reading_threshold.is_finite()
        || !settings.finished_threshold.is_finite()
        || settings.reading_threshold < 0.0
        || settings.finished_threshold > 100.0
        || settings.reading_threshold >= settings.finished_threshold
    {
        return Err(bad(
            "Reading must be at least 0% and below Finished; Finished must be at most 100%.",
        ));
    }
    tokio::task::spawn_blocking(move || {
        let mut db = state.reader.db()?;
        let tx = db.transaction().map_err(failure)?;
        tx.execute("INSERT INTO library_display_preferences(user,tracking_overlays) VALUES (?1,?2) ON CONFLICT(user) DO UPDATE SET tracking_overlays=excluded.tracking_overlays", params![state.auth.username(), settings.tracking_overlays]).map_err(failure)?;
        tx.execute("INSERT INTO reading_thresholds VALUES (?1,?2,?3) ON CONFLICT(user) DO UPDATE SET reading=excluded.reading,finished=excluded.finished", params![state.auth.username(), settings.reading_threshold, settings.finished_threshold]).map_err(failure)?;
        tx.execute("INSERT INTO colored_edition_preferences VALUES (?1,?2) ON CONFLICT(user) DO UPDATE SET effect=excluded.effect", params![state.auth.username(), settings.colored_effect]).map_err(failure)?;
        tx.commit().map_err(failure)?;
        Ok(Json(settings))
    }).await.map_err(failure)?
}
pub(crate) async fn load_state(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Option<SavedState>>, HttpError> {
    tokio::task::spawn_blocking(move || {
        state.reader.path(&id)?;
        let saved: Option<(String, String)> = state
            .reader
            .db()?
            .query_row(
                "SELECT revision,state FROM reader_states WHERE user=?1 AND book=?2",
                params![state.auth.username(), id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(failure)?;
        saved
            .map(|(revision, data)| {
                serde_json::from_str(&data)
                    .map(|data| SavedState { revision, data })
                    .map_err(failure)
            })
            .transpose()
            .map(Json)
    })
    .await
    .map_err(failure)?
}
pub(crate) async fn save_state(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(saved): Json<SavedState>,
) -> Result<Json<bool>, HttpError> {
    let data = serde_json::to_string(&saved.data).map_err(failure)?;
    if data.len() > 64 * 1024 {
        return Err(bad("Reader settings and bookmarks exceed 64 KB."));
    }
    tokio::task::spawn_blocking(move || {
        current(&state.reader,&id,&saved.revision)?;
        let _guard = state.reader.writes.lock().map_err(failure)?;
        state.reader.db()?.execute("INSERT INTO reader_states(user,book,revision,state) VALUES (?1,?2,?3,?4) ON CONFLICT(user,book) DO UPDATE SET revision=excluded.revision,state=excluded.state",params![state.auth.username(),id,saved.revision,data]).map_err(failure)?;
        Ok(Json(true))
    }).await.map_err(failure)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    #[test]
    fn epub_spine_and_navigation() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("book.epub");
        let mut zip = zip::ZipWriter::new(File::create(&path).unwrap());
        for (name, body) in [
            (
                "META-INF/container.xml",
                r#"<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>"#,
            ),
            (
                "OPS/book.opf",
                r#"<package><manifest><item id="two" href="two.xhtml"/><item id="one" href="one.xhtml"/><item id="nav" href="nav.xhtml" properties="nav"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>"#,
            ),
            (
                "OPS/nav.xhtml",
                r#"<html><body><nav><a href="one.xhtml">Beginning</a><a href="two.xhtml">Ending</a></nav></body></html>"#,
            ),
            ("OPS/one.xhtml", "<html><body>Hello</body></html>"),
            ("OPS/two.xhtml", "<html><body>World</body></html>"),
        ] {
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
        let store = ReaderStore::new(temp.path().into(), temp.path().join("reader.db"));
        let id = store.register(&path).unwrap();
        let manifest = make_manifest(&store, &id).unwrap();
        assert_eq!(manifest.chapters[0].name, "OPS/one.xhtml");
        assert_eq!(manifest.chapters[0].title, "Beginning");
        assert_eq!(manifest.chapters[1].title, "Ending");
        assert!(xml(b"<!DOCTYPE html><html/>").is_err());
    }
    #[tokio::test]
    async fn authenticated_ranges_and_durable_progress() {
        use axum::{
            Router,
            body::Body,
            http::{Request, StatusCode},
            routing::get,
        };
        use http_body_util::BodyExt;
        use std::sync::Arc;
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("book.pdf");
        fs::write(&path, b"%PDF-1.7 test content").unwrap();
        let runtime = Arc::new(posterview_runtime::Runtime::new(temp.path()));
        runtime.initialize().unwrap();
        let reader = Arc::new(ReaderStore::new(
            temp.path().into(),
            temp.path().join("reader.db"),
        ));
        let id = reader.register(&path).unwrap();
        let version = revision(&path).unwrap();
        let auth = crate::AuthState::for_tests("secret");
        let (_, cookie) = auth.login("admin", "secret").unwrap();
        let cookie = cookie
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        let state = AppState {
            runtime,
            auth: auth.clone(),
            metadata: Arc::new(crate::metadata::MetadataStore::new(temp.path().into())),
            login_backdrop: crate::login_backdrop::LoginBackdrop::new(temp.path()),
            reader,
        };
        let app = Router::new()
            .route("/books/{id}/file", get(file))
            .route("/books/{id}/state", get(load_state).put(save_state))
            .route_layer(axum::middleware::from_fn_with_state(
                auth,
                crate::require_auth,
            ))
            .with_state(state);
        let url = format!("/books/{id}/file?revision={version}");
        let unauthorized = app
            .clone()
            .oneshot(Request::get(&url).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
        let range = app
            .clone()
            .oneshot(
                Request::get(&url)
                    .header("cookie", &cookie)
                    .header("range", "bytes=0-3")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(range.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            &range.into_body().collect().await.unwrap().to_bytes()[..],
            b"%PDF"
        );
        let url = format!("/books/{id}/state");
        let payload = serde_json::json!({"revision":version,"data":{"page":3,"bookmarks":[{"page":2,"label":"Start"}]}});
        let saved = app
            .clone()
            .oneshot(
                Request::put(&url)
                    .header("cookie", &cookie)
                    .header("content-type", "application/json")
                    .body(Body::from(payload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(saved.status(), StatusCode::OK);
        let loaded = app
            .oneshot(
                Request::get(&url)
                    .header("cookie", &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let loaded: serde_json::Value =
            serde_json::from_slice(&loaded.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(loaded, payload);
        let reopened = ReaderStore::new(temp.path().into(), temp.path().join("reader.db"));
        let count: i64 = reopened
            .db()
            .unwrap()
            .query_row(
                "SELECT count(*) FROM reader_states WHERE user='admin'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }
    #[test]
    fn natural_page_order() {
        let mut names = vec!["10.jpg", "2.jpg", "1.jpg"];
        names.sort_by(|a, b| natural(a, b));
        assert_eq!(names, vec!["1.jpg", "2.jpg", "10.jpg"]);
    }
    #[test]
    fn rejects_unsafe_entries() {
        for name in ["../secret", "/etc/passwd", "a/../../b", "a\\b", "C:/file"] {
            assert!(!safe_entry(name));
        }
        assert!(resolve_entry("OPS/book.opf", "../../outside").is_err());
    }
    #[test]
    fn mounted_files_only() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("media");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("one.pdf"), b"pdf").unwrap();
        fs::write(temp.path().join("outside.pdf"), b"pdf").unwrap();
        let store = ReaderStore::new(root.clone(), temp.path().join("reader.db"));
        assert!(store.register(&root.join("one.pdf")).is_ok());
        assert!(store.register(&temp.path().join("outside.pdf")).is_err());
        assert!(store.register(&root.join("../outside.pdf")).is_err());
    }
    #[test]
    fn cbz_manifest_and_stable_identity() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("Volume 1.cbz");
        let mut zip = zip::ZipWriter::new(File::create(&file).unwrap());
        for name in ["10.png", "2.png", "1.png"] {
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(b"image").unwrap();
        }
        zip.finish().unwrap();
        let store = ReaderStore::new(temp.path().into(), temp.path().join("reader.db"));
        let id = store.register(&file).unwrap();
        assert_eq!(id, store.register(&file).unwrap());
        let manifest = make_manifest(&store, &id).unwrap();
        assert_eq!(manifest.chapters[1].name, "2.png");
        assert!(current(&store, &id, "old-revision").is_err());
    }
}
