# YouTube libraries and YTDL

Administrators configure YTDL in **Settings → Plugins → YTDL**. The plugin
downloads public YouTube videos and playlists with yt-dlp, writes local NFO
metadata and thumbnails, and imports completed files into a native YouTube
library. Browsing, playback, resume, and watch history use normal library access
permissions. Non-administrators cannot configure, inspect, queue, cancel, or retry
downloads through the API.

## Setup

1. Create a library with type **YouTube** from the plugin popup or Libraries.
2. Choose **Single channel** (playlists → videos) or **Multiple channels**
   (channels → playlists → videos). Configure channel IDs, `@handles`, or HTTPS
   YouTube channel URLs. An empty channel list permits the first channel for a
   single-channel library, or any channel for a multiple-channel library.
3. Select existing folders under the configured media mount. Docker/Unraid paths
   are container paths, not host paths. The download directory must already
   exist, be writable, and lie within this library's selected roots.
4. In the plugin popup, select the library/directory, enable YTDL, choose formats
   and metadata options, and **Save configuration**.
5. Paste a video or playlist URL into Downloads, **Fetch Info**, select videos,
   and queue the download. A channel URL opens its playlists; choose **Open
   playlist** before selecting videos. Standalone videos appear under All Videos.

## Formats and jobs

Resolution and frame rate are upper bounds; they never upscale the source.
Codec preferences select available source streams without encoding unless
**Convert to selected codecs** is enabled. Strict fallback fails when the source
cannot match the selection. Best fallback chooses another available source
within the quality limits. WebM requires VP9/AV1 and Opus; use MP4/MKV for
H.264/AAC. Conversion runs FFmpeg in staging before publishing a final file.

The queue runs one job at a time and persists job settings, status, progress,
speed, ETA, and errors. Each job keeps the settings used when it was submitted.
Cancel stops work; retry is available once the process has stopped. A server
restart marks active jobs Interrupted and leaves queued jobs queued. Retry is
explicit; staging for interrupted work is not guaranteed resumable.

Completed video IDs are reused even when requested in another playlist. Existing
media is not overwritten or automatically re-encoded when format settings change.
The playlist's ordered membership is updated without duplicating video playback
or watch history. Downloads stage under application data, so leave adequate free
space both there and at the media destination.

## Metadata and files

Files have stable ID-based paths:

```text
<download-directory>/channels/<channel-id>/
  tvshow.nfo
  <video-id>/
    <video-id>.mp4     # or .mkv/.webm
    <video-id>.nfo
    <video-id>.jpg
    <video-id>.<language>.vtt
```

The video NFO uses `<episodedetails>` with standard title, plot, aired, runtime,
tags, thumbnail, and `<uniqueid type="youtube">`. Its `<youtube>` extension stores
video/channel IDs, channel name, canonical source URL, exact duration, chapters,
and `<playlist id="…" title="…" index="…">` membership. Channel `tvshow.nfo`
stores its title, description, source URL, and playlist descriptions. Unrelated
custom fields and other playlist memberships survive updates.

YouTube scanning uses local metadata rather than TV identification providers and
does not synthesize missing television episodes or seasons. The frontend displays
playlists as series in single-channel mode and as season-style groups inside
channels in multiple-channel mode. All Videos remains available in either mode.

## Runtime dependencies

The Docker image includes a pinned yt-dlp installation, Node.js for YouTube's
JavaScript extraction, and FFmpeg/ffprobe. Local development needs these programs
on PATH. The popup reports dependency versions. yt-dlp user configuration,
external plugin directories, and remotely fetched components are disabled. Only
YouTube extractors are enabled; generic-site extraction is not permitted.

This version does not import browser cookies, download authenticated/private
videos, automatically subscribe to channel updates, or delete media removed from
YouTube. Extraction can fail because of rate limits or site changes; errors are
shown in the queue. Tool updates require a rebuilt image.
