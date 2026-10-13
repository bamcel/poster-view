//! HLS timeline retention and public playlist generation.
use super::{HttpError, failure};
use std::path::Path as FsPath;

pub(super) fn playlist_seconds(path: &FsPath) -> f64 {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| {
            l.strip_prefix("#EXTINF:")?
                .split(',')
                .next()?
                .parse::<f64>()
                .ok()
        })
        .filter(|n| n.is_finite())
        .sum()
}
pub(super) fn prune_consumed(dir: &FsPath, position: f64, retention_seconds: f64) {
    // Keep the delivery method's safety window for seeks in the current generation
    // behind playback. The served rolling manifest omits retired files and keeps
    // the original segment numbers and fMP4 timestamps for the attached client.
    let Ok(playlist) = std::fs::read_to_string(dir.join("index.m3u8")) else {
        return;
    };
    let mut end = 0.0;
    let mut length = None;
    for line in playlist.lines() {
        if let Some(value) = line.strip_prefix("#EXTINF:") {
            length = value
                .split(',')
                .next()
                .and_then(|s| s.parse::<f64>().ok())
                .filter(|n| n.is_finite() && *n >= 0.0);
        } else if !line.starts_with('#') && safe_segment(line) && line.ends_with(".m4s") {
            if let Some(length) = length.take() {
                end += length;
                if end + retention_seconds < position {
                    let _ = std::fs::remove_file(dir.join(line));
                }
            }
        }
    }
}
pub(super) fn rolling_manifest(raw: &str, directory: &FsPath) -> Result<String, HttpError> {
    let mut headers = Vec::new();
    let mut fragments = Vec::new();
    let mut pending = Vec::new();
    let mut sequence = 0u64;
    let mut ended = false;
    let mut started = false;
    for line in raw.lines() {
        if let Some(value) = line.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
            sequence = value
                .parse::<u64>()
                .map_err(|_| failure("Invalid playback playlist sequence."))?;
            continue;
        }
        if line.starts_with("#EXT-X-PLAYLIST-TYPE:") || line.starts_with("#EXT-X-START:") {
            continue;
        }
        if line == "#EXT-X-ENDLIST" {
            ended = true;
            continue;
        }
        if line.starts_with("#EXTINF:") {
            started = true;
            pending.push(line.to_string());
        } else if !line.starts_with('#') && !line.is_empty() {
            if !safe_segment(line) || !line.ends_with(".m4s") {
                return Err(failure("Invalid playback playlist segment."));
            }
            pending.push(line.to_string());
            fragments.push(std::mem::take(&mut pending));
        } else if started {
            pending.push(line.to_string());
        } else {
            headers.push(line.to_string());
        }
    }
    // Retire only a completed prefix. Preserve the remaining original sequence
    // numbers; never advertise a deleted URI or rewrite the media timestamps.
    let first = fragments
        .iter()
        .position(|f| f.last().is_some_and(|name| directory.join(name).is_file()))
        .ok_or_else(|| failure("Playback segments are not available yet."))?;
    let mut result = headers.join("\n");
    result.push_str(&format!(
        "\n#EXT-X-MEDIA-SEQUENCE:{}\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n",
        sequence + first as u64
    ));
    let mut complete = true;
    for fragment in fragments.iter().skip(first) {
        if !fragment
            .last()
            .is_some_and(|name| directory.join(name).is_file())
        {
            complete = false;
            break;
        }
        for line in fragment {
            result.push_str(line);
            result.push('\n');
        }
    }
    if ended && complete {
        result.push_str("#EXT-X-ENDLIST\n");
    }
    Ok(result)
}

pub(super) fn safe_segment(name: &str) -> bool {
    name == "index.m3u8"
        || name == "init.mp4"
        || (name.starts_with("segment-")
            && name.ends_with(".m4s")
            && name.len() == 18
            && name
                .as_bytes()
                .get(8..14)
                .is_some_and(|bytes| bytes.iter().all(u8::is_ascii_digit)))
}

pub(super) fn retained_range(raw: &str, directory: &FsPath) -> Option<(f64, f64)> {
    let mut time = 0.0;
    let mut length = None;
    let mut start = None;
    let mut end = 0.0;
    for line in raw.lines() {
        if let Some(value) = line.strip_prefix("#EXTINF:") {
            length = value
                .split(',')
                .next()?
                .parse::<f64>()
                .ok()
                .filter(|value| value.is_finite() && *value >= 0.0);
        } else if safe_segment(line) && line.ends_with(".m4s") {
            let length = length.take()?;
            if directory.join(line).is_file() {
                start.get_or_insert(time);
                end = time + length;
            } else if start.is_some() {
                break;
            }
            time += length;
        }
    }
    start.map(|start| (start, end))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn longer_copy_retention_keeps_backward_skips_but_still_prunes_old_segments() {
        for (retention, first_retained) in [(60.0, 22), (120.0, 7)] {
            let temp = tempfile::tempdir().unwrap();
            let mut raw = String::from("#EXTM3U\n#EXT-X-TARGETDURATION:4\n");
            for index in 0..40 {
                let name = format!("segment-{index:06}.m4s");
                raw.push_str(&format!("#EXTINF:4.0,\n{name}\n"));
                std::fs::write(temp.path().join(name), b"segment").unwrap();
            }
            std::fs::write(temp.path().join("index.m3u8"), &raw).unwrap();
            prune_consumed(temp.path(), 150.0, retention);
            assert_eq!(
                retained_range(&raw, temp.path()),
                Some((f64::from(first_retained) * 4.0, 160.0))
            );
            assert!(!temp.path().join("segment-000000.m4s").exists());
        }
    }
    #[test]
    fn retained_playlist_omits_pruned_prefix_but_preserves_sequence_and_source_time() {
        let temp = tempfile::tempdir().unwrap();
        let raw = "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:4.0,\nsegment-000000.m4s\n#EXTINF:4.0,\nsegment-000001.m4s\n#EXTINF:4.0,\nsegment-000002.m4s\n#EXT-X-ENDLIST\n";
        for index in 1..=2 {
            std::fs::write(
                temp.path().join(format!("segment-{index:06}.m4s")),
                b"segment",
            )
            .unwrap();
        }
        assert_eq!(retained_range(raw, temp.path()), Some((4.0, 12.0)));
        let manifest = rolling_manifest(raw, temp.path()).unwrap();
        assert!(manifest.contains("MEDIA-SEQUENCE:1"));
        assert!(!manifest.contains("PLAYLIST-TYPE:EVENT"));
        assert!(!manifest.contains("segment-000000"));
        assert!(manifest.ends_with("#EXT-X-ENDLIST\n"));
    }
    #[test]
    fn names_cannot_escape_the_generation() {
        for valid in ["index.m3u8", "init.mp4", "segment-000000.m4s"] {
            assert!(safe_segment(valid));
        }
        for invalid in [
            "../init.mp4",
            "/init.mp4",
            "owner.json",
            "segment-foo.m4s",
            "segment-000000.m4s/..",
            "segment-ééé.m4s",
        ] {
            assert!(!safe_segment(invalid));
        }
    }
}
