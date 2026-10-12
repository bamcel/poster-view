# PosterView developer guide

PosterView combines native media libraries and artwork management for connected
Plex, Emby and Jellyfin servers. Rust/Axum and SQLite provide the server;
React/Vite/TypeScript/Tailwind provide the frontend. One Docker image serves both.
Read `AGENTS.md` and relevant scoped instructions before changing ownership.

## Commands

```sh
# Repository root
cargo run --package posterview-server
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings

# frontend/
npm run dev
npm test
npm run build
```

The server defaults to 7979; Vite uses 5173 and proxies `/api` to the server. The
workspace minimum Rust version and Docker/CI toolchain are 1.88. Newer Clippy
versions may diagnose existing code differently; record the toolchain used.
When the host defaults to another toolchain, run the Cargo commands through
`rustup run 1.88.0 cargo` for CI-aligned verification.
FFmpeg/ffprobe enable media fixtures. Live provider verification needs explicitly
supplied credentials and is opt-in. Install dependencies with `npm ci` and use the
committed Cargo/npm lockfiles. Build/deployment configuration is unchanged.

Use focused checks while editing, then the full commands above. On Windows,
serialize Cargo tests/builds sharing `target/`: running executables cannot be
relinked. If monitor tests time out during parallel media processing, compare
`cargo test --workspace --locked -- --test-threads=1` and report both outcomes.
Do not hide baseline failures or waive regressions.

## Rust module map

| Boundary | Responsibility |
| --- | --- |
| `posterview-contracts` | Shared normalized API and native library/catalog models |
| `posterview-infra-media-servers` | Plex/Emby/Jellyfin normalization and remote operations |
| `posterview-infra-artwork` | Artwork provider clients, authentication/search/downloads |
| `posterview-infra-sqlite` | Main database, encrypted secrets, native catalog and migrations |
| `posterview-url-security` | Media-server/provider URL trust policy |
| `posterview-runtime` | Host-independent orchestration, artwork operations and cache |
| `apps/server/src/lib.rs` | Public facade, SPA/middleware composition, worker startup |
| `apps/server/src/state.rs` | Shared state constructor and backdrop refresh helper |
| `apps/server/src/routes/` | System/auth, connected-server and artwork HTTP adapters; legacy registry |
| `apps/server/src/playback/` | Native playback and feature route registration |

`playback/models.rs` holds wire models; `planner.rs` makes capability/quality
choices; `hardware.rs` probes/selects encoders; `manifest.rs` owns HLS retention.
`mod.rs` remains the delivery/session/resource facade. Planner/manifest tests are
adjacent; `tests.rs` covers cross-boundary streaming and process behavior.

Native CRUD/scan coordination remains in `native.rs`. Discovery/probing,
monitoring, missing items, identification, providers and artwork already have
separate `native_*.rs` modules. `google_books.rs`, `reader.rs`, `metadata.rs`,
`watch.rs`, `transcoding.rs` and `scheduled_tasks.rs` keep their feature interfaces.
Shared fixtures now come from `test_support.rs`, not native scan tests. Feature
routers return `Router<AppState>`; central composition applies authentication
once. Preserve explicit public and compatibility registrations.

Existing crates already supply the necessary dependency boundaries. No new crate
was added. Further extraction should identify a reusable interface or concrete
ownership/dependency problem first.

## Frontend module map

```text
src/
  App.tsx, main.tsx          routing and bootstrap
  api/                      shared transport and existing catalog/server clients
  features/
    playback/
      PlayerPage.tsx, .css   player entry point and layout
      types.ts              canonical playback/watch contracts and defaults
      api/                  delivery and watch/preferences/rules clients
      components/           Play/Resume, Continue Watching, preferences/rules
      lib/                  capability and track-selection helpers
    settings/
      appearance/           appearance/theme controls
      providers/            credentials and default artwork provider forms
      formStyles.ts         shared settings input styling
  pages/                    remaining route composition and pages
  components/, lib/         reused UI/utilities and remaining catalog/reader/auth
```

Playback tests moved with their code. Wire definitions and watch endpoints have
one implementation each. Both feature API clients use `apiRequest`; the player
uses the watch client for watch operations. Media/WASM dependencies stay lazy-loaded.
API modules re-export their types for existing consumers; definitions live in
`features/playback/types.ts`.

