//! Review and edit existing Emby-style movie and tvshow NFOs in place.
use super::{MAX_NFO, MetadataStore, invalid, io_error, linked};
use crate::{AppState, error::HttpError};
use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use posterview_contracts::ItemType;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};
use xmltree::{Element, EmitterConfig, XMLNode};

const SCALARS: &[&str] = &[
    "title",
    "originaltitle",
    "sorttitle",
    "year",
    "plot",
    "tagline",
    "premiered",
    "releasedate",
    "enddate",
    "runtime",
    "mpaa",
    "status",
    "outline",
    "rating",
    "criticrating",
    "customrating",
    "language",
];
const REPEATED: &[&str] = &[
    "genre", "tag", "studio", "country", "director", "credits", "writer", "trailer",
];
const IDS: &[&str] = &["imdb", "tmdb", "tvdb"];

#[derive(Deserialize)]
pub(crate) struct Selection {
    server_id: i64,
    item_id: String,
    target: Option<String>,
}
#[derive(Deserialize)]
pub(crate) struct Update {
    server_id: i64,
    item_id: String,
    target: String,
    revision: String,
    fields: BTreeMap<String, String>,
}
#[derive(Serialize)]
pub(crate) struct Actor {
    name: String,
    role: String,
}
#[derive(Serialize)]
pub(crate) struct VideoDocument {
    kind: String,
    target: String,
    choices: Vec<String>,
    can_write: bool,
    revision: String,
    xml: String,
    fields: BTreeMap<String, String>,
    actors: Vec<Actor>,
}
struct Resolved {
    directory: PathBuf,
    target: PathBuf,
    choices: Vec<String>,
}

