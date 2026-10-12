# Native video playback

PosterView plays movies and episodes from native libraries. The server resolves
files from the catalog; clients never submit filesystem paths or FFmpeg commands.
Connected Plex, Emby and Jellyfin libraries continue to provide artwork and
metadata browsing. They are not used as native playback sources.

## Start watching

Open a movie or episode and choose **Play** or **Resume**. Series and season pages
start the first unwatched available episode, or resume an in-progress episode. The player
supports audio/subtitle selection, quality, speed, chapters, fullscreen, picture
in picture when supported, and Up Next. Space/K toggles playback, left/right
arrows skip, F toggles fullscreen, and M toggles mute. Controls remain visible
while paused or using a menu and hide during uninterrupted playback.

Settings → Playback controls preferred languages, remembered tracks, subtitles,
skip lengths, resume rewind, automatic next episode, and the inactivity prompt.
Plain text subtitles support color, shadow, background and top/bottom placement.
Automatic placement keeps the track's cue positions. ASS/SSA and burned-in
subtitles keep their embedded or server-rendered appearance.
Library settings → Advanced → Playback controls minimum/maximum resume
percentages and minimum resumable **video duration**, not time spent watching.

Watch state is stored in `watch.sqlite` in application data, separate from NFOs
and metadata. It is scoped to the configured signed-in administrator identity.
This does not introduce multiple user accounts. Active sessions use monotonic
report sequences; newer sessions and manual watched changes supersede older
reports. Seeking alone does not count as watching. Metadata scans preserve state.
Seeking near the completion threshold or remaining paused there does not mark a
title watched; completion requires actual playback progress. Initialization
retries establish watch tracking before starting video, and changing episodes
stops the previous source while the next episode loads.

## Playback decisions

Original-file playback is the default. **Allow media conversion** in Settings →
Transcoding is off for new installations and older settings that do not contain
this option. Existing hardware/encoder choices are preserved and apply after
conversion is explicitly enabled. The playback mode applies to new sessions.

The browser reports codec/container capabilities. Compatible MKV, MP4/M4V/MOV
and WebM files use the original file through authenticated HTTP range requests,
so seeking does not create another FFmpeg session or require downloading the
whole video. Multiple audio tracks do not prevent playback of the default track.
Other audio tracks can be selected directly when the browser exposes native
tracks and their identities can be matched to the file. Without native track
selection, a saved alternate-audio preference falls back to the file's default
with an explanation. A contradictory or unidentifiable requested native track
stops playback rather than reporting the wrong language. Unsupported files
produce an explanation without automatic audio/video conversion.

When conversion is explicitly enabled, the server chooses remuxing when a
container or selected track requires it, audio conversion when only audio is
incompatible, and video conversion for unsupported profiles, lower quality or
subtitle burn-in. The original media file remains untouched in either mode.
Converted sessions use segmented HLS, with encoding ahead limited by the
configured buffer. Consumed segments are retired after a
one-minute safety window; the served playlist advertises the retained segments.
Seeking inside buffered or retained HLS segments reuses the current stream.
Seeking outside that window starts a new conversion session at the requested
source position. The timeline keeps the requested position while the new source
loads; reset-clock events cannot move it back to the beginning or overwrite
watch progress. Paused playback stays paused after seeking.
Play, pause and local seeks notify the producer immediately, rather than waiting
for the periodic heartbeat. A paused seek stops showing buffering once its
preview is ready. Copied-video playback targets a longer browser buffer when the
source bitrate fits its buffer budget; unknown or high bitrates use a smaller
target. A short forward seek checks a fresh live playlist before replacing a
stream whose cached playlist may lag behind the available segments.
Video conversion produces two-second segments/keyframes for quicker startup;
stream-copy segments still depend on the original video's keyframes.
On Linux, throttled stream-copy and audio-only conversion can read up to eight
times source speed to fill that buffer, while video encoding stays at four.
The configured encode-ahead, disk and concurrency limits continue to apply.
Converted video uses an encoder supported by both the browser and server
settings. Compatible audio is preserved unless conversion/downmixing or the
requested bitrate budget requires otherwise. Audio boost applies only when
downmixing multichannel audio. Missing container duration falls back to probed
audio/video stream duration; an unknown duration is not treated as a short video.
When source bitrate is unknown, a requested bitrate limit still triggers
conversion unless the file size and duration establish that the source fits.

