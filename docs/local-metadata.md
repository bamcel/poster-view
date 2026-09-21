# Local book and manga metadata

PosterView reads and writes `<series folder name>.nfo` beside a selected series in a mounted
book-style library. This is opt-in: browsing folders never writes files. The editor manages a
PosterView sidecar directly and does not change Plex, Jellyfin, or Emby metadata through their
APIs.

The filename uses the exact series folder name, including edition suffixes, rather than the
editable title. For example, `Hunter x Hunter/Hunter x Hunter.nfo`. Changing the title does not
rename the file.

## Mount your library

`/config` stores PosterView's database, credentials, settings, and caches. Keep that volume and add
a separate writable media bind mount at `/media`:

```text
/media/
  Manga/
    Chainsaw Man/
      Chainsaw Man.nfo
      Volume 01.cbz
    Chainsaw Man (Colored)/
      Chainsaw Man (Colored).nfo
      Volume 01.cbz
```

The optional `docker-compose.media.yml` reads its host source from `POSTERVIEW_MANGA_PATH`:

```dotenv
POSTERVIEW_MANGA_PATH=/mnt/user/media/Manga
# Windows example: POSTERVIEW_MANGA_PATH=D:/Media/Manga
```

Start that configuration with:

```sh
docker compose -f docker-compose.yml -f docker-compose.media.yml up -d --build
```

The host directory must already exist. PosterView runs as UID/GID 10001 and needs read/traverse
permission plus write permission where NFOs are saved. The entrypoint does not change media
ownership. Mount media under `/media`, not `/config`; `/config` is application state. Multiple
libraries may be mounted beneath `/media`.

For a native installation, set `POSTERVIEW_MEDIA_DIR` to an absolute common media root before
starting the server. In the container it normally remains `/media`. PosterView rejects local paths
outside this root.

## Review and save metadata

1. On the **Dashboard**, open a manga, comic, or book library and select a series.
2. Choose **Edit Metadata** on the series detail page.
3. PosterView loads `<series folder name>.nfo`; a new record starts with the folder-derived title.
4. Edit values manually or use a provider result to populate them. Known AniList or ComicVine IDs
   are reused for provider searches, which helps edition names such as “Color” match correctly.
5. Review each proposed overwrite. Description metadata also supports append when you want to
   retain existing text. Equivalent normalized values, such as `FINISHED` and `Finished`, are not
   presented as meaningful overwrites.
6. Save the metadata. PosterView checks that the file has not changed since it was opened.

AniList may populate titles, publication year, synopsis, status, source material, country, IDs,
and source links. Review edition-specific publisher, edition, and volume totals yourself; a
provider's status can describe the original work rather than a translated or colored edition.

## File format and preservation

New files are UTF-8 XML with a `<series>` root. Supported optional values are `title`,
`originaltitle`, `translatedtitle`, `year`, `plot`, `publisher`, `edition`, `volumes`, `status`,
`anilistid`, `malid`, `comicvineid`, `genres`, `tags`, `creators`, `country`, and
`sourcematerial`. Each database URL is stored in its own `<source>` element so AniList and
ComicVine references can coexist. Unknown values are omitted. `volumes` is the confirmed total
for the edition, not the number owned.

Existing `series`, `book`, and `tvshow` roots are supported. Explicit updates retain the root and
unrelated XML elements, attributes, and comments when possible, although formatting may change.
PosterView updates the current NFO atomically and does not leave `.nfo.bak` files in the media
folder.

Files are written through a temporary file in the same directory and renamed into place. A stale
editor cannot overwrite a revision changed after it was loaded, and a new file uses no-clobber
creation. Invalid XML, DTD/entity declarations, linked paths, unsupported roots, and files larger
than 1 MB are rejected unchanged.

## Compatibility

`<series folder name>.nfo` is PosterView's sidecar convention. Plex, Jellyfin, Emby, and their
book/comic plugins can use different filenames, roots, and fields. PosterView guarantees its own
read/edit/write round trip; it does not promise that a media server will import edition-specific
fields.

The editor operates on physical folders independently of the active media server. Two servers
pointing at the same folder therefore share the same sidecar by design.