fn conflict() -> HttpError {
    HttpError {
        status: StatusCode::CONFLICT,
        detail: "The NFO or media location changed since you opened it. Reload before saving."
            .into(),
    }
}
fn child_text(root: &Element, name: &str) -> String {
    root.get_child(name)
        .and_then(Element::get_text)
        .map(|s| s.into_owned())
        .unwrap_or_default()
}
fn nodes<'a>(root: &'a Element, name: &'a str) -> impl Iterator<Item = &'a Element> {
    root.children.iter().filter_map(move |n| match n {
        XMLNode::Element(e) if e.name == name => Some(e),
        _ => None,
    })
}
fn parse(xml: &str, kind: &str) -> Result<Element, HttpError> {
    if xml.contains("<!DOCTYPE") || xml.contains("<!ENTITY") {
        return Err(invalid(
            "NFO files containing DTDs or entities are not supported.",
        ));
    }
    let root = Element::parse(xml.as_bytes())
        .map_err(|_| invalid("The NFO is not valid XML. It has not been changed."))?;
    if root.name != kind {
        return Err(invalid(format!(
            "Expected an Emby <{kind}> NFO. The existing file has not been changed."
        )));
    }
    Ok(root)
}
fn id_tags(provider: &str, kind: &str) -> Vec<String> {
    let mut tags = vec![format!("{provider}id")];
    if provider == "imdb" {
        tags.push("imdb_id".into());
    }
    if (provider == "imdb" && kind == "movie") || (provider == "tvdb" && kind == "tvshow") {
        tags.push("id".into());
    }
    tags
}
fn fields(root: &Element) -> BTreeMap<String, String> {
    let mut result = BTreeMap::new();
    for &key in SCALARS {
        result.insert(key.into(), child_text(root, key));
    }
    for &key in REPEATED {
        result.insert(
            key.into(),
            nodes(root, key)
                .filter_map(Element::get_text)
                .map(|s| s.into_owned())
                .collect::<Vec<_>>()
                .join("\n"),
        );
    }
    for &provider in IDS {
        let value = id_tags(provider, &root.name)
            .iter()
            .map(|tag| child_text(root, tag))
            .find(|v| !v.is_empty())
            .unwrap_or_else(|| {
                nodes(root, "uniqueid")
                    .find(|e| {
                        e.attributes
                            .get("type")
                            .is_some_and(|t| t.eq_ignore_ascii_case(provider))
                    })
                    .and_then(Element::get_text)
                    .map(|s| s.into_owned())
                    .unwrap_or_default()
            });
        result.insert(format!("{provider}id"), value);
    }
    result
}
fn set_elements(root: &mut Element, key: &str, values: &[&str]) {
    let previous = nodes(root, key).cloned().collect::<Vec<_>>();
    root.children
        .retain(|n| !matches!(n,XMLNode::Element(e) if e.name==key));
    for (index, value) in values.iter().enumerate() {
        let mut e = previous
            .get(index)
            .cloned()
            .unwrap_or_else(|| Element::new(key));
        e.children = vec![XMLNode::Text((*value).into())];
        root.children.push(XMLNode::Element(e));
    }
}
fn render(
    values: &BTreeMap<String, String>,
    original: &str,
    kind: &str,
) -> Result<String, HttpError> {
    let mut root = parse(original, kind)?;
    let old = fields(&root);
    if values.get("title").is_none_or(|v| v.trim().is_empty()) {
        return Err(invalid("A title is required."));
    }
    for (key, value) in values {
        if !old.contains_key(key) {
            return Err(invalid("Unknown NFO field."));
        }
        if value.len() > 32_768
            || value
                .chars()
                .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
        {
            return Err(invalid(
                "An NFO field contains invalid characters or is too long.",
            ));
        }
        if old.get(key) == Some(value) {
            continue;
        }
        if matches!(key.as_str(), "year" | "runtime" | "tmdbid" | "tvdbid")
            && !value.is_empty()
            && !value.parse::<u32>().is_ok_and(|v| v > 0)
        {
            return Err(invalid(format!(
                "{key} must be a positive whole number or blank."
            )));
        }
        if key == "imdbid"
            && !value.is_empty()
            && !(value.starts_with("tt")
                && value.len() > 2
                && value[2..].bytes().all(|c| c.is_ascii_digit()))
        {
            return Err(invalid("IMDb ID must start with tt followed by digits."));
        }
        if let Some(provider) = IDS.iter().find(|p| key == &format!("{p}id")) {
            let tags = id_tags(provider, kind);
            let parts = if value.is_empty() {
                vec![]
            } else {
                vec![value.as_str()]
            };
            // Keep every existing representation synchronized; use Emby's provider tag for new IDs.
            for tag in &tags {
                if tag == key || root.get_child(tag.as_str()).is_some() {
                    set_elements(&mut root, tag, &parts);
                }
            }
            let mut updated = Vec::new();
            root.children.retain(|n| {
                if let XMLNode::Element(e) = n
                    && e.name == "uniqueid"
                    && e.attributes
                        .get("type")
                        .is_some_and(|t| t.eq_ignore_ascii_case(provider))
                {
                    if !value.is_empty() {
                        let mut e = e.clone();
                        e.children = vec![XMLNode::Text(value.clone())];
                        updated.push(XMLNode::Element(e));
                    }
                    return false;
                }
                true
            });
            root.children.extend(updated);
        } else {
            let parts = if REPEATED.contains(&key.as_str()) {
                value
                    .lines()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
            } else if value.is_empty() {
                vec![]
            } else {
                vec![value.as_str()]
            };
            set_elements(&mut root, key, &parts);
        }
    }
    if fields(&root) == old {
        return Ok(original.to_owned());
    }
    let mut bytes = Vec::new();
    root.write_with_config(&mut bytes, EmitterConfig::new().perform_indent(true))
        .map_err(|_| invalid("Could not serialize the NFO."))?;
    if bytes.len() as u64 > MAX_NFO {
        return Err(invalid("The resulting NFO exceeds 1 MB."));
    }
    String::from_utf8(bytes).map_err(|_| invalid("The NFO must be UTF-8."))
}

