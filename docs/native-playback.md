# Native video playback

PosterView plays movies and episodes from native libraries by serving their original
files. It does not transcode, remux, burn subtitles, downmix audio, reduce resolution
or adapt bitrate. Connected Plex, Emby and Jellyfin libraries remain artwork and
metadata sources; their playback engines are not used for native library playback.

## Start watching

Open a movie or episode and choose **Play** or **Resume**. Series and season pages
choose an available in-progress or unwatched episode. The player supports native
audio selection, browser-rendered text subtitles, speed, chapters, fullscreen,
picture in picture when supported, and Up Next. Space/K toggles playback,
left/right arrows skip, F toggles fullscreen, and M toggles mute. Controls remain
visible while paused or using a menu and hide during uninterrupted playback.

Settings → Playback controls preferred languages, remembered tracks, subtitles,
skip lengths, resume rewind, automatic next episode and the inactivity prompt.
Old Transcoding-page links redirect to Playback. No conversion or hardware-encoder
settings are available.

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
can be selected only when the browser exposes them and their identities can be
matched reliably to the file. Unsupported or unidentifiable choices are disabled.
TrueHD, DTS/DTS-HD and PCM/LPCM are currently unsupported by this player;
there is no audio conversion fallback. Unsupported containers or video profiles
produce a clear direct-play error instead of silently changing the media.

## Subtitles and metadata

ASS/SSA subtitles use a local WebAssembly renderer with embedded fonts. Other
supported text subtitle tracks are prepared as WebVTT. Color, shadow, background
and placement preferences apply to plain text; ASS/SSA retains its authored styling.
Subtitle selection and Off preserve the original audio/video stream and watch session.
Picture in picture may omit browser-rendered styled subtitles.

PGS and VobSub/DVD are bitmap subtitle formats. The current browser renderer does
not support them, and subtitle burn-in has been removed. Those choices are disabled.

FFmpeg/ffprobe remain installed for metadata, bounded text-subtitle/font extraction,
and existing book/artwork capture features. These operations do not re-encode the
playback video or audio. Subtitle/font resources cache by source fingerprint and
track, with entry-count, size and LRU limits. Playback never starts an audio/video encoder,
HLS producer or stream-copy process.

## Watch tracking

Watch state is stored in `watch.sqlite` under application data, separately from NFOs
and catalog metadata, and scoped to the configured administrator identity. This
does not add multiple accounts. Active sessions use monotonic report sequences;
newer sessions and manual watched changes supersede older reports. Metadata scans
preserve watch state.

Library settings → Advanced → Playback controls minimum/maximum resume percentages
and minimum resumable **video duration**, not time spent watching. Seeking alone
does not count as watching. Seeking or staying paused near completion does not mark
an item watched; completion requires new actual playback progress. Initialization
establishes watch tracking before playing, and changing episodes stops the old source.

## Unraid and upgrades

Direct playback requires the server to read the original files and sufficient network
bandwidth for their bitrate. Hardware decoding, when available, happens on the client.
PosterView needs no server GPU mapping, NVIDIA runtime or hardware encoder drivers.
Application-data, media mounts, PUID, PGID and UMASK keep their existing behavior.

Existing conversion settings are retained in the database but ignored. Existing
generated HLS files are not served or reused; application data and original media
are not rewritten or deleted during this change. No playback temporary mount is
required. Legacy `/transcode` mounts remain excluded from automatic media-root
discovery so an old container configuration does not become an extra library root.

Existing native playback and watch URLs retain their purpose. Legacy conversion
request fields are decoded for compatibility, but requests that ask for encoding,
remuxing, quality/bitrate changes, encoder selection or burn-in fail explicitly.
The retired settings, hardware-capability and HLS endpoints return not found.
