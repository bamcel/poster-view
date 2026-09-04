# Authentication and login handoff

## Task for the receiving developer or coding agent

Port PosterView's authentication, login screen, and Privacy / Security settings into the target
application. Preserve the existing appearance and behavior; do not redesign the login screen.
Use the target application's branding, environment-variable prefix, and storage/event namespace.
Integrate with its existing routes and providers rather than replacing application functionality.
Do not copy media-server, artwork, or database features that are unrelated to authentication.

Reference repository: https://github.com/bamcel/poster-view

Pinned reference revision: `6e8621b70ce43ddb14f20e95ad3a5488af4c5ad7`.
Use this revision rather than an evolving `main` branch for a faithful port.
Source URL pattern:
`https://github.com/bamcel/poster-view/blob/6e8621b70ce43ddb14f20e95ad3a5488af4c5ad7/<path>`.

## Source files to reuse

Copy or adapt these frontend modules together:

- `frontend/src/components/AuthGate.tsx`: login form, auth-status refresh, and authenticated boundary.
- `frontend/src/lib/authContext.ts`: shares effective authentication policy with the layout.
- `frontend/src/lib/useIdleSession.ts`: user-activity tracking and inactivity logout.
- `frontend/src/lib/rememberUsername.ts`: browser-local username preference.
- `frontend/src/components/SecuritySection.tsx`: Privacy / Security settings form.
- Authentication types/methods and shared request/401 handling from `frontend/src/api/client.ts`.
- Provider placement from `frontend/src/App.tsx` and `frontend/src/main.tsx`.
- Conditional sign-out controls and bottom-sidebar positioning from `frontend/src/components/Layout.tsx`.
- Settings-tab registration from `frontend/src/pages/SettingsPage.tsx`.
- Theme tokens/global styles from `frontend/src/index.css`, and theme initialization/application
  from `frontend/src/lib/theme.ts`. Reuse the `Logo` component structure from
  `frontend/src/components/ui.tsx`, replacing its image and brand with the target application's.

Backend and deployment references:

- `apps/server/src/auth.rs`: credentials, session cookies, expiry, LAN bypass, persisted settings.
- Authentication/security handlers and `require_auth` middleware in `apps/server/src/lib.rs`.
- `apps/server/src/config.rs`: environment parsing and defaults.
- `apps/server/src/main.rs`: auth initialization and TCP peer connection information.
- `apps/server/src/error.rs`: JSON errors; adapt dependencies on the target application's error types.
- `apps/server/Cargo.toml` and root `Cargo.toml`: Rust dependency definitions.
- `templates/posterview.xml`: Unraid login fields and their order.
- `docker-compose.yml`: environment/data-volume integration.

The frontend uses React, TypeScript, React Router, TanStack Query, Tailwind CSS v4, and
`lucide-react`. Match the reference package manifest/lockfile when using the same stack.
The backend is Rust/Axum with Serde, UUID, subtle, Tokio, and tracing. If the target has another
backend stack, reproduce the HTTP contract and server enforcement rather than relying on a
frontend-only login gate.

## Appearance: preserve the reference components and classes

- Full-height themed background, centered sign-in card, horizontal padding on small screens.
- Card: `w-full max-w-sm rounded-xl border border-border bg-surface p-6 shadow-xl`.
- Brand/logo at the top; below it a 40px rounded icon tile with the Lucide `LockKeyhole` icon.
- Heading: “Administrator sign in”. Supporting text: “Enter your APP_NAME username and password.”
- Visible Username and Password labels, stacked full-width inputs. Username is plain text;
  password is masked. Keep `autoComplete="username"` and `autoComplete="current-password"`.
- Inputs: `rounded-lg border border-border bg-input px-3 py-2.5`, with an accent focus border.
- Full-width accent “Sign in” button, disabled and displaying `Loader2` while submitting.
- Inline error below the password field using `role="alert"`; centered spinner while checking auth.
- Match the existing theme system, not just a hardcoded background/accent approximation.
  Initialize the theme before rendering and preserve the root height/global font rules.