impl MetadataStore {
    fn video_resolve(
        &self,
        source: &str,
        kind: &str,
        selection: Option<&str>,
    ) -> Result<Resolved, HttpError> {
        let root = self.root.canonicalize().map_err(|_| {
            invalid(
                "Media Path is unavailable. Mount the library and configure POSTERVIEW_MEDIA_DIR.",
            )
        })?;
        let normalized = source.replace('\\', "/");
        let path = PathBuf::from(&normalized);
        let root_text = root.to_string_lossy().replace('\\', "/");
        let root_text = root_text.strip_prefix("//?/").unwrap_or(&root_text);
        let root_prefix = format!("{}/", root_text.trim_end_matches('/'));
        // Check lexical components before resolving links.
        let relative = if let Ok(relative) = path.strip_prefix(&root) {
            relative.to_path_buf()
        } else if normalized.starts_with(&root_prefix)
            || (cfg!(windows)
                && normalized
                    .to_lowercase()
                    .starts_with(&root_prefix.to_lowercase()))
        {
            PathBuf::from(&normalized[root_prefix.len()..])
        } else if let Some(relative) = normalized
            .strip_prefix("/media/")
            .or_else(|| normalized.strip_prefix("/mnt/user/"))
        {
            PathBuf::from(relative)
        } else {
            return Err(invalid(
                "The server path does not map to Media Path. Mount the same library under /media or configure POSTERVIEW_MEDIA_DIR.",
            ));
        };
        if relative.as_os_str().is_empty()
            || relative
                .components()
                .any(|c| !matches!(c, Component::Normal(_)))
        {
            return Err(invalid("The selected media must be inside Media Path."));
        }
        let mut mapped = root.clone();
        for part in relative.components() {
            mapped.push(part);
            let info=fs::symlink_metadata(&mapped).map_err(|_|invalid("The selected media path is unavailable in PosterView. Check the library mount."))?;
            if linked(&info) {
                return Err(invalid("Linked media paths are not supported."));
            }
        }
        let directory = if mapped.is_dir() {
            mapped.clone()
        } else {
            mapped
                .parent()
                .ok_or_else(|| invalid("Invalid media location."))?
                .to_path_buf()
        };
        if kind == "tvshow" && !mapped.is_dir() {
            return Err(invalid("The series path must point to its series folder."));
        }
        let mut expected = Vec::new();
        if kind == "tvshow" {
            expected.push("tvshow.nfo".to_owned());
            if let Some(name) = directory.file_name() {
                expected.push(format!("{}.nfo", name.to_string_lossy()));
            }
        } else {
            if mapped.is_file() {
                expected.push(
                    mapped
                        .with_extension("nfo")
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned(),
                );
            }
            expected.push("movie.nfo".into());
        }
        // Case-insensitive extension/name discovery retains the actual existing spelling.
        let entries = fs::read_dir(&directory)
            .map_err(io_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(io_error)?;
        let mut choices = Vec::new();
        for expected in &expected {
            for entry in &entries {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.eq_ignore_ascii_case(expected) && !choices.contains(&name) {
                    choices.push(name);
                }
            }
        }
        // For directory-based movie records, an explicit choice can select a named NFO in that folder.
        if kind == "movie" && mapped.is_dir() {
            for entry in &entries {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.to_lowercase().ends_with(".nfo") && !choices.contains(&name) {
                    choices.push(name);
                }
            }
        }
        let chosen=selection.map(str::to_owned).or_else(||choices.first().cloned()).ok_or_else(||invalid(format!("No existing {} found beside this {}. Check the folder mount. No file was created.",if kind=="tvshow"{"tvshow.nfo or series-folder-name.nfo"}else{"movie NFO"},if kind=="tvshow"{"series"}else{"movie"})))?;
        if !choices.contains(&chosen) {
            return Err(invalid("Choose one of this item's existing NFO filenames."));
        }
        Ok(Resolved {
            target: directory.join(&chosen),
            directory,
            choices,
        })
    }
    fn video_current(target: &Path) -> Result<String, HttpError> {
        let info = fs::symlink_metadata(target).map_err(io_error)?;
        if !info.is_file() || linked(&info) || info.len() > MAX_NFO {
            return Err(invalid(
                "The NFO must be a regular, unlinked file smaller than 1 MB.",
            ));
        }
        let mut xml = String::new();
        fs::File::open(target)
            .map_err(io_error)?
            .take(MAX_NFO + 1)
            .read_to_string(&mut xml)
            .map_err(io_error)?;
        if xml.len() as u64 > MAX_NFO {
            return Err(invalid("The NFO exceeds 1 MB."));
        }
        Ok(xml)
    }
    fn video_document(
        &self,
        source: &str,
        kind: &str,
        target: Option<&str>,
        can_write: bool,
    ) -> Result<VideoDocument, HttpError> {
        let location = self.video_resolve(source, kind, target)?;
        let revision = Self::video_current(&location.target)?;
        let root = parse(&revision, kind)?;
        let actors = nodes(&root, "actor")
            .map(|e| Actor {
                name: child_text(e, "name"),
                role: child_text(e, "role"),
            })
            .collect();
        Ok(VideoDocument {
            kind: kind.into(),
            target: location.target.to_string_lossy().into_owned(),
            choices: location.choices,
            can_write,
            xml: revision.clone(),
            revision,
            fields: fields(&root),
            actors,
        })
    }
    fn video_save(
        &self,
        source: &str,
        kind: &str,
        request: &Update,
        preview: bool,
    ) -> Result<VideoDocument, HttpError> {
        let _lock = self
            .writes
            .lock()
            .map_err(|_| invalid("Please retry this save."))?;
        let name = Path::new(&request.target)
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| invalid("Invalid NFO filename."))?;
        let location = self.video_resolve(source, kind, Some(name))?;
        if location.target.to_string_lossy() != request.target
            || Self::video_current(&location.target)? != request.revision
        {
            return Err(conflict());
        }
        let xml = render(&request.fields, &request.revision, kind)?;
        if preview {
            let mut doc = self.video_document(source, kind, Some(name), true)?;
            doc.fields = fields(&parse(&xml, kind)?);
            doc.xml = xml;
            return Ok(doc);
        }
        let mut temporary =
            tempfile::NamedTempFile::new_in(&location.directory).map_err(io_error)?;
        temporary.write_all(xml.as_bytes()).map_err(io_error)?;
        temporary
            .as_file()
            .set_permissions(
                fs::metadata(&location.target)
                    .map_err(io_error)?
                    .permissions(),
            )
            .map_err(io_error)?;
        temporary.as_file().sync_all().map_err(io_error)?;
        let refreshed = self.video_resolve(source, kind, Some(name))?;
        if refreshed.target != location.target
            || Self::video_current(&location.target)? != request.revision
        {
            return Err(conflict());
        }
        temporary
            .persist(&location.target)
            .map_err(|e| io_error(e.error))?;
        self.video_document(source, kind, Some(name), true)
    }
}

