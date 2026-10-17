//! Preserve unrelated XML fields while updating authoritative YouTube metadata.
use super::{HttpError, err};
use serde_json::Value;
use std::path::Path;
use xmltree::{Element, XMLNode};
fn text(v: &Value, key: &str) -> String {
    v[key].as_str().unwrap_or_default().to_string()
}
fn set(root: &mut Element, key: &str, value: impl Into<String>) {
    root.children
        .retain(|n| !matches!(n,XMLNode::Element(e) if e.name==key));
    let mut e = Element::new(key);
    e.children.push(XMLNode::Text(value.into()));
    root.children.push(XMLNode::Element(e));
}
fn read(path: &Path, name: &str) -> Result<Element, HttpError> {
    if path.exists() {
        let root = Element::parse(std::fs::File::open(path).map_err(err)?).map_err(err)?;
        if root.name != name {
            return Err(err("Existing NFO has an unexpected root; preserving it."));
        }
        Ok(root)
    } else {
        Ok(Element::new(name))
    }
}
fn youtube(root: &mut Element) -> &mut Element {
    if !root
        .children
        .iter()
        .any(|n| matches!(n,XMLNode::Element(e) if e.name=="youtube"))
    {
        root.children
            .push(XMLNode::Element(Element::new("youtube")));
    }
    root.children
        .iter_mut()
        .find_map(|n| match n {
            XMLNode::Element(e) if e.name == "youtube" => Some(e),
            _ => None,
        })
        .expect("youtube node inserted")
}
fn playlist(root: &mut Element, entry: &Value, parent: &Value) {
    let id = text(entry, "playlist_id");
    if id.is_empty() {
        return;
    }
    let mut p = root
        .children
        .iter()
        .find_map(|n| match n {
            XMLNode::Element(e) if e.name == "playlist" && e.attributes.get("id") == Some(&id) => {
                Some(e.clone())
            }
            _ => None,
        })
        .unwrap_or_else(|| Element::new("playlist"));
    p.attributes.insert("id".into(), id.clone());
    p.attributes
        .insert("title".into(), text(entry, "playlist_title"));
    p.attributes.insert(
        "index".into(),
        entry["playlist_index"].as_u64().unwrap_or(1).to_string(),
    );
    let description = text(parent, "description");
    if !description.is_empty() {
        set(&mut p, "description", description);
    }
    root.children.retain(|n|!matches!(n,XMLNode::Element(e) if e.name=="playlist" && e.attributes.get("id")==Some(&id)));
    root.children.push(XMLNode::Element(p));
}
fn persist(path: &Path, root: &Element) -> Result<(), HttpError> {
    let parent = path.parent().ok_or_else(|| err("NFO has no parent."))?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(err)?;
    root.write_with_config(
        &mut temp,
        xmltree::EmitterConfig::new().perform_indent(true),
    )
    .map_err(err)?;
    temp.as_file().sync_all().map_err(err)?;
    temp.persist(path).map_err(|e| err(e.error))?;
    Ok(())
}
/// Whether both episode and channel NFOs already carry this playlist's current metadata.
pub(super) fn playlist_current(
    media: &Path,
    entry: &Value,
    parent: &Value,
) -> Result<bool, HttpError> {
    let id = text(entry, "playlist_id");
    if id.is_empty() {
        return Ok(true);
    }
    fn matches(
        path: &Path,
        id: &str,
        entry: &Value,
        parent: &Value,
        episode: bool,
    ) -> Result<bool, HttpError> {
        if !path.exists() {
            return Ok(false);
        }
        let root = Element::parse(std::fs::File::open(path).map_err(err)?).map_err(err)?;
        let Some(p) = root.get_child("youtube").and_then(|yt| {
            yt.children.iter().find_map(|node| match node {
                XMLNode::Element(p)
                    if p.name == "playlist" && p.attributes.get("id").is_some_and(|v| v == id) =>
                {
                    Some(p)
                }
                _ => None,
            })
        }) else {
            return Ok(false);
        };
        if p.attributes.get("title") != Some(&text(entry, "playlist_title")) {
            return Ok(false);
        }
        if episode
            && p.attributes.get("index")
                != Some(&entry["playlist_index"].as_u64().unwrap_or(1).to_string())
        {
            return Ok(false);
        }
        let description = text(parent, "description");
        if !description.is_empty()
            && p.get_child("description")
                .and_then(Element::get_text)
                .as_deref()
                != Some(description.as_str())
        {
            return Ok(false);
        }
        Ok(true)
    }
    let folder = media
        .parent()
        .ok_or_else(|| err("Video has no parent directory."))?;
    let channel = folder
        .parent()
        .ok_or_else(|| err("Video has no channel directory."))?;
    Ok(
        matches(&media.with_extension("nfo"), &id, entry, parent, true)?
            && matches(&channel.join("tvshow.nfo"), &id, entry, parent, false)?,
    )
}
#[cfg(test)]
pub(super) fn write(
    target: &Path,
    info: &Value,
    entry: &Value,
    parent: &Value,
    channel_info: &Value,
) -> Result<(), HttpError> {
    write_named(
        target,
        info["id"].as_str().unwrap_or_default(),
        info,
        entry,
        parent,
        channel_info,
    )
}
pub(super) fn write_named(
    target: &Path,
    stem: &str,
    info: &Value,
    entry: &Value,
    parent: &Value,
    channel_info: &Value,
) -> Result<(), HttpError> {
    let id = text(info, "id");
    let path = target.join(format!("{stem}.nfo"));
    let mut episode = read(&path, "episodedetails")?;
    set(&mut episode, "title", text(info, "title"));
    set(&mut episode, "plot", text(info, "description"));
    let date = text(info, "upload_date");
    if date.len() == 8 && date.bytes().all(|c| c.is_ascii_digit()) {
        set(
            &mut episode,
            "aired",
            format!("{}-{}-{}", &date[..4], &date[4..6], &date[6..]),
        );
    }
    let seconds = info["duration"].as_f64().unwrap_or_default();
    set(&mut episode, "runtime", (seconds / 60.0).ceil().to_string());
    set(&mut episode, "showtitle", text(info, "channel"));
    set(
        &mut episode,
        "episode",
        entry["playlist_index"].as_u64().unwrap_or(1).to_string(),
    );
    episode.children.retain(|n|!matches!(n,XMLNode::Element(e) if e.name=="uniqueid" && e.attributes.get("type").is_some_and(|v|v=="youtube")));
    let mut unique = Element::new("uniqueid");
    unique.attributes.insert("type".into(), "youtube".into());
    unique.attributes.insert("default".into(), "true".into());
    unique.children.push(XMLNode::Text(id.clone()));
    episode.children.push(XMLNode::Element(unique));
    if target.join(format!("{stem}.jpg")).exists() {
        set(&mut episode, "thumb", format!("{stem}.jpg"));
    }
    if let Some(tags) = info["tags"].as_array() {
        episode
            .children
            .retain(|n| !matches!(n,XMLNode::Element(e) if e.name=="tag"));
        for tag in tags.iter().filter_map(Value::as_str) {
            let mut e = Element::new("tag");
            e.children.push(XMLNode::Text(tag.into()));
            episode.children.push(XMLNode::Element(e));
        }
    }
    let yt = youtube(&mut episode);
    set(yt, "video_id", id.clone());
    set(yt, "channel_id", text(info, "channel_id"));
    set(yt, "channel", text(info, "channel"));
    set(
        yt,
        "source_url",
        format!("https://www.youtube.com/watch?v={id}"),
    );
    set(yt, "duration_seconds", seconds.to_string());
    if let Some(published) = info["timestamp"]
        .as_i64()
        .or_else(|| info["release_timestamp"].as_i64())
        .and_then(|stamp| chrono::DateTime::from_timestamp(stamp, 0))
    {
        set(yt, "published_at", published.to_rfc3339());
    }

    if let Some(chapters) = info["chapters"].as_array() {
        let mut chapter_list = Element::new("chapters");
        for chapter in chapters {
            let mut e = Element::new("chapter");
            set(&mut e, "title", text(chapter, "title"));
            set(&mut e, "start_seconds", chapter["start_time"].to_string());
            set(&mut e, "end_seconds", chapter["end_time"].to_string());
            chapter_list.children.push(XMLNode::Element(e));
        }
        yt.children
            .retain(|n| !matches!(n,XMLNode::Element(e) if e.name=="chapters"));
        yt.children.push(XMLNode::Element(chapter_list));
    }
    playlist(yt, entry, parent);
    persist(&path, &episode)?;
    let channel_dir = target
        .parent()
        .ok_or_else(|| err("Missing channel directory."))?;
    let show_path = channel_dir.join("tvshow.nfo");
    let mut show = read(&show_path, "tvshow")?;
    set(&mut show, "title", text(info, "channel"));
    let description = text(channel_info, "description");
    if !description.is_empty() {
        set(&mut show, "plot", description);
    }
    let yt = youtube(&mut show);
    set(yt, "channel_id", text(info, "channel_id"));
    set(yt, "source_url", text(info, "channel_url"));
    playlist(yt, entry, parent);
    persist(&show_path, &show)
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn readable_sidecar_names_preserve_metadata_identity() {
        let temp = tempfile::tempdir().unwrap();
        let channel = temp.path().join("channel");
        let target = channel.join("vid");
        std::fs::create_dir_all(&target).unwrap();
        let stem = "2026-02-03 - Readable Title [vid]";
        std::fs::write(target.join(format!("{stem}.jpg")), "fixture").unwrap();
        let info = json!({"id":"vid","title":"Readable: Title?","channel":"Channel","channel_id":"UCfixture"});
        write_named(
            &target,
            stem,
            &info,
            &Value::Null,
            &Value::Null,
            &Value::Null,
        )
        .unwrap();
        assert!(!target.join("vid.nfo").exists());
        let root = Element::parse(std::fs::File::open(target.join(format!("{stem}.nfo"))).unwrap())
            .unwrap();
        assert_eq!(
            root.get_child("title").unwrap().get_text().unwrap(),
            "Readable: Title?"
        );
        assert_eq!(
            root.get_child("thumb").unwrap().get_text().unwrap(),
            format!("{stem}.jpg")
        );
        assert_eq!(
            root.get_child("youtube")
                .unwrap()
                .get_child("video_id")
                .unwrap()
                .get_text()
                .unwrap(),
            "vid"
        );
        assert_eq!(
            root.get_child("uniqueid").unwrap().get_text().unwrap(),
            "vid"
        );
    }
    #[test]
    fn generated_nfo_imports_one_video_with_multiple_playlist_memberships() {
        use posterview_contracts::native::{AnimeContent, NativeLibraryInput, NativeLibraryType};
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        let root = state.metadata.directory("", true).unwrap();
        let target = root.join("YouTube/Readable Channel/Video title");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("video.mp4"), b"fixture").unwrap();
        image::DynamicImage::new_rgb8(16, 9)
            .save(target.join("video.jpg"))
            .unwrap();
        let info = json!({"id":"video","channel_id":"UCfixture","channel":"Channel","title":"Video title","description":"Video description","duration":120,"upload_date":"20260102","channel_url":"https://www.youtube.com/channel/UCfixture"});
        for (id, index) in [("PLone", 2), ("PLtwo", 1)] {
            write(
                &target,
                &info,
                &json!({"playlist_id":id,"playlist_title":id,"playlist_index":index}),
                &json!({"description":"Playlist description"}),
                &json!({"description":"Channel description"}),
            )
            .unwrap();
        }
        let store = posterview_infra_sqlite::ServerStore::new(state.runtime.data_dir());
        let library = store
            .save_native_library(
                None,
                &NativeLibraryInput {
                    name: "YouTube".into(),
                    library_type: NativeLibraryType::Youtube,
                    anime_content: AnimeContent::Both,
                    paths: vec!["YouTube".into()],
                    revision: None,
                    options: Default::default(),
                },
            )
            .unwrap();
        let (entries, _) = crate::native_scan::collect(&state, &library).unwrap();
        let videos = entries
            .iter()
            .filter(|entry| entry.kind == "episode")
            .collect::<Vec<_>>();
        assert_eq!(videos.len(), 1);
        assert_eq!(videos[0].metadata["youtube"]["video_id"], "video");
        assert_eq!(
            videos[0].metadata["youtube"]["playlists"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert!(videos[0].artwork.iter().any(|art| art.kind == "thumb"));
        assert!(!entries.iter().any(|entry| entry.kind == "season"));
        let channel = entries.iter().find(|entry| entry.kind == "series").unwrap();
        assert_eq!(channel.metadata["plot"], "Channel description");
        assert_eq!(videos[0].parent_path.as_ref(), Some(&channel.path));
        store
            .ingest_native_catalog(&library.id, library.revision, &entries)
            .unwrap();
        let id = store
            .native_catalog(&library.id)
            .unwrap()
            .into_iter()
            .find(|entry| entry.kind == "episode")
            .unwrap()
            .id;
        store
            .ingest_native_catalog(&library.id, library.revision, &entries)
            .unwrap();
        assert_eq!(
            store
                .native_catalog(&library.id)
                .unwrap()
                .into_iter()
                .find(|entry| entry.kind == "episode")
                .unwrap()
                .id,
            id
        );
    }

    #[test]
    fn metadata_escapes_and_merges_membership() {
        let temp = tempfile::tempdir().unwrap();
        let channel = temp.path().join("channel");
        let target = channel.join("video");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(
            target.join("vid.nfo"),
            "<episodedetails><custom>keep</custom></episodedetails>",
        )
        .unwrap();
        let info = json!({"id":"vid","channel_id":"UCid","channel":"A & B","title":"<Title>","description":"x & y","upload_date":"20260102","duration":123,"timestamp":1767312000});
        for id in ["playlistA", "playlistB"] {
            write(
                &target,
                &info,
                &json!({"playlist_id":id,"playlist_title":"List","playlist_index":2}),
                &json!({"description":"playlist & description"}),
                &json!({"description":"channel description"}),
            )
            .unwrap();
        }
        let root = Element::parse(std::fs::File::open(target.join("vid.nfo")).unwrap()).unwrap();
        assert_eq!(
            root.get_child("custom").unwrap().get_text().unwrap(),
            "keep"
        );
        assert_eq!(
            root.get_child("title").unwrap().get_text().unwrap(),
            "<Title>"
        );
        assert_eq!(
            root.get_child("youtube")
                .unwrap()
                .children
                .iter()
                .filter(|n| matches!(n,XMLNode::Element(e) if e.name=="playlist"))
                .count(),
            2
        );
        assert!(
            root.get_child("youtube")
                .unwrap()
                .get_child("published_at")
                .is_some()
        );
        assert_eq!(
            root.get_child("aired").unwrap().get_text().unwrap(),
            "2026-01-02"
        );
    }
}
