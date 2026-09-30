# Native libraries: initial foundation

Settings → Libraries creates and edits native configurations without importing a connected server.
The dialog has General, Folders, and Review sections. Movies, TV Shows, Anime, and Books are supported
configuration types; Anime defaults to shows and movies. These configurations are not yet indexed
or exposed as browsable native catalogs. Automatic scanning, provider enrichment, and native reader
integration are subsequent work. No settings for unavailable services are exposed.

The multi-folder browser starts at the logical `/media` root (the physical root can be overridden by
`POSTERVIEW_MEDIA_DIR`). Roots are stored as relative paths, validated against the mounted directory,
and cannot overlap within a library. Selection supports multiple directories across browser navigation.
Library names are unique ignoring case; updates require the last observed revision. Inaccessible media
folders produce an error rather than a successfully configured library. Existing book/NFO tools remain
independent and unchanged.

Authenticated API:

- `GET /api/native/libraries`
- `POST /api/native/libraries`
- `PUT /api/native/libraries/{id}`
- `GET /api/metadata/folders?path=…` (existing guarded folder browser)

Create body: `{"name":"Anime","library_type":"anime","anime_content":"both","paths":["Anime/Shows","Anime/Movies"],"revision":null}`.
For updates, supply the integer revision returned by the preceding read. Stale revisions return 409.

Migration 1 adds native libraries/roots and catalog foundations to `posterview.db`, preserving current
connections, settings, history, and `reader.sqlite`. Catalog IDs are independent of remote server IDs.
The schema includes item hierarchy, many-to-many library membership, namespaced provider identifiers,
tags/genres/studios/publishers, people, independent characters/appearances, typed credits, metadata
values with source/lock/revision, files/streams, alternate episode numbering, and NFO associations.
These metadata tables are storage foundations, not a claim that their ingestion/editor workflows exist.
The migration and its ledger entry commit together; repeated startup does not recreate these tables.
No legacy tables or files are removed.