async fn selected(
    state: &AppState,
    server: i64,
    item: &str,
) -> Result<(String, &'static str, bool), HttpError> {
    let settings = state
        .runtime
        .get_server(server)?
        .ok_or_else(HttpError::not_found)?;
    let detail = state
        .runtime
        .get_item_detail(server, item)
        .await?
        .ok_or_else(HttpError::not_found)?
        .map_err(HttpError::bad_gateway)?;
    let kind = match detail.item_type {
        ItemType::Movie => "movie",
        ItemType::Show => "tvshow",
        _ => return Err(invalid("Select a movie or series to review its NFO.")),
    };
    let source=detail.source_path.ok_or_else(||invalid("The server did not provide a single filesystem location for this title. Titles spanning multiple locations need a specific media location."))?;
    Ok((source, kind, settings.nfo_metadata_enabled))
}
pub(crate) async fn document(
    State(state): State<AppState>,
    Query(query): Query<Selection>,
) -> Result<Json<VideoDocument>, HttpError> {
    let (source, kind, writable) = selected(&state, query.server_id, &query.item_id).await?;
    tokio::task::spawn_blocking(move || {
        state
            .metadata
            .video_document(&source, kind, query.target.as_deref(), writable)
    })
    .await
    .map_err(|_| invalid("Could not read NFO metadata."))?
    .map(Json)
}
async fn update(
    state: AppState,
    input: Update,
    preview: bool,
) -> Result<Json<VideoDocument>, HttpError> {
    let (source, kind, writable) = selected(&state, input.server_id, &input.item_id).await?;
    if !writable {
        return Err(invalid(
            "Enable NFO metadata for this server in Settings → Server Setup before editing. You can still review the file.",
        ));
    }
    tokio::task::spawn_blocking(move || state.metadata.video_save(&source, kind, &input, preview))
        .await
        .map_err(|_| invalid("Could not save NFO metadata."))?
        .map(Json)
}
pub(crate) async fn save(
    State(state): State<AppState>,
    Json(input): Json<Update>,
) -> Result<Json<VideoDocument>, HttpError> {
    update(state, input, false).await
}
pub(crate) async fn preview(
    State(state): State<AppState>,
    Json(input): Json<Update>,
) -> Result<Json<VideoDocument>, HttpError> {
    update(state, input, true).await
}

