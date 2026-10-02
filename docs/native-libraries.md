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
/config/native-artwork. Reader preferences remain in reader.sqlite. Server metadata import is optional and updates only matched manual items.

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


## Dashboard comparison

The Dashboard uses one library tab row: the active server's libraries appear first,
followed by manual libraries with a small Manual label to distinguish matching
names. Manual libraries show their native catalog directly on the page, including
search, artwork, scan progress, metadata and child items. Library and item selection
are represented in the URL, so Back returns to the correct library. Without a
connected server, the Dashboard opens manual libraries automatically. Manage
manual libraries in Settings → Libraries.


## Background workers

Manual-library scans share bounded media and network workers across libraries:

- Two media workers inspect video files with ffprobe and handle image encoding,
  media-folder artwork export, and NFO writeback. Inspection has its own live
  progress phase. Catalog assembly and database projection remain coordinated.
- Four network slots bound metadata requests, artwork downloads, and bulk edition
  lookups. Provider jobs process root titles first, then seasons, then episodes.
  Children receive the completed parent identifiers, and provider priority remains
  sequential within each title. Artwork types download independently, with each
  type trying its sources in priority order.
- Provider gates are shared across scans. AniList jobs are spaced by at least
  1.5 seconds and other provider jobs by 250 ms; AniDB retains its stricter
  serialized requests, daily quota, and cache. Rate-limited providers are skipped
  for the remaining jobs in that scan.
- Bulk edition edits run two requests at once, with per-item results and retries.
  Stop After Active Items lets the active writes finish and leaves queued items
  available through Continue Remaining.

Optional environment settings `POSTERVIEW_MEDIA_WORKERS` (default `2`) and
`POSTERVIEW_NETWORK_WORKERS` (default `4`) accept integers from 1 to 8. Invalid
values use the defaults. Restart the application after changing them. The budgets
are process-wide, so concurrent scans share the same limits. These workers use
the existing scan and database lifecycle; they do not introduce a durable job
queue or automatically retry jobs across restarts.


Internet gap filling requires title/overview for movies, series, book series, and
episodes; seasons require a title. Missing genres, cast/crew, and other optional
fields do not independently trigger lookups. Episode downloads target thumbnails
only; season downloads target posters only. Local landscape images satisfy a
thumbnail requirement. Movies and series use their enabled image types.

Metadata providers stop once essential fields are present. Image providers are
tried separately in their configured order until the applicable images have
been saved. Responses are reused when a provider serves both purposes. A failed
image download leaves its type missing, allowing a lower-priority image source
to try. Local and manual values remain protected.

Real-time monitoring ignores PosterView's own NFO and artwork sidecar writes, including delayed polling notifications, so saving scan results does not queue another scan. External file edits, additions, and deletions remain monitored.

Auxiliary folders (`extras`, `extra`, `trailers`, `featurettes`, `behind the scenes`, `deleted scenes`, and `interviews`, case-insensitive) are also excluded from scanning and monitoring. `Specials` remains included for series special episodes. Rescanning removes previously indexed auxiliary videos from the available catalog without deleting media files.

NCOP/NCED credit-video filename tokens (including numbered and versioned variants) are excluded even outside auxiliary folders. Manual library browsing shows available entries only; a rescan hides previously indexed exclusions while retaining catalog history.

Manual Dashboard browsing uses the shared poster cards, library backdrop, title information, synopsis, About section, and detail action styling from connected-server views. Series open into seasons, seasons into episode thumbnail lists, and episodes into their own detail views. Metadata opens in an editor dialog; artwork opens in the shared provider panel. Manual title links use `native_library` and `native_item` URL parameters so refresh and browser history preserve the selected title. Library scanning and removal remain in Settings → Libraries.

`Specials` and `Special` folders belong to their parent series as season 0. Named season folders beneath a series `tvshow.nfo` also inherit that series, within the selected library root. A rescan marks old standalone Specials records unavailable.

The manual Dashboard groups series with matching confirmed provider IDs, combines matching season numbers, and retains all episode/file records. Matching titles alone do not trigger grouping, and conflicting TVDB/TMDB/IMDb identities stay separate. Grouping changes presentation rather than deleting or rewriting either folder.

