# Playback delivery decisions

PosterView prefers the least processing that satisfies the selected tracks and
client capabilities. Processing here creates a temporary playback stream; it does
not replace originals or produce permanent optimized library versions.

| Delivery | When it is useful | Video | Audio |
| --- | --- | --- | --- |
| Direct Play | The original container, profile and selected track work in the browser | Original bytes | Original bytes |
| Direct Stream | Browser packaging or embedded audio selection needs a different stream | Copied | Copied |
| Audio-only transcoding | The selected audio is unsupported, including TrueHD, DTS or PCM | Copied | AAC stereo, 192 kbps |
| Video transcoding | The original video cannot decode, or a selected bitrate/resolution limit requires encoding | Encoded | Copied when supported, otherwise AAC |

Direct Stream is strictly lossless with respect to selected audio/video packets.
It cannot make an unsupported video decoder work. Audio-only conversion changes
the audio and does not retain lossless surround or Atmos metadata. Video encoding
is lossy; HLS packaging itself is not a quality reduction.

## Why Direct Play remains the default

Direct Play avoids a server producer, manifest preparation and client MSE setup.
Earlier measurements on The Apothecary Diaries S01E01 showed a live unbuffered
seek reaching playback in about 305 ms. An independent native-video test against
the same MKV over SMB reached its `playing` event in about 205 ms. Those tests used
different delivery servers and warmed caches; they are evidence that native
seeking can be fast, not a universal performance guarantee.

The earlier 26-second resume and 13-second seek observations also remain relevant.
An October 12, 2026 comparison in the same browser reproduced an approximately
35-second PosterView cold-resume stall near 11 minutes, while Emby resumed near
10 minutes in approximately one second. Both delivered the original HEVC/MKV.
These estimates use sampled media clocks, not instrumented first-frame events;
the target positions and warmed browser caches differed. Native skip/seek checks
completed in roughly 0.2 seconds. They motivated first-data seek initialization
and policy-authorized lossless recovery rather than unconditional video encoding.

A retest after deploying `b3ec79f` on October 12 still reproduced cold-resume
buffering beyond 12.8 seconds at about 10 minutes; Emby was playing by 3.1 seconds
at a similar position. A warm PosterView seek reached decoded data in about
285 ms, and the Emby seek check completed in about 238 ms. Startup appeared to
take about two seconds and one second respectively, inferred from advancing
media clocks. These are browser-tool observations with different cache histories,
not precise first-frame benchmarks.

The follow-up fixes two native seek assumptions: a full seekable range advertised
at metadata time does not establish decoded data, and a matching `currentTime`
with `readyState` below `HAVE_CURRENT_DATA` does not complete a seek. Resume now
waits for initial decoded data before assigning its target. Pending seeks retain
their recovery deadline until a frame exists, including when early `seeked` and
`timeupdate` events report the target. A late `loadeddata` event also settles a
paused seek. Regression tests cover those browser states; the follow-up still
requires deployment and another live Unraid comparison.

The next live retest showed native cold resume still stalling, with authorized
lossless recovery active and a browser-captured video frame by about 14 seconds.
Emby resumed in approximately one second inferred from its advancing clock.
PosterView's native forward skip was advancing at 268 ms; a distant backward
seek was advancing by the 6.3-second observation (about 0.4 seconds of delay
inferred from the clock). Different targets and cache histories limit comparison.

The user simultaneously observed black video with visible subtitles in the app
window and reported the same behavior in Chrome/Edge. Browser captures showed
decoded pictures at those positions, so captures and media-clock advancement
cannot establish that the physical display is healthy. This remains a live
validation limitation. The player now monitors video-frame presentation separately
from audio clock advancement, rearms it on seeks and source changes, and invokes
the existing permitted recovery when native video frames stop for eight seconds.
Paused, hidden and offscreen playback suspend that frame deadline. This catches
decoder/frame stalls; it cannot establish that a GPU/compositor displaying black
despite advancing presentation callbacks has recovered.

On October 13, the same 694 MiB HEVC Main 10/AAC episode was copied into an
isolated local test library. A plain native viewer and a minimal Video.js 10
player displayed the picture; lossless MP4 and fragmented-MP4 HLS baselines also
displayed video after seeking. Video.js was installed only in the temporary
comparison harness, not in PosterView. The full unmodified PosterView player
reproduced black video with ASS subtitles visible at the five-minute seek.
Disabling ASS restored the same paused frame without seeking or replacing its
source. Native window captures, rather than browser-only screenshots, exposed
this failure while decoding and media-clock advancement continued.

Video opacity, isolated compositing layers and an identity brightness filter did
not resolve the reproduced failure. A one-pixel rounded `clip-path` on the video
while its ASS canvas exists did: removing it reproduced black video, and restoring
it displayed video and subtitles at the same seek position. The rounded mask keeps
the video in the browser compositing path alongside the OffscreenCanvas overlay.
It does not alter delivery, decoding, stream packets or subtitle rendering; it
clips only the outermost video-element corners, usually within the letterbox.
This is a browser/GPU presentation workaround validated on the reproduced setup;
other GPUs, HDR sources and native TV clients require their own validation.
Startup, storage latency, source indexes, browser decoder behavior and background
tab scheduling can vary. Sending every compatible original through an encoder
would not address all of these causes and would add cost and quality loss.

