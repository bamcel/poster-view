# PosterView — developer guide

Self-hosted artwork manager for Plex/Jellyfin/Emby. Rust/Axum + SQLite backend,
React/Vite/TS/Tailwind v4 frontend, shipped as one Docker image. See README.md
for the user-facing overview; this file is for working on the code.

## Commands

```bash
# backend (from repo root)
cargo run --package posterview-server # dev server on :7979
cargo test --workspace --locked       # contract/integration tests
cargo clippy --workspace --all-targets --locked -- -D warnings

# frontend (from frontend/)
npm run dev                            # Vite on :5173, proxies /api -> :7979
npm test                               # Vitest component and API-client tests
npm run build                          # tsc typecheck + production bundle -> dist/

# deploy the running container (rebuilds frontend + backend into the image)
docker compose up -d --build           # serves SPA + API on :7979
```

Automated fixtures cover contracts, CRUD, encryption, normalization, uploads, and history.
Live provider/media-server verification remains opt-in because it needs user credentials.

## Deployment security

PosterView requires an administrator session for every API route except health and authentication.
Set `POSTERVIEW_PASSWORD`, or retrieve the generated first-run password from
`data/admin-password.txt`. Set `POSTERVIEW_SECURE_COOKIES=true` behind HTTPS. Keep the service on a
trusted network or behind a reverse proxy because application login does not replace TLS and
network access controls.

Server URLs intentionally support LAN IPs, direct Tailscale IPs, resolvable MagicDNS names, and
complete domain URLs because PosterView must reach remote media servers. URL validation therefore
allows private destinations only for configured media-server bases. Artwork downloads and their
redirects are HTTPS-only and restricted to the selected provider's domain.

## Architecture

- `crates/posterview-infra-media-servers/` — Plex, Jellyfin, and Emby adapters.
  Everything is normalized to the `Normalized*` / `ItemDetail` schemas so
  routers and the UI never branch on server type.
- `crates/posterview-infra-artwork/` — ThePosterDB session/scraping plus
  Fanart.tv, TheTVDB, AniList, and MediUX providers.