ASS/SSA subtitles use a local WebAssembly renderer and embedded fonts. Plain text
subtitles are converted to WebVTT. Source timestamps remain authoritative after
seeking and transcoding. Burn-in is offered where conversion is enabled and the
server can render the selected subtitle format. Metadata inspection, subtitle
extraction and embedded font preparation remain available for original playback;
they do not encode the video or audio. With conversion enabled, unsupported
playback has a bounded fallback rather than an infinite retry loop.

## Transcoding and Unraid

Settings → Transcoding controls the conversion opt-in, hardware encoding, codecs,
output size, CPU fallback, concurrency, disk limits, throttling and subtitle/font
extraction.
**Test hardware encoders** runs small real encodes inside the server container.
An encoder appearing in FFmpeg's list does not establish that the GPU is usable.
Tests are cached for five minutes. Full source profiles and filtering can have
additional requirements. Hardware encoding does not guarantee hardware decoding
or GPU tone mapping; CPU filters may still be used.
Playback validates only the encoder candidates needed for its selected codec
and backend, stopping once one works. The explicit hardware test still reports
all supported candidates. Episode lookup is scoped to its series rather than
loading the entire library for each playback/subtitle/font request.

For Intel Quick Sync/VA-API, enable the integrated GPU in the host BIOS, make
`/dev/dri` available in Unraid, and add a device mapping `/dev/dri:/dev/dri` to
the container. Intel userspace drivers are included. The entrypoint adds only
the groups belonging to mapped GPU character devices when dropping privileges;
it does not change device or media ownership.

For NVIDIA, install Unraid's NVIDIA driver integration and expose the selected
GPU through the NVIDIA container runtime. `NVIDIA_VISIBLE_DEVICES` selects the
GPU and `NVIDIA_DRIVER_CAPABILITIES=video,utility,compute` exposes the required
libraries. Choose NVIDIA NVENC and run the encoder test. Never assume a GPU
supports AV1 encoding based on AV1 decoding support.

The default temporary location is in application data. For sustained use, map
an SSD-backed host directory to `/transcode` and set the temporary path to
`/transcode` in Transcoding settings. Keep it separate from media. The entrypoint
does not treat `/transcode` as a library media mount. Ensure the configured PUID
and PGID can write to the folder. A session limit prevents unbounded FFmpeg jobs;
idle sessions are stopped and owned temporary files are cleaned up.

GPU device access and performance must be tested on the actual Unraid server.
Software fallback can preserve playback but may be too slow for demanding 4K
sources. HDR conversion requires supported tone-mapping filters; errors are
reported rather than silently treating HDR frames as SDR.

## Current boundaries

There is no casting integration or automatic intro detection in this release.
The player does not display fake controls for those features. Embedded chapter
markers are supported. Large-file throughput, hardware conversion and browser
codec support depend on the client, storage, network and container configuration.
Test remote playback behind the same authenticated reverse proxy used for the
rest of PosterView. Playlists, segments, subtitles and fonts require the existing
server authentication.

## Engineering references

- [FFmpeg stream copy and seeking](https://ffmpeg.org/ffmpeg.html)
- [FFmpeg HLS muxer](https://ffmpeg.org/ffmpeg-formats.html)
- [HTTP range requests](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Range_requests)
- [Browser Media Capabilities API](https://developer.mozilla.org/en-US/docs/Web/API/Media_Capabilities_API)
- [hls.js](https://github.com/video-dev/hls.js)
- [JASSUB](https://github.com/ThaUnknown/jassub)

The interface was designed from REA observations of Emby's browser player and
preferences. PosterView implements its own server rules and controls; browser
evidence did not establish Emby's internal database or server algorithms.