- Privacy / Security uses the same surface cards, controls, muted help text, and amber risk warning.
- Desktop Sign out belongs at the bottom of the sidebar, immediately above the application's
  bottom context/account/server panel. It is not directly below Settings.
- Preserve mobile sign-out access in the header. Hide both controls when `password_required` is false.

## Authentication behavior

1. Check `/api/auth/status` before mounting any protected application providers or pages.
   Show only a loading state until that check finishes.
2. Mount data-fetching providers inside `AuthGate`, not above it. The reference fixed a bug where
   requests ran before login and failed, leaving an empty dashboard until a manual refresh.
3. Require both username and password. The default username is `admin`; usernames are case-sensitive.
4. Display the configured username from auth status when remembering is enabled. It overrides
   stale remembered `admin` after a container username change. Never overwrite active typing.
5. After successful login, remember the username if enabled, clear the password, and reveal the app.
6. “Remember username on this browser” defaults to enabled and saves immediately, independently
   of server-wide settings. Disabling it deletes the saved value and leaves future sign-in input blank.
   Never store the administrator password or session token in local/session storage.
7. Poll auth status every 15 seconds and refresh on security-setting changes. Preserve the revision
   guard so an older response cannot undo a newer login or session-expiry transition.
8. Shared API handling must announce HTTP 401 responses so the gate returns to sign-in.
9. Sign out revokes the current server session, clears its cookie, and returns to the app root.

## HTTP contract

Keep requests same-origin. Return JSON errors as `{ "detail": "message" }`.

| Endpoint | Behavior |
| --- | --- |
| `GET /api/auth/status` | Public; returns `username`, `authenticated`, `password_required`, and nullable `idle_timeout_minutes`. Does not extend a session. |
| `POST /api/auth/login` | JSON `{ "username": "admin", "password": "..." }`; validates both, sets session cookie, and returns auth status. Invalid credentials receive 401 with “Incorrect username or password.” |
| `POST /api/auth/logout` | Revokes the cookie's session and expires the cookie. Returns `authenticated: false`. |
| `POST /api/auth/activity` | Protected; extends a valid, unexpired session. Returns 204; expired sessions receive 401 and cannot be revived. |
| `GET /api/security/settings` | Protected; returns `{ "idle_timeout_minutes": null, "local_network_bypass": false }` by default. |
| `PUT /api/security/settings` | Protected; validates and persists those fields, returning the saved settings. Timeout must be null or an integer from 1 through 1440. Invalid values receive 400. |

The public status endpoint intentionally exposes the configured username for prefilling, never
the password. Treat the username as a convenience identifier, not a secret security factor.

## Sessions and inactivity

- Generate opaque, random session tokens and keep them server-side in memory.
- Cookie: app-specific name, `Path=/`, `HttpOnly`, `SameSite=Strict`, optionally `Secure`.
- Sessions do not survive server restart. Security preferences and configured credentials do.
- Auto sign-out defaults to disabled (`idle_timeout_minutes: null`); the UI suggests 30 minutes
  when the feature is enabled without a previous duration.
- Enforce expiry on the server using monotonic last-activity time, not only a browser timer.
- Only activity requests refresh last activity. API polling, images, and background tasks do not.
- Count pointer movement/clicks, keyboard, touch, and scrolling. The reference checks once per
  second, throttles activity submissions, and shares activity across same-origin tabs through storage events.
- A suspended tab must check expiry before accepting fresh input. Clean up timers/listeners on unmount.
- Password-free access has no login barrier to restore: disable inactivity logout for it and hide Sign out.

## Configuration and Unraid template

Replace `APP_` below with the target application's own prefix:

| Variable | Meaning and reference default |
| --- | --- |
| `APP_AUTH_ENABLED` | `true` or `false`. Runtime default if omitted: true. Unraid template explicitly selects false. False disables login for ALL connections. |
| `APP_USERNAME` | Default `admin`. Blank configuration falls back to admin. |
| `APP_PASSWORD` | Configured password; if absent/blank, generate and preserve an administrator password in the data directory. |
| `APP_SECURE_COOKIES` | Enable for HTTPS deployments; do not require Secure cookies on plain HTTP LAN access. |
| `APP_DATA_DIR` | Persistent data directory; normally `/data` in the container. |

