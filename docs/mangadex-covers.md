# MangaDex covers

Open a manga or book series, choose **MangaDex** in the Artwork panel, and search by title,
alternate/Japanese title, or MangaDex UUID. Select the correct manga, browse its volume covers,
open a preview, and apply the chosen image to the intended series or volume. MangaDex requires no
API key. If its tab is hidden, enable it in **Settings → Search Providers**.

Volume numbers can be suggested from media-server metadata, titles, or filenames such as
`Food Wars v14.epub`. A suggestion never applies artwork automatically. Edit the volume, filter by
language or matching volume, or change the selected manga at any time. Covers with unknown volume
or language remain available. The gallery loads in pages; use **Load more** for the next group and
the refresh control to bypass cached provider results.

PosterView saves the selected MangaDex series, preferred volume/language, and last cover for that
media-server item. This provider selection is independent of the expiring artwork cache and does
not modify EPUB, CBZ, CBR, or PDF contents.

## Companion cover files

When a MangaDex poster is applied to a book or audiobook, PosterView also attempts to write the
downloaded image beside the source media with its exact stem. For example:

```text
/media/manga/Plunderer/Plunderer - Volume 01.cbz
/media/manga/Plunderer/Plunderer - Volume 01.jpg
```

The extension follows the actual JPEG, PNG, or WebP content. Reapplying a cover replaces the
same companion image. This requires the source path reported by the media server to be visible and
writable inside PosterView. A typical matching bind mount is:

```yaml
services:
  posterview:
    volumes:
      - /mnt/user/media/manga:/media/manga
```

Applying artwork through Emby or Jellyfin can still succeed if the companion mount is missing or
read-only; PosterView reports that only the companion file could not be saved. For complete folder
and metadata setup, see [Book libraries](book-libraries.md).

## Privacy and service use

PosterView uses MangaDex's documented API and proxies image previews through its server-side
cache. Use the service responsibly and respect MangaDex's terms and rate limits.
