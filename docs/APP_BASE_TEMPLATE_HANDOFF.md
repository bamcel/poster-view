# PosterView application base-template handoff

## Purpose

Use PosterView as a reference implementation for a self-hosted web application with a Rust API,
React frontend, responsive application shell, authentication, tabbed settings, automatic saving,
and selectable color themes. This handoff identifies the reusable foundation, the PosterView-only
features to replace, and the order in which to extract the foundation into another application.

Reference repository: <https://github.com/bamcel/poster-view>

Pinned reference revision: `713a5aa`. Pinning the revision keeps future ports reproducible even as
PosterView changes. Replace the revision only after reviewing newer changes.

This is an implementation handoff, not a request to clone PosterView's media-management product.
Retain the shell and infrastructure patterns, then substitute the new application's domain.

## Technology baseline

| Layer | PosterView implementation |
| --- | --- |
| Backend | Rust 1.88, Axum 0.8, Tokio, Serde, tracing |
| Frontend | React 19, TypeScript, Vite 8 |
| UI | Tailwind CSS 4, Lucide icons, semantic CSS variables |
| Routing/data | React Router 7, TanStack Query 5 |
| Persistence | SQLite plus JSON files in a persistent `/data` directory |
| Packaging | Multi-stage Docker build with a non-root runtime user |
| Testing | Cargo tests/Clippy, Vitest/Testing Library, production frontend build |

Keep the architectural roles if the target app uses different libraries. For example, a different
backend still needs public and protected route groups, server-enforced sessions, structured errors,
runtime configuration, and a static single-page-app fallback.

## Architecture to preserve

```text
Browser
  main.tsx
    QueryClientProvider
      BrowserRouter
        App
          AuthGate                         authentication boundary
            application providers         target/domain state
              ToastProvider
                Routes
                  Layout                   responsive app chrome
                    routed page via Outlet

Rust server
  configuration -> shared AppState -> Axum router
                              |-> public health/auth endpoints
                              |-> authenticated API endpoints
                              |-> compiled frontend + SPA fallback

Persistent data directory
  application database
  security-settings.json
  generated administrator password, when applicable
  target-specific cached data/assets
```

The provider order matters. Providers that fetch protected data belong inside `AuthGate`; otherwise
they can issue unauthorized requests before login and remain empty until the page is refreshed.

## Reusable source map

### Copy or closely adapt

| Concern | Reference files |
| --- | --- |
| Frontend bootstrap | `frontend/src/main.tsx`, `frontend/src/App.tsx` |
| Responsive shell | `frontend/src/components/Layout.tsx` |
| Shared controls/branding | `frontend/src/components/ui.tsx` |
| Authentication | `frontend/src/components/AuthGate.tsx`, `frontend/src/lib/authContext.ts`, `frontend/src/lib/useIdleSession.ts`, `frontend/src/lib/rememberUsername.ts` |
| Privacy/security settings | `frontend/src/components/SecuritySection.tsx` |
| Theme engine | `frontend/src/lib/theme.ts`, theme declarations in `frontend/src/index.css` |
| Settings save feedback | `frontend/src/lib/settingsSaveStatus.ts`, status handling in `frontend/src/pages/SettingsPage.tsx` |
| API conventions | `frontend/src/api/client.ts` |
| Notifications | `frontend/src/lib/toast.tsx` |
| Backend entry/config | `apps/server/src/main.rs`, `apps/server/src/config.rs` |
| Backend routing/errors | `apps/server/src/lib.rs`, `apps/server/src/error.rs` |
| Server authentication | `apps/server/src/auth.rs` |
| Container packaging | `Dockerfile`, `docker-entrypoint.sh`, `docker-compose.yml` |

Use [`AUTH_LOGIN_HANDOFF.md`](AUTH_LOGIN_HANDOFF.md) for the complete authentication contract,
security behavior, Unraid fields, and acceptance tests. It is intentionally more detailed than the
authentication summary in this document.

### Replace with the target application's domain

