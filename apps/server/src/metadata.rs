//! Opt-in sidecars on a mounted manga directory. No media-server mutations.
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

use crate::{AppState, error::HttpError};
use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use xmltree::{Element, EmitterConfig, XMLNode};

const MAX_NFO: u64 = 1_048_576;
const SOURCE_CACHE_TTL: Duration = Duration::from_secs(5 * 60);

fn linked(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

pub(crate) struct MetadataStore {
    root: PathBuf,
    writes: Mutex<()>,
    sources: Mutex<HashMap<(i64, String), CachedSource>>,
}

struct CachedSource {
    path: String,
    resolved_at: Instant,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub(crate) struct Fields {
    title: String,
    year: String,
    publisher: String,
    edition: String,
    volumes: String,
    status: String,
    plot: String,
    anilist_id: String,
    comicvine_id: String,
    source_url: String,
    native_title: String,
    mal_id: String,
    genres: String,
    tags: String,
    creators: String,
    country: String,
    source_material: String,
}

#[derive(Deserialize)]
pub(crate) struct Location {
    path: String,
}

#[derive(Serialize)]
pub(crate) struct Folder {
    name: String,
    path: String,
    has_nfo: bool,
}

#[derive(Serialize)]
pub(crate) struct FolderList {
    root: String,
    path: String,
    folders: Vec<Folder>,
}

#[derive(Serialize)]
pub(crate) struct Document {
    path: String,
    target: String,
    fields: Fields,
    // An exact revision allows stale editors to fail rather than overwrite changes.
    revision: Option<String>,
    xml: String,
}

#[derive(Deserialize)]
pub(crate) struct SaveRequest {
    path: String,
    fields: Fields,
    revision: Option<String>,
}

fn invalid(message: impl Into<String>) -> HttpError {
    HttpError::bad_request(message)
}
fn io_error(error: std::io::Error) -> HttpError {
    let detail = if error.kind() == std::io::ErrorKind::PermissionDenied {
        "The media folder is not writable/readable by PosterView. Check mount permissions (container UID 10001).".to_owned()
    } else {
        format!("Media folder operation failed: {error}")
    };
    HttpError {
        status: StatusCode::BAD_REQUEST,
        detail,
    }
}

impl MetadataStore {
    pub(crate) fn new(root: PathBuf) -> Self {
        Self {
            root,
            writes: Mutex::new(()),
            sources: Mutex::new(HashMap::new()),
        }
    }

    fn cached_source(&self, server_id: i64, item_id: &str) -> Option<String> {
        let key = (server_id, item_id.to_owned());
        let mut sources = self.sources.lock().ok()?;
        if sources
            .get(&key)
            .is_some_and(|source| source.resolved_at.elapsed() < SOURCE_CACHE_TTL)
        {
            return sources.get(&key).map(|source| source.path.clone());
        }
        sources.remove(&key);
        None
    }

    fn remember_source(&self, server_id: i64, item_id: &str, path: &str) {
        if let Ok(mut sources) = self.sources.lock() {
            sources.insert(
                (server_id, item_id.to_owned()),
                CachedSource {
                    path: path.to_owned(),
                    resolved_at: Instant::now(),
                },
            );
        }
    }

    fn directory(&self, relative: &str, allow_root: bool) -> Result<PathBuf, HttpError> {
        if relative.contains('\\')
            || relative.contains(':')
            || relative.contains('\0')
            || PathBuf::from(relative)
                .components()
                .any(|p| !matches!(p, Component::Normal(_)))
            || (!allow_root && relative.is_empty())
        {
            return Err(invalid(
                "Choose a series folder beneath the mounted media root.",
            ));
        }
        let root = self.root.canonicalize().map_err(|_| invalid(format!(
            "Media path is not available: {}. Mount your manga directory at /media, or set POSTERVIEW_MEDIA_DIR to its local path.", self.root.display())))?;
        let mut directory = root.clone();
        for part in PathBuf::from(relative).components() {
            directory.push(part);
            // Do not follow symlinks or Windows junctions, even within the media tree.
            if linked(&fs::symlink_metadata(&directory).map_err(io_error)?) {
                return Err(invalid(
                    "Linked folders are not supported. Mount the real directory.",
                ));
            }
        }
        let directory = directory.canonicalize().map_err(io_error)?;
        if !directory.starts_with(&root) || !directory.is_dir() {
            return Err(invalid("Folder must be inside the mounted media root."));
        }
        Ok(directory)
    }

    fn target(directory: &std::path::Path) -> PathBuf {
        let mut name = directory.file_name().unwrap_or_default().to_os_string();
        name.push(".nfo");
        directory.join(name)
    }

    fn current(directory: &std::path::Path) -> Result<Option<String>, HttpError> {
        let path = Self::target(directory);
        let metadata = match fs::symlink_metadata(&path) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(io_error(error)),
        };
        if !metadata.is_file() || linked(&metadata) || metadata.len() > MAX_NFO {
            return Err(invalid("The NFO must be a regular file smaller than 1 MB."));
        }
        let mut text = String::new();
        fs::File::open(path)
            .map_err(io_error)?
            .take(MAX_NFO + 1)
            .read_to_string(&mut text)
            .map_err(io_error)?;
        if text.len() as u64 > MAX_NFO {
            return Err(invalid("The NFO is too large."));
        }
        Ok(Some(text))
    }

    fn list(&self, path: &str) -> Result<FolderList, HttpError> {
        let directory = self.directory(path, true)?;
        let mut folders = Vec::new();
        for entry in fs::read_dir(directory).map_err(io_error)? {
            let entry = entry.map_err(io_error)?;
            if !entry.file_type().map_err(io_error)?.is_dir() {
                continue;
            }
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if name.starts_with('.') {
                continue;
            }
            folders.push(Folder {
                path: if path.is_empty() {
                    name.clone()
                } else {
                    format!("{path}/{name}")
                },
                has_nfo: Self::target(&entry.path()).symlink_metadata().is_ok(),
                name,
            });
            if folders.len() > 10_000 {
                return Err(invalid("Too many folders. Choose a smaller media root."));
            }
        }
        folders.sort_by_key(|folder| folder.name.to_lowercase());
        Ok(FolderList {
            root: self.root.display().to_string(),
            path: path.to_owned(),
            folders,
        })
    }

    fn read(&self, path: &str) -> Result<Document, HttpError> {
        let directory = self.directory(path, false)?;
        let revision = Self::current(&directory)?;
        let mut fields = if let Some(xml) = &revision {
            fields_from(&parse(xml)?)
        } else {
            Fields {
                title: directory
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
                ..Fields::default()
            }
        };
        if fields.title.trim().is_empty() {
            fields.title = directory
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
        }
        let xml = match &revision {
            Some(xml) => xml.clone(),
            None => render(&fields, None)?,
        };
        Ok(Document {
            path: path.to_owned(),
            target: Self::target(&directory).display().to_string(),
            fields,
            revision,
            xml,
        })
    }

    fn relative_directory_for_source(&self, source: &str) -> Result<String, HttpError> {
        let root = self.root.canonicalize().map_err(|_| invalid(format!(
            "Media path is not available: {}.", self.root.display())))?;
        let normalized = source.replace('\\', "/");
        let source_path = PathBuf::from(&normalized);
        let canonical_source = source_path.canonicalize().unwrap_or_else(|_| source_path.clone());
        let mapped = if canonical_source.starts_with(&root) {
            canonical_source
        } else if let Some(relative) = normalized.strip_prefix("/mnt/user/") {
            root.join(relative)
        } else if let Some(relative) = normalized.strip_prefix("/media/") {
            root.join(relative)
        } else {
            return Err(invalid("The media server path is outside the configured Media Path."));
        };
        let directory = if mapped.is_dir() { mapped } else { mapped.parent().unwrap_or(Path::new("")).to_path_buf() };
        let relative = directory.strip_prefix(&root).map_err(|_| invalid("The media item is outside the configured Media Path."))?;
        Ok(relative.to_string_lossy().replace('\\', "/"))
    }

    pub(crate) fn read_for_source(&self, source: &str) -> Result<Option<Fields>, HttpError> {
        let relative = self.relative_directory_for_source(source)?;
        let document = self.read(&relative)?;
        Ok(document.revision.map(|_| document.fields))
    }

    pub(crate) fn save_fields_for_source(
        &self,
        source: &str,
        fields: Fields,
    ) -> Result<Fields, HttpError> {
        let relative = self.relative_directory_for_source(source)?;
        let document = self.read(&relative)?;
        Ok(self
            .save(&SaveRequest {
                path: relative,
                fields,
                revision: document.revision,
            })?
            .fields)
    }

    pub(crate) fn save_comicvine_for_source(
        &self,
        source: &str,
        id: &str,
        title: &str,
        year: &str,
        publisher: &str,
        volumes: &str,
        plot: &str,
        source_url: &str,
    ) -> Result<Fields, HttpError> {
        let relative = self.relative_directory_for_source(source)?;
        let document = self.read(&relative)?;
        let mut fields = document.fields;
        fields.title = title.to_owned();
        fields.year = year.to_owned();
        fields.publisher = publisher.to_owned();
        fields.volumes = volumes.to_owned();
        fields.plot = plot.to_owned();
        fields.comicvine_id = id.to_owned();
        fields.source_url = source_url.to_owned();
        Ok(self.save(&SaveRequest { path: relative, fields, revision: document.revision })?.fields)
    }

    pub(crate) fn save_anilist_manga_for_source(
        &self,
        source_path: &str,
        id: &str, mal_id: &str, title: &str, native_title: &str, year: &str,
        status: &str, plot: &str, genres: &str, tags: &str, creators: &str,
        country: &str, source_material: &str, source_url: &str,
    ) -> Result<Fields, HttpError> {
        let relative = self.relative_directory_for_source(source_path)?;
        let document = self.read(&relative)?;
        let mut fields = document.fields;
        for (target, incoming) in [
            (&mut fields.title, title), (&mut fields.native_title, native_title),
            (&mut fields.year, year), (&mut fields.status, status), (&mut fields.plot, plot),
            (&mut fields.anilist_id, id), (&mut fields.mal_id, mal_id),
            (&mut fields.genres, genres), (&mut fields.tags, tags),
            (&mut fields.creators, creators), (&mut fields.country, country),
            (&mut fields.source_material, source_material), (&mut fields.source_url, source_url),
        ] {
            if !incoming.trim().is_empty() { *target = incoming.to_owned(); }
        }
        Ok(self.save(&SaveRequest { path: relative, fields, revision: document.revision })?.fields)
    }

    fn preview(&self, request: &SaveRequest) -> Result<Document, HttpError> {
        let directory = self.directory(&request.path, false)?;
        let current = Self::current(&directory)?;
        if current != request.revision {
            return Err(HttpError {
                status: StatusCode::CONFLICT,
                detail: "The NFO changed since you opened it. Reload before saving.".to_owned(),
            });
        }
        Ok(Document {
            path: request.path.clone(),
            target: Self::target(&directory).display().to_string(),
            fields: request.fields.clone(),
            revision: current.clone(),
            xml: render(&request.fields, current.as_deref())?,
        })
    }

    fn save(&self, request: &SaveRequest) -> Result<Document, HttpError> {
        let _guard = self
            .writes
            .lock()
            .map_err(|_| invalid("Please retry this save."))?;
        let document = self.preview(request)?;
        let directory = self.directory(&request.path, false)?;
        let target = Self::target(&directory);
        let mut temporary = tempfile::NamedTempFile::new_in(&directory).map_err(io_error)?;
        temporary
            .write_all(document.xml.as_bytes())
            .map_err(io_error)?;
        if let Ok(metadata) = fs::metadata(&target) {
            temporary
                .as_file()
                .set_permissions(metadata.permissions())
                .map_err(io_error)?;
        } else {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                temporary
                    .as_file()
                    .set_permissions(fs::Permissions::from_mode(0o644))
                    .map_err(io_error)?;
            }
        }
        temporary.as_file().sync_all().map_err(io_error)?;
        if Self::current(&directory)? != request.revision {
            return Err(invalid(
                "The NFO changed during the save. Reload and try again.",
            ));
        }
        if request.revision.is_none() {
            temporary
                .persist_noclobber(&target)
                .map_err(|e| io_error(e.error))?;
        } else {
            // Keep the original bytes next to the file before any explicit update.
            let mut backup_name = target.file_name().unwrap_or_default().to_os_string();
            backup_name.push(format!(".{}.bak", uuid::Uuid::new_v4()));
            let backup = directory.join(backup_name);
            fs::write(backup, request.revision.as_deref().unwrap_or_default()).map_err(io_error)?;
            temporary.persist(&target).map_err(|e| io_error(e.error))?;
        }
        self.read(&request.path)
    }
}

