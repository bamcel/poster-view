# Working on PosterView

PosterView is Rust/Axum with SQLite and a React/TypeScript frontend, packaged as
one Docker image. Read `DEVELOPMENT.md` for the module map and storage details.
Follow the user's branch and shipping instructions. Inspect the working tree,
existing instructions and active agents before editing. Preserve unrelated
changes and local artifacts; never reset or overwrite someone else's work.

## Architecture and task locations

| Area | Location |
| --- | --- |
| Shared Rust serialization contracts | `crates/posterview-contracts/src/` |
| Plex/Emby/Jellyfin adapters | `crates/posterview-infra-media-servers/src/` |
| Remote artwork providers | `crates/posterview-infra-artwork/src/` |
| Application SQLite storage and migrations | `crates/posterview-infra-sqlite/src/` |
| Orchestration and artwork cache | `crates/posterview-runtime/src/` |
| URL trust rules | `crates/posterview-url-security/src/` |
| Server composition/state | `apps/server/src/lib.rs`, `state.rs` |
| HTTP adapters/central legacy registration | `apps/server/src/routes/` |
| Playback delivery, models, planning, segmented jobs and resources | `apps/server/src/playback/` |
| Native libraries/scans/identification/artwork | `apps/server/src/native*.rs` |
| Reading, metadata/NFO editing, watch persistence | `apps/server/src/reader.rs`, `metadata.rs`, `watch.rs` |
| Frontend playback/watch experience | `frontend/src/features/playback/` |
| Appearance/provider configuration | `frontend/src/features/settings/` |
| Remaining catalog/reader/authentication/shared UI | `frontend/src/components/`, `pages/`, `lib/` |
| Shared browser transport and existing API models | `frontend/src/api/client.ts`, `nativeLibraries.ts`, `frontend/src/types.ts` |

Use existing crates and feature boundaries. Add a crate only for a concrete
dependency or ownership problem, not because a file is large. Move code when a
responsibility gains a useful owner; avoid cosmetic sweeps and unnecessary wrappers.

## Delegation and ownership

Use subagents for substantial independent implementation, investigation or review;
they are optional for small changes. Give each agent an objective, exact allowed
files/directories, assumed interfaces, verification scope and read-only/edit mode.
Name files it must not edit. Reserve ownership before work starts; use one writer
per file.

The main agent owns integration and shared boundaries:

- Rust contracts, frontend shared DTOs, public API shapes and error/status semantics.
- Dependencies/lockfiles, migrations/persistent schemas, configuration, deployment,
  CI and project instructions.
- Server composition/state/central route registration and shared test fixtures.
- Frontend routing/layout/bootstrap, global CSS, shared transport and shared UI.

The main agent may delegate a bounded shared-file change, but must sequence and
review it. Feature-owned routers and API clients can change within an agreed
contract. Request integration changes instead of independently adding routes,
dependencies, state fields or migrations in shared files.

Concurrent edits suit disjoint implementations with agreed interfaces, or
read-only reviews. Sequence overlapping files, renames/import rewrites,
dependencies/contracts/schemas and shared integration. Separate agents/branches
do not isolate edits in the same checkout. Agents hand off changes and results;
they do not commit, push or deploy unless explicitly assigned that responsibility
within the user's authorization.

Remaining large files such as `NativeLibraryBrowser.tsx`, `ReaderPage.tsx`,
`native.rs`, `reader.rs` and `watch.rs` require one assigned writer until their
responsibilities are split. Reserve narrower files explicitly when splitting them.

## Verification and completion

Run focused behavior tests while changing a boundary. Keep tests adjacent to their
feature or in its existing test module. Do not add file-location tests. Preserve
URLs, JSON names/defaults, storage compatibility, authentication, query/storage
keys and deployment behavior unless the user requests a change.

For a cross-project refactor, complete:

```sh
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
# From frontend/:
npm test
npm run build
```

Set the working directory explicitly. Serialize Cargo tests/builds sharing a
target directory on Windows; running test executables can prevent relinking.
Independent frontend checks and read-only searches can run in parallel. Compare
failures with the pre-edit baseline, fix regressions, and report existing failures
separately. Do not suppress lints or skip checks to manufacture success. A serial
diagnostic test run does not replace reporting the requested command's outcome.

Review the diff for unrelated changes/secrets. Keep commits focused and finish
with the change, ownership benefit, verification and limitations. Honor existing
user authorization for committing/pushing; repository instructions do not grant
deployment, merge or push permission by themselves.

## Development branch policy

Until the user explicitly changes this policy, work on `development` and push
only to `origin/development`. Before editing, committing, or pushing, verify
`git branch --show-current` and `git status --short --branch`. Use an explicit
push destination (`git push origin HEAD:development`) after verifying the current
branch is `development`. Do not merge into or push to `main` or `experimental`
without explicit user direction. Preserve unrelated local changes.
