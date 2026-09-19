# Local manga metadata

PosterView's **Manga metadata** page browses a mounted folder and reads/writes
`series.nfo` beside each series. This is opt-in: opening or scanning folders never
writes files. It does not change Plex, Jellyfin, or Emby through their APIs.

## Mount your library

`/data` already stores PosterView's database, credentials and cache. Keep that
volume and add a separate writable media bind mount at **`/data/media`**:

```text
/data/media/
  Chainsaw Man/
    series.nfo
    Volume 01.cbz
  Chainsaw Man (Colored)/
    series.nfo
    Volume 01.cbz
```

Set your host path in `.env` (use forward slashes for Windows paths):

```dotenv
POSTERVIEW_MANGA_PATH=/mnt/user/media/Manga
# Windows example: POSTERVIEW_MANGA_PATH=D:/Media/Manga
```

Then run:

```sh
docker compose -f docker-compose.yml -f docker-compose.media.yml up -d --build
```

The directory must already exist. PosterView runs as UID/GID 10001 and needs
read/traverse permissions on the folders and write permissions where NFOs are
saved. The entrypoint does **not** change media ownership. Keep media mounts under
`/data/media` or outside `/data`; other paths under `/data` are application state.
You can mount several libraries beneath `/data/media` and browse into them.

For a native installation set `POSTERVIEW_MEDIA_DIR` to the absolute local manga
directory before starting the server. Without this variable, the default is
`<POSTERVIEW_DATA_DIR>/media`. No local paths can be accessed outside this root.

## Review and save

1. Open **Manga metadata** in PosterView's navigation.
2. Select a series folder. The folder icon browses into grouping folders.
3. Existing `series.nfo` metadata loads automatically. For a new file only the
   title is prefilled from the folder name.
4. Optionally search AniList and choose a match to fill title, first publication
   year, synopsis, status and AniList ID. Searches require internet access;
   manual editing, browsing and NFO reading/writing work locally.
5. Enter edition-specific publisher, year, status and volume total when verified.
   Edition suggests **Original** and **Color**, and accepts any custom label.
   AniList status describes the original work, not necessarily a translated or
   color edition. No volume totals are fetched or inferred from AniList or files.
6. Click **Preview NFO**, review the XML and destination, then **Save beside series**.

For bulk setup, select series folders missing an NFO and choose **Create missing
NFOs**. After confirmation this creates **title-only** NFOs, skips existing files,
and reports each result. It does not auto-match names or manufacture metadata.
Only select actual series/edition folders, not library/grouping folders. Scans
list one directory level at a time so grouping directories aren't automatically
treated as manga. Full bulk provider matching is not part of this first version.

## File format and preservation

New files are UTF-8 XML with a `<series>` root and these optional fields:
`title`, `year`, `plot`, `publisher`, `edition`, `volumes`, `status`, `anilistid`.
Unknown values are omitted. `volumes` means the confirmed total for this edition,
not the number owned and not a completeness assessment.

Existing `series`, `book`, and `tvshow` roots are supported. Explicit updates retain
the root and unrelated XML elements/attributes/comments (formatting may change).
Before updating, PosterView saves the original bytes to a unique
`series.nfo.<UUID>.bak` beside the file. Backups are not deleted automatically.
To restore, stop editing and copy the chosen backup over `series.nfo`, then reload.

Files are written through temporary files in the same directory and renamed into
place. A stale editor cannot overwrite a different revision detected before save;
new files use no-clobber creation. Avoid simultaneous edits from other programs:
there is no cross-application filesystem lock. Invalid XML, DTD/entity declarations,
linked paths, unsupported roots and files larger than 1 MB are rejected unchanged.

**Compatibility:** `series.nfo` is the requested PosterView sidecar name. Do not
assume Emby/Plex/Jellyfin will import manga edition fields or this filename. Their
library types, plugins and NFO conventions differ. This version guarantees the
PosterView round trip; it does not promise automatic server-side ingestion.

The page browses physical folders independently of the active server. Two servers
pointing to the same physical folder share the same sidecar by design. The current
version reads NFOs in this editor; it does not replace metadata in artwork details
or the media-server library listing.