fn parse(xml: &str) -> Result<Element, HttpError> {
    if xml.contains("<!DOCTYPE") || xml.contains("<!ENTITY") {
        return Err(invalid(
            "NFO files containing DTDs or entities are not supported.",
        ));
    }
    let element = Element::parse(xml.as_bytes())
        .map_err(|_| invalid("The existing NFO is not valid XML. It has not been changed."))?;
    if !matches!(element.name.as_str(), "series" | "book" | "tvshow") {
        return Err(invalid(
            "Unsupported NFO root. Expected series, book, or tvshow; the file has not been changed.",
        ));
    }
    Ok(element)
}

fn fields_from(root: &Element) -> Fields {
    let text = |name: &str| {
        root.get_child(name)
            .and_then(Element::get_text)
            .map(|s| s.into_owned())
            .unwrap_or_default()
    };
    Fields {
        title: text("title"),
        year: text("year"),
        publisher: text("publisher"),
        edition: text("edition"),
        volumes: text("volumes"),
        status: text("status"),
        plot: text("plot"),
        anilist_id: text("anilistid"),
        comicvine_id: text("comicvineid"),
        source_url: text("source"),
        native_title: text("originaltitle"),
        mal_id: text("malid"),
        genres: text("genres"),
        tags: text("tags"),
        creators: text("creators"),
        country: text("country"),
        source_material: text("sourcematerial"),
    }
}

