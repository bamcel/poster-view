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
pub(crate) fn auxiliary_folder(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "backdrop"
            | "backdrops"
            | "extras"
            | "extra"
            | "trailers"
            | "featurettes"
            | "behind the scenes"
            | "deleted scenes"
            | "interviews"
    )
}

pub(crate) fn credit_video(path: &Path) -> bool {
    static PATTERN: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?i)(?:^|[^a-z0-9])nc(?:op|ed)s?(?:[0-9]+(?:v[0-9]+)?)?(?:$|[^a-z0-9])")
            .unwrap()
    });
    path.file_stem()
        .is_some_and(|name| PATTERN.is_match(&name.to_string_lossy()))
}

pub(crate) fn season_folder(name: &str) -> Option<i64> {
    if name.eq_ignore_ascii_case("specials") || name.eq_ignore_ascii_case("special") {
        return Some(0);
    }
    static SEASON: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?i)^(?:.+?[ ._-]+)?(?:season|s)[ ._-]*(\d{1,3})$").unwrap()
    });
    SEASON.captures(name).and_then(|m| m[1].parse().ok())
}

fn series_directory(dir: &Path, boundary: &Path) -> PathBuf {
    let seasonal = season_folder(&dir.file_name().unwrap_or_default().to_string_lossy()).is_some();
    let fallback = if seasonal && dir != boundary {
        dir.parent().unwrap_or(dir)
    } else {
        dir
    };
    // Named season folders can be nested beneath the series NFO (e.g. R2).
    // Never walk outside the library's selected root.
    for candidate in fallback.ancestors().take_while(|p| p.starts_with(boundary)) {
        // Old scans may have written a mistaken tvshow.nfo inside Specials.
        if season_folder(&candidate.file_name().unwrap_or_default().to_string_lossy()).is_none()
            && candidate.join("tvshow.nfo").is_file()
        {
            return candidate.to_path_buf();
        }
    }
    fallback.to_path_buf()
}

