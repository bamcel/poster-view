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
6. For automatic imports, open **Subscriptions**, add a channel or playlist URL,
   and choose its days/time/timezone. A channel subscription discovers its public
   playlists automatically; individual playlist subscriptions are optional.

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

Video cards display the NFO title and sort by upload date, newest first, in both
playlists and All Videos. Undated videos come last; equal-time ties use titles.
Exact publication time is used when available; older NFOs fall back to the upload
date. Original playlist positions remain stored in NFO metadata.

The popup offers five filename conventions: Video ID, Title only, Upload date +
Title, Title + video ID, and Upload date + title + video ID. The YouTube ID stays
in the NFO for every convention, including filenames without an ID. New configurations default to date + title + ID;
older saved settings and queued jobs retain ID-only naming until changed. Date
prefixes sort chronologically in file browsers; choose descending name order for
newest-first filesystem listings. Filename settings do not control app ordering.
Existing media is preserved and reused, including its original filenames.

Folder paths keep stable channel/video IDs; filenames and matching sidecars may
be readable:

```text
<download-directory>/channels/<channel-id>/
  tvshow.nfo
  <video-id>/
    2026-01-02 - Example video [<video-id>].mp4
    2026-01-02 - Example video [<video-id>].nfo
    2026-01-02 - Example video [<video-id>].jpg
    2026-01-02 - Example video [<video-id>].<language>.vtt
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
videos, or delete media removed from YouTube. Extraction can fail because of rate limits or site changes; errors are
shown in the queue. Tool updates require a rebuilt image.

Newly downloaded videos have their filesystem Date modified set to the YouTube
upload timestamp, falling back to midnight UTC on the upload date. If neither is
available, the filesystem timestamp is retained. This applies after remuxing or
conversion; existing videos and sidecar timestamps are preserved.

## Scheduled subscriptions

In the plugin popup's **Subscriptions** tab, save a channel or playlist URL,
select weekdays and a local check time, and choose an IANA timezone (for example,
`America/Los_Angeles`). A Wednesday-only 09:00 schedule checks weekly; selecting
Monday, Wednesday, and Friday at 16:00 checks on each of those days. Selecting all
seven weekdays checks daily. Each link has its own schedule.

Checks use the currently saved plugin download configuration. The first check
queues every available video not already downloaded; later checks queue newly
available videos and retry missing downloads. Already queued videos are skipped.
Channel subscriptions discover the channel's public playlists, check each playlist,
and save its grouping automatically. They also check the Videos tab for uploads
outside playlists. Videos shared by playlists keep one media file with multiple
NFO memberships. Existing downloads gain missing playlist groups without being
downloaded again. Newly discovered playlists are included on later checks. Playlist
subscriptions retain their playlist membership metadata. Downloads continue through the existing
serial queue, including normal NFO creation and library import.

Schedules and check status persist across restarts. The plugin must be enabled
for automatic checks. Administrators can edit, pause, delete, or **Check now**, and
see last/next check times and extraction errors. Subscription management and manual
checks use the same administrator-only access as downloads.

An overdue check runs once after restart rather than replaying every missed
occurrence. During daylight saving transitions, nonexistent local times are
skipped; repeated local times run once at their first occurrence.

Each source inspection considers up to 10,000 entries. Channel subscriptions
include public playlists and the Videos tab. Private or inaccessible playlists
cannot be discovered; source errors appear in the subscription status.

Each channel check inspects up to 1,000 playlists within a 15-minute budget. When
either limit is reached, the next check resumes after the last inspected
playlist. Completed sources are queued and the subscription reports the partial
check, including inaccessible playlists, rather than discarding successful work.
