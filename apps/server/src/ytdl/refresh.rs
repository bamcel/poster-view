//! Metadata-only jobs deliberately have no download, staging or encoder path.
use super::{AppState, HttpError, Job, cancelled, downloader, err, naming, nfo, update};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
};

fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_string()
}

type Memberships = HashMap<String, Vec<(Value, Value)>>;

fn merge_playlist(
    local: &HashSet<String>,
    combined: &mut Vec<Value>,
    memberships: &mut Memberships,
    parent: &Value,
) {
    let mut seen = combined
        .iter()
        .map(|entry| text(entry, "id"))
        .collect::<HashSet<_>>();
    for member in parent["entries"].as_array().into_iter().flatten() {
        let id = text(member, "id");
        if !local.contains(&id) {
            continue;
        }
        if seen.insert(id.clone()) {
            combined.push(member.clone());
        }
        memberships.entry(id).or_default().push((
            member.clone(),
            serde_json::json!({"description":parent["description"]}),
        ));
    }
}

/// Index only the plugin's channel/video layout, without creating missing paths.
pub(super) fn local_videos(root: &Path) -> Result<HashSet<String>, HttpError> {
    let channels = root.join("channels");
    if !channels.try_exists().map_err(err)? {
        return Ok(HashSet::new());
    }
    real_directory(&channels)?;
    let mut ids = HashSet::new();
    for channel in std::fs::read_dir(channels).map_err(err)? {
        let channel = channel.map_err(err)?;
        if !channel.file_type().map_err(err)?.is_dir() {
            continue;
        }
        real_directory(&channel.path())?;
        for video in std::fs::read_dir(channel.path()).map_err(err)? {
            let video = video.map_err(err)?;
            if !video.file_type().map_err(err)?.is_dir() {
                continue;
            }
            real_directory(&video.path())?;
            if naming::existing_media(&video.path())?.is_none() {
                continue;
            }
            let identity = naming::video_identity(&video.path())?.or_else(|| {
                let name = video.file_name().to_string_lossy().into_owned();
                downloader::valid_id(&name).then_some(name)
            });
            if let Some(id) = identity
                && !ids.insert(id)
            {
                return Err(err(
                    "Multiple local folders identify the same video; resolve the duplicate before refreshing metadata.",
                ));
            }
        }
    }
    Ok(ids)
}

fn real_directory(path: &Path) -> Result<(), HttpError> {
    let metadata = std::fs::symlink_metadata(path).map_err(err)?;
    #[cfg(windows)]
    let linked = {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    };
    #[cfg(not(windows))]
    let linked = metadata.file_type().is_symlink();
    if linked || !metadata.is_dir() {
        return Err(err("Metadata refresh requires existing real directories."));
    }
    Ok(())
}

/// Recheck writable sidecars before the shared writer reads their contents.
fn safe_sidecar(path: &Path) -> Result<(), HttpError> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => Err(err(
            "Metadata sidecars must be regular files, not symbolic links.",
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(err(error)),
    }
}

fn existing_target(root: &Path, info: &Value) -> Result<Option<PathBuf>, HttpError> {
    let (channel, video) = naming::folder_names(
        root,
        &text(info, "channel_id"),
        &text(info, "id"),
        &text(info, "channel"),
        &text(info, "title"),
    )?;
    let target = root.join("channels").join(channel).join(video);
    if !target.try_exists().map_err(err)? {
        return Ok(None);
    }
    real_directory(&target)?;
    Ok(Some(target))
}

fn write_existing(
    target: &Path,
    info: &Value,
    entry: &Value,
    parent: &Value,
    channel: &Value,
) -> Result<bool, HttpError> {
    real_directory(target)?;
    let Some(media) = naming::existing_media(target)? else {
        return Ok(false);
    };
    let stem = media
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| err("Existing video filename is not valid UTF-8."))?;
    safe_sidecar(&target.join(format!("{stem}.nfo")))?;
    let channel_dir = target
        .parent()
        .ok_or_else(|| err("Missing channel directory."))?;
    real_directory(channel_dir)?;
    safe_sidecar(&channel_dir.join("tvshow.nfo"))?;
    nfo::write_named(target, stem, info, entry, parent, channel)?;
    Ok(true)
}

