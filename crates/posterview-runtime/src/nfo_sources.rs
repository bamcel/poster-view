//! Read only the provider links from a book item's local NFO for Sync preloading.
use std::{collections::HashMap, fs, path::{Path, PathBuf}};
use url::Url;
use xmltree::{Element, XMLNode};

const MAX_NFO_BYTES: u64 = 1_048_576;

pub(super) fn linked_providers(source_path: Option<&str>) -> HashMap<&'static str, String> {
    let Some(source_path) = source_path else { return HashMap::new() };
    let root = std::env::var_os("POSTERVIEW_MEDIA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/media"));
    linked_providers_under(&root, source_path)
}

fn linked_providers_under(root: &Path, source_path: &str) -> HashMap<&'static str, String> {
    let mut providers = HashMap::new();
    let Ok(root) = root.canonicalize() else { return providers };
    let normalized = source_path.replace('\\', "/");
    let source = PathBuf::from(&normalized);
    let source = source.canonicalize().unwrap_or(source);
    let mapped = if source.starts_with(&root) {
        source
    } else if let Some(relative) = normalized.strip_prefix("/mnt/user/") {
        root.join(relative)
    } else if let Some(relative) = normalized.strip_prefix("/media/") {
        root.join(relative)
    } else {
        return providers;
    };
    let Ok(mapped) = mapped.canonicalize() else { return providers };
    if !mapped.starts_with(&root) { return providers; }
    let directory = if mapped.is_dir() { mapped } else {
        let Some(parent) = mapped.parent() else { return providers };
        parent.to_path_buf()
    };
    let Some(name) = directory.file_name() else { return providers };
    let nfo = directory.join(format!("{}.nfo", name.to_string_lossy()));
    let Ok(metadata) = fs::symlink_metadata(&nfo) else { return providers };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_NFO_BYTES {
        return providers;
    }
    let Ok(xml) = fs::read_to_string(nfo) else { return providers };
    if xml.contains("<!DOCTYPE") || xml.contains("<!ENTITY") { return providers; }
    let Ok(root) = Element::parse(xml.as_bytes()) else { return providers };
    if !matches!(root.name.as_str(), "series" | "book" | "tvshow") { return providers; }
    for child in root.children {
        let XMLNode::Element(element) = child else { continue };
        if element.name != "source" { continue; }
        let Some(value) = element.get_text() else { continue };
        for source in value.lines() {
            let Ok(url) = Url::parse(source.trim()) else { continue };
            if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() { continue; }
            let Some(host) = url.host_str() else { continue };
            let segments = url.path_segments().map(|parts| parts.collect::<Vec<_>>()).unwrap_or_default();
            let linked = if host.eq_ignore_ascii_case("anilist.co") && segments.first() == Some(&"manga") {
                segments.get(1).filter(|id| id.parse::<u32>().is_ok()).map(|id| ("anilist-manga", (*id).to_owned()))
            } else if host.eq_ignore_ascii_case("mangadex.org") && segments.first() == Some(&"title") {
                segments.get(1).filter(|id| posterview_infra_artwork::valid_manga_id(id)).map(|id| ("mangadex", (*id).to_owned()))
            } else if host.eq_ignore_ascii_case("comicvine.gamespot.com") {
                segments.iter().find_map(|part| part.strip_prefix("4050-")).filter(|id| !id.is_empty() && id.chars().all(|c| c.is_ascii_digit())).map(|id| ("comicvine", id.to_owned()))
            } else if (host.eq_ignore_ascii_case("viz.com") || host.eq_ignore_ascii_case("www.viz.com")) && url.path().starts_with("/manga-books/manga/") && url.path().ends_with("/all") {
                Some(("viz", url.to_string()))
            } else { None };
            if let Some((provider, id)) = linked { providers.entry(provider).or_insert(id); }
        }
    }
    providers
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_explicit_trusted_nfo_sources_are_selected() {
        let temp = tempfile::tempdir().unwrap();
        let series = temp.path().join("Classroom of the Elite");
        fs::create_dir(&series).unwrap();
        fs::write(series.join("Classroom of the Elite.nfo"), "<series><anilistid>999</anilistid><source>https://anilist.co/manga/123</source><source>https://comicvine.gamespot.com/classroom-of-the-elite/4050-456/</source><source>https://www.viz.com/manga-books/manga/black-clover/all</source><source>https://anilist.co.evil.test/manga/789</source></series>").unwrap();
        let links = linked_providers_under(temp.path(), series.to_str().unwrap());
        assert_eq!(links.get("anilist-manga").map(String::as_str), Some("123"));
        assert_eq!(links.get("comicvine").map(String::as_str), Some("456"));
        assert_eq!(links.get("viz").map(String::as_str), Some("https://www.viz.com/manga-books/manga/black-clover/all"));
        assert_eq!(links.len(), 3);
    }

    #[test]
    fn missing_or_outside_nfo_has_no_preload_sources() {
        let temp = tempfile::tempdir().unwrap();
        let series = temp.path().join("Series");
        fs::create_dir(&series).unwrap();
        assert!(linked_providers_under(temp.path(), series.to_str().unwrap()).is_empty());
        assert!(linked_providers_under(temp.path(), "C:/outside/Series").is_empty());
    }
}
