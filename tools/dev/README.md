# Shared Unraid development

The shared checkout is `\\192.168.1.100\projects\poster-view`, backed by
`/mnt/cache/projects/poster-view` on Unraid. Open this same folder from either
computer. Do not copy it into a second local checkout for live development.
Use your existing Unraid SMB account (`brett`) with read/write access.

The preview is at http://192.168.1.100:5173. Saved frontend changes reload through
Vite. Saved Rust changes trigger an incremental build and restart the backend
after a successful build. A failed build leaves the previous backend running;
fix the source and save again to retry. The first build takes longer because
the dependency caches start empty. Changing lockfiles may require a restart.

Run commands in the Unraid terminal:

```sh
cd /mnt/cache/projects/poster-view
docker compose -f compose.dev.yml up -d --build
docker compose -f compose.dev.yml logs --tail=80 -f
# Stop without deleting the database or caches:
docker compose -f compose.dev.yml down
# Reinstall frontend dependencies after changing package-lock.json:
docker compose -f compose.dev.yml restart frontend
```

Vite on port 5173 proxies API requests to the backend. Port 7979 also serves the
backend and the most recently built frontend; run `npm run build` in the frontend
container to refresh that static UI. Use 5173 for automatic frontend updates.

The previous `PosterView-Development` image-based container is replaced by this
Compose stack. It uses the existing `/mnt/user/appdata/posterview-development`
directory, preserving accounts, libraries, settings, artwork and credentials.
Do not run another server against this same directory concurrently. The media
mount retains the existing `/mnt/user` to `/media` mapping and write access, so
edits in this environment affect your real development data and media files.
The application runs as UID 10001 / GID 100, matching the existing appdata owner.
The stopped-server database/config files were backed up under
`appdata/posterview-development/workspace-backup-20261019` before the switch.
No Ollama service is used.

Build caches and node_modules live in Docker volumes. `down` retains them;
`down -v` discards those caches. Appdata is a bind mount and survives both, but
should still be backed up independently. Database files and credentials stay
outside the shared source checkout.

Override `POSTERVIEW_DEV_MEDIA_ROOT` or `POSTERVIEW_DEV_APPDATA` in a local `.env`
if needed. Override `POSTERVIEW_DEV_PORT` (5173), `POSTERVIEW_DEV_API_PORT` (7979),
`PUID` or `PGID` for another host.
The tools live inside `posterview-workspace:local`; Unraid needs only Docker
Compose and Git. Builds, npm and tests run on Unraid, not over SMB on Windows:

```sh
docker compose -f compose.dev.yml exec frontend npm test
docker compose -f compose.dev.yml exec frontend npm run build
docker compose -f compose.dev.yml exec backend cargo test --workspace --locked
```

Keep one active editor/agent per file when moving between computers. Save and
close work on one computer before editing it on the other. Git remains useful
for checkpoints and backup; a push is not required to preview changes. Both
computers see the same branch, uncommitted changes and Git index. Continue using
`development` and push only to `origin/development` when ready.

If Windows Git reports dubious ownership, trust only this exact checkout:

```powershell
git config --global --add safe.directory '//192.168.1.100/projects/poster-view'
```

In the root Unraid terminal, use the bounded equivalent rather than trusting all
repositories:

```sh
git -c safe.directory=/mnt/cache/projects/poster-view status --short --branch
```

The SMB share should remain Secure. This development server exposes source and
debug tooling to the LAN; do not forward its port through the Internet proxy.