fn walk(
    state: &AppState,
    root: &Path,
    dir: &Path,
    files: &mut Vec<PathBuf>,
    depth: usize,
    progress: &mut crate::native_progress::Reporter,
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
            // Auxiliary videos are not standalone library items.
            let name = child.file_name().to_string_lossy().to_ascii_lowercase();
            if auxiliary_folder(&name) {
                continue;
            }
            state.metadata.directory(&relative(root, &path)?, true)?;
            walk(state, root, &path, files, depth + 1, progress)?;
        } else if kind.is_file() {
            checked_file(root, &path)?;
            progress.report(
                "discovering",
                files.len() + 1,
                None,
                0,
                &relative(root, &path)?,
                false,
            );
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
    if let Some(youtube) = root.get_child("youtube") {
        let mut metadata = value(youtube);
        if !metadata.is_object() {
            metadata = json!({});
        }
        if let Some(seconds) = metadata["duration_seconds"]
            .as_str()
            .and_then(|s| s.parse::<f64>().ok())
            .filter(|s| s.is_finite() && *s >= 0.0)
        {
            metadata["duration_seconds"] = json!(seconds);
        }
        let playlists: Vec<Value> = youtube.children.iter().filter_map(|node| {
            let XMLNode::Element(child) = node else { return None };
            if child.name != "playlist" { return None; }
            let id = child.attributes.get("id")?;
            let mut playlist = json!({"id": id, "title": child.attributes.get("title").cloned().unwrap_or_else(|| id.clone())});
            if let Some(index) = child.attributes.get("index").and_then(|s| s.parse::<u64>().ok()) { playlist["index"] = json!(index); }
            if let Some(description) = child.get_child("description").and_then(Element::get_text) { playlist["description"] = json!(description); }
            Some(playlist)
        }).collect();
        metadata["playlists"] = json!(playlists);
        fields["youtube"] = metadata;
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
        ("comicvineid", "comicvine"),
        ("mangadexid", "mangadex"),
        ("tmdbid", "tmdb"),
        ("imdbid", "imdb"),
        ("tvdbid", "tvdb"),
        ("malid", "mal"),
        ("myanimelistid", "mal"),
        ("anidbid", "anidb"),
    ] {
        if let Some(v) = fields.get(field).cloned() {
            ids[provider] = v;
        }
    }
    if ids.as_object().is_some_and(|v| !v.is_empty()) {
        fields["identifiers"] = ids;
    }
    let mut credits = Vec::new();
    let mut voices = Vec::new();
    let mut manual_voices = false;
    for child in &root.children {
        if let XMLNode::Element(child) = child {
            match child.name.as_str(){"actor"=>{let actor=value(child); if actor["posterviewcategory"]=="voice" {
                manual_voices |= actor["posterviewmanual"]=="true";
                let credit=json!({"name":actor["name"],"role":actor["role"],"category":"voice","image":actor["thumb"],"language":actor["language"],"dub_group":actor["dubgroup"],"role_notes":actor["rolenotes"],"provider":actor["provider"],"provider_id":actor["providerid"]});
                voices.push(credit.clone());credits.push(credit);
            } else {credits.push(json!({"name":actor["name"],"role":actor["role"],"category":"cast","image":actor["thumb"]}));}},"director"|"writer"|"author"|"illustrator"=>credits.push(json!({"name":child.get_text().unwrap_or_default(),"role":child.name,"category":if child.name=="author"||child.name=="illustrator"{child.name.as_str()}else{"crew"}})),_=>{}}
        }
    }
    if !voices.is_empty() {
        fields["voice_cast"] = json!(voices);
    }
    if !credits.is_empty() {
        fields["credits"] = json!(credits);
    }
    let mut sources = json!({});
    for field in fields.as_object().unwrap().keys() {
        sources[field] = json!("nfo");
    }
    if manual_voices {
        sources["voice_cast"] = json!("manual");
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
pub(crate) fn local_art(root: &Path, dir: &Path, stem: Option<&str>) -> Vec<NativeArtwork> {
    local_art_variants(root, dir, stem, false)
}
pub(crate) fn local_art_variants(
    root: &Path,
    dir: &Path,
    stem: Option<&str>,
    static_only: bool,
) -> Vec<NativeArtwork> {
    let Ok(files) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut result = BTreeMap::<String, (u8, NativeArtwork)>::new();
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
    let mut files = files.flatten().collect::<Vec<_>>();
    files.sort_by_key(|f| f.file_name());
    for child in files {
        let path = child.path();
        if !child.file_type().is_ok_and(|t| t.is_file()) || checked_file(root, &path).is_err() {
            continue;
        }
        let ext = path
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_ascii_lowercase();
        if !["jpg", "jpeg", "png", "webp", "gif", "webm"].contains(&ext.as_str()) {
            continue;
        }
        let animated = u8::from(["gif", "webm"].contains(&ext.as_str()));
        if static_only && animated == 1 {
            continue;
        }
        let base = path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_ascii_lowercase();
        if stem.is_some_and(|s| base == s.to_lowercase()) {
            if let Ok(path) = relative(root, &path) {
                choose_art(
                    &mut result,
                    2 + animated,
                    "thumb".to_owned(),
                    NativeArtwork {
                        kind: "thumb".into(),
                        path,
                        source: "local".into(),
                    },
                );
            }
        }
        for (name, kind) in names {
            if base == name
                || (stem.is_some_and(|s| base == format!("{}-{name}", s.to_lowercase())))
            {
                if let Ok(path) = relative(root, &path) {
                    let art = NativeArtwork {
                        kind: kind.into(),
                        path,
                        source: "local".into(),
                    };
                    if stem.is_some_and(|s| base == format!("{}-{name}", s.to_lowercase())) {
                        choose_art(&mut result, 2 + animated, kind.to_owned(), art);
                    } else {
                        choose_art(&mut result, animated, kind.to_owned(), art);
                    }
                }
            }
        }
    }
    result.into_values().map(|(_, art)| art).collect()
}
fn choose_art(
    result: &mut BTreeMap<String, (u8, NativeArtwork)>,
    priority: u8,
    kind: String,
    art: NativeArtwork,
) {
    if result
        .get(&kind)
        .is_none_or(|(current, _)| priority > *current)
    {
        result.insert(kind, (priority, art));
    }
}

fn clean_title(stem: &str) -> String {
    static BRACKETS: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"\[[^\]]*\]").unwrap());
    let name = BRACKETS.replace_all(stem, "");
    name.replace(['.', '_'], " ").trim().to_owned()
}
pub(crate) const MEDIA_INFO_VERSION: u64 = 3;
fn current_media_info(info: &Value) -> bool {
    info["posterview_probe_version"].as_u64() == Some(MEDIA_INFO_VERSION)
}
fn probe(path: &Path) -> Result<Value, String> {
    use std::{
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    let output = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
    let mut child = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-show_streams",
            "-show_format",
            "-show_chapters",
            "-of",
            "json",
        ])
        .arg(path)
        .stdout(Stdio::from(output.reopen().map_err(|e| e.to_string())?))
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| {
            "ffprobe is unavailable; media codecs and duration were not inspected.".to_string()
        })?;
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
    let mut info: Value =
        serde_json::from_slice(&fs::read(output.path()).map_err(|e| e.to_string())?)
            .map_err(|_| "Invalid media information.".to_string())?;
    if !info.is_object() {
        return Err("Invalid media information.".into());
    }
    info["posterview_probe_version"] = json!(MEDIA_INFO_VERSION);
    Ok(info)
}
#[cfg(test)]
pub(crate) fn collect(
    state: &AppState,
    library: &NativeLibrary,
) -> Result<(Vec<NativeCatalogEntry>, Vec<String>), HttpError> {
    collect_scoped(state, library, None)
}
pub(crate) fn collect_scoped(
    state: &AppState,
    library: &NativeLibrary,
    scopes: Option<&[String]>,
) -> Result<(Vec<NativeCatalogEntry>, Vec<String>), HttpError> {
    let root = state.metadata.directory("", true)?;
    let mut progress = crate::native_progress::Reporter::new(state, &library.id);
    progress.report("discovering", 0, None, 0, "", true);
    let mut files = Vec::new();
    let mut warnings = Vec::new();
    let scan_roots = library
        .paths
        .iter()
        .map(|path| state.metadata.directory(path, true))
        .collect::<Result<Vec<_>, _>>()?;
    let targets = scopes
        .map(|paths| paths.iter().map(|p| root.join(p)).collect::<Vec<_>>())
        .unwrap_or_else(|| scan_roots.clone());
    for target in targets {
        if !scan_roots.iter().any(|dir| target.starts_with(dir)) {
            return Err(bad("Scan scope is outside the library roots."));
        }
        match fs::symlink_metadata(&target) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && scopes.is_some() => continue,
            Err(e) => return Err(bad(e)),
            Ok(meta) if meta.is_file() => {
                checked_file(&root, &target)?;
                files.push(target);
            }
            Ok(_) => walk(state, &root, &target, &mut files, 0, &mut progress)?,
        }
    }
    let mut series_directories = BTreeMap::<PathBuf, PathBuf>::new();
    files.sort();
    files.dedup();
    // Animated artwork is a sidecar, not a movie or episode.
    let media_stems = files
        .iter()
        .filter(|p| {
            p.extension().is_some_and(|e| {
                [
                    "mkv", "mp4", "avi", "mov", "m4v", "ts", "mpg", "mpeg", "m2ts",
                ]
                .contains(&e.to_string_lossy().to_ascii_lowercase().as_str())
            })
        })
        .map(|p| p.with_extension(""))
        .collect::<std::collections::BTreeSet<_>>();
    files.retain(|p| !is_artwork_video(p, &media_stems));
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
    static EPISODE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?i)(?:s(\d{1,3})[ ._-]*e(\d{1,4})|(\d{1,3})x(\d{1,4}))").unwrap()
    });
    let episode = &*EPISODE;
    static ANIME_NUMBER: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?i) - (\d{1,3})(?:v\d)?(?:\s|\[|$)").unwrap()
    });
    let anime_number = &*ANIME_NUMBER;
    static YEAR_REGEX: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?:\(|\[|\s)((?:19|20)\d{2})(?:\)|\]|$)").unwrap()
    });
    let year_regex = &*YEAR_REGEX;
    let mut entries = BTreeMap::<String, NativeCatalogEntry>::new();
    let mut probe_unavailable = false;
    files.retain(|p| {
        p.extension().is_some_and(|ext| {
            let ext = ext.to_string_lossy().to_ascii_lowercase();
            if library.library_type == NativeLibraryType::Books {
                ["pdf", "epub", "cbz"].contains(&ext.as_str())
            } else {
                [
                    "mkv", "mp4", "avi", "mov", "m4v", "webm", "ts", "mpg", "mpeg", "m2ts",
                ]
                .contains(&ext.as_str())
            }
        })
    });
    files.retain(|p| {
        !(library.library_type != NativeLibraryType::Books
            && library.library_type != NativeLibraryType::Youtube
            && library.options.sample_ignore_mb > 0
            && p.file_name()
                .is_some_and(|n| n.to_string_lossy().to_ascii_lowercase().contains("sample"))
            && fs::metadata(p)
                .is_ok_and(|m| m.len() < u64::from(library.options.sample_ignore_mb) * 1024 * 1024))
    });
    if !matches!(
        library.library_type,
        NativeLibraryType::Books | NativeLibraryType::Youtube
    ) {
        files.retain(|p| !credit_video(p));
    }
    let total = files.len();
    let previous = posterview_infra_sqlite::ServerStore::new(state.runtime.data_dir())
        .native_catalog_scoped(&library.id, scopes)
        .map_err(|e| bad(e.to_string()))?;
    let previous_files = previous
        .iter()
        .flat_map(|e| e.files.iter())
        .filter_map(|v| Some((root.join(v["path"].as_str()?), v.clone())))
        .collect::<BTreeMap<_, _>>();
    let completed = std::sync::atomic::AtomicUsize::new(0);
    let reporter = std::sync::Mutex::new(crate::native_progress::Reporter::new(state, &library.id));
    let unavailable = std::sync::atomic::AtomicBool::new(false);
    let mut probes = if library.library_type != NativeLibraryType::Books {
        progress.report("inspecting", 0, Some(total), 0, "", true);
        crate::workers::parallel(files.clone(), |file| {
            let cached = previous_files.get(&file).filter(|v| {
                fs::metadata(&file).is_ok_and(|m| {
                    v["size"].as_u64() == Some(m.len())
                        && v["mtime_ns"].as_str()
                            == m.modified()
                                .ok()
                                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                                .map(|d| d.as_nanos().to_string())
                                .as_deref()
                }) && current_media_info(&v["media_info"])
            });
            let result = if let Some(cached) = cached {
                Ok(cached["media_info"].clone())
            } else if unavailable.load(std::sync::atomic::Ordering::Relaxed) {
                Err("ffprobe is unavailable; media codecs and duration were not inspected.".into())
            } else {
                probe(&file)
            };
            if result.as_ref().is_err_and(|e| e.contains("unavailable")) {
                unavailable.store(true, std::sync::atomic::Ordering::Relaxed);
            }
            let done = completed.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
            reporter.lock().unwrap_or_else(|e| e.into_inner()).report(
                "inspecting",
                done,
                Some(total),
                0,
                &relative(&root, &file).unwrap_or_default(),
                done == total,
            );
            (file, result)
        })
        .into_iter()
        .collect::<BTreeMap<_, _>>()
    } else {
        BTreeMap::new()
    };
    progress.report("reading", 0, Some(total), 0, "", true);
    for (index, file) in files.into_iter().enumerate() {
        progress.report(
            "reading",
            index,
            Some(total),
            entries.len(),
            &relative(&root, &file)?,
            false,
        );
        let ext = file
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase();
        let books = library.library_type == NativeLibraryType::Books;
        let dir = file
            .parent()
            .ok_or_else(|| bad("Missing media directory."))?;
        let info = fs::metadata(&file).map_err(bad)?;
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
                    anime_number.captures(&stem).map(|m| {
                        (
                            season_folder(&dir.file_name().unwrap_or_default().to_string_lossy())
                                .unwrap_or(1),
                            m[1].parse().unwrap(),
                        )
                    })
                } else {
                    None
                }
            });
        let youtube = library.library_type == NativeLibraryType::Youtube;
        let show = youtube
            || (!books
                && library.library_type != NativeLibraryType::Movies
                && library.anime_content != AnimeContent::Movies
                && (numbers.is_some()
                    || dir.join("tvshow.nfo").is_file()
                    || library.library_type == NativeLibraryType::Shows));
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
            let series_dir = if books {
                dir.to_path_buf()
            } else {
                series_directories
                    .entry(dir.to_path_buf())
                    .or_insert_with(|| {
                        let boundary = scan_roots
                            .iter()
                            .filter(|path| dir.starts_with(path))
                            .max_by_key(|path| path.components().count())
                            .unwrap_or(&root);
                        series_directory(dir, boundary)
                    })
                    .clone()
            };
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
            if show && !youtube {
                if let Some((season, _)) = numbers {
                    let season_path = format!("{series_path}/@season-{season}");
                    entries.entry(season_path.clone()).or_insert_with(|| {
                        let mut s = blank(
                            season_path.clone(),
                            "season",
                            Some(series_path.clone()),
                            if season == 0 {
                                "Specials".into()
                            } else {
                                format!("Season {season}")
                            },
                        );
                        if season_folder(&dir.file_name().unwrap_or_default().to_string_lossy())
                            .is_some()
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
                        if library.options.local_artwork {
                            let prefix = format!("season{season:02}-");
                            for art in
                                local_art(&root, &series_dir, Some(&format!("season{season:02}")))
                                    .into_iter()
                                    .filter(|a| {
                                        Path::new(&a.path).file_name().is_some_and(|n| {
                                            n.to_string_lossy().to_lowercase().starts_with(&prefix)
                                        })
                                    })
                            {
                                s.artwork.retain(|a| a.kind != art.kind);
                                s.artwork.push(art);
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
        if let Some((season, ep)) = numbers.filter(|_| !youtube) {
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
            if entry.kind == "book" {
                entry.artwork.retain(|art| {
                    std::path::Path::new(&art.path)
                        .file_stem()
                        .is_some_and(|name| {
                            let name = name.to_string_lossy().to_lowercase();
                            name == stem.to_lowercase()
                                || name.starts_with(&format!("{}-", stem.to_lowercase()))
                        })
                });
                // Some book tools append the image extension to the complete media filename.
                if let Some(name) = file.file_name().and_then(|name| name.to_str()) {
                    for art in local_art(&root, dir, Some(name)) {
                        if !entry.artwork.iter().any(|current| current.kind == art.kind) {
                            entry.artwork.push(art);
                        }
                    }
                }
                // Filename-matched book covers are posters, not video thumbnails.
                if let Some(mut cover) = entry
                    .artwork
                    .iter()
                    .find(|art| art.kind == "thumb")
                    .cloned()
                {
                    cover.kind = "poster".into();
                    entry
                        .artwork
                        .retain(|art| art.kind != "poster" && art.kind != "thumb");
                    entry.artwork.push(cover);
                }
            }
            if (entry.kind == "episode" && !youtube) || entry.kind == "book" {
                entry.artwork.retain(|a| {
                    Path::new(&a.path).file_stem().is_some_and(|n| {
                        let n = n.to_string_lossy().to_lowercase();
                        n == stem.to_lowercase()
                            || n.starts_with(&format!("{}-", stem.to_lowercase()))
                            || (entry.kind == "book"
                                && file.file_name().and_then(|name| name.to_str()).is_some_and(
                                    |name| {
                                        n == name.to_lowercase()
                                            || n.starts_with(&format!("{}-", name.to_lowercase()))
                                    },
                                ))
                    })
                });
            }
        }
        if books
            && library.options.local_artwork
            && library.options.save_artwork
            && !entry.artwork.iter().any(|art| art.kind == "poster")
        {
            match capture_book_cover(&file) {
                Ok(()) => {
                    entry.artwork.push(NativeArtwork {
                        kind: "poster".into(),
                        path: relative(&root, &file.with_extension("jpg"))?,
                        source: "local".into(),
                    });
                }
                Err(error) => warnings.push(format!("Cover capture for {file_path}: {error}")),
            }
        }
        let media_info = if !books && !probe_unavailable {
            match probes
                .remove(&file)
                .unwrap_or_else(|| Err("Media inspection did not finish.".into()))
            {
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
        if library.options.prefer_embedded_titles
            && entry.metadata["_sources"]["title"] == "filename"
        {
            if let Some(title) = media_info["format"]["tags"]["title"]
                .as_str()
                .filter(|v| !v.trim().is_empty())
            {
                entry.title = title.trim().into();
                entry.metadata["title"] = json!(entry.title);
                entry.metadata["_sources"]["title"] = json!("embedded");
            }
        }
        entry.files.push(json!({"media_info":media_info,"path":file_path,"size":info.len(),"mtime_ns":info.modified().ok().and_then(|m|m.duration_since(std::time::UNIX_EPOCH).ok()).map(|d|d.as_nanos().to_string()),"modified":info.modified().ok().and_then(|m|m.duration_since(std::time::UNIX_EPOCH).ok()).map(|d|d.as_secs().to_string()),"extension":ext}));
        entries.insert(file_path, entry);
    }
    progress.report("reading", total, Some(total), entries.len(), "", true);
    Ok((entries.into_values().collect(), warnings))
}
fn capture_book_cover(file: &Path) -> Result<(), String> {
    let target = file.with_extension("jpg");
    if target.exists() {
        return Ok(());
    }
    let bytes = crate::reader::initial_cover(file)?;
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(20000);
    limits.max_image_height = Some(20000);
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    let decoded = reader.decode().map_err(|e| e.to_string())?;
    let image = if decoded.width() > 1200 || decoded.height() > 1800 {
        decoded.thumbnail(1200, 1800).to_rgb8()
    } else {
        decoded.to_rgb8()
    };
    let mut encoded = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut encoded, 90)
        .encode_image(&image)
        .map_err(|e| e.to_string())?;
    use std::io::Write;
    let mut output = match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    if let Err(error) = output.write_all(&encoded) {
        drop(output);
        let _ = fs::remove_file(&target);
        return Err(error.to_string());
    }
    Ok(())
}

// Missing books are catalog-only targets; no media or sidecar is created.
pub(crate) fn book_placeholders(entries: &mut Vec<NativeCatalogEntry>) {
    static NUMBER: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?i)(?:^|[^a-z])(?:volume|vol\.?|v|chapter|ch\.?|c)\s*[-_ ]*([0-9]+)")
            .unwrap()
    });
    let number = &*NUMBER;
    static CHAPTER: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?i)(?:^|[^a-z])(?:chapter|ch\.?|c)\s*[-_ ]*[0-9]+").unwrap()
    });
    let chapter = &*CHAPTER;
    entries.retain(|e| e.metadata["missing"] != true);
    for entry in entries.iter_mut().filter(|e| e.kind == "book") {
        let filename = Path::new(&entry.path)
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy();
        let key = if !entry.metadata["chapter"].is_null()
            || chapter.is_match(&entry.title)
            || chapter.is_match(&filename)
        {
            "chapter"
        } else {
            "volume"
        };
        if entry.metadata[key]
            .as_u64()
            .or_else(|| {
                entry.metadata[key]
                    .as_str()
                    .and_then(|v| v.trim().parse::<u64>().ok())
            })
            .is_none()
        {
            if let Some(found) = number
                .captures(&filename)
                .or_else(|| number.captures(&entry.title))
            {
                entry.metadata[key] = json!(found[1].parse::<u64>().unwrap_or(0));
            }
        }
        entry.metadata["missing"] = json!(false);
    }
    let mut by_parent: BTreeMap<&str, Vec<&NativeCatalogEntry>> = BTreeMap::new();
    for entry in entries.iter().filter(|e| e.kind == "book" && e.available) {
        if let Some(parent) = entry.parent_path.as_deref() {
            by_parent.entry(parent).or_default().push(entry);
        }
    }
    let mut missing = Vec::new();
    for series in entries
        .iter()
        .filter(|e| e.kind == "book_series" && e.available)
    {
        let children = by_parent
            .get(series.path.as_str())
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let key = if !children.is_empty()
            && children
                .iter()
                .all(|e| !e.metadata["chapter"].is_null() && e.metadata["volume"].is_null())
        {
            "chapter"
        } else {
            "volume"
        };
        // Do not guess which numbers are absent when existing files have no identity.
        if children.iter().any(|e| e.metadata[key].is_null()) {
            continue;
        }
        let total = series.metadata[if key == "chapter" {
            "chapters"
        } else {
            "volumes"
        }]
        .as_u64()
        .or_else(|| {
            series.metadata[if key == "chapter" {
                "chapters"
            } else {
                "volumes"
            }]
            .as_str()
            .and_then(|v| v.parse().ok())
        })
        .unwrap_or(0)
        .min(5000);
        let present = children
            .iter()
            .filter_map(|e| {
                e.metadata[key]
                    .as_u64()
                    .or_else(|| e.metadata[key].as_str().and_then(|v| v.parse().ok()))
            })
            .collect::<std::collections::BTreeSet<_>>();
        for n in 1..=total {
            if present.contains(&n) {
                continue;
            }
            let title = format!(
                "{} {n:02}",
                if key == "chapter" {
                    "Chapter"
                } else {
                    "Volume"
                }
            );
            missing.push(NativeCatalogEntry {
                id: String::new(),
                path: format!("{}/@missing-{key}-{n}", series.path),
                kind: "book".into(),
                parent_path: Some(series.path.clone()),
                title: title.clone(),
                metadata: json!({"title":title,key:n,"missing":true}),
                artwork: vec![],
                files: vec![],
                nfo_path: None,
                nfo_xml: None,
                available: true,
                revision: 1,
            });
        }
    }
    entries.extend(missing);
}