Do not carry these concepts into an unrelated app merely because they exist in PosterView:

- Media-server connections and the active-server selector.
- Library, movie, series, artwork, provider, history, and login-poster-backdrop workflows.
- PosterView contracts and infrastructure crates whose names contain media, artwork, or SQLite
  repository implementations specific to those records.
- PosterView API types, database migrations, cached images, real credentials, or runtime data.
- PosterView name, logo, descriptions, URLs, container image, ports, and browser-storage namespace.

In `Layout.tsx`, replace the navigation array with the target routes. Remove the active-server card
or turn it into a target-appropriate bottom context panel. Keep Sign out immediately above that
panel and hide it when authentication is globally disabled.

## Backend foundation

### Recommended boundaries

Keep a small executable in `apps/server` and put business logic behind interfaces in workspace
crates. A clean target layout is:

```text
apps/server/                 HTTP composition, middleware, static UI, process lifecycle
crates/app-contracts/        request/response types and domain interfaces
crates/app-runtime/          use cases and orchestration
crates/app-infra-sqlite/     persistence adapters and migrations
crates/app-infra-*/          external-service adapters, only when needed
```

Dependencies should point inward: HTTP and infrastructure can depend on contracts/runtime, while
the domain must not depend on Axum, React, or a concrete database. Preserve `unsafe_code = "forbid"`
and workspace-wide Clippy rules.

### Router and state

Build one shared `AppState` containing configuration, authentication state, and target services.
Split routes into:

- Public: health, authentication status/login, and only assets required before login.
- Protected: all application data and mutation endpoints.
- Static: built frontend files with an `index.html` fallback for client-side routes.

Apply authentication on the server, not only in React. Use JSON errors shaped as
`{ "detail": "message" }` so the API client can consistently display useful failures. Preserve
graceful shutdown and request tracing from the server entry point.

### Runtime configuration

Rename every `POSTERVIEW_` variable to a unique target prefix. At minimum provide:

| Target variable | Purpose |
| --- | --- |
| `APP_BIND` | Listener address, normally `0.0.0.0:<port>` |
| `APP_DATA_DIR` | Persistent application data, normally `/data` |
| `APP_UI_DIR` | Compiled frontend directory inside the image |
| `APP_AUTH_ENABLED` | Explicit `true` or `false` global login switch |
| `APP_USERNAME` | Administrator username; reference default is `admin` |
| `APP_PASSWORD` | Administrator password |
| `APP_SECURE_COOKIES` | Secure-cookie mode for HTTPS deployments |

Validate boolean and numeric inputs at startup and fail with an actionable error. Do not silently
accept malformed security settings. Never bake real credentials into an image or source file.

## Frontend application shell

`main.tsx` initializes the theme before the first render, creates a shared TanStack Query client,
and mounts the browser router. `App.tsx` owns provider composition and routes. Retain this separation
so application startup remains understandable and testable.

The reusable `Layout` provides:

- A full-height desktop sidebar and compact mobile header.
- Logo, navigation, active-route treatment, routed content through `Outlet`, and Sign out.
- Semantic theme utilities rather than hardcoded background/text colors.
- `min-h-0`, `min-w-0`, and controlled overflow so individual pages own their scrolling behavior.
- A bottom context area that may be removed or replaced without disturbing navigation.

For each new route, add one entry to the navigation model and one matching route in `App.tsx`.
Keep labels, icons, routes, page headings, and tests synchronized.

The API client should remain the single request boundary. It should:

- Use same-origin relative `/api/...` URLs.
- Set JSON headers and credentials consistently.
- Parse the shared `{ detail }` error shape.
- Announce HTTP 401 through an app-namespaced browser event so `AuthGate` can return to login.
- Contain typed methods instead of scattering `fetch` calls across components.

## Settings layout and automatic saving

Use the PosterView settings page as the structural reference:

