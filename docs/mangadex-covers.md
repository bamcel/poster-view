# MangaDex covers

Open a library item, choose **MangaDex** in Artwork, and search by title,
alternate/Japanese title, or MangaDex UUID. Select a series, browse its volume
covers, open a preview, and choose **Use Cover**. MangaDex needs no API key.
If the tab is hidden, enable MangaDex in Settings → enabled artwork databases.
Existing saved provider preferences are preserved on upgrade.

Volume numbers are suggested from media-server metadata, item titles, or filenames
such as `Food Wars v14.epub`. The suggestion never applies a cover automatically.
Edit and save the volume, filter by language or matching volume, or change series
at any time. Unknown volumes/languages remain browseable. The gallery loads 24
thumbnails at a time; **Load more** reveals the next batch. **Refresh search** and
**Refresh covers** bypass metadata caches. Manual artwork selection remains available.

Book and audiobook libraries returned by Emby/Jellyfin are included in discovery,
item listing, and item detail. Manga/book libraries browse their real folder hierarchy:
the library grid shows immediate series folders such as **Food Wars!**, opening a
series shows its volume folders, and opening a volume reaches the book item. The
Library page respects Settings visibility for every library type, including manga
libraries reported as `other`.

## Implementation

- MangaDex extends the existing `ArtworkService` search/fetch provider interface
  and normalized artwork contracts. The provider uses MangaDex's supported API:
  [`GET /manga`, `GET /manga/{id}`, `GET /cover`](https://api.mangadex.org/docs/swagger.html).
  The cover endpoint is paged with `limit=100`; volume, locale, and description
  come from cover attributes. Description is retained without assuming it names
  an edition. Alternate titles remain available for disambiguation.
- The MangaDex panel reuses artwork image/button components and the existing
  apply endpoint, server upload, image caching, and revert history. Preview and
  thumbnail images pass through a cached proxy restricted to HTTPS on
  `uploads.mangadex.org`, including redirect validation.
- Series selection is explicitly saved through
  `GET/PUT /api/artwork/mangadex/selection?server_id=…&item_id=…`. The existing SQLite
  settings store holds `mangadex-selection:{server_id}:{item_id}` independently
  of the expiring artwork cache. It retains the series UUID/title, user volume,
  and the last selected cover record, including cover UUID, volume, locale,
  description and full image URL. These fields do not rewrite EPUB files.
- Saved series UUIDs are reused when artwork is requested without an override.
  React Query keys and a 400 ms debounce keep late search results from replacing
  current results. Failed lookups are not persisted in the server cache.

## Verification

Run `cargo test --workspace --locked`, `cargo clippy --workspace --all-targets --locked -- -D warnings`,
`cargo fmt --all -- --check`, and frontend `npm test` / `npm run build`.

The opt-in acceptance test reads live MangaDex data and applies a real downloaded
Food Wars volume 14 cover **only to a local mock media server**. It checks saved
identity lookup, thumbnail decoding, upload, cover metadata and history. It also
checks One Piece cover pagination:

```sh
cargo test -p posterview-server live_mangadex_food_wars_search_cover_apply_and_history --locked -- --ignored --nocapture
```

Normal tests cover book-library browsing, alternate titles, incomplete cover
metadata, source URL validation, selection persistence/isolation, volume parsing,
debouncing, explicit application, saved-series restoration, filtering and retries.