fn render(fields: &Fields, original: Option<&str>) -> Result<String, HttpError> {
    if fields.title.trim().is_empty() {
        return Err(invalid("A series title is required."));
    }
    for (name, value) in [
        ("Year", &fields.year),
        ("Edition volumes", &fields.volumes),
        ("AniList ID", &fields.anilist_id),
    ] {
        if !value.is_empty() && !value.parse::<u32>().is_ok_and(|number| number > 0) {
            return Err(invalid(format!(
                "{name} must be a positive whole number or left blank."
            )));
        }
    }
    let mut root = original
        .map(parse)
        .transpose()?
        .unwrap_or_else(|| Element::new("series"));
    for (name, value) in [
        ("title", &fields.title),
        ("year", &fields.year),
        ("publisher", &fields.publisher),
        ("edition", &fields.edition),
        ("volumes", &fields.volumes),
        ("status", &fields.status),
        ("plot", &fields.plot),
        ("anilistid", &fields.anilist_id),
        ("comicvineid", &fields.comicvine_id),
        ("source", &fields.source_url),
        ("originaltitle", &fields.native_title),
        ("malid", &fields.mal_id),
        ("genres", &fields.genres),
        ("tags", &fields.tags),
        ("creators", &fields.creators),
        ("country", &fields.country),
        ("sourcematerial", &fields.source_material),
    ] {
        if value.len() > 32_768
            || value
                .chars()
                .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
        {
            return Err(invalid(
                "Metadata contains invalid characters or an oversized field.",
            ));
        }
        // Preserve untouched elements, attributes, comments and third-party fields.
        let old = root
            .get_child(name)
            .and_then(Element::get_text)
            .map(|s| s.into_owned())
            .unwrap_or_default();
        if old == *value {
            continue;
        }
        root.children
            .retain(|node| !matches!(node, XMLNode::Element(e) if e.name == name));
        if !value.is_empty() {
            let mut element = Element::new(name);
            element.children.push(XMLNode::Text(value.clone()));
            root.children.push(XMLNode::Element(element));
        }
    }
    let mut output = Vec::new();
    root.write_with_config(&mut output, EmitterConfig::new().perform_indent(true))
        .map_err(|_| invalid("Could not generate NFO XML."))?;
    if output.len() as u64 > MAX_NFO {
        return Err(invalid("The resulting NFO would exceed the 1 MB limit."));
    }
    String::from_utf8(output).map_err(|_| invalid("Could not encode NFO XML."))
}