- Full available page width instead of a narrow centered form.
- A horizontal tab bar on desktop with a clean responsive fallback.
- One focused settings category per tab.
- Bordered surface sections, compact labels/help text, and balanced grids.
- A sticky/global save-status area visible regardless of the selected tab.
- Desktop panels sized to fit within the application viewport when practical; allow scrolling on
  small screens and when accessibility text scaling makes a single-window layout impossible.

Ordinary settings save automatically. Use TanStack Query mutations or an equivalent serialized
save mechanism and report the lifecycle through one app-wide event:

```ts
export type SettingsSaveStatus = "saving" | "saved" | "error";

export function reportSettingsSave(status: SettingsSaveStatus) {
  window.dispatchEvent(new CustomEvent("newapp:settings-save", { detail: status }));
}
```

The settings shell listens for that event and renders `Saving…`, `Settings saved automatically.`,
or a clear error. Recommended behavior:

1. Update local UI state immediately.
2. Debounce text/number fields; toggles and discrete selections may save immediately.
3. Serialize or cancel superseded writes so an older response cannot overwrite a newer value.
4. Invalidate the relevant query after success.
5. Restore or clearly mark failed state after an error.
6. Add accessible live-region semantics to status text.

Do not autosave password or destructive/security-sensitive changes while the user is typing. Use an
explicit confirmation/save action where partial input could lock out the administrator or cause an
irreversible operation. “Everything saves automatically” should not weaken safe secret handling.

## Color-theme system

The theme engine is intentionally semantic. Components refer to roles such as `surface`, `text`, or
`accent`; a theme supplies the actual colors. Preserve the `AppTheme` role set:

```ts
interface AppTheme {
  name: string;
  window: string;
  card: string;
  panel: string;
  sidebar: string;
  input: string;
  inputHover: string;
  button: string;
  buttonHover: string;
  selected: string;
  border: string;
  borderStrong: string;
  text: string;
  muted: string;
  subtle: string;
  disabled: string;
  accent: string;
  accentHover: string;
  success: string;
  warning: string;
}
```

`applyTheme()` maps these values onto the CSS variables consumed by Tailwind utilities, stores the
selected name in an app-specific local-storage key, and sets the browser color scheme. Call
`initializeTheme()` before React renders to avoid a flash of the default palette.

When porting themes:

1. Rename `posterview.theme` to a unique key such as `newapp.theme`.
2. Keep one stable default theme and fall back to it if a stored name no longer exists.
3. Copy the semantic `@theme` mappings from `index.css`.
4. Use utilities such as `bg-base`, `bg-surface`, `bg-input`, `border-border`, `text-text`,
   `text-muted`, `text-accent`, and `bg-accent` throughout the UI.
5. Add a theme by defining every role, registering it in the theme list, and previewing it in the
   Appearance tab. Check normal, hover, focus, selected, disabled, success, and warning states.
6. Test contrast in both dark and light palettes. Avoid isolated literal colors except deliberate
   status colors whose contrast has been checked.

Theme selection is a browser-local appearance preference in PosterView and applies immediately.
If the target needs a server-wide theme, add an authenticated setting and reconcile it with the
local preference explicitly rather than changing this behavior accidentally.

## Authentication summary

PosterView implements single-administrator authentication with username/password, opaque
server-side sessions, optional inactivity expiry, optional local-network bypass, optional global
login disablement, remembered username, conditional Sign out, and secure-cookie support.

Important integration rules:

- Check auth status before protected providers mount.
- Protect backend routes even if the frontend is hidden.
- Store only the username preference in browser storage; never store the password/session token.
- Use a unique cookie name and event/storage namespace for every application.
- Treat proxy/LAN bypass behavior as security-sensitive and retain the warning from the dedicated
  authentication handoff.
- Do not represent this as multi-user accounts, roles, MFA, recovery, or public-service hardening.

## Branding and assets

Replace all logo and product references together:

- Wordmark and icon imports in `frontend/src/components/ui.tsx`.
- Browser favicon and web metadata in `frontend/index.html` and `frontend/public`.
- Sidebar subtitle, login copy, document title, README, screenshots, and accessibility text.
- Docker/Compose/Unraid names, image URLs, support URLs, and icon URLs.

