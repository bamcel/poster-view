# Book libraries: manga, comics, and books

PosterView treats manga, comics, light novels, conventional books, and audiobooks as book-style
libraries. Emby and Jellyfin book/audiobook/folder libraries are the most extensively supported.
Plex uses the same normalized browsing and artwork interfaces, but book-library behavior depends
on the Plex library and agent configuration and has not been verified as broadly.

## Recommended organization

Keep one folder per series or book and place volumes beneath it or directly inside it. A simple
layout is easiest for PosterView and your media server to map:

```text
Manga/
  Dragon Ball/
    Dragon Ball.nfo
    Dragon Ball - Volume 01.cbz
    Dragon Ball - Volume 01.jpg
    Dragon Ball - Volume 02.cbz
    poster.jpg
    backdrop.jpg
Comics/
  Saga/
    Saga.nfo
    Saga - Volume 01.cbz
Books/
  Dune/
    Dune.nfo
    Dune.epub
    poster.jpg
```

Grouping folders may be used above series folders. Selecting a grouping folder navigates deeper;
selecting a series opens its detail page. PosterView deliberately does not open an individual
book/volume as another Dashboard detail page, so Back returns to the series rather than skipping
directly to the library.

## Enable and open the library

1. In **Settings → Server**, expand the server's **Show Libraries** list.
2. Enable the manga, comic, book, or audiobook library.
3. Return to **Dashboard** and choose its library tab.
4. Select a series folder to manage its series artwork and listed volumes.

The search bar filters the active library. Folder names and the media server's metadata determine
what appears; PosterView does not rename source media files.

## Series and volume artwork

Book artwork providers include **AniList Manga**, **MangaDex**, **VIZ**, and **ComicVine**.
**Show More** exposes screen-artwork providers when their results are useful for a book backdrop
or alternate cover. Use **Manual** for a local file or image URL.

- Apply **Poster** to change a series cover.
- Apply **Background** to add a series backdrop.
- Choose a listed volume as the target to set that volume's cover.
- Use **Remove** to remove one target, or **Remove all** to clear the available artwork targets
  after confirmation.

When a database image is used for a book or audiobook, PosterView attempts to create a companion
image beside the source media using the media file's exact stem, such as
`Dragon Ball - Volume 01.cbz` → `Dragon Ball - Volume 01.jpg`. The extension follows the real
JPEG, PNG, or WebP data. A series-level poster is kept in the series folder rather than at the
library root. Media-server artwork can still be applied when a companion file cannot be written;
PosterView reports the filesystem result separately.

For MangaDex-specific volume selection, languages, and saved matches, see
[MangaDex covers](mangadex-covers.md).

## Database Sync for book libraries

For manga, comics, books, light novels, and audiobooks, **Sync** preloads artwork only from
provider URLs explicitly saved as `<source>` entries in that series folder's NFO. It does not
guess providers from the title or use an ID field alone. Supported links are AniList Manga,
MangaDex, VIZ, and ComicVine; the provider must also be enabled in Database settings (and
ComicVine requires its API key). A book without an NFO or supported source URL is skipped.
Sync walks nested book folders and checks existing series again on later runs, so adding a link
does not require the series to be newly added to the library.

## Backdrops and mobile displays

Upload or select a series background, then enable **Show backdrops** in
**Settings → Appearance → Dashboard**. Desktop Dashboard rotation uses available backgrounds.
Mobile Dashboard rotation uses portrait posters for better phone coverage. A selected series uses
its backdrop across the content and side panels, with the same shared panel/overlay controls.

If no background appears, confirm that backdrops are enabled and that the active library contains
usable art. Appearance choices are saved on the PosterView server and apply across clients.

## Edit series metadata

Open a series and choose **Edit Metadata**. Existing `<series folder name>.nfo` data is loaded when
the folder is available under PosterView's configured media root. You can edit fields manually or
import a provider result, then review overwrite/append choices before saving. Saved AniList and
ComicVine IDs let later searches use the ID even when an edition suffix such as “Color” makes a
title search ambiguous.

PosterView's NFO format is intended for its own reliable round trip. Media servers and their
agents may use different filenames or fields, so do not assume every custom field will be imported
by Plex, Jellyfin, or Emby. See [local metadata](local-metadata.md) for mounting, fields, safety,
and compatibility details.

## Container path requirements

Artwork companion files and NFO files require writable access to the source media. The path
reported by the media server must resolve inside the PosterView container, normally through a
matching bind mount. For example:

```yaml
services:
  posterview:
    volumes:
      - /mnt/user/media/manga:/media/manga
```

Keep NFO-managed folders beneath `POSTERVIEW_MEDIA_DIR` (normally `/media`). The container process
runs as UID/GID 10001 and needs directory traversal and write permission. Never mount the media
library over `/config`, which is reserved for PosterView's database and caches.

## Troubleshooting

- **Series cover landed in the library root:** update to the latest image and verify the media
  server reports the series/volume source path, not only the library root.
- **No companion cover:** mount the server-reported path into PosterView and make it writable.
- **Metadata editor cannot save:** ensure the series is under `POSTERVIEW_MEDIA_DIR`, the folder is
  writable, and the existing XML is valid and smaller than 1 MB.
- **Provider did not auto-search:** enter a known AniList/ComicVine ID or title. Add the ID to the
  series metadata so subsequent searches can reuse it.
- **Backdrop absent on a phone:** enable backdrops in Appearance; mobile rotation uses posters.