pub(crate) async fn folders(
    State(state): State<AppState>,
    Query(location): Query<Location>,
) -> Result<Json<FolderList>, HttpError> {
    tokio::task::spawn_blocking(move || state.metadata.list(&location.path))
        .await
        .map_err(|_| invalid("Could not read folders."))?
        .map(Json)
}
pub(crate) async fn document(
    State(state): State<AppState>,
    Query(location): Query<Location>,
) -> Result<Json<Document>, HttpError> {
    tokio::task::spawn_blocking(move || state.metadata.read(&location.path))
        .await
        .map_err(|_| invalid("Could not read metadata."))?
        .map(Json)
}
pub(crate) async fn preview(
    State(state): State<AppState>,
    Json(request): Json<SaveRequest>,
) -> Result<Json<Document>, HttpError> {
    tokio::task::spawn_blocking(move || state.metadata.preview(&request))
        .await
        .map_err(|_| invalid("Could not preview metadata."))?
        .map(Json)
}
pub(crate) async fn save(
    State(state): State<AppState>,
    Json(request): Json<SaveRequest>,
) -> Result<Json<Document>, HttpError> {
    tokio::task::spawn_blocking(move || state.metadata.save(&request))
        .await
        .map_err(|_| invalid("Could not save metadata."))?
        .map(Json)
}

