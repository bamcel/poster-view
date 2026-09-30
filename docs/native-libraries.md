# Manual libraries and the native catalog

Settings → Libraries creates independent manual libraries without importing catalogs from Emby,
Jellyfin, or Plex. Existing connected-server workflows remain separate. Configuration sections are
General, Folders, Metadata, and Review. Movies, TV Shows, Anime, and Books are supported; Anime
can contain both shows and movies or either alone.

## Sources and storage

- Read local NFO metadata: enabled by default. Video NFO roots include movie, tvshow, season,
  and episodedetails. Books retain the custom series/book profile and folder-named series sidecar.
- Save metadata to NFO: disabled by default. Enable only for writable media. Writes preserve unknown
  XML fields, use a temporary file, and check for concurrent changes. Invalid existing XML and DTDs
  are never replaced. The database remains authoritative for manual edits even if writeback fails.
- Use local artwork: enabled by default. Recognizes poster/cover/folder, fanart/backdrop/background,
  banner, landscape, thumb, logo/clearlogo, and disc in JPEG, PNG, and WebP, including file-prefixed names.
- Fetch missing metadata and artwork: enabled by default. Anime and book-series identification uses
  AniList; movies/shows use TMDB. An existing TMDB identity in Anime can also use TMDB. Episode
  enrichment uses the parent show's TMDB ID and aired season/episode numbers. TMDB uses the saved
  credential from Search Providers. General novels without an AniList manga identity need manual data.

Local NFO values and artwork take priority. Only a unique exact title/year/type search result is
accepted automatically; unresolved matches appear in scan notices. Confirm a provider ID in the
catalog's Identification fields and scan again. Manual metadata changes and uploaded artwork are
locked against rescans. Imported provider responses remain stored with field source information,
including supplementary data. The initial AniList fetch stores up to 100 characters and 100 staff;
larger lists generate an explicit notice. Provider failures leave local data usable.

Metadata, identities, file records, credits, terms, characters, NFO associations, and artwork references
are stored in native tables in posterview.db. NFO XML is retained in its document record. Local
artwork references original media files; downloaded/uploaded images are managed under
/config/native-artwork. Reader preferences remain in reader.sqlite. No server catalog is imported.

## Scanning and browsing

New libraries start a background scan after creation. Existing configurations must be scanned manually.
Choose Open library, then Scan library. Local results are published before network enrichment;
status refreshes while scanning. The catalog supports search, series/season/episode navigation,
metadata editing, cast/crew editing, character information, and artwork upload.

Episode filenames use S01E01 or 1x01, or numbers from episode NFOs; Anime also recognizes the
common ' - 01' numbering pattern. Season folders use Season 01 or S01. Unrecognized mixed Anime
videos are treated as movies until identified; complex release layouts may require rearranging files
or adding NFO identity information. Video formats include MKV, MP4, AVI, MOV, M4V, WebM, TS,
MPG/MPEG, and M2TS. Book formats include PDF, EPUB, and CBZ. FFprobe ships in the container to
inspect duration, codecs, dimensions, audio, and subtitle streams; native installations need ffprobe
on PATH. Probe failures appear in notices and do not discard the media item.

Scans are limited to 50,000 files and 64 directory levels. Dot-prefixed files/directories and symbolic
links are skipped; paths and junctions are checked against the configured media root. Missing files
are marked unavailable without discarding metadata or manual edits. Item IDs remain stable for a
library/path; moving or renaming media creates a new identity. Interrupted scans are reported after
restart and can be run again. A failed traversal does not mark the entire catalog missing.

Delete library requires confirmation and the current library revision. It removes native library and
catalog records, leaving media, NFO files, and local artwork on disk. Editing or deleting library
configuration is blocked while its scan is running. Metadata edits use item revisions.

The folder browser uses logical /media-relative paths; its physical root follows POSTERVIEW_MEDIA_DIR
or container mount detection. Configuration roots cannot overlap. Existing books/NFO tools are retained;
the native catalog does not yet add a separate playback or book-reader route.

## API and migrations

All endpoints require the existing application authentication:

- GET/POST /api/native/libraries; PUT/DELETE /api/native/libraries/{id}
- GET/POST /api/native/libraries/{id}/scan
- GET /api/native/libraries/{id}/items
- PUT /api/native/libraries/{id}/items/{item} with revision and metadata
- GET/POST /api/native/libraries/{id}/items/{item}/artwork/{kind}

Migration 2 adds library source options, stable path-to-item mappings, scan status, artwork records,
and NFO XML storage to migration 1's catalog foundations. Both migrations preserve existing settings,
connections, history, credentials, and reader storage. Scan ingestion is transactional; manual field
protection, local-source priority, hierarchy, and relational projections apply within that transaction.

Backdrop folders (`backdrop` and `backdrops`, case-insensitive) are excluded from recursive media scans, including nested NCOP/NCED videos. Original files are left untouched.
