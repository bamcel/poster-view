# YouTube libraries and YTDL

Administrators configure YTDL in **Settings → Plugins → YTDL**. The plugin
downloads public YouTube videos and playlists with yt-dlp, writes local NFO
metadata and thumbnails. It works without a configured media library. Existing
YouTube libraries whose folders contain the download directory are refreshed
after completion. Browsing, playback, resume, and watch history use normal library access
permissions. Non-administrators cannot configure, inspect, queue, cancel, or retry
downloads through the API.

## Setup

1. In the plugin popup, select a writable existing directory under the media mount
   using **Download directory**, enable YTDL, choose formats and metadata options,
   and **Save configuration**. Docker/Unraid paths are container paths.
2. To browse downloaded files in PosterView, create a **YouTube** library separately
   in **Settings → Libraries** and select the download folder (or a parent folder).
3. Configure **Single channel** (playlists → videos) or **Multiple channels**
   (channels → playlists → videos) and optional channel filters in Library settings.
   These settings control library display and do not restrict plugin downloads.
4. A library can be added after downloading; scan it to import the existing NFOs.
5. Paste a video or playlist URL into Downloads, **Fetch Info**, select videos,
   and queue the download. A channel URL opens its playlists; choose **Open
   playlist** before selecting videos. Standalone videos appear under All Videos.
6. For automatic imports, open **Subscriptions**, add a channel or playlist URL,
   and choose its days/time/timezone. A channel subscription discovers its public
   playlists automatically; individual playlist subscriptions are optional.

## Formats and jobs

Quality offers Highest Available, 2160, 1080, 720, or 480. A numbered choice
requests that source resolution. If unavailable, select Highest Available,
Next highest (nearest larger resolution), Next lowest (nearest smaller
resolution), or Skip. If no resolution exists in the requested direction, the
video is skipped and the rest of the job continues. Frame rate remains an upper
bound. Quality selection never upscales the source. Older saved settings retain
their previous maximum-resolution behavior until Quality or its fallback changes.
Codec preferences select available source streams without encoding unless
**Convert to selected codecs** is enabled. Quality fallbacks respect the selected
codecs, container, and frame-rate limit. WebM requires VP9/AV1 and Opus; use MP4/MKV for
H.264, HEVC/H.265, or AAC. HEVC conversion uses FFmpeg libx265; enable
**Convert to selected codecs** to encode to HEVC when no matching source exists.
Conversion runs FFmpeg in staging before publishing a final file.

With conversion enabled, **Encoding device** selects CPU, NVIDIA NVENC, Intel
Quick Sync, or VA-API. GPU conversion requires an explicit H.264, HEVC, or AV1
codec; Automatic and VP9 use CPU. **Test hardware encoders** performs real short
encodes to check codec support and container access. GPU jobs validate the chosen
encoder before downloading and fail with setup guidance if it is unavailable;
they do not silently switch to CPU. CPU uses CRF, while GPU quality uses the
backend's constant-quality control; all default to 23, but their quality scales
are not equivalent.

For Intel Quick Sync or VA-API on Unraid, expose `/dev/dri` to the PosterView
container. VA-API uses `/dev/dri/renderD128`; ensure that render node belongs to
the intended GPU. The image includes Intel media drivers. NVIDIA requires the
Unraid NVIDIA driver and NVIDIA container runtime, an exposed GPU, and the
`video` driver capability (usually `NVIDIA_DRIVER_CAPABILITIES=compute,video,utility`).
Container access changes take effect after a container recreation; let active
downloads finish before applying them. NVIDIA RTX 3050 supports H.264/HEVC
encoding, while supported codecs always depend on the GPU and FFmpeg build.

The queue runs one job at a time and persists job settings, status, progress,
speed, ETA, and errors. Each job keeps the settings used when it was submitted.
Cancel stops work; retry is available once the process has stopped. A server
restart marks active jobs Interrupted and leaves queued jobs queued. Retry is
explicit; staging for interrupted work is not guaranteed resumable.

The queue, settings sidebar, and settings dashboard show playlist counts and
overall progress. During conversion they also show the current video's encoding
percentage, encoded time, frame rate, speed, and estimated remaining encoding
time. If duration is unavailable, live encoder activity is shown without an
estimated percentage. Minimize closes the popup without stopping work.
Removing a queue card stops that job without deleting downloaded files. Finished
job history expires after seven days; queued and active jobs are retained.

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

New channel/video folders use sanitized channel names and video titles. Stable
IDs remain in NFO metadata and identify existing downloads even after titles
change. Existing ID-based folders are reused without moving files. Different
channels or videos with identical names receive a numeric folder suffix such as
` (2)`; filename convention remains a separate setting:

```text
<download-directory>/channels/<channel-name>/
  tvshow.nfo
  <video-title>/
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
