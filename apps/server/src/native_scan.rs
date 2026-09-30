use crate::{AppState, HttpError};
use posterview_contracts::native::{
    AnimeContent, NativeArtwork, NativeCatalogEntry, NativeLibrary, NativeLibraryType,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};
use xmltree::{Element, XMLNode};
const MAX_FILES: usize = 50_000;
const NFO_LIMIT: u64 = 4 * 1024 * 1024;
fn bad(e: impl std::fmt::Display) -> HttpError {
    HttpError::bad_request(e.to_string())
}
fn relative(root: &Path, path: &Path) -> Result<String, HttpError> {
    Ok(path
        .strip_prefix(root)
        .map_err(bad)?
        .to_string_lossy()
        .replace('\\', "/"))
}
fn checked_file(root: &Path, path: &Path) -> Result<(), HttpError> {
    if fs::symlink_metadata(path).map_err(bad)?.is_symlink() {
        return Err(bad("Symbolic links are not scanned."));
    }
    if !path.canonicalize().map_err(bad)?.starts_with(root) {
        return Err(bad("File is outside the media root."));
    }
    Ok(())
}
fn walk(
    state: &AppState,
    root: &Path,
    dir: &Path,
    files: &mut Vec<PathBuf>,
    depth: usize,
) -> Result<(), HttpError> {
    if depth > 64 {
        return Err(bad("Folder nesting exceeds the scan limit."));
    }
    for child in fs::read_dir(dir).map_err(bad)? {
        let child = child.map_err(bad)?;
        let path = child.path();
        if child.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        if files.len() >= MAX_FILES {
            return Err(bad(
                "Library exceeds 50,000 media files; use smaller library roots.",
            ));
        }
        let kind = child.file_type().map_err(bad)?;
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            // Backdrop directories can contain theme/credit videos, not library items.
            let name = child.file_name().to_string_lossy().to_ascii_lowercase();
            if matches!(name.as_str(), "backdrop" | "backdrops") {
                continue;
            }
            state.metadata.directory(&relative(root, &path)?, true)?;
            walk(state, root, &path, files, depth + 1)?;
        } else if kind.is_file() {
            checked_file(root, &path)?;
            files.push(path);
        }
    }
    Ok(())
}
fn value(element: &Element) -> Value {
    if element
        .children
        .iter()
        .all(|c| !matches!(c, XMLNode::Element(_)))
    {
        return Value::String(element.get_text().unwrap_or_default().trim().into());
    }
    let mut object = json!({});
    for child in &element.children {
        if let XMLNode::Element(child) = child {
            let v = value(child);
            if let Some(previous) = object.get_mut(&child.name) {
                if let Some(array) = previous.as_array_mut() {
                    array.push(v);
                } else {
                    let old = previous.take();
                    *previous = json!([old, v]);
                }
            } else {
                object[&child.name] = v;
            }
        }
    }
    object
}
pub(crate) fn parse_nfo(bytes: &[u8]) -> Result<(String, Value), String> {
    if bytes.len() > NFO_LIMIT as usize {
        return Err("NFO exceeds 4 MB.".into());
    }
    let text = std::str::from_utf8(bytes).map_err(|_| "NFO must be UTF-8.")?;
    let upper = text.to_ascii_uppercase();
    if upper.contains("<!DOCTYPE") || upper.contains("<!ENTITY") {
        return Err("NFO document declarations are not supported.".into());
    }
    let root = Element::parse(bytes).map_err(|_| "Invalid NFO XML.")?;
    if ![
        "movie",
        "tvshow",
        "episodedetails",
        "season",
        "series",
        "book",
    ]
    .contains(&root.name.as_str())
    {
        return Err("Unsupported NFO format.".into());
    }
    let mut fields = value(&root);
    if !fields.is_object() {
        fields = json!({});
    }
    for field in ["year", "season", "episode", "runtime", "volumes"] {
        if let Some(v) = fields[field].as_str().and_then(|v| v.parse::<i64>().ok()) {
            fields[field] = json!(v);
        }
    }
    for (input, output) in [
        ("genre", "genres"),
        ("tag", "tags"),
        ("studio", "studios"),
        ("publisher", "publishers"),
    ] {
        if let Some(v) = fields.get(input).cloned() {
            fields[output] = if v.is_array() { v } else { json!([v]) };
        }
    }
    let mut ids = json!({});
    for child in &root.children {
        if let XMLNode::Element(child) = child {
            if child.name == "uniqueid" {
                if let Some(provider) = child.attributes.get("type") {
                    ids[provider] = json!(child.get_text().unwrap_or_default());
                }
            }
        }
    }
    for (field, provider) in [
        ("anilistid", "anilist"),
        ("tmdbid", "tmdb"),
        ("imdbid", "imdb"),
        ("tvdbid", "tvdb"),
    ] {
        if let Some(v) = fields.get(field).cloned() {
            ids[provider] = v;
        }
    }
    if ids.as_object().is_some_and(|v| !v.is_empty()) {
        fields["identifiers"] = ids;
    }
    let mut credits = Vec::new();
    for child in &root.children {
        if let XMLNode::Element(child) = child {
            match child.name.as_str(){"actor"=>{let actor=value(child); credits.push(json!({"name":actor["name"],"role":actor["role"],"category":"cast","image":actor["thumb"]}));},"director"|"writer"|"author"|"illustrator"=>credits.push(json!({"name":child.get_text().unwrap_or_default(),"role":child.name,"category":if child.name=="author"||child.name=="illustrator"{child.name.as_str()}else{"crew"}})),_=>{}}
        }
    }
    if !credits.is_empty() {
        fields["credits"] = json!(credits);
    }
    let mut sources = json!({});
    for field in fields.as_object().unwrap().keys() {
        sources[field] = json!("nfo");
    }
    fields["_sources"] = sources;
    Ok((root.name, fields))
}
fn nfo(
    root: &Path,
    path: &Path,
    warnings: &mut Vec<String>,
) -> Option<(String, Value, String, String)> {
    if !path.exists() {
        return None;
    }
    let result: Result<(String, Value, String, String), String> = (|| {
        checked_file(root, path).map_err(|e| e.detail)?;
        if fs::metadata(path).map_err(|e| e.to_string())?.len() > NFO_LIMIT {
            return Err("NFO exceeds 4 MB.".into());
        }
        let bytes = fs::read(path).map_err(|e| e.to_string())?;
        let (kind, fields) = parse_nfo(&bytes)?;
        Ok((
            kind,
            fields,
            String::from_utf8(bytes).map_err(|e| e.to_string())?,
            relative(root, path).map_err(|e| e.detail)?,
        ))
    })();
    match result {
        Ok(v) => Some(v),
        Err(e) => {
            warnings.push(format!(
                "{}: {e}",
                path.file_name().unwrap_or_default().to_string_lossy()
            ));
            None
        }
    }
}
fn blank(path: String, kind: &str, parent: Option<String>, title: String) -> NativeCatalogEntry {
    NativeCatalogEntry {
        id: String::new(),
        path,
        kind: kind.into(),
        parent_path: parent,
        title: title.clone(),
        metadata: json!({"title":title,"_sources":{"title":"filename"}}),
        artwork: Vec::new(),
        files: Vec::new(),
        nfo_path: None,
        nfo_xml: None,
        available: true,
        revision: 1,
    }
}
fn apply_nfo(entry: &mut NativeCatalogEntry, doc: Option<(String, Value, String, String)>) {
    if let Some((_, fields, xml, path)) = doc {
        let fallback = entry.metadata["title"].clone();
        entry.metadata = fields;
        if entry.metadata["title"].as_str().unwrap_or("").is_empty() {
            entry.metadata["title"] = fallback;
            entry.metadata["_sources"]["title"] = json!("filename");
        }
        entry.title = entry.metadata["title"]
            .as_str()
            .unwrap_or(&entry.title)
            .into();
        entry.nfo_path = Some(path);
        entry.nfo_xml = Some(xml);
    }
}
fn local_art(root: &Path, dir: &Path, stem: Option<&str>) -> Vec<NativeArtwork> {
    let Ok(files) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut result = BTreeMap::new();
    let names = [
        ("poster", "poster"),
        ("cover", "poster"),
        ("folder", "poster"),
        ("fanart", "backdrop"),
        ("backdrop", "backdrop"),
        ("background", "backdrop"),
        ("banner", "banner"),
        ("landscape", "landscape"),
        ("thumb", "thumb"),
        ("logo", "logo"),
        ("clearlogo", "logo"),
        ("disc", "disc"),
    ];
    for child in files.flatten() {
        let path = child.path();
        if !child.file_type().is_ok_and(|t| t.is_file()) || checked_file(root, &path).is_err() {
            continue;
        }
        let ext = path
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_ascii_lowercase();
        if !["jpg", "jpeg", "png", "webp"].contains(&ext.as_str()) {
            continue;
        }
        let base = path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_ascii_lowercase();
        for (name, kind) in names {
            if base == name
                || (stem.is_some_and(|s| base == format!("{}-{name}", s.to_lowercase())))
            {
                if let Ok(path) = relative(root, &path) {
                    result.entry(kind.to_owned()).or_insert(NativeArtwork {
                        kind: kind.into(),
                        path,
                        source: "local".into(),
                    });
                }
            }
        }
    }
    result.into_values().collect()
}
fn clean_title(stem: &str) -> String {
    let name = regex::Regex::new(r"\[[^\]]*\]")
        .unwrap()
        .replace_all(stem, "");
    name.replace(['.', '_'], " ").trim().to_owned()
}
fn probe(path: &Path) -> Result<Value, String> {
    use std::{
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    let output = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
    let mut child=Command::new("ffprobe").args(["-v","error","-protocol_whitelist","file,pipe","-show_entries","format=duration,format_name,bit_rate:stream=index,codec_type,codec_name,width,height,channels,sample_rate,bit_rate,duration","-of","json"]).arg(path).stdout(Stdio::from(output.reopen().map_err(|e|e.to_string())?)).stderr(Stdio::null()).spawn().map_err(|_|"ffprobe is unavailable; media codecs and duration were not inspected.".to_string())?;
    let started = Instant::now();
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => {
                if !status.success() {
                    return Err("Unable to inspect media streams.".into());
                }
                break;
            }
            None => {
                if started.elapsed() > Duration::from_secs(10) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("Media inspection timed out.".into());
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
    if output
        .as_file()
        .metadata()
        .map_err(|e| e.to_string())?
        .len()
        > 4 * 1024 * 1024
    {
        return Err("Media information exceeds 4 MB.".into());
    }
    serde_json::from_slice(&fs::read(output.path()).map_err(|e| e.to_string())?)
        .map_err(|_| "Invalid media information.".into())
}
pub(crate) fn collect(
    state: &AppState,
    library: &NativeLibrary,
) -> Result<(Vec<NativeCatalogEntry>, Vec<String>), HttpError> {
    let root = state.metadata.directory("", true)?;
    let mut files = Vec::new();
    let mut warnings = Vec::new();
    for selected in &library.paths {
        let dir = state.metadata.directory(selected, true)?;
        walk(state, &root, &dir, &mut files, 0)?;
    }
    files.sort();
    files.dedup();
    let mut video_counts = BTreeMap::<PathBuf, usize>::new();
    for file in &files {
        let ext = file
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase();
        if [
            "mkv", "mp4", "avi", "mov", "m4v", "webm", "ts", "mpg", "mpeg", "m2ts",
        ]
        .contains(&ext.as_str())
        {
            if let Some(dir) = file.parent() {
                *video_counts.entry(dir.to_path_buf()).or_default() += 1;
            }
        }
    }
    let episode =
        regex::Regex::new(r"(?i)(?:s(\d{1,3})[ ._-]*e(\d{1,4})|(\d{1,3})x(\d{1,4}))").unwrap();
    let anime_number = regex::Regex::new(r"(?i) - (\d{1,3})(?:v\d)?(?:\s|\[|$)").unwrap();
    let season_dir = regex::Regex::new(r"(?i)^(?:season|s)[ ._-]*(\d{1,3})$").unwrap();
    let year_regex = regex::Regex::new(r"(?:\(|\[|\s)((?:19|20)\d{2})(?:\)|\]|$)").unwrap();
    let mut entries = BTreeMap::<String, NativeCatalogEntry>::new();
    let mut probe_unavailable = false;
    for file in files {
        let ext = file
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase();
        let books = library.library_type == NativeLibraryType::Books;
        if if books {
            !["cbz", "epub", "pdf"].contains(&ext.as_str())
        } else {
            ![
                "mkv", "mp4", "avi", "mov", "m4v", "webm", "ts", "mpg", "mpeg", "m2ts",
            ]
            .contains(&ext.as_str())
        } {
            continue;
        }
        let dir = file
            .parent()
            .ok_or_else(|| bad("Missing media directory."))?;
        let stem = file
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let sidecar = if library.options.read_nfo {
            nfo(&root, &file.with_extension("nfo"), &mut warnings)
        } else {
            None
        };
        let numbers = episode
            .captures(&stem)
            .map(|m| {
                (
                    m.get(1)
                        .or(m.get(3))
                        .unwrap()
                        .as_str()
                        .parse::<i64>()
                        .unwrap(),
                    m.get(2)
                        .or(m.get(4))
                        .unwrap()
                        .as_str()
                        .parse::<i64>()
                        .unwrap(),
                )
            })
            .or_else(|| {
                sidecar
                    .as_ref()
                    .and_then(|(_, f, _, _)| Some((f["season"].as_i64()?, f["episode"].as_i64()?)))
            })
            .or_else(|| {
                if library.library_type == NativeLibraryType::Anime
                    && library.anime_content != AnimeContent::Movies
                {
                    anime_number
                        .captures(&stem)
                        .map(|m| (1, m[1].parse().unwrap()))
                } else {
                    None
                }
            });
        let show = !books
            && library.library_type != NativeLibraryType::Movies
            && library.anime_content != AnimeContent::Movies
            && (numbers.is_some()
                || dir.join("tvshow.nfo").is_file()
                || library.library_type == NativeLibraryType::Shows);
        if library.library_type == NativeLibraryType::Anime
            && library.anime_content == AnimeContent::Shows
            && !show
        {
            warnings.push(format!(
                "Skipped {stem}: no episode identity in a shows-only library."
            ));
            continue;
        }
        let mut parent = None;
        if books || show {
            let mut series_dir = dir.to_path_buf();
            if season_dir.is_match(&dir.file_name().unwrap_or_default().to_string_lossy()) {
                series_dir = dir.parent().unwrap_or(dir).to_path_buf();
            }
            let series_path = relative(&root, &series_dir)?;
            if !entries.contains_key(&series_path) {
                let mut series = blank(
                    series_path.clone(),
                    if books { "book_series" } else { "series" },
                    None,
                    series_dir
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into(),
                );
                if library.options.read_nfo {
                    let named = series_dir.join(format!(
                        "{}.nfo",
                        series_dir.file_name().unwrap_or_default().to_string_lossy()
                    ));
                    let doc = nfo(&root, &named, &mut warnings).or_else(|| {
                        if books {
                            None
                        } else {
                            nfo(&root, &series_dir.join("tvshow.nfo"), &mut warnings)
                        }
                    });
                    apply_nfo(&mut series, doc);
                }
                if library.options.local_artwork {
                    series.artwork = local_art(&root, &series_dir, None);
                }
                entries.insert(series_path.clone(), series);
            }
            parent = Some(series_path.clone());
            if show {
                if let Some((season, _)) = numbers {
                    let season_path = format!("{series_path}/@season-{season}");
                    entries.entry(season_path.clone()).or_insert_with(|| {
                        let mut s = blank(
                            season_path.clone(),
                            "season",
                            Some(series_path.clone()),
                            format!("Season {season}"),
                        );
                        if season_dir
                            .is_match(&dir.file_name().unwrap_or_default().to_string_lossy())
                        {
                            if library.options.read_nfo {
                                apply_nfo(
                                    &mut s,
                                    nfo(&root, &dir.join("season.nfo"), &mut warnings),
                                );
                            }
                            if library.options.local_artwork {
                                s.artwork = local_art(&root, dir, None);
                            }
                        }
                        s.metadata["season"] = json!(season);
                        s
                    });
                    parent = Some(season_path);
                }
            }
        }
        let file_path = relative(&root, &file)?;
        let mut entry = blank(
            file_path.clone(),
            if books {
                "book"
            } else if show {
                "episode"
            } else {
                "movie"
            },
            parent,
            clean_title(&stem),
        );
        apply_nfo(&mut entry, sidecar);
        if let Some((season, ep)) = numbers {
            entry.metadata["season"] = json!(season);
            entry.metadata["episode"] = json!(ep);
        }
        if let Some(year) = year_regex.captures(&stem) {
            if entry.metadata["year"].is_null() {
                entry.metadata["year"] = json!(year[1].parse::<i64>().unwrap());
            }
        }
        if !books
            && !show
            && entry.nfo_path.is_none()
            && library.options.read_nfo
            && video_counts.get(dir) == Some(&1)
        {
            apply_nfo(
                &mut entry,
                nfo(&root, &dir.join("movie.nfo"), &mut warnings),
            );
        }
        if library.options.local_artwork {
            entry.artwork = local_art(&root, dir, Some(&stem));
        }
        let info = fs::metadata(&file).map_err(bad)?;
        let media_info = if !books && !probe_unavailable {
            match probe(&file) {
                Ok(v) => v,
                Err(e) => {
                    probe_unavailable = e.contains("unavailable");
                    if probe_unavailable {
                        warnings.push(e);
                    } else {
                        warnings.push(format!("{stem}: {e}"));
                    }
                    Value::Null
                }
            }
        } else {
            Value::Null
        };
        entry.files.push(json!({"media_info":media_info,"path":file_path,"size":info.len(),"modified":info.modified().ok().and_then(|m|m.duration_since(std::time::UNIX_EPOCH).ok()).map(|d|d.as_secs().to_string()),"extension":ext}));
        entries.insert(file_path, entry);
    }
    Ok((entries.into_values().collect(), warnings))
}
pub(crate) fn write_nfo(
    state: &AppState,
    entry: &NativeCatalogEntry,
) -> Result<(String, String), String> {
    if entry.kind == "season" && entry.nfo_path.is_none() {
        return Err("Season writeback is not supported.".into());
    }
    let media_root = state.metadata.directory("", true).map_err(|e| e.detail)?;
    let target = if let Some(path) = &entry.nfo_path {
        media_root.join(path)
    } else if entry.kind == "series" {
        media_root.join(&entry.path).join("tvshow.nfo")
    } else if entry.kind == "book_series" {
        let dir = media_root.join(&entry.path);
        dir.join(format!(
            "{}.nfo",
            dir.file_name().unwrap_or_default().to_string_lossy()
        ))
    } else {
        media_root.join(&entry.path).with_extension("nfo")
    };
    let parent = target.parent().ok_or("Missing NFO parent.")?;
    state
        .metadata
        .directory(&relative(&media_root, parent).map_err(|e| e.detail)?, true)
        .map_err(|e| e.detail)?;
    let previous = if target.exists() {
        checked_file(&media_root, &target).map_err(|e| e.detail)?;
        if fs::metadata(&target).map_err(|e| e.to_string())?.len() > NFO_LIMIT {
            return Err("Existing NFO exceeds 4 MB.".into());
        }
        Some(fs::read(&target).map_err(|e| e.to_string())?)
    } else {
        None
    };
    let relative_target = relative(&media_root, &target).map_err(|e| e.detail)?;
    if let Some(expected) = posterview_infra_sqlite::ServerStore::new(state.runtime.data_dir())
        .native_nfo_content(&relative_target)
        .map_err(|e| e.to_string())?
    {
        if previous.as_deref() != Some(expected.as_bytes()) {
            return Err(
                "NFO changed since the last scan. Scan the library before writing it again.".into(),
            );
        }
    }
    let mut xml = if let Some(bytes) = &previous {
        parse_nfo(bytes)?;
        Element::parse(bytes.as_slice()).map_err(|e| e.to_string())?
    } else {
        Element::new(match entry.kind.as_str() {
            "movie" => "movie",
            "episode" => "episodedetails",
            "series" => "tvshow",
            "book" => "book",
            _ => "series",
        })
    };
    for field in [
        "title",
        "originaltitle",
        "sorttitle",
        "plot",
        "year",
        "season",
        "episode",
        "runtime",
        "edition",
        "status",
        "volumes",
        "publisher",
    ] {
        let Some(v) = entry.metadata.get(field) else {
            continue;
        };
        let text = if let Some(v) = v.as_str() {
            v.into()
        } else if v.is_number() {
            v.to_string()
        } else {
            continue;
        };
        xml.children
            .retain(|n| !matches!(n,XMLNode::Element(e) if e.name==field));
        let mut element = Element::new(field);
        element.children.push(XMLNode::Text(text));
        xml.children.push(XMLNode::Element(element));
    }
    for (field, tag) in [("genres", "genre"), ("tags", "tag"), ("studios", "studio")] {
        if let Some(values) = entry.metadata[field].as_array() {
            xml.children
                .retain(|n| !matches!(n,XMLNode::Element(e) if e.name==tag));
            for name in values.iter().filter_map(Value::as_str) {
                let mut element = Element::new(tag);
                element.children.push(XMLNode::Text(name.into()));
                xml.children.push(XMLNode::Element(element));
            }
        }
    }
    if let Some(ids) = entry.metadata["identifiers"].as_object() {
        for (provider, id) in ids {
            xml.children.retain(|n|!matches!(n,XMLNode::Element(e) if e.name=="uniqueid"&&e.attributes.get("type")==Some(provider)));
            let mut e = Element::new("uniqueid");
            e.attributes.insert("type".into(), provider.clone());
            e.children.push(XMLNode::Text(
                id.as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| id.to_string()),
            ));
            xml.children.push(XMLNode::Element(e));
        }
    }
    if let Some(credits) = entry.metadata["credits"].as_array() {
        xml.children.retain(|n|!matches!(n,XMLNode::Element(e) if ["actor","director","writer","author","illustrator"].contains(&e.name.as_str())));
        for credit in credits {
            let Some(name) = credit["name"].as_str() else {
                continue;
            };
            let category = credit["category"].as_str().unwrap_or("cast");
            let role = credit["role"].as_str().unwrap_or("");
            if category == "cast" || category == "voice" {
                let mut actor = Element::new("actor");
                for (tag, text) in [("name", name), ("role", role)] {
                    let mut e = Element::new(tag);
                    e.children.push(XMLNode::Text(text.into()));
                    actor.children.push(XMLNode::Element(e));
                }
                xml.children.push(XMLNode::Element(actor));
            } else if ["author", "illustrator"].contains(&category)
                || ["Director", "Writer", "Screenplay"].contains(&role)
            {
                let tag = if category == "author" || category == "illustrator" {
                    category
                } else if role == "Director" {
                    "director"
                } else {
                    "writer"
                };
                let mut e = Element::new(tag);
                e.children.push(XMLNode::Text(name.into()));
                xml.children.push(XMLNode::Element(e));
            }
        }
    }
    let mut bytes = Vec::new();
    xml.write(&mut bytes).map_err(|e| e.to_string())?;
    if previous.as_deref() == Some(bytes.as_slice()) {
        return Ok((
            relative(&media_root, &target).map_err(|e| e.detail)?,
            String::from_utf8(bytes).map_err(|e| e.to_string())?,
        ));
    }
    use std::io::Write;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    temp.write_all(&bytes).map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    let latest = if target.exists() {
        Some(fs::read(&target).map_err(|e| e.to_string())?)
    } else {
        None
    };
    if previous != latest {
        return Err("NFO changed during write; retry after reviewing it.".into());
    }
    if previous.is_none() {
        temp.persist_noclobber(&target).map_err(|e| e.to_string())?;
    } else {
        temp.persist(&target).map_err(|e| e.to_string())?;
    }
    Ok((
        relative(&media_root, &target).map_err(|e| e.detail)?,
        String::from_utf8(bytes).map_err(|e| e.to_string())?,
    ))
}