#[cfg(test)]
mod tests {
    use super::*;
    const MOVIE: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<movie custom="keep"><title>Original</title><id>tt123</id><imdbid>tt123</imdbid><uniqueid type="imdb" default="true">tt123</uniqueid>
<genre>Drama</genre><genre>Action</genre><actor><name>Actor</name><role>Hero</role><type>Actor</type><thumb>https://example.test/image</thumb></actor>
<director>Director</director><lockdata>true</lockdata><lockedfields>Cast|Genres</lockedfields>
<fileinfo><streamdetails><video><codec>hevc</codec></video></streamdetails></fileinfo><ratings><rating name="custom"><value>9</value></rating></ratings><unknown flag="retain"><nested>Value</nested></unknown><!-- keep comment --></movie>"#;
    fn setup() -> (tempfile::TempDir, MetadataStore, String) {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("Movie")).unwrap();
        let media = dir.path().join("Movie/Film.mkv");
        fs::write(&media, "").unwrap();
        fs::write(dir.path().join("Movie/Film.nfo"), MOVIE).unwrap();
        let store = MetadataStore::new(dir.path().to_owned());
        (dir, store, media.to_string_lossy().into_owned())
    }
    fn request(doc: VideoDocument) -> Update {
        Update {
            server_id: 1,
            item_id: "movie".into(),
            target: doc.target,
            revision: doc.revision,
            fields: doc.fields,
        }
    }
    #[test]
    fn edits_preserve_emby_structure_and_synchronize_ids() {
        let original = parse(MOVIE, "movie").unwrap();
        let mut values = fields(&original);
        values.insert("title".into(), "New & better".into());
        values.insert("genre".into(), "Fantasy\nComedy".into());
        values.insert("imdbid".into(), "tt456".into());
        let output = render(&values, MOVIE, "movie").unwrap();
        let updated = parse(&output, "movie").unwrap();
        assert_eq!(child_text(&updated, "title"), "New & better");
        assert_eq!(fields(&updated)["genre"], "Fantasy\nComedy");
        assert_eq!(child_text(&updated, "id"), "tt456");
        assert_eq!(child_text(&updated, "imdbid"), "tt456");
        assert_eq!(child_text(&updated, "uniqueid"), "tt456");
        assert_eq!(
            updated.get_child("uniqueid").unwrap().attributes["default"],
            "true"
        );
        for tag in [
            "actor",
            "director",
            "lockdata",
            "lockedfields",
            "fileinfo",
            "ratings",
            "unknown",
        ] {
            assert_eq!(original.get_child(tag), updated.get_child(tag), "{tag}");
        }
        assert_eq!(updated.attributes["custom"], "keep");
        assert!(output.contains("keep comment"));
        assert_eq!(render(&fields(&original), MOVIE, "movie").unwrap(), MOVIE);
    }
    #[test]
    fn preview_does_not_write_save_updates_only_selected_file_and_stale_save_fails() {
        let (dir, store, source) = setup();
        fs::write(
            dir.path().join("Movie/movie.nfo"),
            "<movie><title>Other</title></movie>",
        )
        .unwrap();
        let doc = store.video_document(&source, "movie", None, true).unwrap();
        assert_eq!(doc.choices.len(), 2);
        assert_eq!(doc.actors[0].name, "Actor");
        let mut input = request(doc);
        input.fields.insert("title".into(), "Edited".into());
        let preview = store.video_save(&source, "movie", &input, true).unwrap();
        assert_eq!(preview.fields["title"], "Edited");
        assert_eq!(fs::read_to_string(&input.target).unwrap(), MOVIE);
        let saved = store.video_save(&source, "movie", &input, false).unwrap();
        assert_eq!(saved.fields["title"], "Edited");
        assert_eq!(
            fs::read_to_string(dir.path().join("Movie/movie.nfo")).unwrap(),
            "<movie><title>Other</title></movie>"
        );
        assert_eq!(
            store
                .video_save(&source, "movie", &input, false)
                .err()
                .unwrap()
                .status,
            StatusCode::CONFLICT
        );
    }
    #[test]
    fn external_edits_are_not_overwritten() {
        let (_dir, store, source) = setup();
        let mut input = request(store.video_document(&source, "movie", None, true).unwrap());
        input.fields.insert("title".into(), "Edited".into());
        fs::write(&input.target, "<movie><title>External edit</title></movie>").unwrap();
        assert_eq!(
            store
                .video_save(&source, "movie", &input, false)
                .err()
                .unwrap()
                .status,
            StatusCode::CONFLICT
        );
        assert!(
            fs::read_to_string(&input.target)
                .unwrap()
                .contains("External edit")
        );
    }
    #[test]
    fn series_uses_existing_tvshow_and_missing_never_creates() {
        let (dir, store, _) = setup();
        let folder = dir.path().join("Series");
        fs::create_dir(&folder).unwrap();
        let source = folder.to_string_lossy();
        assert!(store.video_document(&source, "tvshow", None, true).is_err());
        assert_eq!(fs::read_dir(&folder).unwrap().count(), 0);
        fs::write(
            folder.join("TVSHOW.NFO"),
            "<tvshow><title>Series</title><id>123</id><season>4</season></tvshow>",
        )
        .unwrap();
        let doc = store
            .video_document(&source, "tvshow", None, false)
            .unwrap();
        assert!(!doc.can_write);
        assert_eq!(doc.fields["tvdbid"], "123");
        assert!(doc.target.ends_with("TVSHOW.NFO"));
        let mut input = request(doc);
        input.fields.insert("tvdbid".into(), "456".into());
        let result = store.video_save(&source, "tvshow", &input, false).unwrap();
        assert_eq!(
            child_text(&parse(&result.xml, "tvshow").unwrap(), "id"),
            "456"
        );
        assert!(result.xml.contains("<season>4</season>"));
        assert!(
            store
                .video_document("/media/Series", "tvshow", None, false)
                .is_ok()
        );
    }

    #[test]
    fn series_named_sidecar_is_editable_and_tvshow_remains_default() {
        let (dir, store, _) = setup();
        let folder = dir.path().join("Justfied");
        fs::create_dir(&folder).unwrap();
        let source = folder.to_string_lossy();
        let named = folder.join("Justfied.NFO");
        fs::write(&named, "<tvshow><title>Justfied</title></tvshow>").unwrap();
        fs::write(folder.join("Episode.nfo"), "<episodedetails/>").unwrap();
        let doc = store.video_document(&source, "tvshow", None, true).unwrap();
        assert_eq!(doc.choices, vec!["Justfied.NFO"]);
        assert!(doc.target.ends_with("Justfied.NFO"));
        let canonical = "<tvshow><title>Canonical</title></tvshow>";
        fs::write(folder.join("tvshow.nfo"), canonical).unwrap();
        let default = store.video_document(&source, "tvshow", None, true).unwrap();
        assert!(default.target.ends_with("tvshow.nfo"));
        assert_eq!(default.choices, vec!["tvshow.nfo", "Justfied.NFO"]);
        let selected = store
            .video_document(&source, "tvshow", Some("Justfied.NFO"), true)
            .unwrap();
        let mut input = request(selected);
        input.fields.insert("title".into(), "Updated".into());
        store.video_save(&source, "tvshow", &input, false).unwrap();
        assert!(fs::read_to_string(named).unwrap().contains("Updated"));
        assert_eq!(
            fs::read_to_string(folder.join("tvshow.nfo")).unwrap(),
            canonical
        );
    }
    #[test]
    fn rejects_invalid_xml_paths_and_target_tampering() {
        let (_dir, store, source) = setup();
        assert!(parse(MOVIE, "tvshow").is_err());
        assert!(parse("<!DOCTYPE movie><movie/>", "movie").is_err());
        assert!(parse("<movie>", "movie").is_err());
        assert!(
            store
                .video_resolve("/media/../outside", "movie", None)
                .is_err()
        );
        assert!(
            store
                .video_resolve(&source, "movie", Some("../Film.nfo"))
                .is_err()
        );
        let mut input = request(store.video_document(&source, "movie", None, true).unwrap());
        input.target = "Film.nfo".into();
        assert!(store.video_save(&source, "movie", &input, false).is_err());
        let mut values = fields(&parse(MOVIE, "movie").unwrap());
        values.insert("year".into(), "invalid".into());
        assert!(render(&values, MOVIE, "movie").is_err());
    }

    #[tokio::test]
    async fn emby_location_is_used_and_server_setting_gates_writes() {
        use axum::{Router, routing::get};
        use posterview_contracts::{ServerCreate, ServerType};
        use serde_json::json;
        use std::sync::Arc;
        let (dir, store, source) = setup();
        let fixture = Router::new()
            .route("/Users", get(|| async { Json(json!([{"Id":"user"}])) }))
            .route("/Items", get(move || { let source = source.clone(); async move { Json(json!({"Items":[{"Id":"movie","Name":"Movie","Type":"Movie","Path":source}]})) } }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, fixture).await.unwrap();
        });
        let runtime = Arc::new(posterview_runtime::Runtime::new(dir.path().join("state")));
        runtime.initialize().unwrap();
        let state = AppState {
            runtime: runtime.clone(),
            auth: crate::AuthState::for_tests(""),
            login_backdrop: crate::login_backdrop::LoginBackdrop::new(runtime.data_dir()),
            metadata: Arc::new(store),
            reader: Arc::new(crate::reader::ReaderStore::new(
                dir.path().to_owned(),
                dir.path().join("reader.db"),
            )),
        };
        for writable in [false, true] {
            let server = runtime
                .create_server(&ServerCreate {
                    name: "Emby".into(),
                    server_type: ServerType::Emby,
                    base_url: format!("http://{address}"),
                    token: "fixture".into(),
                    is_default: false,
                    nfo_metadata_enabled: writable,
                })
                .unwrap();
            let Json(doc) = document(
                State(state.clone()),
                Query(Selection {
                    server_id: server.id,
                    item_id: "movie".into(),
                    target: None,
                }),
            )
            .await
            .unwrap();
            assert_eq!(doc.can_write, writable);
            let mut input = request(doc);
            input.server_id = server.id;
            input
                .fields
                .insert("title".into(), "Updated via Emby location".into());
            let result = update(state.clone(), input, false).await;
            assert_eq!(result.is_ok(), writable);
            if !writable {
                assert_eq!(
                    fs::read_to_string(dir.path().join("Movie/Film.nfo")).unwrap(),
                    MOVIE
                );
            }
        }
        assert!(
            fs::read_to_string(dir.path().join("Movie/Film.nfo"))
                .unwrap()
                .contains("Updated via Emby location")
        );
        task.abort();
    }
    #[cfg(unix)]
    #[test]
    fn linked_nfo_is_rejected() {
        let (dir, store, source) = setup();
        let target = dir.path().join("Movie/Film.nfo");
        fs::remove_file(&target).unwrap();
        std::os::unix::fs::symlink("elsewhere", target).unwrap();
        assert!(store.video_document(&source, "movie", None, true).is_err());
    }
}
