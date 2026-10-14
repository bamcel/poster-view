# Native video playback

PosterView prefers original files for movies and episodes in native libraries.
Optional Direct Stream and transcoding create temporary playback streams when
packaging, selected tracks, browser compatibility or quality limits require them.
Original library files remain unchanged. Connected Plex, Emby and Jellyfin libraries remain artwork and
metadata sources; their playback engines are not used for native library playback.

## Start watching

Open a movie or episode and choose **Play** or **Resume**. Series and season pages
choose an available in-progress or unwatched episode. The player supports multiple
audio selections, browser-rendered text and bitmap subtitles, speed, chapters, fullscreen,
picture in picture when supported, and Up Next. Space/K toggles playback,
left/right arrows skip, F toggles fullscreen, and M toggles mute. Controls remain
visible while paused or using a menu and hide during uninterrupted playback.

Settings → Playback controls preferred languages, remembered tracks, subtitles,
skip lengths, resume rewind, automatic next episode and the inactivity prompt.
Settings → Transcoding separately permits lossless remuxing, audio-only encoding,
video encoding and automatic bandwidth adaptation. Hardware and temporary storage
limits apply to segmented playback. Old saved permission keys remain compatible.

FFmpeg producers use separate server-wide limits: eight Direct Stream/audio-only
jobs and two video transcodes by default. Each account can hold at most five jobs
across both types. Original playback uses no producer slot. These limits are
editable in Settings → Transcoding. Existing `max_concurrent` settings now control
video transcodes; saved configurations gain the new stream and user defaults.
Paused jobs retain their reservations until stopped or finished. Track changes
and seeks release the current producer first when a replacement cannot fit.

## Browser compatibility and delivery

The browser must decode the original container, video profile and selected audio.
Compatible MKV, MP4/M4V/MOV and WebM sources use authenticated HTTP byte-range
delivery. The server resolves catalog paths and verifies that each file remains
inside the configured media root and library. Clients cannot submit filesystem
paths or FFmpeg commands.

Startup, resume and seeks share the original source clock. Seeking changes the
browser's current position without preparing another server media job or changing
the stream URL. Pause stays paused after seeking. Byte ranges avoid requiring a
whole-file download, but a browser can still read ahead when seeking inside some
MKV files. Native seek performance depends on the browser and the source's index
and keyframes; a supported codec does not guarantee instant seeking.

Video and audio responses are never HTTP-compressed, including full-file responses.
Their original bytes, length and byte-range headers remain intact. JSON and frontend
assets retain ordinary compression. Media stays private and is not persistently
cached by the browser; metadata probes cache against file size and modification time.

Several audio tracks do not prevent playback of the default track. Other tracks
use reliable native selection where available, otherwise authorized Direct Stream
selects and copies the requested track. Unsupported selected audio, including
Dolby TrueHD (also called TrueHD), DTS-HD Master Audio/DTS and PCM/LPCM, can use
AAC stereo at 192 kbps when audio encoding is permitted. This changes audio quality
and does not preserve lossless surround
or Atmos metadata; video is copied when compatible. Unsupported video can use an
authorized video encoder. With these permissions disabled, the player explains
compatibility limits.

FLAC is copied losslessly when the browser supports the selected delivery format.
Direct Stream enables FFmpeg's FLAC-in-fragmented-MP4 compatibility option for
older FFmpeg versions, retaining the original channels and bit depth. If the
browser cannot decode FLAC, the same permitted audio-only AAC fallback applies.

## Subtitles and metadata

ASS/SSA subtitles use a local WebAssembly renderer with embedded fonts. Other
supported text subtitle tracks are prepared as WebVTT. Color, shadow, background
and placement preferences apply to plain text; ASS/SSA retains its authored styling.
Subtitle selection and Off preserve the original audio/video stream and watch session.
Picture in picture may omit browser-rendered styled subtitles.

PGS and VobSub/DVD use the local libbitsub WASM renderer and a canvas overlay.
Their copied .sup/.mks resources retain timestamps and DVD palettes. Subtitles do
not require video burn-in. Other unknown bitmap formats remain unavailable.

FFmpeg/ffprobe are installed for metadata, bounded subtitle/font extraction,
and existing book/artwork capture features. These operations do not re-encode the
playback video or audio. Subtitle/font resources cache by source fingerprint and
track, with entry-count, size and LRU limits. Playback jobs run only for permitted selected modes, with concurrency, temporary
storage and idle-session limits. Very large or slow subtitle extraction can time
out and reports that failure.

## Watch tracking

Watch state is stored in `watch.sqlite` under application data, separately from NFOs
and catalog metadata, and scoped to each immutable account identity. History and
resume progress are private to that account. Active sessions use monotonic report sequences;
newer sessions and manual watched changes supersede older reports. Metadata scans
preserve watch state.

Library settings → Advanced → Playback controls minimum/maximum resume percentages
and minimum resumable **video duration**, not time spent watching. Seeking alone
does not count as watching. Seeking or staying paused near completion does not mark
an item watched; completion requires new actual playback progress. Initialization
establishes watch tracking before playing, and changing episodes stops the old source.

## Playback modes, seeking and quality

Auto prefers Direct Play. Original requires compatible direct playback. Direct
Stream copies selected video and audio without encoding. Explicit lower bitrate
choices encode video only when permitted; HLS packaging itself does not reduce
quality. The player reports the actual delivery mode and codecs.

Resuming an original file waits for its initial media data or a usable seek range
before applying a nonzero position. Auto can recover a stalled native seek through
lossless Direct Stream when remuxing and the exact copied tracks are supported.
This recovery does not permit video or audio encoding. Original mode keeps the
original file and offers a recovery action at the requested position instead.
Exiting saves final progress before stopping delivery; immediate reopening waits
for that save before creating a new watch token.

HLS seeks within retained available segments use the current stream. Beyond that
range the server repositions a keyframe-aligned producer inside the same logical
session, preserving the full episode timeline and watch token. That can still
require a short wait for network, muxing or decoding. Transcoding cannot guarantee
seamless unbuffered seeks and may be slower than a compatible original.

Automatic bandwidth adaptation applies to HLS with reliable transfer evidence and
sustained stalls. It excludes startup, recent seeks and cached transfers. Direct
Play has no reliable throughput sample here, so native buffering alone does not
silently trigger video encoding. Select a lower bitrate explicitly when needed.

## Unraid and upgrades

Direct playback requires readable media and network bandwidth for its bitrate.
Client hardware decodes Direct Play; server GPU encoding is optional. PUID, PGID,
UMASK, application-data and media mounts retain existing behavior.

For Intel Quick Sync or VA-API, map `/dev/dri` into the container. The image includes
Intel media drivers and preserves mapped render-device group access after dropping
privileges. For NVIDIA, install the Unraid NVIDIA driver plugin, use the NVIDIA
container runtime and expose the intended GPU. Use **Test hardware encoders** to
verify actual access. AVC is the default compatibility encoder; HEVC and AV1 require
both enabled server encoders and browser support. GPU decode support does not
imply support for encoding the same format; encoder availability is checked at runtime.

Temporary streams live in a private server-owned cache or configured absolute
path; an SSD-backed mapped directory can help. Existing permission JSON is reused.
Original media is preserved. Cleanup targets only recognized, marked temporary
playback jobs and bounded extracted resources; unrelated folders are preserved.
Legacy `/transcode` mounts remain excluded from media-root discovery.

See [playback decisions](playback-design.md) for implementation ownership, tradeoffs
and measured Direct Play limits.