pub(super) async fn run(state: &AppState, job: &Job) -> Result<(), HttpError> {
    if !super::load::<super::Settings>(state, "plugin-ytdl")?.enabled {
        return Err(err("YTDL plugin is disabled."));
    }
    let destination = super::validate_metadata_destination(state, &job.settings)?;
    let local = local_videos(&destination)?;
    if local.is_empty() {
        return Err(err(
            "No existing local videos found. Metadata refresh never downloads missing videos.",
        ));
    }
    update(state, &job.id, "inspecting", None, None).await?;
    let source = async {
        if downloader::is_channel_url(&job.url) {
            downloader::inspect_channel_videos(&job.url).await
        } else {
            downloader::inspect(&job.url).await
        }
    };
    let mut inspection = tokio::select! {
        result = source => result?,
        _ = downloader::await_cancel(state, job) => return Err(err("Metadata refresh cancelled.")),
    };
    {
        let _lock = state.ytdl_lock.lock().await;
        let mut jobs = super::load::<Vec<Job>>(state, "plugin-ytdl-jobs")?;
        if let Some(saved) = jobs.iter_mut().find(|saved| saved.id == job.id) {
            saved.title = text(&inspection, "title");
        }
        super::save(state, "plugin-ytdl-jobs", &jobs)?;
    }
    let mut channels = HashMap::new();
    let mut memberships = Memberships::new();
    if downloader::is_channel_url(&job.url) {
        let channel = downloader::job_raw_inspect(state, job, &job.url).await?;
        let mut combined = inspection["entries"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        for playlist in channel["entries"].as_array().into_iter().flatten() {
            let playlist_id = text(playlist, "id");
            if !downloader::valid_id(&playlist_id) {
                continue;
            }
            let url = format!("https://www.youtube.com/playlist?list={playlist_id}");
            let parent = tokio::select! {
                result = downloader::inspect(&url) => result?,
                _ = downloader::await_cancel(state, job) => return Err(err("Metadata refresh cancelled.")),
            };
            merge_playlist(&local, &mut combined, &mut memberships, &parent);
        }
        inspection["entries"] = Value::Array(combined);
        let channel_id = channel["channel_id"]
            .as_str()
            .or_else(|| channel["id"].as_str())
            .unwrap_or_default();
        if downloader::valid_id(channel_id) {
            channels.insert(channel_id.to_string(), channel);
        }
    }
    let entries = inspection["entries"]
        .as_array()
        .ok_or_else(|| err("No videos found."))?;
    let selected = entries
        .iter()
        .filter(|entry| {
            let id = text(entry, "id");
            local.contains(&id) && (job.video_ids.is_empty() || job.video_ids.contains(&id))
        })
        .collect::<Vec<_>>();
    if selected.is_empty() {
        return Err(err(
            "No matching existing local videos found. Metadata refresh never downloads missing videos.",
        ));
    }
    let mut refreshed = 0;
    for (index, entry) in selected.iter().enumerate() {
        if cancelled(state, &job.id).await {
            return Err(err("Metadata refresh cancelled."));
        }
        let id = text(entry, "id");
        downloader::video_progress(
            state,
            &job.id,
            selected.len(),
            index,
            Some(text(entry, "title")),
        )
        .await?;
        let info = downloader::job_raw_inspect(
            state,
            job,
            &format!("https://www.youtube.com/watch?v={id}"),
        )
        .await?;
        if text(&info, "id") != id {
            return Err(err(
                "Extracted video identity did not match the requested video.",
            ));
        }
        let channel_id = text(&info, "channel_id");
        if !downloader::valid_id(&channel_id) {
            return Err(err("Video has no stable channel ID."));
        }
        if !channels.contains_key(&channel_id) {
            let value = downloader::job_raw_inspect(
                state,
                job,
                &format!("https://www.youtube.com/channel/{channel_id}/playlists"),
            )
            .await?;
            channels.insert(channel_id.clone(), value);
        }
        let Some(target) = existing_target(&destination, &info)? else {
            continue;
        };
        // Revalidate all components using the application's metadata path policy.
        let relative = target
            .strip_prefix(&destination)
            .map_err(err)?
            .to_string_lossy()
            .replace('\\', "/");
        let relative = if job.settings.directory.is_empty() {
            relative
        } else {
            format!("{}/{relative}", job.settings.directory)
        };
        let target = state.metadata.directory(&relative, false)?;
        if cancelled(state, &job.id).await {
            return Err(err("Metadata refresh cancelled."));
        }
        update(state, &job.id, "importing", None, None).await?;
        let channel = &channels[&channel_id];
        if write_existing(&target, &info, entry, &inspection, channel)? {
            refreshed += 1;
            for (member, parent) in memberships.get(&id).into_iter().flatten() {
                if text(member, "id") == id {
                    if cancelled(state, &job.id).await {
                        return Err(err("Metadata refresh cancelled."));
                    }
                    write_existing(&target, &info, member, parent, channel)?;
                }
            }
        }
        downloader::video_progress(state, &job.id, selected.len(), index + 1, None).await?;
    }
    if refreshed == 0 {
        return Err(err(
            "No matching existing media files were available to refresh.",
        ));
    }
    if cancelled(state, &job.id).await {
        return Err(err("Metadata refresh cancelled."));
    }
    update(state, &job.id, "completed", None, Some(100.0)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture(root: &Path) -> PathBuf {
        let target = root.join("channels/Original channel/Original video");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(
            target.parent().unwrap().join("tvshow.nfo"),
            "<tvshow><youtube><channel_id>UCfixture</channel_id></youtube></tvshow>",
        )
        .unwrap();
        std::fs::write(target.join("Original filename.nfo"),
            "<episodedetails><title>Old title</title><playcount>3</playcount><youtube><video_id>fixture</video_id></youtube></episodedetails>").unwrap();
        std::fs::write(
            target.join("Original filename.mp4"),
            b"existing low quality video",
        )
        .unwrap();
        std::fs::write(target.join("Original filename.jpg"), b"existing artwork").unwrap();
        target
    }

    #[test]
    fn channel_union_includes_local_unlisted_and_short_playlist_members_once() {
        let local = ["upload", "unlisted", "short"]
            .into_iter()
            .map(str::to_string)
            .collect();
        let mut combined = vec![json!({"id":"upload"})];
        let mut memberships = Memberships::new();
        for playlist in ["PLfirst", "PLsecond"] {
            merge_playlist(
                &local,
                &mut combined,
                &mut memberships,
                &json!({
                    "description":"Playlist description", "entries":[
                        {"id":"upload", "playlist_id":playlist},
                        {"id":"unlisted", "playlist_id":playlist},
                        {"id":"short", "playlist_id":playlist},
                        {"id":"not_downloaded", "playlist_id":playlist}
                    ]
                }),
            );
        }
        assert_eq!(
            combined
                .iter()
                .map(|entry| text(entry, "id"))
                .collect::<Vec<_>>(),
            ["upload", "unlisted", "short"]
        );
        assert_eq!(memberships["unlisted"].len(), 2);
        assert_eq!(memberships["short"].len(), 2);
        assert!(!memberships.contains_key("not_downloaded"));
    }

    #[test]
    fn refresh_preserves_original_media_artwork_names_and_unrelated_metadata() {
        let temp = tempfile::tempdir().unwrap();
        let target = fixture(temp.path());
        let info = json!({"id":"fixture", "title":"Corrected title", "channel_id":"UCfixture", "channel":"Corrected channel", "description":"New description", "upload_date":"20261016", "duration":120});
        assert_eq!(
            existing_target(temp.path(), &info).unwrap(),
            Some(target.clone())
        );
        assert!(write_existing(&target, &info, &json!({"playlist_id":"PLfixture", "playlist_title":"Playlist", "playlist_index":4}), &Value::Null, &json!({"description":"Channel description"})).unwrap());
        assert_eq!(
            std::fs::read(target.join("Original filename.mp4")).unwrap(),
            b"existing low quality video"
        );
        assert_eq!(
            std::fs::read(target.join("Original filename.jpg")).unwrap(),
            b"existing artwork"
        );
        assert_eq!(std::fs::read_dir(&target).unwrap().count(), 3);
        let xml = std::fs::read_to_string(target.join("Original filename.nfo")).unwrap();
        assert!(xml.contains("<title>Corrected title</title>"));
        assert!(xml.contains("<playcount>3</playcount>"));
        assert!(xml.contains("PLfixture"));
        assert!(
            std::fs::read_to_string(target.parent().unwrap().join("tvshow.nfo"))
                .unwrap()
                .contains("Channel description")
        );
    }

    #[test]
    fn missing_media_never_creates_video_folders_or_sidecars() {
        let temp = tempfile::tempdir().unwrap();
        assert!(local_videos(temp.path()).unwrap().is_empty());
        let info = json!({"id":"missing", "channel_id":"UCfixture", "title":"Missing video", "channel":"Channel"});
        assert_eq!(existing_target(temp.path(), &info).unwrap(), None);
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
        let target = temp.path().join("empty");
        std::fs::create_dir(&target).unwrap();
        assert!(!write_existing(&target, &info, &Value::Null, &Value::Null, &Value::Null).unwrap());
        assert_eq!(std::fs::read_dir(target).unwrap().count(), 0);
    }

    #[test]
    fn skip_index_uses_identity_regardless_of_media_quality_or_changed_title() {
        let temp = tempfile::tempdir().unwrap();
        let target = fixture(temp.path());
        let original = std::fs::read(target.join("Original filename.nfo")).unwrap();
        assert!(local_videos(temp.path()).unwrap().contains("fixture"));
        assert_eq!(
            std::fs::read(target.join("Original filename.nfo")).unwrap(),
            original
        );
    }

    #[tokio::test]
    async fn metadata_job_without_existing_media_fails_before_inspection_or_encoder() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::test_support::state(temp.path());
        let destination = temp.path().join("media/downloads");
        std::fs::create_dir(&destination).unwrap();
        let settings = super::super::Settings {
            enabled: true,
            directory: "downloads".into(),
            convert: true,
            hardware_backend: "unavailable-encoder".into(),
            ..Default::default()
        };
        super::super::save(&state, "plugin-ytdl", &settings).unwrap();
        let job: Job = serde_json::from_value(json!({
            "metadata_only":true, "id":"fixture", "url":"invalid URL must never be inspected",
            "title":"Fixture", "status":"queued", "created_at":"", "settings":settings
        }))
        .unwrap();
        super::super::save(&state, "plugin-ytdl-jobs", &vec![job.clone()]).unwrap();
        let error = downloader::run(&state, &job).await.unwrap_err();
        assert!(error.detail.contains("No existing local videos"));
        assert_eq!(std::fs::read_dir(destination).unwrap().count(), 0);
        assert!(!state.runtime.data_dir().join("ytdl").exists());
    }
}