AniList character and staff connections are paginated beyond the first 100 results, with a 5,000-entry limit per connection. Later-page failures retain earlier data and report partial imports. Previously truncated provider lists can be extended when AniList is fetched again; local and manual credits retain priority. Pagination follows AniList’s connection and `hasNextPage` documentation: https://docs.anilist.co/guide/graphql/connections and https://docs.anilist.co/guide/graphql/pagination. Missing provider configuration skips that provider for the remaining scan; failed HTTP requests include status codes without exposing request URLs or API keys. The metadata editor includes MAL and AniDB identifiers.

Manual dashboard artwork requests use a library-scoped lookup for one image, rather than loading the full catalog for every poster. Browsers may privately cache images for 60 seconds; artwork URLs include the item revision so edits load the new image. The dashboard retains catalog data as fresh for 60 seconds when returning to a library, and refreshes after a scan finishes or an edit is saved. External image-file changes can take up to 60 seconds to appear at an unchanged URL.

Automatic monitoring coalesces changed paths and scans the affected title folders instead of the whole library. Anime retains its Mixed classification rules for series and movies. Scoped database reconciliation marks missing records unavailable only inside those folders; unrelated titles, manual edits, and artwork are retained. Changes arriving during an active scan remain queued. NFO/artwork writes are limited to the affected records. Initial scans and the manual Scan files action remain full scans. Watcher errors or event overflow trigger a full recovery scan; loose files directly inside a selected library root also reconcile that root because their sidecars and sibling media share it.

Monitor self-write fingerprints remain valid until the file actually changes (bounded to 50,000 tracked paths), so delayed polling notifications from long scans do not expire after a minute. Repeated watcher errors request one recovery scan per outage, rather than continuously rescanning; a real external change or watcher reconfiguration permits another recovery request. Directory rename events remain eligible for reconciliation.

Cast portraits survive NFO saves: actor thumbnail URLs and extra actor fields are preserved, and provider portraits can fill missing images without replacing existing local images or manually locked credit lists. Manual detail pages also resolve missing portraits from matching cached AniList, TMDB, or TVDB people data; no additional network metadata requests are required for that fallback.
# Anime voice cast

Anime series and movies show original-language voice cast first, followed by voice cast in the library's **Preferred metadata download language**. Matching original and preferred languages produce one group. Actors who voice several characters appear once per group with their character roles combined; production crew remains separate.

AniList supplies voice actors and portraits for each available language. Missing language casts are shown explicitly rather than substituted. Original language uses stored original-language metadata first, then infers language from country of origin when available; country is a fallback, not a verification of the audio track.

After updating, run **Scan files** once for existing anime libraries with AniList enabled as a metadata downloader and missing-metadata fetching enabled. This backfills multilingual voice cast even for otherwise complete titles. A successful result is recorded, including empty casts, so missing dub data does not cause repeated enrichment on every scan. Changing the preferred language then uses the stored multilingual cast.

## Manual-library artwork panel

Manual titles use the same artwork source panel and lookup UI as connected-server titles, including ThePosterDB, AniList, Fanart, TheTVDB, Mediux, book providers, manual uploads, and removal. Provider credentials remain in Search Providers settings. Searches use the native catalog's title and stored provider identifiers, with parent-series identifiers available for seasons and episodes. No connected media server is required.

Applying an image stores a managed image in application storage and records a locked manual artwork choice in the native database. The catalog revision changes and the dashboard refreshes immediately. Rescans preserve that choice. If **Save artwork into media folders** is enabled, the explicit selection also replaces the corresponding media-folder image using the configured naming rules. Season poster targets and episode thumbnails are supported. Changes are blocked while the library is scanning.

Explicit static artwork removal clears the database reference and removes the recorded static sidecar, retaining a managed backup. With Connected Server Sync enabled, it also queues deletion on supported linked servers. Animated variants are removed separately and do not delete the static selection. Provider downloads use the existing validated download and cache paths, with manual-library requests isolated from connected-server caches.

### MyAnimeList artwork

The artwork panel includes **MyAnimeList** for anime and **MyAnimeList Manga** for manga/book covers. Both reuse the MyAnimeList client ID saved under **Settings → Search Providers**. Stored `mal` or `myanimelist` identifiers load the main cover automatically; enter a title and choose a search result when an ID is missing or incorrect. The provider offers the largest available main cover, with a medium-image fallback. Applying it follows the same database and media-folder rules as other artwork providers.

### Supplemental anime people data