Provide SVG for the in-app wordmark when possible, plus browser and marketplace/container PNG sizes.
Do not copy PosterView artwork or cached media into the new repository.

## Container and deployment baseline

Preserve the multi-stage build: install locked frontend dependencies and build static assets, build
the locked Rust release binary, then copy only runtime requirements into a slim final image. Run as
a dedicated non-root user, expose one documented port, persist `/data`, and include a health check.

Before shipping, replace:

- Binary, package, crate, runtime-user, image, and container names.
- Default port and every matching health/Compose/template reference.
- Environment-variable prefix and log target.
- Repository, support, project, icon, and documentation URLs.
- Database filename and any application-specific filesystem paths.

The entrypoint may need to reconcile Unraid `PUID`/`PGID` with the runtime user. Preserve ownership
handling without broadening permissions on credentials or the entire host-mounted directory.

## Required rename matrix

| PosterView value | Target replacement |
| --- | --- |
| `PosterView` | Display/product name |
| `posterview` / `poster-view` | Package, binary, crate, image, and slug names |
| `POSTERVIEW_` | Unique uppercase environment prefix |
| `posterview.*` | Unique browser storage keys |
| `posterview:*` | Unique browser event names |
| Session cookie name | Unique target cookie name; ports do not isolate cookies |
| `7979` | Target port, changed consistently everywhere |
| `posterview.db` and data paths | Target-specific persistent filenames |
| GitHub/container URLs | Target repository and registry locations |

Search case-insensitively for `posterview`, `poster-view`, the old port, repository owner, cookie
name, and old URLs after renaming. Review matches rather than blindly replacing generated locks or
database migrations.

## Extraction sequence

1. Create a new repository with a fresh Rust workspace and frontend manifest; preserve applicable
   MIT license notices for copied/derived code.
2. Copy the Docker/runtime skeleton, server configuration, error handling, router composition, and
   static SPA fallback.
3. Port authentication using `AUTH_LOGIN_HANDOFF.md`, including backend enforcement and tests.
4. Copy frontend bootstrap, semantic theme engine, CSS tokens, shared controls, toast system, and
   responsive `Layout`.
5. Remove PosterView routes/providers and insert the target navigation, pages, state, and APIs.
6. Build the full-width tabbed Settings page. Add automatic saving and the global status before
   adding many individual settings.
7. Replace branding/assets and complete the rename matrix.
8. Add only the domain crates, database tables, adapters, and cached assets the target needs.
9. Validate locally and in the production container, including both HTTP LAN and HTTPS reverse-
   proxy access if those are supported deployment paths.

## Verification checklist

Run the equivalent of:

```powershell
cargo fmt --all -- --check
cargo test --workspace --locked
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings

Set-Location frontend
npm ci
npm test
npm run build
Set-Location ..

docker build -t newapp:local .
docker run --rm -p 7979:7979 -v newapp-data:/data newapp:local
```

Then verify manually:

- Directly opening a nested frontend route survives refresh.
- Protected data does not load before authentication and appears immediately after login.
- Login-disabled, login-enabled, sign-out, invalid credentials, idle expiry, and cookie settings work.
- Sidebar/mobile navigation, keyboard focus, loading, empty, success, and error states are usable.
- Every setting reports saving/saved/error and survives restart as intended.
- All themes apply before first paint and every semantic state remains readable.
- The interface fits a normal desktop viewport while remaining usable at browser zoom and on mobile.
- Container data survives recreation, health checks pass, and the process is non-root.
- No PosterView credentials, databases, cached posters, branding, URLs, or domain behavior remain.

## Definition of done

The target is a successful extraction when it has PosterView's architectural qualities—one clear
backend composition root, protected typed APIs, a responsive themed shell, reliable authentication,
organized settings with visible automatic-save state, persistent configuration, production
packaging, and tests—while its product language, data model, workflows, branding, and repository
identity are wholly its own.