Use Direct Stream to compare delivery on a particular client, to choose an audio
track that native browser APIs cannot identify, or when the original container is
unsupported. Use video transcoding for an actual compatibility or bandwidth need.
Server encode FPS measures production speed, not Direct Play decode speed. Direct
Play decoding happens on the client, and an unbuffered seek still needs bytes and
a decodable keyframe.

## Session and seek ownership

Direct playback keeps its authenticated range URL through native seeks. Segmented
playback has one logical session and generation-specific HLS URLs. A seek inside
retained produced segments reuses them. Repositioning the producer or changing
selected streams creates a new generation inside the same logical session.

The seek request supplies the expected generation. A stale generation returns
409 rather than replacing a newer producer. The client serializes requests and
coalesces rapid seek intent. UI and watch reports use the full source clock;
generation-relative media events cannot reset the displayed time to zero. Watch
sessions and completion sequencing remain separate from delivery generations.
Preparation reserves a unique generation, then performs probing and FFmpeg work
outside the session mutex. Stop and newer seeks cancel pending preparation. A
completed replacement rechecks session membership, account permissions, source
fingerprint and its reservation before publication. Existing delivery remains
available during preparation when the configured producer limit permits it.
At a one-producer limit, the old producer retires before replacement preparation.
Closing a session marks it closed and removes active membership before queued
operations can restart it. The cleanup worker also sweeps marked abandoned jobs
after canceled preparation expires, rechecking active membership before removing
each directory. Unrelated and other-instance directories are preserved by this
periodic sweep; preparing a new job separately retires recognized older-instance
jobs.
Extracted resources have a separate bounded sweep for unindexed generated files.
It skips active extraction and cached tracks, and retries files still locked by
Windows on a later cleanup tick.

HLS stream-copy boundaries follow source keyframes. Re-encoding may insert shorter
closed GOPs, which can improve segment latency at the cost of processing and
quality. No mode guarantees an instantaneous seek beyond downloaded media.

## Limits and compatibility

Administrator settings separately permit remuxing, audio encoding, video encoding
and automatic bandwidth adaptation. Existing stored settings retain their JSON
keys and explicit permissions. Hardware selection uses a small real encoder probe;
an installed encoder name alone is insufficient. An encoder probe does not prove
hardware decoding, HDR tone mapping or sustained real-file throughput.
Hardware validation uses independent per-encoder locks; one slow probe does not
block cached or unrelated encoder choices. Verified stream-copy seek points have
a bounded fingerprint-aware cache. Preparation polls readiness separately from
storage accounting, which runs on blocking workers at a bounded cadence and
again before publishing a ready stream.

Automatic bandwidth decisions use HLS fragment transfer evidence and sustained
buffering. They exclude startup, recent seeks, pauses and cached transfers. Native
Direct Play has no reliable throughput sample in the current browser API, so it
does not silently switch based on a brief native buffering event. Users can select
a lower playback bitrate explicitly when video transcoding is permitted.

PGS and VobSub are copied into bounded subtitle resources and rendered in a local
WASM canvas overlay. ASS retains its authored styling and fonts; text subtitles
use WebVTT. Subtitle selection does not require video encoding. Overlays may not
appear in the browser's picture-in-picture window.

FFmpeg commands remain server-authored and operate on resolved, validated library
sources. Job limits, timeouts, generation validation and private temporary folders
bound work. The media root is never a cleanup target. Resource extraction can
time out on very large or slow sources and reports that failure explicitly.

## Runtime comparison and verification

The restored pipeline was checked with isolated, local synthetic media on Windows
and the production Linux image. The Linux image uses its packaged FFmpeg 5.1;
it was run with a read-only media mount and no exposed GPU. These are warm local
API preparation measurements, not end-to-end Unraid playback benchmarks:

| Mode | Linux session preparation | Windows session preparation |
| --- | --- | --- |
| Direct Play, H.264/AAC MP4 | 89 ms | 32 ms |
| Direct Stream, copied H.264/AAC | 677 ms | 2,137 ms |
| Software H.264 at a selected 1.5 Mbps budget | 1,063 ms | 2,001 ms |
| TrueHD to AAC with copied video | 759 ms | 3,284 ms |
| DTS to AAC with copied video | 1,076 ms | 5,127 ms |
| PCM to AAC with copied video | 1,097 ms | 4,078 ms |

Browser checks kept the original Direct Play URL across buffered and unbuffered
seeks. A local unbuffered seek was observed playing again within about 229 ms of
the UI action; that includes tool timing and is not a precise seek-event trace.
Retained HLS seeks kept the attached source and full source clock. Cold Windows
HLS seeks that needed a new producer took about 2.0–3.3 seconds for the 90-second
fixture. Source keyframes, OS/filesystem behavior and producer analysis matter;
HLS is therefore a compatibility/quality tool, not a universal latency fix.