AniList remains the primary character and voice-cast source. When fetching missing metadata is enabled, anime series and movies with a known MyAnimeList ID also use Jikan to fill missing voice cast, crew, and portraits. Existing portraits and manually edited people fields take priority. Jikan actors remain in the language-specific voice-cast rows; characters remain separate from cast and crew. AniDB remains a supplementary metadata provider.

Jikan is an unofficial public MyAnimeList API and needs no additional credentials. Responses are cached for 24 hours, requests are serialized at least 1.1 seconds apart, and rate-limit responses defer further requests. Successful checks are retained for 30 days even when a language has no cast, preventing repeated requests for unavailable information. Failed checks are deferred for an hour. Saved fallback data is reused on later scans.

After updating, use **Scan files** once to backfill existing anime titles. Titles without a known MyAnimeList ID are skipped rather than matched by a potentially ambiguous name.

### Animated artwork

Manual libraries support GIF and WebM artwork for posters, backdrops, banners, logos, landscape images, episode thumbnails, and disc art. Upload through the artwork panel or an item's artwork editor. Local sidecars such as `poster.webm`, `fanart.gif`, `clearlogo.webm`, and `season01-poster.webm` are also discovered; rescan after adding them. Animated artwork takes priority over a static sidecar of the same kind, while filename-specific artwork still takes priority over shared folder artwork. Named WebM artwork is excluded from media indexing.

WebM files loop silently. Before storing an upload, PosterView inspects its video and audio tracks, removes audio without re-encoding the video, and generates a static first-frame fallback. If validation, audio removal, or fallback generation fails, the artwork is rejected. Local WebM files are prepared in the application cache before serving; the original media-folder file is never modified. FFmpeg and FFprobe are included in the Docker image and must be available on PATH for installations outside Docker.

Animations run only while visible, in the active browser tab, and when reduced motion is not enabled. A cached static frame is used otherwise, including when video playback fails. WebM responses support byte ranges. Static fallbacks are accessible using `still=1` on a native artwork URL, for future clients that need a conventional image.

The existing 20 MB artwork limit applies. WebM supports VP8, VP9, and AV1 video, up to 16 megapixels and two minutes per animation. Stored static frames are scaled to at most 1920 pixels per side. Animated uploads and their fallback frames use application storage; local animations also require a prepared cache copy. Animated uploads remain in application storage as separate logical `poster-animated`, `backdrop-animated`, and corresponding artwork variants; they are not written alongside media. Ordinary static artwork retains existing JPEG/PNG naming. Connected-server uploads use static images; animated GIF/WebM uploads are available only for manual libraries. Poster rotation is unchanged.


### Correcting an identification

Use **Identify** beside Artwork on a manual series or movie. Search by title and optional year; anime searches AniList, TheTVDB, TMDB, MyAnimeList, and AniDB together. Configure provider credentials under Search Providers. AniDB title searches use a daily cached title index; confirming an AniDB ID requires your registered HTTP client name/version. Its title index has no dates, so those results remain visible with a year filter.

Select and review provider records or enter IDs manually. Unique exact title/year matches are suggestions; sequels and seasons need review, especially with AniDB's separate records. Saving verifies selected searchable IDs and provider-declared cross references, rejecting conflicting links. IMDb accepts a manual ID. Missing credentials or unavailable providers are shown per provider.

Saving replaces the item's IDs in the manual database, protects the confirmed IDs while leaving the title/year available for normal metadata resolution, and clears provider-derived metadata and artwork for the item and its descendants. Local metadata and local/manually selected artwork remain. Identification is blocked during a scan. If NFO saving is enabled, corrected IDs replace previous known-provider IDs while preserving unrelated XML; write conflicts are reported. Use **Scan files** afterward to fetch missing metadata with the corrected IDs.

The metadata editor includes an explicit title lock. Enable it for a custom title that must survive NFO reads and provider refreshes. Identify keeps the entered title when selecting results and does not automatically lock it. Existing protected titles remain locked until you clear this option.

Identify results use poster cards organized by provider tabs. Selecting a record resolves provider-declared cross references and places linked records first for review. Linking follows known IDs only; providers with no published links still require a separate selection or manual ID. Missing credentials and conflicting links are reported, and nothing is saved until you confirm. AniDB title-index results have no posters until the selected record is retrieved.

## Connected Server Sync