#[derive(Deserialize)]
pub(crate) struct ItemMetadataQuery {
    server_id: i64,
    item_id: String,
}

#[derive(Deserialize)]
pub(crate) struct ItemMetadataUpdate {
    server_id: i64,
    item_id: String,
    fields: Fields,
}

#[derive(Deserialize)]
pub(crate) struct ComicVineRequest {
    server_id: i64,
    item_id: String,
    volume_id: String,
}

#[derive(Deserialize)]
pub(crate) struct AniListMangaRequest {
    server_id: i64,
    item_id: String,
    anilist_id: String,
}

async fn item_source(state: &AppState, server_id: i64, item_id: &str) -> Result<String, HttpError> {
    if let Some(source) = state.metadata.cached_source(server_id, item_id) {
        return Ok(source);
    }
    let item = state.runtime.get_item_detail(server_id, item_id).await?
        .ok_or_else(HttpError::not_found)?
        .map_err(HttpError::bad_gateway)?;
    let source = item.source_path.ok_or_else(|| invalid("The media server did not provide a filesystem path for this item."))?;
    state.metadata.remember_source(server_id, item_id, &source);
    Ok(source)
}

pub(crate) async fn item(
    State(state): State<AppState>,
    Query(query): Query<ItemMetadataQuery>,
) -> Result<Json<Option<Fields>>, HttpError> {
    let source = item_source(&state, query.server_id, &query.item_id).await?;
    state.metadata.read_for_source(&source).map(Json)
}

