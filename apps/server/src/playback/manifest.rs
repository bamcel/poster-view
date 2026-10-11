//! HLS timeline retention and public playlist generation.
use super::{HttpError, failure, safe_segment};
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
pub(super) fn prune_consumed(dir: &FsPath, position: f64) {
    // Seeking always creates a new source session; keep a one-minute safety window
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
                if end + 60.0 < position {
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rolling_hls_manifest_never_advertises_retired_segments() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let raw = "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:10\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:4.000,\nsegment-000010.m4s\n#EXTINF:4.000,\nsegment-000011.m4s\n#EXTINF:4.000,\nsegment-000012.m4s\n#EXTINF:4.000,\nsegment-000013.m4s\n#EXT-X-ENDLIST\n";
        for sequence in 10..=13 {
            std::fs::write(root.join(format!("segment-{sequence:06}.m4s")), b"segment").unwrap();
        }
        let initial = rolling_manifest(raw, root).unwrap();
        assert!(initial.contains("#EXT-X-MEDIA-SEQUENCE:10"));
        assert!(!initial.contains("PLAYLIST-TYPE:EVENT"));
        assert!(initial.contains("TIME-OFFSET=0"));
        std::fs::remove_file(root.join("segment-000010.m4s")).unwrap();
        std::fs::remove_file(root.join("segment-000011.m4s")).unwrap();
        let window = rolling_manifest(raw, root).unwrap();
        assert!(window.contains("#EXT-X-MEDIA-SEQUENCE:12"));
        assert!(!window.contains("segment-000010"));
        assert!(!window.contains("segment-000011"));
        assert!(window.contains("segment-000012"));
        assert!(window.ends_with("#EXT-X-ENDLIST\n"));
        assert!(window.contains("#EXT-X-MAP:URI=\"init.mp4\""));
    }
}
