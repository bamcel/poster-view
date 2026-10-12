# Server-specific guidance

- `src/lib.rs` composes the application and starts workers. `src/state.rs` builds
  shared state without starting workers. Keep these integration boundaries small.
- `src/routes/{system,media_servers,artwork}.rs` own their HTTP adapters/route lists.
  `routes/mod.rs` composes protected routers and retains native/reader/metadata/task
  registration. Playback/watch expose feature routers. Preserve the existing
  public/protected classification and apply authentication once.
- Preserve the public `router`, `AuthState` and `ServerConfig` facade. Prefer
  private modules and `pub(super)` feature helpers; reserve `pub(crate)` for real
  server-wide interfaces. Keep HTTP/domain error mapping explicit.
- Playback is direct-only. Wire models live in `playback/models.rs`; native
  compatibility checks in `planner.rs`; original delivery, resources and bounded
  sessions in `mod.rs`. Do not add encoding, remuxing, HLS or bitmap burn-in as
  an implicit fallback. Agree interfaces before assigning separate writers.
- Reuse `crate::test_support::state` for isolated, worker-free fixtures. Do not
  borrow setup from another feature's tests. Playback has test-only fixtures and
  cross-boundary tests; pure planner tests are beside their implementation.
- Keep application storage in existing infrastructure crates. Reader/watch still
  own separate SQLite stores in server modules; their SQL/schema changes remain
  coordinated migrations. Preserve names, paths, encryption and startup compatibility.
- Media paths, credentials, FFmpeg arguments, cleanup and byte ranges are server
  responsibilities. Preserve trust boundaries during moves. Media fixtures need
  FFmpeg/ffprobe; do not use live credentials or user media as disposable data.

Focused examples: `cargo test -p posterview-server playback:: --locked`, or
`cargo test -p posterview-server native_playback_and_watch_routes_require_authentication --locked`.
Serialize Cargo test/build commands sharing the same target directory.
