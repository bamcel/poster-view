# Frontend-specific guidance

- `src/features/playback/` contains the player, watch controls, helpers, clients
  and adjacent tests. `types.ts` is its canonical wire contract. Delivery and
  watch/prefs/rules endpoints have separate clients with one implementation each.
- `src/features/settings/appearance/` and `providers/` own independent forms.
  `pages/SettingsPage.tsx` is composition. Plugins import provider forms directly;
  preview loads settings lazily to avoid a static page/appearance/preview cycle.
- Keep broadly reused UI/utilities in `components/` and `lib/`. Catalog, reader
  and authentication remain in established locations until a useful boundary is
  extracted. Do not move directories merely for naming consistency.
- JSON requests use shared `apiRequest` in `api/client.ts`; preserve its error and
  authentication handling. Feature clients own feature URLs, not another transport.
  Binary media/subtitle/font loading has separate delivery requirements; preserve
  same-origin URLs, cancellation and existing error behavior.
- Main integration owns `App.tsx`, `Layout.tsx`, `main.tsx`, global CSS, shared
  types/transport, dependencies and configuration. Request these edits when your
  assigned feature does not explicitly reserve them.
- Move `.test.ts(x)` files with their implementation and update imports/mocks.
  Preserve interaction, query, URL, storage-key and compatibility assertions.
  Page-level settings tests still verify composition; extract behavior tests when
  their scope changes. Do not create file-location tests.

Run commands from `frontend/`: `npm test -- src/features/playback`,
`npm test -- src/pages/SettingsPage.test.tsx`, then `npm test` and `npm run build`.