Video packet hashes matched the originals for sampled stream-copy and audio-only
output (96 H.264 or 168 HEVC packets). AAC output was inspected for generated
TrueHD, DTS-core and PCM inputs. Synthetic PGS and a public-domain VobSub fixture
rendered in browser canvas overlays during original playback; bitmap resources
also returned authenticated range responses in both runtimes. Linux read-ahead
was observed sending SIGSTOP/SIGCONT, stale generations returned 409, and stopping
sessions removed owned temporary directories and FFmpeg processes.

A High10 H.264 source with six-channel AAC verified the video-only fallback:
the video encoded to browser-compatible H.264 while 83 sampled AAC packets stayed
identical and retained all six channels. The production browser build played it
to completion without a media error. When source video cannot be copied, the
client proves each audio profile against every advertised encoded-video output;
it does not infer audio-copy support from the rejected source-video profile.

Final checks passed 442 frontend tests, the frontend production build, the full
Rust workspace serially, Clippy with warnings denied, and production Docker
build/runtime checks. The requested default parallel Rust command still hit the
two recorded library-monitor timeout failures (`manual_scan_nfo_writes_do_not_restart_monitor_scans`
and `monitoring_scans_new_files_and_can_be_disabled`). Those passed in the serial
workspace run. A new playback test's ENDLIST-versus-process-exit timing assumption
was corrected to wait for actual producer-slot release before asserting it.

Real Unraid GPU encoding, large NAS files, real DTS-HD/TrueHD sources and long bitmap
tracks still need live validation. Audio-only output is stereo AAC, not lossless
passthrough. Bitmap extraction currently scans the complete source before serving
the cached track, with a 45-second timeout and 128 MiB resource limit; particularly
large or slow sources can fail that bounded extraction. Native Direct Play does
not automatically adapt bandwidth, and seeking outside retained HLS data still
prepares a new producer.

References: [Emby delivery modes](https://emby.media/support/articles/DirectPlay-Stream-Transcoding.html),
[Plex Direct Play and Direct Stream](https://support.plex.tv/articles/200250387-streaming-media-direct-play-and-direct-stream/),
[FFmpeg HLS muxer](https://ffmpeg.org/ffmpeg-formats.html#hls-2), and
[libbitsub renderer](https://github.com/altqx/libbitsub).

## Cold resumes and copied-stream seeks

Lossless producers may prepare up to 60 seconds while paused, capped by the
speed-adjusted administrator buffer limit and existing disk accounting. They
refill below half that lead after confirmed seeks. Conversion jobs retain the
12-second paused threshold. This lets a warmed 30-second skip reuse buffered media
instead of launching another producer. Browser remux delivery targets 60 seconds
when bitrate is unknown; known-bitrate sizing retains its existing formula.
The hls.js 48 MiB setting is a buffer target, not a strict memory cap, so buffering
unknown high-bitrate sources can use more memory. Video/audio codecs and packet
copying are unchanged.

A local browser check on the same HEVC/AAC/ASS episode buffered roughly 61 seconds
ahead while paused. A subsequent 30-second skip was ready and advancing within
205 ms of the UI action, preserving its blob URL. This verifies the buffered
client path; Unix producer suspension and refill policy are covered by tests,
and the updated Unraid image still needs live validation. Large jumps outside
retained media continue to incur keyframe inspection and producer startup.

Auto starts cold HEVC playback in Matroska with stream copying, including Play
at zero and nonzero Resume, when the administrator permits remuxing and the
browser supports copying both selected
tracks. The response must actually be a remux. Native time-zero movie startup
was observed stalling before metadata/frames and triggering recovery, while a
second attempt played. This extends the existing cold-resume safeguard to avoid
that native startup path without encoding either track. Warm native seeks, other
compatible formats and explicit Original mode retain direct delivery behavior.
Native initialization has a bounded recovery deadline even before decoded data
arrives.

Only buffered HLS targets qualify for local seeks. Unbuffered targets go through
the seek API, which can retain the existing producer or prepare another generation.
For a retained source, the HLS engine reloads at the target and can reapply it when
MSE duration grows. While a seek is pending, maintenance heartbeats use the last
confirmed position; watch reports preserve the user's requested position. New
generations start maintenance at their own offset, including backward seeks.
Unfinished HLS seeks retry once after 15 seconds, then offer an explicit error
instead of buffering indefinitely.

The exact 22:50 HEVC Main 10/AAC/ASS episode used for the Unraid report was retested
against the updated production frontend and an isolated Windows server. Auto
resumed directly into copied delivery without native fallback. The previously
stalled 30-second copied-stream skip completed, as did distant backward and
forward seeks; a forward seek to 15:00 was advancing at the first 5.8-second check.
Original forward and backward skips were ready and advancing within 234 ms and
204 ms of the UI actions, retaining the same media URL. Browser captures showed
picture and ASS subtitles. These local checks are not measurements of the updated
Unraid image or proof of the physical display on every GPU.