- `crates/posterview-infra-sqlite/` — compatible SQLite schema and Fernet secrets.
- `crates/posterview-url-security/` — shared media-server and provider URL trust rules.
- `crates/posterview-runtime/` — host-independent orchestration, apply, history, and revert.
- `apps/server/` — Axum routes, authentication, configuration, errors, and compiled-SPA serving.
- **Title search for Fanart.tv/TheTVDB/MediUX** (`GET /api/artwork/search`,
  `ArtworkBrowser.tsx`'s id/search box): typing a non-numeric value shows a
  picker of candidates instead of an id lookup. None of the three has its
  own title-search API — Fanart.tv has none at all, MediUX's is invite-only
  beta, and Fanart/MediUX both need a TMDB (or, for Fanart movies, IMDb) id
  rather than a TVDB one — so all three are backed by `TVDBProvider.search()`
  (TheTVDB's own `/search` endpoint), which conveniently returns each
  candidate's `remote_ids` (TMDB/IMDb correlations) alongside its own tvdb
  id. `remote_id()` in `tvdb.py` pulls the right one out per provider: tvdb
  id for TVDB (and Fanart shows), TMDB for MediUX, TMDB/IMDb for Fanart
  movies. This means title search on **any of the three tabs requires a
  TheTVDB API key**, even when searching from the Fanart.tv or MediUX tab —
  surfaced as a friendly message, not an error, when the key's missing.
- `frontend/src/components/ArtworkPanel.tsx` — provider selector wrapping
  `PosterDBBody` (ThePosterDB drill-down), `ArtworkBrowser` (API providers),
  and `ManualUpload`. Apply targets are built once in `lib/targets.ts`.
- `crates/posterview-runtime/` owns apply history (revert-to-previous-image). Every
  successful `set_image` call, from any of the two apply endpoints
  (`/posterdb/apply`, `/artwork/upload`), also calls `history.record(...)`,
  which writes the bytes to `data/history/` and indexes them in the
  `apply_history` SQLite table. Two independent, **user-configurable** caps:
  a global entry-count ceiling (`history_max_entries` setting, default 50,
  always enforced on insert — oldest rows + files pruned first, not
  per-item, a single shared budget; lowering it in Settings also prunes
  immediately via `history.enforce_max_entries()`, not just on the next
  apply) and an optional max age in days (`history_purge_days` setting, 0 =
  disabled — only entries *older than* the threshold are ever touched,
  swept opportunistically on every `record()` call, no scheduler needed).
  Revert re-applies those same bytes and records that as a new entry —
  reverting never deletes the entry it reverted to, so history stays a true
  timeline, not a stack. The UI is a single **global** feed
  (`frontend/src/pages/HistoryPage.tsx`, linked from the sidebar) rather
  than a per-item tab, grouped client-side into one tile per (item, target)
  — the newest entry in each group is the tile's image; clicking it opens a
  modal listing every version in that group with Revert — `GET /api/history`
  returns that global feed when
  called without `item_id`; `POST /api/history/purge` triggers an immediate
  manual purge. `item_title` is denormalized onto each row (sent by the
  frontend at apply time, since it's already in hand there) specifically so
  the global feed doesn't need an extra media-server round trip per row
  just to render.
- Secrets (server tokens, TPDb password, API keys) remain Fernet-encrypted in
  SQLite; the key lives in `data/secret.key`. Neither
  is ever sent to the browser.
- All images the browser shows are proxied through the backend
  (`/api/servers/{id}/image`, `/api/posterdb/image`) so credentials/sessions
  stay server-side and CORS never applies.

## Gotchas (learned the hard way)

- **Jellyfin/Emby image upload** wants the request body **base64-encoded**
  with `Content-Type` set to the real image mime. Raw bytes fail.
- **Emby backdrops are a list** — `POST /Items/{id}/Images/Backdrop` appends;
  it does not replace the displayed image. `set_image` deletes existing
  backdrops first so the new one becomes index 0.
- **Emby item ids change on library rescan.** Never cache them across
  sessions; always re-list.
- **Plex logo upload** uses `POST /library/metadata/{id}/clearLogos` (same
  raw-bytes pattern as `posters`/`arts`).
- **ThePosterDB is behind Cloudflare** but a logged-in httpx session with
  browser-like headers gets through. A 429 is rate-limiting, NOT a dead
  session — do not re-login on it (re-login used to tear down the shared
  client and kill every in-flight request). Grid thumbnails must use the
  small optimized webp from each card's `<picture><source srcset>` (~70 KB),
  never the full-res `/api/assets/{id}` (2–5 MB), or big sets rate-limit.
- **ThePosterDB search results come from TMDB**, so most matched titles have
  zero uploaded posters. `/api/posterdb/verify` counts posters per title and
  the UI hides the empty ones.
- **The user's Emby goes offline intermittently.** If "nothing loads", hit
  `/api/servers/{id}/test` before suspecting PosterView; restarting the
  container does not fix an unreachable media server.
- **Git Bash on Windows mangles container paths** (`/tmp/...` becomes
  `C:/...`) in `docker exec`/`docker cp` args — wrap the remote command in
  `sh -c '...'` or set `MSYS_NO_PATHCONV=1`.
- **Emby's `/Items?Ids=` lookup silently returns nothing for a BoxSet**
  unless `IncludeItemTypes` explicitly allow-lists it alongside the regular
  types (`Movie,Series,BoxSet`) — no error, just an empty result, which reads
  as "item not found."
- **Emby's `CollapseBoxSetItems` query param doesn't reliably group a
  library's movies into their collections** — tested live: it silently drops
  the extra member items instead of replacing them with a collection tile.
  Grouping is done by hand instead (`JellyfinClient._collapse_boxsets`):
  list every BoxSet, fetch each one's children via `ParentId` in parallel,
  then substitute.
- **MediUX needs no login**, unlike ThePosterDB — a plain browser-header GET
  reaches `mediux.pro/{movies,shows,collections}/{tmdbId}` fine. But its
  Next.js image proxy (used for thumbnails) 403s without a same-origin
  `Referer` header and 400s on a non-whitelisted `w=` value (only specific
  sizes like 256 are allowed) — see `crates/posterview-infra-artwork/src/lib.rs`.
- **SQLite's `datetime('now')`** (used for `apply_history.applied_at`) is
  `"YYYY-MM-DD HH:MM:SS"` UTC with **no timezone marker and a space, not a
  `T`** — `Date.parse()` on the frontend needs
  `str.replace(" ", "T") + "Z"` first or it's ambiguous/wrong depending on
  the browser. Jellyfin/Emby's `DateCreated` and Plex's normalized
  `added_at` are proper ISO 8601 and don't need this.
- **Plex's collection-grouping (`_collapse_collections`) and the rest of the
  Plex collections code are unverified** — there's no Plex server in this
  dev environment. It mirrors Jellyfin's `_collapse_boxsets` pattern closely
  (fetch the section's own collections, fetch each one's children via
  `/library/collections/{id}/children` in parallel, substitute), but the
  first real Plex test is the thing most likely to need a tweak.
- **`db.SCHEMA`'s `CREATE TABLE IF NOT EXISTS` doesn't retroactively add new
  columns** to a table that already exists on disk (e.g. adding `item_title`
  to `apply_history` after the table was already created) — needs an
  explicit `ALTER TABLE ... ADD COLUMN` in `db._migrate()`, gated on a
  `PRAGMA table_info` check, run from `init_db()` on every startup.
- **The container's non-root user doesn't survive a bind mount.** The Dockerfile
  bakes in `chown -R posterview:posterview /data` at build time, which is enough for a
  Docker-managed named volume (docker-compose's `posterview-data`) since Docker
  copies that ownership over on first creation — but a bind mount to a host path
  (e.g. Unraid's `Type="Path"` config, which Unraid creates as root) always
  reflects the host directory's actual ownership and ignores the image, so
  `secret.key`/`posterview.db` writes previously failed with a permission error.
  Fixed by starting the container as root and using `docker-entrypoint.sh` to
  `chown -R` `/data` at *runtime* (works for both bind mounts and named
  volumes) before dropping to uid 10001 via `setpriv --reuid=10001
  --regid=10001 --init-groups`. Verified live: a fresh root-owned bind-mounted
  directory now starts cleanly and `docker top` confirms `posterview-server` runs
  as uid 10001, not root.
- **`apply_history` prunes to the last 50 rows *globally*** (not per item)
  — deletes both the DB row and the file on disk, on every `record()` call.
  Originally per-(server,item,target) capped at 5; changed to one shared
  global budget per user request. If a specific history entry you were
  expecting seems to have vanished mid-testing, check whether repeated
  applies (to *any* title) pushed it out of that window before assuming
  something's broken (bit us once while testing revert).
- **A manually-placed Unraid template XML must go in `templates-user/`, not
  `templates/`.** Confirmed live: the user first dropped the downloaded XML
  into `/boot/config/plugins/dockerMan/templates/` — selecting PosterView from
  the Add Container → Template dropdown still produced a blank/default form
  (no WebUI Port/Data rows, Network Type: None) even though the XML itself
  was valid and complete. Moving the exact same file to
  `/boot/config/plugins/dockerMan/templates-user/` fixed it immediately —
  full Overview/Network/WebUI Port/Data rows populated correctly.
  `templates/` is treated as Community-Applications/system-managed;
  `templates-user/` is the directory Unraid actually scans for manually
  supplied templates. README's Unraid instructions lead with this
  local-file method (curl straight into `templates-user/`) rather than
  Unraid's in-UI "Template repositories" paste-a-URL flow, which was never
  confirmed working in this troubleshooting session.

## Conventions

- Applying artwork always flows through `POST /api/posterdb/apply`
  (`provider` field decides how the bytes are fetched) or
  `POST /api/artwork/upload` for user files — then `MediaClient.set_image`,
  then `history.record(...)`. Any new apply path must call all three, in
  that order — history is written from the bytes that were actually
  uploaded, not re-fetched from the source afterward.
- Banners are display-only everywhere: no supported media server has a
  banner-upload endpoint.
- Keep commits focused and verify both the Rust workspace and frontend build before pushing.
