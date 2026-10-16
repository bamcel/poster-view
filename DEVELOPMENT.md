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
committed Cargo/npm lockfiles. Direct playback needs no server GPU passthrough;
optional hardware encoding requires explicitly mapped devices and working drivers.

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

`playback/models.rs` holds wire models; `planner.rs` chooses the least processing
permitted by administrator policy and browser capabilities. `mod.rs` owns original
range delivery, sessions, probes and subtitle/font resources. Segmented jobs,
hardware probes and rolling manifests have focused modules. `transcoding.rs` owns
persisted playback permissions and resource settings. Planner tests are adjacent;
`tests.rs` covers authenticated delivery, resources, generation changes and cleanup.

Native CRUD/scan coordination remains in `native.rs`. Discovery/probing,
monitoring, missing items, identification, providers and artwork already have
separate `native_*.rs` modules. `reader.rs`, `metadata.rs`,
`watch.rs` and `scheduled_tasks.rs` keep their feature interfaces.
Shared fixtures now come from `test_support.rs`, not native scan tests. Feature
routers return `Router<AppState>`; central composition applies authentication
once. Keep only health, authentication and login-backdrop endpoints public.

Video-library browsing uses `GET /api/native/libraries/{id}/summaries`, a compact
relational projection with navigation, filtering, artwork, ratings and a
`metadata._has_files` playback flag. It does not deserialize scan snapshots or
include files, NFO text, cast or provider payloads. `GET .../items/{item}` expands
the selected title or editor; the original full `GET .../items` contract remains
available for editing workflows, books and YouTube. Query keys retain the
`native-catalog` library prefix so scans and edits invalidate summaries and full
records together. Library-strip previews use a separate thin database query.

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
      transcoding/          temporary playback policy, hardware and resource controls
      formStyles.ts         shared settings input styling
  pages/                    remaining route composition and pages
  components/, lib/         reused UI/utilities and remaining catalog/reader/auth
