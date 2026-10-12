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
separate `native_*.rs` modules. `google_books.rs`, `reader.rs`, `metadata.rs`,
`watch.rs` and `scheduled_tasks.rs` keep their feature interfaces.
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
Native seeks keep one URL and session. When permitted and needed, the planner
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

Protected routes require administrator authentication by default. Configuration
still controls disabled authentication, TCP-peer LAN bypass, idle timeout and
secure cookies. Public health/auth/backdrop and existing compatibility plugin
registrations are unchanged. Forwarded headers do not define trusted peers.
Playing heartbeats refresh authenticated activity; ordinary polling/image loads
do not. Credential handling and URL validation remain server-side.

Artwork applies retain runtime/provider behavior. Legacy artwork history has
been retired; older Python-era instructions requiring history recording on every
apply no longer apply. See [native playback setup](docs/native-playback.md) for
delivery policy, browser compatibility and optional hardware setup.
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