Player seeks use source time consistently across direct and converted streams.
Reuse individual buffered/retained HLS ranges before allocating another job;
outside-range seeks retain the requested timeline position through restart.
Session generations and pending-seek guards prevent reset-clock events from
rewinding the UI or watch state. Server lookup stays scoped to the episode's
series, and playback encoder validation is selective while the explicit
capability test remains comprehensive. Preserve these boundaries when changing
startup or buffering behavior; no request/response or database changes are needed.
Producer heartbeats on transport/seek events are ordered and coalesced separately
from watch reports. Keep speculative playlist refreshes at the confirmed source
clock so they cannot retire media that a canceled seek still needs. HLS buffer
targets account for source bitrate rather than forcing long buffers for large
files. Copied-video pacing differs from video encoding, but both retain the
configured server limits and keyframe-aligned segment behavior.

Playback defaults to original files. `transcoding::Settings.allow_conversion`
defaults to false, including older settings JSON with this field absent; existing
encoder preferences are preserved. `Settings.allow_remux` defaults to true and
allows lossless packaging changes for track selection. `PlaybackInfo` advertises
the policies as `conversion_allowed` and `remux_allowed`. The separate
`allow_audio_transcoding` and `auto_bandwidth_transcoding` settings also default
to false in new and older saved JSON. `audio_conversion_allowed` reports the
effective audio permission; `bandwidth_adaptation_allowed` reports the automatic
bandwidth option. Audio-only permission can convert an incompatible audio track
to 192 kbps stereo AAC with supported original video copied into HLS. It cannot
encode video, lower quality or burn subtitles, including through a decode or
keyframe-scan fallback. This path does not require the lossless remux option.
`SessionInput.hls_aac_supported` proves the copied source-video/AAC-LC pair
independently of the selected source audio profile; keep it separate from the
selected-track eligibility in `hls_audio_codecs`.

Automatic bandwidth adaptation is independently scoped: a nonzero
`SessionInput.bandwidth_limit_bps` must be authorized, bounded and lower than a
known source bitrate. It permits a bitrate reduction for compatible video;
it does not authorize unsupported-video recovery, manual quality requests or
subtitle burn-in. `source_video_supported` carries the client's source-profile
probe independently of its generic output encoder capabilities. The plan owns
the validated bitrate limit used by the command
builder. The server advertises `source_bitrate` from probe data; unknown bitrate
does not establish an automatic bandwidth deficit. Broad `allow_conversion`
retains its existing compatibility, manual-quality and burn-in behavior.

The player's adjacent `lib/bandwidth.ts` owns throughput evidence and downgrade
decisions. Automatic adaptation requires measured media throughput and sustained
low-buffer playback, with startup/seek grace, a cooldown and a per-item limit.
HLS measures disjoint partial-fragment body windows as well as completed
transfers, so a large fragment can establish a deficit before it finishes.
Producer waits and time before the first byte are excluded; a startup switch
requires measured slow transfer windows after the grace period. Stalled direct
playback uses bounded authenticated Range probes on the owned media URL. Probes
must be canceled on session/item cleanup, and disabled, paused or manual-quality
playback must not probe or adapt. Keep the selected budget across track changes
and seeks while preserving the source clock and watch session. The browser's
general connection hint alone must never authorize a downgrade.
Adaptation currently runs at normal (1x) playback speed. Other speeds suppress
sampling and probing, since their media-rate demand differs from wall-clock
network throughput. Reductions stay in effect for the current player item;
reopening the player starts with original quality and fresh evidence.
Without a known bitrate or measurable transfer evidence, keep the current
stream rather than treating a waiting event as permission to encode video.

Direct playback permits a supported MKV and does not reject the default audio
because a file contains several tracks. `SessionInput.native_audio_tracks` is a
client capability for alternate audio; browser tracks must be identified after
metadata loads before their enabled flags change. Inconclusive mappings must
never claim an alternate track is playing. If native switching is unavailable,
`force_remux` selects a verified stream-copy fallback; `hls_video_codecs` and
`hls_audio_codecs` report fMP4 capability separately from original-file decoding.
Client probes check the source profile and combined video/audio MIME support.
The internal `hls_audio_track_indexes` map keeps each track's profile eligibility;
strip it from requests and send only the verified selected codec in
`hls_audio_codecs`, so an unsupported HE-AAC track cannot hide usable AAC-LC.
Preserve source clock and pause state through remux switches; watch sessions and
client subtitle timelines remain independent of media-session replacement.
When a subtitle is selected on a paused frame, repaint ASS after renderer startup
using the current media clock; do not wait for another video frame or seek to
force rendering.
Direct streams keep a zero source offset, the source's MIME type and authenticated
`ServeFile` range handling. PGS/VobSub have no client bitmap renderer and still
require explicit conversion permission for burn-in.