Unraid fields must appear in this order:

1. Require Login: optional variable, choices `false|true`, selected value `false`.
2. Administrator Username: optional variable, default/value `admin`, unmasked.
3. Administrator Password: optional variable, blank default, masked, last in the group.

Use the reference XML's `Default="false|true"` choice list and inner value `false` for Require Login.
Explain that false grants access to everyone who can reach the service, including reverse-proxy
visitors. Do not describe it as LAN-only. Preserve credentials while disabled so enabling login
restores them. Changing environment settings requires recreating the container.

Persist shared preferences in `security-settings.json` inside the data directory. Use validated,
atomic updates; report write failures. The generated `admin-password.txt` is sensitive plaintext:
restrict its filesystem permissions and never serve or log its contents.

## LAN bypass: preserve the explicit risk warning

The separate local-network bypass setting defaults to false. When enabled, use the actual TCP
peer address: private IPv4, loopback, link-local, and IPv6 unique-local addresses qualify, including
IPv4-mapped IPv6. Missing peer information fails closed. Do not trust forwarded headers or Host
to identify a LAN client. The reference does not classify Tailscale IPv4 100.64.0.0/10 as private.

Use generic wording, not a particular proxy product's name:

> Warning: Anyone whose connection appears local gets full access without a password. A reverse
> proxy or Docker networking can make remote visitors appear local too, including visitors using
> your public domain. Enable only if you accept this risk.

Global authentication disabled takes precedence over LAN bypass and inactivity settings. Retain
this behavior for parity, but do not silently enable it on an existing target deployment. Confirm
the target's deployment defaults, especially if publicly reachable.

This is single-administrator authentication, not a multi-user identity system. Do not claim MFA,
account recovery, role-based access, login throttling, or public-service hardening that is not
implemented. If those are needed, scope them separately. Keep TLS, network restrictions, and
reverse-proxy protections in place where appropriate.

## Rename and integration checklist

- Replace PosterView branding, logo, environment prefix, and cookie name.
- Rename all `posterview.*` browser storage keys and `posterview:*` events together; they must
  remain consistent across the API client, gate, settings, and inactivity hook.
- Give each app a unique cookie name; cookies are not isolated by port.
- Keep browser preference keys unique even when apps share an origin.
- Preserve the target application's data/providers under the auth boundary.
- Protect all target APIs except explicitly public health/auth routes. Test the real server
  entry point supplies peer information for LAN bypass, not just the middleware in isolation.
- Adapt root redirects, cookie paths, API prefix, and router basename together if deploying under
  a URL subpath; the reference assumes root-path deployment.
- Preserve the target app's runtime data and existing edits. Do not copy credentials, session
  files, real settings, or historical user data from PosterView.

## Acceptance tests and handoff completion

Port the applicable tests from `apps/server/src/auth.rs`, `apps/server/src/tests.rs`, and:
`frontend/src/components/AuthGate.test.tsx`, `Layout.test.tsx`, `SecuritySection.test.tsx`,
`frontend/src/lib/useIdleSession.test.tsx`, `frontend/src/api/client.test.ts`, and
`frontend/src/App.test.tsx`.

Verify default/custom usernames; wrong username and wrong password rejection; configured username
replacing stale admin; no overwrite while typing; remembering off; no stored passwords; protected
providers loading immediately after login; session expiry without background keepalives; cross-tab
activity; settings persistence; bypass disabled by default; public/missing peers rejected;
reverse-proxy risk disclosure; global login disabled; and both responsive Sign out controls.

Run frontend tests and production build, Rust tests/fmt/strict Clippy (when applicable), XML and
Compose validation. Visually compare the sign-in form and settings on desktop and mobile to the
reference components using the same theme. Report any intentional deviations and verification
limits. Do not commit, push, or deploy the target app unless its user requests it.