```

Playback tests moved with their code. Wire definitions and watch endpoints have
one implementation each. Both feature API clients use `apiRequest`; the player
uses the watch client for watch operations. Media/WASM dependencies stay lazy-loaded.
API modules re-export their types for existing consumers; definitions live in
`features/playback/types.ts`.

Playback prefers authenticated original-file byte ranges with source offset zero.
Native seeks keep one URL and session. Opening playback starts optional background
timeline storyboard preparation, with authenticated, permission-checked manifests
and JPEG sheets of thirty 240×136 previews at ten-second intervals. The browser
preloads and decodes sheets at low network priority; inspecting a ready frame
only changes the sprite crop. Unprepared positions retain on-demand JPEG fallback.
One single-thread background FFmpeg worker runs outside playback/probe admission,
with a separate single-worker budget for interactive fallback previews so sheet
generation cannot block hover requests. It uses keyframe-only decoding for approximate previews,
yields between sheets and limits preparation to six hours per title. Source
fingerprints invalidate changed media. The disk cache is capped at 512 files/
128 MiB; the browser retains at most eight sheets/16 MiB of compressed images
and cancels preloading on media/account changes. First-time preparation still
takes time; unavailable previews fall back to a timestamp. Playback media URLs,
quality, sessions and encoding decisions do not change for preview preparation.
Playback statistics poll browser media state only while Info is open. Subtitle
delay is stored per user/video in watch JSON (positive means later), defaults to
zero for old records, and adjusts browser subtitle rendering without replacing media.
Series track choices live in the watch database keyed by user, library and catalog
series ID. The personal `remember_series_tracks` option controls them independently
of per-video memory. Only explicit choices update series preferences; matching uses
language and track characteristics, never another episode's track index. Valid
remembered per-video selections take priority. The personal Playback settings reset
clears both per-video and series track choices atomically. It preserves watch state
and preferences; an internal active-session marker prevents old player reports
from restoring cleared choices until the video is reopened. Chapter names/highlighting and the
`[` / `]` previous/next shortcuts share normalized, bounded source timestamps.
 When permitted and needed, the planner
chooses stream-copy HLS, audio-only AAC encoding, or video encoding. Direct Stream
never encodes selected audio/video; audio-only mode copies the video. Compatible
originals are not encoded merely because hardware acceleration is enabled.

Settings → Transcoding controls these permissions independently and preserves old
`transcoding-settings` JSON names/defaults. `allow_conversion` is the legacy key
for playback video encoding, not an offline library conversion workflow. There is
no database migration or original-media rewrite. Routes for settings, real encoder
probes, generation-scoped HLS resources and seek replacement are authenticated.

Segmented requests retain agreed client capabilities and selected options. A seek
inside retained produced segments reuses the producer. An unavailable seek or
track promotion uses `/sessions/{id}/seek` with the expected generation, returning
409 for stale work. Logical session ID, watch token and full source duration remain
stable through delivery generations. Direct seeks use the browser and need no job.

Metadata and resource preparation are bounded, cached and source-scoped. ASS/SSA
uses JASSUB and embedded fonts; text uses WebVTT. PGS and VobSub are stream-copied
into .sup/.mks resources and drawn by local libbitsub overlays with source-clock
synchronization. Unknown bitmap formats stay unavailable. Neither subtitle track
changes nor bitmap overlays require video burn-in.

Automatic bandwidth adaptation uses sustained HLS transfer/stall evidence. It does
not infer native Direct Play throughput from a short buffering event. Quality caps
remain explicit. Hardware encoder availability is verified by a small real encode;
that result does not imply hardware source decoding or HDR tone-mapping support.
See [playback decisions](docs/playback-design.md) for tradeoffs and measurement limits.

Original media bypasses HTTP compression for full responses and ranges, preserving
its exact bytes, Content-Length and Accept-Ranges. Keep JSON/CSS/JavaScript compression.
Regression tests layer the same middleware factory used by the real server over
the protected playback routes, rather than checking delivery helpers alone.

Session generations and pending-seek guards prevent reset-clock events from
rewinding the UI or watch state. Playback heartbeats are ordered separately from
watch reports. Preserve paused/playing intent, watch-session ownership and source
time when changing startup, seeking, audio or subtitle behavior. Capability
support does not guarantee efficient native MKV seeking: browser indexing,
source keyframes and HTTP delivery still need runtime measurements.

Brief native fetch/decode waits leave the original video attached and show a buffering
indicator only after 500 ms; startup preparation remains immediate. This is a
visual delay, not a claim that unbuffered seeks require no network or decoding.
Ignore queued media error events with a cleared `MediaError`; only an owned
current source with a real error may terminate playback.

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

Library detail pages share `components/LibraryDetailLayout.tsx`: the hero owns
portrait/episode-landscape geometry and responsive synopsis placement; sections
share vertical spacing. Native detail composition fixes the order to related
content, people (including anime characters and voice casts), About, then media
information. Callers retain type-specific metadata, actions, visibility rules,
queries and artwork components. Connected-server item/season pages reuse the
same hero and section primitives; their provider navigation and reading controls
remain with the page.

## Dividing cross-layer work

Assign exact files and interfaces before concurrent edits. The main agent owns
shared contracts, dependencies, schemas/migrations, configuration, composition
and documentation. Feature agents own implementations and behavior tests.
Read-only review is useful alongside implementation; subagents are unnecessary
for every small edit.

Example: improving native audio-track support.

1. Main agrees request/response/default behavior and reserves Rust
   `playback/models.rs`, frontend `features/playback/types.ts`, configuration and
   integration edits.
2. Backend agent owns `playback/planner.rs` and its delivery policy
   tests; it does not change shared wire models independently.
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

Accounts and salted Argon2id password hashes live in `posterview.db`. The first
visitor must create an administrator through the atomic first-run setup endpoint
when the account table is empty; subsequent starts preserve account
edits and password resets. Account IDs remain stable across username changes.
Watch, reader and playback preferences use those IDs, and playback sessions and
reader resources belong to the account that created them.

Protected routes authenticate the current account and enforce its role. Configuration
still controls disabled authentication, TCP-peer LAN bypass, idle timeout and
secure cookies. Health/auth/backdrop routes are public; plugin configuration
requires authentication. Forwarded headers do not define trusted peers.
Playing heartbeats refresh authenticated activity; ordinary polling/image loads
do not. Credential handling and URL validation remain server-side.

Administrators manage accounts in Settings → Users. Ordinary users can browse,
play and track permitted native libraries, with separate movie and TV rating
ceilings and an explicit choice for unrated content. Ratings come from catalog
metadata and inherit parent restrictions; numerical review scores are not parental
ratings. Connected-server configuration, metadata/artwork editing and server
operations require administrator access. Account edits revoke existing sessions.
While any ordinary user account is enabled, individual sign-in is required;
LAN authentication bypass and disabled-login configuration cannot override account
restrictions. Administrator-only installations retain their configured bypass.

Artwork applies retain runtime/provider behavior. Legacy artwork history has
been retired; older Python-era instructions requiring history recording on every
apply no longer apply. See [native playback setup](docs/native-playback.md) for
delivery policy, browser compatibility and optional hardware setup.

Native artwork display requests accept a `width` of 96, 192, 320, 480, 640,
1280 or 1920 pixels. Derived JPEG/WebP images live in appdata `artwork-variants/`;
source artwork and editor/export requests remain unchanged. Variants preserve
aspect ratio without upscaling and fit within 1920×1920 pixels. Source path, size
and modification time version the cache. A single generation gate bounds image
decoding; a busy generator or unsupported source falls back to the original.
Playing GIF/WebM artwork remains animated; static previews can request `still=1`.
Catalog scans, artwork uploads/applies and monitored sidecar updates coalesce
background generation. The enabled daily **Optimize Artwork** scheduled task
backfills existing artwork and removes obsolete cache files after seven days.
It can also be run manually or disabled in Scheduled Tasks. Deleting the derived
cache is safe; requested variants regenerate. Existing authenticated artwork
revalidation and account access checks still apply.
See [playback design and runtime comparison](docs/playback-design.md) for the
direct-first decision, generation ownership, measured preparation costs and
remaining GPU/large-file validation limits. Keep temporary encoding opt-in and
preserve original media. Hardware encoder detection does not establish hardware
decoding support or throughput on the user's actual Unraid server.

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

## YTDL and YouTube libraries

`apps/server/src/ytdl/` owns downloader commands, NFO metadata, settings and the
persistent serial queue. The central router enforces administrator-only plugin
access. Jobs/settings use encrypted application settings in `posterview.db`.
Native migration 3 extends library types without changing existing catalog IDs.

`frontend/src/features/settings/ytdl/` owns the plugin popup and client;
`features/youtube/` renders channel/playlist/video views using native playback
and watch controls. `native_scan.rs` reads the YouTube NFO extension. YouTube
libraries skip TV-provider enrichment and missing-episode generation. See
[setup, metadata, and runtime requirements](docs/ytdl.md).

## Native Collections

Curated collections live independently of scan-owned catalog hierarchy. Shared DTOs
are in `posterview-contracts/src/collections.rs`, transactional storage and migration
4 in `posterview-infra-sqlite`, and HTTP projections in `apps/server/src/collections.rs`.
The feature router is protected by normal authentication. Reads project only permitted
library/rating members; empty hidden collections return 404 and partial collections
omit unrestricted overview text. Artwork is derived from permitted member artwork.

Admins create collections and add/remove/reorder movie or series members. Member
identity is `(library_id,item_id)`; scans preserve membership while IDs remain stable.
Duplicate additions are idempotent and report added/existing counts. Edits/additions
use optimistic revisions and reject stale writes with 409. Deleting a collection
never removes media. Ordering is release date (unknown last), sort title, or custom.

Frontend ownership is `frontend/src/features/collections/`, with lazy `/collections`
and `/collections/:id` pages. Library grids add admin multi-selection, including
Shift ranges, Ctrl/Cmd+A, and Escape. Selections survive filtering within the same
library. Grouping preferences are stored per user/library in SQLite and default off;
only groups with at least two visible members replace cards. Search and metadata/
artwork filters show individual titles, and selection mode also expands groups.
No playback engine, original-media URL, or watch state is changed by collections.

## Native video versions

Movie and episode files with a shared basename and explicit delivery suffix (for
example `John Wick - Original.mkv`, `John Wick - Streamable.mp4`, and
`John Wick - UHD.mkv`) group into one title on the next library scan. Grouping
stays within a directory and episode identity; theatrical/extended/director cuts
are not guessed as interchangeable. Existing primary catalog identity is retained.
Each catalog file carries `version_id` (its relative path) and `version_name`.

Playback info, source sessions, subtitle/font resources and timeline previews
accept an optional `version_id` selected only from that title's catalog files.
Existing library-root/path authorization still applies. Detail/player selectors
show available versions; audio, subtitles, chapters and probes belong to the
selected physical file. Original playback still serves the same source bytes.

The existing per-user watch JSON saves the current version alongside its position,
audio/subtitle indices and subtitle delay. Resume selects that version first.
An explicit different version begins at zero and discards incompatible indices;
missing remembered files fall back with a notice. Series language preferences may
still match tracks by characteristics. No database migration or media rewrite is
needed; older clients without a version use the default catalog file.