pub(crate) fn write_identification_nfo(
    state: &AppState,
    entry: &NativeCatalogEntry,
) -> Result<(String, String), String> {
    write_nfo_inner(state, entry, true)
}
pub(crate) fn write_nfo(
    state: &AppState,
    entry: &NativeCatalogEntry,
) -> Result<(String, String), String> {
    write_nfo_inner(state, entry, false)
}
fn clear_identity_nfo(xml: &mut Element) {
    xml.children.retain(|node|!matches!(node,XMLNode::Element(e) if !["fileinfo","streamdetails","season","episode","thumb","fanart","art","logo","banner","posterview"].contains(&e.name.as_str())));
}
fn write_nfo_inner(
    state: &AppState,
    entry: &NativeCatalogEntry,
    replace_ids: bool,
) -> Result<(String, String), String> {
    let media_root = state.metadata.directory("", true).map_err(|e| e.detail)?;
    let target = if let Some(path) = &entry.nfo_path {
        media_root.join(path)
    } else if entry.kind == "season" {
        media_root.join(&entry.path).join("season.nfo")
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
            "season" => "season",
            "book" => "book",
            _ => "series",
        })
    };
    if entry.metadata["_identify_nfo_reset"] == true {
        clear_identity_nfo(&mut xml);
    }
    for field in [
        "title",
        "originaltitle",
        "sorttitle",
        "plot",
        "year",
        "tagline",
        "rating",
        "mpaa",
        "premiered",
        "season",
        "episode",
        "runtime",
        "edition",
        "status",
        "volumes",
        "publisher",
        "country",
        "translatedtitle",
        "sourcematerial",
        "original_year",
        "original_volumes",
        "edition_year",
        "edition_volumes",
        "chapters",
    ] {
        let Some(v) = entry.metadata.get(field) else {
            continue;
        };
        let text = if let Some(v) = v.as_str() {
            v.into()
        } else if v.is_number() {
            v.to_string()
        } else if v.is_null() {
            String::new()
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
    if replace_ids {
        xml.children.retain(|node| !matches!(node, XMLNode::Element(e) if
            ["imdbid","tmdbid","tvdbid","anilistid","malid","anidbid","comicvineid","mangadexid"].contains(&e.name.as_str()) ||
            (e.name=="uniqueid" && e.attributes.get("type").is_some_and(|v| ["imdb","tmdb","tvdb","anilist","mal","anidb","comicvine","mangadex"].contains(&v.to_lowercase().as_str())))));
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
    let mut nfo_credits = entry.metadata["credits"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if let Some(voices) = entry.metadata["voice_cast"].as_array() {
        nfo_credits.retain(|credit| credit["category"] != "voice");
        nfo_credits.extend(voices.iter().cloned());
    }
    if entry.metadata["credits"].is_array() || entry.metadata["voice_cast"].is_array() {
        let credits = &nfo_credits;
        let previous_actors = xml
            .children
            .iter()
            .filter_map(|n| n.as_element())
            .filter(|e| e.name == "actor")
            .cloned()
            .collect::<Vec<_>>();
        xml.children.retain(|n|!matches!(n,XMLNode::Element(e) if ["actor","director","writer","author","illustrator"].contains(&e.name.as_str())));
        for credit in credits {
            let Some(name) = credit["name"].as_str() else {
                continue;
            };
            let category = credit["category"].as_str().unwrap_or("cast");
            let role = credit["role"].as_str().unwrap_or("");
            if category == "cast" || category == "voice" {
                let mut actor = previous_actors
                    .iter()
                    .find(|actor| {
                        actor
                            .get_child("name")
                            .and_then(|e| e.get_text())
                            .is_some_and(|v| v == name)
                            && actor
                                .get_child("role")
                                .and_then(|e| e.get_text())
                                .unwrap_or_default()
                                == role
                    })
                    .cloned()
                    .unwrap_or_else(|| Element::new("actor"));
                actor.children.retain(|n|!matches!(n,XMLNode::Element(e) if ["name","role"].contains(&e.name.as_str())));
                for (tag, text) in [("name", name), ("role", role)] {
                    let mut e = Element::new(tag);
                    e.children.push(XMLNode::Text(text.into()));
                    actor.children.push(XMLNode::Element(e));
                }
                if let Some(image) = credit["image"]
                    .as_str()
                    .filter(|v| !v.trim().is_empty() && !v.starts_with("/api/servers/"))
                {
                    actor
                        .children
                        .retain(|n| !matches!(n,XMLNode::Element(e) if e.name=="thumb"));
                    let mut thumb = Element::new("thumb");
                    thumb.children.push(XMLNode::Text(image.into()));
                    actor.children.push(XMLNode::Element(thumb));
                }
                if category == "voice" {
                    actor
                        .children
                        .retain(|n| !matches!(n,XMLNode::Element(e) if e.name=="posterviewmanual"));
                    if entry.metadata["_sources"]["voice_cast"] == "manual" {
                        let mut e = Element::new("posterviewmanual");
                        e.children.push(XMLNode::Text("true".into()));
                        actor.children.push(XMLNode::Element(e));
                    }
                    for (tag, field) in [
                        ("posterviewcategory", "category"),
                        ("language", "language"),
                        ("dubgroup", "dub_group"),
                        ("rolenotes", "role_notes"),
                        ("provider", "provider"),
                        ("providerid", "provider_id"),
                    ] {
                        actor
                            .children
                            .retain(|n| !matches!(n,XMLNode::Element(e) if e.name==tag));
                        if !credit[field].is_null() {
                            let text = credit[field]
                                .as_str()
                                .map(str::to_owned)
                                .unwrap_or_else(|| credit[field].to_string());
                            if !text.is_empty() {
                                let mut e = Element::new(tag);
                                e.children.push(XMLNode::Text(text));
                                actor.children.push(XMLNode::Element(e));
                            }
                        }
                    }
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
    crate::native_monitor::own_write(&target, || {
        if previous.is_none() {
            temp.persist_noclobber(&target).map_err(|e| e.to_string())?;
        } else {
            temp.persist(&target).map_err(|e| e.to_string())?;
        }
        Ok(())
    })?;
    Ok((
        relative(&media_root, &target).map_err(|e| e.detail)?,
        String::from_utf8(bytes).map_err(|e| e.to_string())?,
    ))
}

fn is_artwork_video(path: &Path, media_stems: &std::collections::BTreeSet<PathBuf>) -> bool {
    if !path
        .extension()
        .is_some_and(|e| e.to_string_lossy().eq_ignore_ascii_case("webm"))
    {
        return false;
    }
    let stem = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase();
    media_stems.contains(&path.with_extension(""))
        || [
            "poster",
            "cover",
            "folder",
            "fanart",
            "backdrop",
            "background",
            "banner",
            "landscape",
            "thumb",
            "logo",
            "clearlogo",
            "disc",
        ]
        .iter()
        .any(|n| stem == *n || stem.ends_with(&format!("-{n}")))
}

#[cfg(test)]
mod animated_artwork_tests {
    use super::*;
    #[test]
    fn episode_thumbnails_accept_both_sidecar_conventions() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        for name in ["Show S01E01.jpg", "Show S01E01-thumb.jpg"] {
            let file = root.join(name);
            fs::write(&file, b"thumbnail").unwrap();
            let art = local_art(&root, &root, Some("Show S01E01"));
            assert!(art.iter().any(|a| a.kind == "thumb" && a.path == name));
            fs::remove_file(file).unwrap();
        }
    }

    #[test]
    fn artwork_videos_are_excluded_and_animated_sidecars_have_priority() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let dir = root.as_path();
        fs::write(dir.join("poster.jpg"), b"static").unwrap();
        fs::write(dir.join("poster.webm"), b"animated").unwrap();
        let still = local_art_variants(dir, dir, None, true);
        assert!(
            still
                .iter()
                .all(|a| !a.path.ends_with(".webm") && !a.path.ends_with(".gif"))
        );
        assert!(
            still
                .iter()
                .any(|a| a.kind == "poster" && a.path == "poster.jpg")
        );
        fs::write(dir.join("Episode.mkv"), b"media").unwrap();
        fs::write(dir.join("Episode.webm"), b"thumb").unwrap();
        let stems = [dir.join("Episode")].into_iter().collect();
        assert!(is_artwork_video(&dir.join("poster.webm"), &stems));
        assert!(is_artwork_video(&dir.join("season01-poster.webm"), &stems));
        assert!(is_artwork_video(&dir.join("Episode.webm"), &stems));
        assert!(!is_artwork_video(&dir.join("Movie.webm"), &stems));
        let art = local_art(dir, dir, Some("Episode"));
        assert!(
            art.iter()
                .any(|a| a.kind == "poster" && a.path == "poster.webm")
        );
        assert!(
            art.iter()
                .any(|a| a.kind == "thumb" && a.path == "Episode.webm")
        );
    }
}

#[cfg(test)]
mod missing_book_tests {
    use super::*;
    #[test]
    fn placeholders_keep_artwork_when_numbered_files_arrive() {
        let temp = tempfile::tempdir().unwrap();
        let db = posterview_infra_sqlite::ServerStore::new(temp.path());
        db.initialize().unwrap();
        let library = db
            .save_native_library(
                None,
                &posterview_contracts::native::NativeLibraryInput {
                    name: "Books".into(),
                    library_type: NativeLibraryType::Books,
                    anime_content: AnimeContent::Both,
                    paths: vec!["Books".into()],
                    options: Default::default(),
                    revision: None,
                },
            )
            .unwrap();
        let mut series = blank("Books/Test".into(), "book_series", None, "Test".into());
        series.metadata["volumes"] = json!(3);
        let mut first = blank(
            "Books/Test/Volume 01.cbz".into(),
            "book",
            Some(series.path.clone()),
            "Volume 01".into(),
        );
        first.files.push(json!({"path":first.path}));
        let mut entries = vec![series.clone(), first.clone()];
        book_placeholders(&mut entries);
        assert_eq!(entries.len(), 4);
        assert_eq!(entries[2].metadata["volume"], 2);
        db.ingest_native_catalog(&library.id, library.revision, &entries)
            .unwrap();
        let missing = db
            .native_catalog(&library.id)
            .unwrap()
            .into_iter()
            .find(|e| e.metadata["volume"] == 2)
            .unwrap();
        db.save_native_artwork(
            &library.id,
            &missing.id,
            &NativeArtwork {
                kind: "poster".into(),
                path: "@managed/cover.jpg".into(),
                source: "manual".into(),
            },
        )
        .unwrap();
        let second = blank(
            "Books/Test/Volume 02.cbz".into(),
            "book",
            Some(series.path.clone()),
            "Volume 02".into(),
        );
        let mut entries = vec![series, first, second];
        book_placeholders(&mut entries);
        db.ingest_native_catalog(&library.id, library.revision, &entries)
            .unwrap();
        let actual = db
            .native_catalog(&library.id)
            .unwrap()
            .into_iter()
            .find(|e| e.path.ends_with("Volume 02.cbz"))
            .unwrap();
        assert_eq!(actual.id, missing.id);
        assert_eq!(actual.metadata["missing"], false);
        assert_eq!(actual.artwork[0].path, "@managed/cover.jpg");
        assert!(
            !db.native_catalog(&library.id)
                .unwrap()
                .iter()
                .any(|e| e.available && e.path.ends_with("@missing-volume-2"))
        );
    }
    #[test]
    fn missing_numbers_are_scoped_to_each_book_series() {
        let mut volumes = blank(
            "Books/Volumes".into(),
            "book_series",
            None,
            "Volumes".into(),
        );
        volumes.metadata = json!({"volumes": 2});
        let mut chapters = blank(
            "Books/Chapters".into(),
            "book_series",
            None,
            "Chapters".into(),
        );
        chapters.metadata = json!({"chapters": 2});
        let first = blank(
            "Books/Volumes/Volume 01.cbz".into(),
            "book",
            Some(volumes.path.clone()),
            "Volume 01".into(),
        );
        let second = blank(
            "Books/Chapters/Chapter 02.cbz".into(),
            "book",
            Some(chapters.path.clone()),
            "Chapter 02".into(),
        );
        let mut entries = vec![volumes, chapters, first, second];
        book_placeholders(&mut entries);
        let missing: Vec<_> = entries
            .iter()
            .filter(|entry| entry.metadata["missing"] == true)
            .collect();
        assert_eq!(missing.len(), 2);
        assert_eq!(missing[0].path, "Books/Volumes/@missing-volume-2");
        assert_eq!(missing[1].path, "Books/Chapters/@missing-chapter-1");
    }
    #[test]
    fn chapter_collections_use_chapter_totals_and_unknown_files_are_not_guessed() {
        let mut series = blank("Books/Test".into(), "book_series", None, "Test".into());
        series.metadata = json!({"volumes":2,"chapters":3});
        let chapter = blank(
            "Books/Test/Chapter 02.cbz".into(),
            "book",
            Some(series.path.clone()),
            "Chapter 02".into(),
        );
        let mut entries = vec![series.clone(), chapter];
        book_placeholders(&mut entries);
        assert_eq!(entries.len(), 4);
        assert!(
            entries
                .iter()
                .filter(|e| e.metadata["missing"] == true)
                .all(|e| !e.metadata["chapter"].is_null())
        );
        let unknown = blank(
            "Books/Test/Unknown.cbz".into(),
            "book",
            Some(series.path.clone()),
            "Unknown".into(),
        );
        let mut entries = vec![series, unknown];
        book_placeholders(&mut entries);
        assert_eq!(entries.len(), 2);
    }
}

#[cfg(test)]
mod identity_nfo_tests {
    use super::*;
    #[test]
    fn identity_reset_removes_old_metadata_but_keeps_numbering_art_and_file_details() {
        let mut xml=Element::parse("<episodedetails><title>Wrong</title><plot>Old</plot><genre>Old genre</genre><custompublisher>Old publisher</custompublisher><uniqueid type='tvdb'>99</uniqueid><season>1</season><episode>2</episode><fileinfo/><thumb>local.jpg</thumb></episodedetails>".as_bytes()).unwrap();
        clear_identity_nfo(&mut xml);
        assert!(xml.get_child("plot").is_none());
        assert!(xml.get_child("genre").is_none());
        assert!(xml.get_child("custompublisher").is_none());
        assert!(xml.get_child("uniqueid").is_none());
        assert!(xml.get_child("season").is_some());
        assert!(xml.get_child("fileinfo").is_some());
        assert!(xml.get_child("thumb").is_some());
    }
}

#[cfg(test)]
mod cover_capture_tests {
    use super::*;
    use std::io::Write;
    #[test]
    fn first_cbz_page_becomes_a_sidecar_without_overwriting_existing_images() {
        let temp = tempfile::tempdir().unwrap();
        let book = temp.path().join("Volume 01.cbz");
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(24, 36)
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        let mut zip = zip::ZipWriter::new(fs::File::create(&book).unwrap());
        zip.start_file("10.png", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"not an image").unwrap();
        zip.start_file("2.png", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(png.get_ref()).unwrap();
        zip.finish().unwrap();
        capture_book_cover(&book).unwrap();
        let sidecar = book.with_extension("jpg");
        let original = fs::read(&sidecar).unwrap();
        assert_eq!(
            image::guess_format(&original).unwrap(),
            image::ImageFormat::Jpeg
        );
        assert_eq!(image::load_from_memory(&original).unwrap().width(), 24);
        fs::write(&book, b"changed book").unwrap();
        capture_book_cover(&book).unwrap();
        assert_eq!(fs::read(sidecar).unwrap(), original);
    }

    #[test]
    fn pdf_first_page_becomes_a_jpeg_sidecar() {
        if std::process::Command::new("pdftoppm")
            .arg("-v")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_err()
        {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let book = temp.path().join("Volume 02.pdf");
        let stream = "1 0 0 rg 0 0 200 300 re f";
        let objects=["<< /Type /Catalog /Pages 2 0 R >>".to_string(),"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Resources << >> /Contents 4 0 R >>".to_string(),format!("<< /Length {} >>\nstream\n{}\nendstream",stream.len(),stream)];
        let mut pdf = "%PDF-1.4\n".to_string();
        let mut offsets = Vec::new();
        for (index, object) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf += &format!("{} 0 obj\n{}\nendobj\n", index + 1, object);
        }
        let xref = pdf.len();
        pdf += "xref\n0 5\n0000000000 65535 f \n";
        for offset in offsets {
            pdf += &format!("{offset:010} 00000 n \n");
        }
        pdf += &format!("trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF");
        fs::write(&book, pdf).unwrap();
        capture_book_cover(&book).unwrap();
        let image = image::open(book.with_extension("jpg")).unwrap();
        assert!(image.height() > image.width());
        assert!(image.width() <= 1200);
    }
    #[test]
    fn invalid_book_does_not_create_a_sidecar() {
        let temp = tempfile::tempdir().unwrap();
        let book = temp.path().join("bad.cbz");
        fs::write(&book, b"broken").unwrap();
        assert!(capture_book_cover(&book).is_err());
        assert!(!book.with_extension("jpg").exists());
    }
}

#[cfg(test)]
mod media_info_cache_tests {
    use super::*;
    #[test]
    fn old_probe_results_are_refreshed() {
        assert!(!current_media_info(&json!({"streams": []})));
        assert!(!current_media_info(&Value::Null));
        assert!(current_media_info(
            &json!({"posterview_probe_version": MEDIA_INFO_VERSION, "streams": []})
        ));
        assert!(!current_media_info(&json!({"posterview_probe_version": 1})));
    }
}

#[cfg(test)]
mod youtube_nfo_tests {
    use super::*;

    #[test]
    fn video_metadata_preserves_identity_and_ordered_playlist_membership() {
        let (_, fields) = parse_nfo(br#"<episodedetails><title>Video</title><custom>keep me</custom><uniqueid type="youtube">abc123</uniqueid><youtube><video_id>abc123</video_id><channel_id>UC123</channel_id><duration_seconds>123.5</duration_seconds><playlist id="PL1" title="First" index="4"/><playlist id="PL2" title="Second" index="2"/></youtube></episodedetails>"#).unwrap();
        assert_eq!(fields["youtube"]["duration_seconds"], json!(123.5));
        assert_eq!(
            fields["youtube"]["playlists"][0],
            json!({"id":"PL1","title":"First","index":4})
        );
        assert_eq!(fields["youtube"]["playlists"][1]["index"], 2);
        assert_eq!(fields["identifiers"]["youtube"], "abc123");
        assert_eq!(fields["custom"], "keep me");
    }

    #[test]
    fn channel_metadata_reads_playlist_descriptions_and_keeps_unknown_fields() {
        let (_, fields) = parse_nfo(br#"<tvshow><title>Channel</title><youtube><channel_id>UC123</channel_id><custom>keep</custom><playlist id="PL1" title="Playlist"><description>Full playlist description</description></playlist></youtube></tvshow>"#).unwrap();
        assert_eq!(
            fields["youtube"]["playlists"][0]["description"],
            "Full playlist description"
        );
        assert_eq!(fields["youtube"]["custom"], "keep");
    }
}