Playback preference appearance fields are defaulted when older JSON is loaded:
`subtitle_color`, `subtitle_shadow`, `subtitle_background` and `subtitle_position`.
The server validates colors and option values; plain-text cue styling/placement
uses these preferences while ASS/SSA keeps its own styling. Watch completion must
require newly credited viewing: a seek or paused report cannot reuse earlier
viewing time to mark a title complete. Initialization retries and item changes
must preserve independent media/watch session ownership.
Completion uses a private viewing-sequence marker in the existing watch JSON
column, rather than comparing wall-clock timestamps. It is omitted from API
responses, and older records without it remain readable.

`SettingsPage.tsx` selects sections and provides their frame. Appearance and
provider editors are independent leaves. `PluginsPage.tsx` imports default
provider forms directly, removing its cycle with SettingsPage. Appearance preview
loads the settings page lazily instead of statically importing its composition.
Existing page tests still verify the composed flow.

Artwork (`ArtworkPanel`, `ArtworkBrowser`, `PosterDBPanel`, provider panels),
reading (`ReaderPage`, `ReaderPages`, `lib/reader*`), catalog/detail views
(`NativeLibraryBrowser`, native catalog helpers), and authentication (`AuthGate`,
`AuthProvider`, idle-session helpers) remain in established locations. Shared UI,
transport, navigation, theme and artwork-target utilities remain shared. Move
these only when a task needs a useful responsibility boundary.

Library title sorting uses `lib/titleSort.ts`: a nonblank NFO sort title wins;
otherwise only a leading "The" is ignored. This is a display-time sorting key,
so displayed titles and NFO files are unchanged. Native catalog cards use
`metadata.sorttitle`; connected book info uses `sort_title`.

## Dividing cross-layer work

Assign exact files and interfaces before concurrent edits. The main agent owns
shared contracts, dependencies, schemas/migrations, configuration, composition
and documentation. Feature agents own implementations and behavior tests.
Read-only review is useful alongside implementation; subagents are unnecessary
for every small edit.

Example: a playback quality option.

1. Main agrees request/response/default behavior and reserves Rust
   `playback/models.rs`, frontend `features/playback/types.ts`, configuration and
   integration edits.
2. Backend agent owns `playback/planner.rs` and its tests. Reserve `hardware.rs`
   separately only when a different encoder needs investigation.
3. Frontend agent owns `features/playback/PlayerPage.tsx` and interaction tests
   against that agreed contract; it requests client/contract changes instead of
   racing the integration owner.
4. Main integrates sequentially, verifies both layers, reviews the diff and
   handles authorized shipping.

Example: a book metadata provider.

1. Backend agent owns the new provider adapter and local fixtures.
2. Frontend agent owns its dedicated configuration/search components and tests.
3. Main owns provider enums/settings, encrypted persistence, HTTP registration,
   native-library wiring, dependencies and deployment configuration. These edits
   are sequenced after agreeing the provider contract.

Do not assign the same file to two writers, even for different functions. Renames
and import rewrites require coordination with consumers. Remaining large native,
reader, catalog and watch files have one writer per task; further splits should
follow responsibilities rather than a size quota.

## Compatibility and storage

The refactor preserves URL patterns, JSON fields/defaults, catalog identity,
query/localStorage keys, worker behavior and deployment files. Native paths and
connected-server URLs retain their existing trust rules.

`posterview.db` holds application/server settings, encrypted credentials and the
native catalog. `reader.sqlite` and `watch.sqlite` remain separate stores under
application data. Authentication/security configuration and the Fernet key stay
in their established locations. SQL changes anywhere require migration ownership;
moving a module does not authorize changing its schema or data location.

Protected routes require administrator authentication by default. Configuration
still controls disabled authentication, TCP-peer LAN bypass, idle timeout and
secure cookies. Public health/auth/backdrop and existing compatibility plugin
registrations are unchanged. Forwarded headers do not define trusted peers.
Playing heartbeats refresh authenticated activity; ordinary polling/image loads
do not. Credential handling and URL validation remain server-side.

Artwork applies retain runtime/provider behavior. Legacy artwork history has
been retired; older Python-era instructions requiring history recording on every
apply no longer apply. See [native playback setup](docs/native-playback.md) for
playback behavior and GPU configuration.

## Practical checks

- Preserve untouched NFO fields and media sidecars during native metadata edits.
- Jellyfin/Emby uploads use base64 payloads; backdrops have list semantics. Plex
  and providers have different upload rules; use the existing adapters.
- Rate limits and unavailable servers are not cache/authentication failures; test
  connections before changing shared behavior.
- `docker-entrypoint.sh` prepares data bind-mount ownership and excludes media.
  PUID/PGID/UMASK and GPU device access remain host configuration.
- Manually installed Unraid templates belong in `templates-user/`.

Finish with focused commits and verification, baseline failures, remaining
coordination points and authorized push/build status. Preserve local artifacts
and unrelated changes; repository guidance alone is not shipping permission.