pub(crate) async fn update_item(
    State(state): State<AppState>,
    Json(request): Json<ItemMetadataUpdate>,
) -> Result<Json<Fields>, HttpError> {
    let server = state
        .runtime
        .list_servers()?
        .into_iter()
        .find(|server| server.id == request.server_id)
        .ok_or_else(HttpError::not_found)?;
    if !server.nfo_metadata_enabled {
        return Err(invalid(
            "Enable NFO metadata for this server in Settings → Server Setup first.",
        ));
    }
    let source = item_source(&state, request.server_id, &request.item_id).await?;
    state
        .metadata
        .save_fields_for_source(&source, request.fields)
        .map(Json)
}

pub(crate) async fn use_comicvine(
    State(state): State<AppState>,
    Json(request): Json<ComicVineRequest>,
) -> Result<Json<Fields>, HttpError> {
    let server = state.runtime.list_servers()?.into_iter()
        .find(|server| server.id == request.server_id)
        .ok_or_else(HttpError::not_found)?;
    if !server.nfo_metadata_enabled {
        return Err(invalid("Enable NFO metadata for this server in Settings → Server Setup first."));
    }
    let source = item_source(&state, request.server_id, &request.item_id).await?;
    let metadata = state.runtime.comicvine_metadata(&request.volume_id).await
        .map_err(|error| HttpError::bad_gateway(error.to_string()))?;
    state.metadata.save_comicvine_for_source(
        &source, &metadata.id, &metadata.title, &metadata.year, &metadata.publisher,
        &metadata.volumes, &metadata.plot, &metadata.source_url,
    ).map(Json)
}

pub(crate) async fn use_anilist_manga(
    State(state): State<AppState>,
    Json(request): Json<AniListMangaRequest>,
) -> Result<Json<Fields>, HttpError> {
    let server = state.runtime.list_servers()?.into_iter()
        .find(|server| server.id == request.server_id).ok_or_else(HttpError::not_found)?;
    if !server.nfo_metadata_enabled {
        return Err(invalid("Enable NFO metadata for this server in Settings → Server Setup first."));
    }
    let source = item_source(&state, request.server_id, &request.item_id).await?;
    let metadata = state.runtime.anilist_manga_metadata(&request.anilist_id).await
        .map_err(|error| HttpError::bad_gateway(error.to_string()))?;
    state.metadata.save_anilist_manga_for_source(
        &source, &metadata.id, &metadata.mal_id, &metadata.title, &metadata.native_title,
        &metadata.year, &metadata.status, &metadata.plot, &metadata.genres, &metadata.tags,
        &metadata.creators, &metadata.country, &metadata.source, &metadata.source_url,
    ).map(Json)
}