In the library dialog's Advanced section, enable **Connected Server Sync**, then choose a source server and library. For a mixed manual library whose shows and movies occupy separate server libraries, select **All matching libraries**; only uniquely matched existing manual items are synchronized. Sync is off by default. **Push changes to all connected servers** is on by default; turn it off to select additional destinations. The source still receives PosterView edits. One source supplies incoming values and recovery, avoiding competing incoming server values. Disable sync and save the library to pause synchronization.

Emby and Jellyfin support the shared metadata fields exposed in the import controls: titles, IDs, year, descriptions, ratings, release date, status, genres, tags, studios, cast/crew, episode numbering, and runtime. Plex is an outgoing static-artwork destination only, supporting posters, episode thumbnails, backdrops, and logos; Plex image deletion is currently unavailable and is skipped with an activity notice. Unsupported artwork types are skipped. Provider API credentials are not migrated.

Initial linking imports current source values into matched manual items. Subsequent PosterView edits are durably queued and pushed; successful source changes are pulled every 30 seconds. Each field is checked against its last server snapshot before updating. If both sides changed while disconnected and edit order cannot be established, the source server's current value wins. Locked local fields are preserved unless **Override locked metadata** is enabled. Manual dashboards poll their catalog every 30 seconds while sync is enabled. This is polling rather than instantaneous server event delivery.

Matching uses unique exact paths or compatible confirmed provider IDs for movies/series/books, and linked parents plus season/episode numbers for child items. Ambiguous and unmatched items are skipped, with counts and notices. **Correct item link** accepts a source item ID only after validating library membership and media type. No title-only fuzzy matching or whole-library comparison is performed, and server-only items are not added to the manual catalog.

**Import metadata** defaults all shared field selections on, with lock override and NFO writing off. Uncheck fields you want preserved. **Write imported metadata to NFO files** and the ongoing **Write synced metadata to NFO files** merge selected shared values into existing XML, preserving unknown/custom elements and unselected fields. Corrected shared provider IDs replace previous IDs. Missing NFO files are created when the media folder is accessible. Stale or invalid XML is not overwritten; write failures are reported while database changes remain saved.

Static artwork stays separate from animated variants. Incoming source images are saved in application storage and optionally to media-folder sidecars. Animated originals retain their own database references and do not push to connected servers. A per-library **Display animated artwork** preference applies to all types; disable it to display the last synchronized static selection. Offline previews retain last confirmed data. Explicit shared artwork deletions are queued both ways; failed reads or omitted response fields do not imply deletion. Previous static references and bounded shared-value snapshots are retained for recovery.

Library cards provide **Sync now**, **Import metadata**, **Correct item link**, **Restore server values**, pending counts, last success, and notices. Recovery discards pending outgoing edits before pulling source values, preserving enhanced data and animations. Failed destination operations remain queued across restarts; one unavailable destination does not roll back successful local edits or other destinations. Characters, language-specific voice cast, animated artwork, visual preferences, and other PosterView enhancements are excluded from shared metadata sync. Database scan reads do not generate outgoing edit events, and self-written sidecars are suppressed by the file monitor.

Automatic sync checks unchanged libraries without switching them back to “Syncing.” Partial server responses preserve known snapshot fields and do not imply a new edit. Imports record successfully completed items, so retries resume only unfinished items. **Sync now** resumes an interrupted import rather than creating another full import.

Unsuccessful sync attempts retry after two minutes and then five minutes. After three unsuccessful attempts, automatic synchronization pauses with the failures and pending work retained. Review **Sync notices**, then use **Sync now** to start a fresh retry budget. A new explicit PosterView edit also resets the budget. Retry state and completed-import progress survive restarts; an outage does not cause an endless full-library import loop.

### PosterEdit

Open Artwork and select PosterEdit to position a series logo over its poster. Drag the logo or use the position, size, and opacity controls. Save Overlay stores editable placement in the manual-library database and displays the logo separately on static or animated artwork in PosterView. It does not replace artwork files or push a combined image to connected servers. Download exports a new combined PNG without changing library artwork; animations use their static preview frame. Connected-server posters can be downloaded, while overlay saving requires a manual library. Existing placement saved by PoserEdit remains readable.

Generated media-folder artwork is readable by other container users on Linux. Atomic saves preserve existing write permissions and add read access so connected servers can read the images. Reapplying an unchanged image also repairs permissions left by older saves.
