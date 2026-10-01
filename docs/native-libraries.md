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
- Fetch missing metadata and artwork: enabled by default. AniList is the default for
  Anime and manga book series; TMDB is the default for other video types. Library
  settings allow other supported providers and independent image-provider priority.
  Episode/season enrichment uses the parent series identity and aired numbers.
  General novels without a supported manga identity need manual data.

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
Choose Scan files directly on the library card. Local results are published before network enrichment;
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

## Library settings

Creation and editing use General, Folders, Library Settings, Metadata, Artwork,
Advanced, and Review sections. Existing settings JSON receives defaults for new
options without a destructive database migration.

Working options:

- Metadata language and certification country for TMDB; AniList title preference
  uses English or Japanese (other languages fall back to English/Romaji).
- Preferred TMDB image language, with neutral images and provider defaults as fallbacks.
- Embedded video title fallback when no NFO title exists; internet identification
  can replace this fallback, but local NFO and manual values keep priority.
- Ignore filenames containing `sample` below a chosen size in MiB (default 300,
  0 disables the rule). Backdrop directories remain excluded.
- NFO reader and saver, local artwork, internet gap filling, adult metadata matching.
- Independent metadata and image provider enablement/order per media type. Explicit
  empty lists disable every source for that type. Lower priority sources fill gaps.
  AniList supports Anime movies/series and manga book series; TMDB supports movies,
  series, seasons, and episodes. TheTVDB supports these video types too. MyAnimeList
  supports Anime movies/series and manga series; OMDb supports movies, series, and
  episodes. AniDB supports Anime movies, series, and episodes. FanArt is an artwork
  source for movies, series, and seasons. Credentials are configured in Search Providers.
- Download toggles for poster, backdrop, thumbnail, logo, and banner artwork.
  One missing image per selected type is downloaded when a provider offers it;
  local artwork remains independent of these download toggles.

Unavailable features are visible but disabled and labeled: global-search exclusion, merged
folder view, `.plexignore`, automatic series grouping, scheduled metadata refresh,
collections, minimum artwork width, local image caching, lazy image
fetching, chapter generation, and video resume settings. They do not save active
options or promise background behavior. Provider artwork is currently downloaded
during a scan into application data; manual scans retain populated metadata.


## Provider configuration and monitoring

Search Providers includes saved credential controls for MyAnimeList (client ID),
OMDb (API key), and AniDB (registered HTTP client name and version), alongside
the existing TMDB, TheTVDB, and FanArt controls. Secret credentials are encrypted
in application storage and are not returned by the settings API. Test buttons
check saved credentials; selecting a provider does not supply its credentials.

AniDB requires an existing AniDB ID in the item NFO/identification; it does not
guess anime identities from titles. Its requests are serialized, spaced at least
three seconds apart, limited to 200 per day, and cached for 24 hours. Rejected
responses pause requests for 15 minutes. Sequel seasons require their own anime
identity; automatic episode lookup supports season 1 and specials. FanArt needs
a TMDB/IMDb movie ID or TVDB series ID. Episode and season providers use the
parent series identity. Provider failures appear in scan notices and preserve
local data. Adult classifications are honored where providers expose them.

Enable **real-time monitoring** under Library Settings to automatically rescan
a library when its files change. It is off by default. Filesystem notifications
are backed by 15-second polling for network mounts. Changes are debounced for
five seconds, with a maximum 30-second batching window; a queued scan waits for
an active scan to finish. Hidden paths and backdrop directories are ignored.
Turning monitoring off or deleting a library removes its watchers. Monitoring
uses the same scanner, local-source priority, and manual-edit protection as
Scan files; it does not enable scheduled internet metadata refresh.


## Artwork in media folders

Enable **Artwork → Artwork Storage → Save artwork into media folders** in a
manual library. It is off by default and requires writable media mounts. A scan
also exports already downloaded/uploaded images, even when internet fetching
is disabled. Managed originals and database references remain in application
data. Local images are left in place.

Sidecar names and encodings:

| Artwork | Filename | Location |
| --- | --- | --- |
| Poster | `poster.jpg` | Movie or series folder |
| Backdrop | `fanart.jpg` | Movie or series folder |
| Landscape/thumbnail | `landscape.jpg` | Movie or series folder |
| Clearlogo | `clearlogo.png` | Movie or series folder |
| Season poster | `season01-poster.jpg`, `season02-poster.jpg`, etc. | Series folder |
| Episode thumbnail | `<video filename without extension>.jpg` | Beside the episode |
| Banner / disc | `banner.jpg` / `disc.png` | Movie or series folder |

PNG clearlogos preserve transparency; JPG sidecars are encoded as JPEG, even
when the original download/upload was PNG or WebP. Movies sharing a flat folder
use `<filename>-poster.jpg`, `<filename>-fanart.jpg`, etc. to avoid collisions.
Individual books keep filename-based cover images.

Scans preserve existing sidecars. Explicit manual uploads replace the matching
sidecar atomically. Identical writes are skipped to avoid repeated monitoring
rescans. Failed exports appear in scan notices; upload errors explain that the
managed image was saved even if the sidecar write failed. Season posters and
episode thumbnails are recognized as local artwork on subsequent scans.


Scan cards show live phases, item counts, and the current relative path. Discovery
shows files found with an indeterminate indicator; local reading and provider
fetching show their own processed/total counts and percentage. Percentages are
per phase, not an estimate of overall completion or remaining time. Updates are
throttled to twice per second and the interface polls every two seconds.