#[derive(Deserialize)]
pub(crate) struct Search {
    query: String,
}
pub(crate) async fn search(Query(search): Query<Search>) -> Result<Json<Vec<Fields>>, HttpError> {
    if search.query.trim().len() < 2 || search.query.len() > 200 {
        return Err(invalid("Enter a manga title (2–200 characters)."));
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|_| HttpError::bad_gateway("Could not start metadata search."))?;
    let response = client.post("https://graphql.anilist.co").json(&serde_json::json!({
        "query": "query($search:String){Page(perPage:8){media(search:$search,type:MANGA){id title{english romaji} startDate{year} description(asHtml:false) status}}}",
        "variables": {"search": search.query.trim()}
    })).send().await.map_err(|_| HttpError::bad_gateway("AniList is unreachable or timed out. You can still edit metadata manually."))?;
    if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(HttpError {
            status: StatusCode::TOO_MANY_REQUESTS,
            detail: "AniList rate limit reached. Wait a minute before searching again.".into(),
        });
    }
    let body: serde_json::Value = response
        .error_for_status()
        .map_err(|_| HttpError::bad_gateway("AniList is temporarily unavailable."))?
        .json()
        .await
        .map_err(|_| HttpError::bad_gateway("Invalid AniList response."))?;
    let media = body["data"]["Page"]["media"]
        .as_array()
        .ok_or_else(|| HttpError::bad_gateway("AniList could not complete this search."))?;
    Ok(Json(
        media
            .iter()
            .map(|item| Fields {
                title: item["title"]["english"]
                    .as_str()
                    .or(item["title"]["romaji"].as_str())
                    .unwrap_or_default()
                    .into(),
                year: item["startDate"]["year"]
                    .as_u64()
                    .map(|v| v.to_string())
                    .unwrap_or_default(),
                status: match item["status"].as_str() {
                    Some("FINISHED") => "Completed",
                    Some("RELEASING") => "Ongoing",
                    Some("HIATUS") => "Hiatus",
                    Some("CANCELLED") => "Cancelled",
                    Some("NOT_YET_RELEASED") => "Not yet released",
                    _ => "",
                }
                .into(),
                plot: item["description"].as_str().unwrap_or_default().into(),
                anilist_id: item["id"]
                    .as_u64()
                    .map(|v| v.to_string())
                    .unwrap_or_default(),
                ..Fields::default()
            })
            .collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn metadata_routes_require_authentication() {
        use axum::{body::Body, http::Request};
        use tower::ServiceExt;
        let directory = tempfile::tempdir().unwrap();
        let runtime = std::sync::Arc::new(posterview_runtime::Runtime::new(directory.path()));
        runtime.initialize().unwrap();
        let app = crate::router(
            runtime,
            PathBuf::from("missing-ui"),
            crate::AuthState::for_tests("secret"),
        );
        for (method, path) in [
            ("GET", "/api/metadata/folders?path="),
            ("GET", "/api/metadata/document?path=Manga"),
            ("PUT", "/api/metadata/document"),
            ("POST", "/api/metadata/preview"),
            ("GET", "/api/metadata/search?query=Manga"),
            ("GET", "/api/metadata/item?server_id=1&item_id=manga"),
            ("PUT", "/api/metadata/item"),
            ("POST", "/api/metadata/comicvine"),
            ("POST", "/api/metadata/anilist-manga"),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(path)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }
    }

    fn setup() -> (tempfile::TempDir, MetadataStore) {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("Manga & Color")).unwrap();
        let store = MetadataStore::new(dir.path().to_owned());
        (dir, store)
    }

    #[test]
    fn resolved_item_sources_are_reused_for_metadata_saves() {
        let (_directory, store) = setup();
        assert!(store.cached_source(7, "series").is_none());
        store.remember_source(7, "series", "/mnt/user/Manga/Series");
        assert_eq!(
            store.cached_source(7, "series").as_deref(),
            Some("/mnt/user/Manga/Series")
        );
        assert!(store.cached_source(8, "series").is_none());
        assert!(store.cached_source(7, "other").is_none());
    }

    #[test]
    fn filename_uses_folder_not_editable_title_and_ignores_old_sidecar() {
        let (dir, store) = setup();
        let folder = dir.path().join("Manga & Color");
        fs::write(
            folder.join("series.nfo"),
            "<series><title>Legacy</title></series>",
        )
        .unwrap();
        let doc = store.read("Manga & Color").ok().unwrap();
        assert!(doc.revision.is_none());
        assert!(!store.list("").ok().unwrap().folders[0].has_nfo);
        assert_eq!(
            doc.target,
            folder
                .canonicalize()
                .unwrap()
                .join("Manga & Color.nfo")
                .display()
                .to_string()
        );
        let saved = store
            .save(&SaveRequest {
                path: doc.path,
                fields: Fields {
                    title: "Different / title 日本語".into(),
                    ..doc.fields
                },
                revision: None,
            })
            .ok()
            .unwrap();
        assert_eq!(saved.fields.title, "Different / title 日本語");
        assert!(folder.join("Manga & Color.nfo").is_file());
        assert!(store.list("").ok().unwrap().folders[0].has_nfo);
        assert_eq!(
            fs::read_to_string(folder.join("series.nfo")).unwrap(),
            "<series><title>Legacy</title></series>"
        );
    }

    #[test]
    fn roundtrip_preserves_unknown_fields_and_backs_up_original() {
        let (dir, store) = setup();
        let original = "<series><title>Old</title><custom value=\"yes\">keep</custom><publisher>Publisher</publisher></series>";
        fs::write(dir.path().join("Manga & Color/Manga & Color.nfo"), original).unwrap();
        let mut doc = store.read("Manga & Color").ok().unwrap();
        doc.fields.title = "Manga & <Color> 日本語".into();
        let saved = store
            .save(&SaveRequest {
                path: doc.path,
                fields: doc.fields,
                revision: doc.revision,
            })
            .ok()
            .unwrap();
        assert_eq!(saved.fields.title, "Manga & <Color> 日本語");
        assert!(saved.xml.contains("<custom value=\"yes\">keep</custom>"));
        assert_eq!(saved.fields.publisher, "Publisher");
        let backup = fs::read_dir(dir.path().join("Manga & Color"))
            .unwrap()
            .flatten()
            .find(|e| e.path().extension().is_some_and(|v| v == "bak"))
            .unwrap();
        assert_eq!(fs::read_to_string(backup.path()).unwrap(), original);
    }
    #[test]
    fn comicvine_metadata_creates_and_updates_the_series_nfo() {
        let (dir, store) = setup();
        let media = dir.path().join("Manga & Color/Volume 1.cbz");
        fs::write(&media, b"comic").unwrap();
        let fields = store.save_comicvine_for_source(
            media.to_str().unwrap(), "132428", "The Apothecary Diaries", "2017",
            "Square Enix", "14", "A palace mystery.", "https://comicvine.gamespot.com/example/",
        ).unwrap_or_else(|error| panic!("{}", error.detail));
        assert_eq!(fields.comicvine_id, "132428");
        assert_eq!(fields.volumes, "14");
        let xml = fs::read_to_string(dir.path().join("Manga & Color/Manga & Color.nfo")).unwrap();
        assert!(xml.contains("<publisher>Square Enix</publisher>"));
        assert!(xml.contains("<comicvineid>132428</comicvineid>"));
    }
    #[test]
    fn rejects_traversal_root_and_stale_writes() {
        let (_dir, store) = setup();
        for path in [
            "../outside",
            "/etc",
            "C:/Windows",
            "",
            "Manga & Color/../../outside",
        ] {
            assert!(store.read(path).is_err());
        }
        let doc = store.read("Manga & Color").ok().unwrap();
        let request = SaveRequest {
            path: doc.path,
            fields: doc.fields,
            revision: None,
        };
        assert!(store.save(&request).is_ok());
        assert_eq!(
            store.save(&request).err().unwrap().status,
            StatusCode::CONFLICT
        );
    }
    #[test]
    fn invalid_existing_nfo_is_never_replaced() {
        let (dir, store) = setup();
        let path = dir.path().join("Manga & Color/Manga & Color.nfo");
        fs::write(&path, "not xml").unwrap();
        assert!(store.read("Manga & Color").is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "not xml");
        assert!(parse("<!DOCTYPE series><series/>").is_err());
    }
    #[cfg(unix)]
    #[test]
    fn refuses_symlink_folders_and_files() {
        use std::os::unix::fs::symlink;
        let (dir, store) = setup();
        let outside = tempfile::tempdir().unwrap();
        symlink(outside.path(), dir.path().join("linked")).unwrap();
        assert!(store.read("linked").is_err());
        fs::write(
            outside.path().join("secret"),
            "<series><title>Secret</title></series>",
        )
        .unwrap();
        symlink(
            outside.path().join("secret"),
            dir.path().join("Manga & Color/Manga & Color.nfo"),
        )
        .unwrap();
        assert!(store.read("Manga & Color").is_err());
    }
}
