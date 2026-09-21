# Getting started with PosterView

PosterView manages artwork and selected local metadata for Plex, Jellyfin, and Emby libraries.
It does not replace your media server: PosterView connects to it, displays its libraries, and
sends approved artwork changes back to it.

## 1. Connect a server

1. Open **Settings → Server** and select **Add server**.
2. Choose Plex, Jellyfin, or Emby and enter the server address and credentials.
3. Expand **Show Libraries** and enable the libraries that should appear on the Dashboard.
4. Save the server. Use the active-server selector when more than one server is configured.

Provider credentials and tokens are encrypted at rest. PosterView never returns stored secrets
to the browser.

## 2. Browse the Dashboard

Choose a library tab, search its titles, or use the filter menu. **Group Collections** replaces
collection members with a collection tile when supported. Selecting a movie or series opens its
detail page; book-style libraries can also contain navigable grouping and series folders.

When Dashboard backdrops are enabled in **Settings → Appearance**, artwork rotates behind the
page. Desktop clients use backdrop artwork. Mobile clients use portrait posters so the image
better fills a phone display. The appearance settings are stored by PosterView and shared by
clients rather than being limited to one browser.

## 3. Find and apply artwork

Open a title and select an artwork provider. PosterView uses a known provider ID when one is
available and otherwise searches by title. You can replace the search with a title or supported
ID to correct a match.

- **Poster**, **Background**, and **Logo** apply the selected image to that target.
- **Custom** lets you choose another target such as a season or collection member.
- **Manual** accepts an image upload or image URL.
- **Remove** deletes one artwork target or all removable artwork after confirmation.
- **Show More** reveals providers normally associated with the other library type.

Every successful apply is recorded in **History**, where an older version can be restored.
PosterView also refreshes its cached media image after an apply or revert.

## 4. Configure providers and caching

Use **Settings → Search Providers** to enable only the databases you use, set the default
provider, and enter required credentials. ThePosterDB uses your own account session; Fanart.tv
and TheTVDB require their respective credentials. AniList Manga and MangaDex do not require an
API key.

The cache and Artwork Watchdog controls preload reusable results. A provider that needs an
external ID may be skipped for an item that has no compatible ID; fix the item's metadata or
search interactively by title/ID rather than treating one missing provider match as a reason to
discard the rest of the library.

## 5. Book-style libraries

Manga, comics, conventional books, light novels, and audiobooks use the same book-library
workflow. PosterView can navigate folders, manage a series poster/backdrop, apply individual
volume covers, and edit PosterView's local series NFO. See the full
[book-library guide](book-libraries.md) before enabling filesystem writes.

## 6. Appearance and sessions

**Settings → Appearance** controls backdrops, panel color, panel blur, panel overlay, backdrop
overlay, and themes. Reset restores PosterView's defaults. Settings remembers the last-opened
tab for the current session. If authentication is enabled, use **Sign out** to end the session.

## Troubleshooting

- If a library is missing, enable it under **Settings → Server → Show Libraries**.
- If a provider tab is missing, enable it in **Settings → Search Providers**.
- If artwork does not change immediately, use the title's refresh control; do not repeatedly
  apply the same image.
- If local files are not written, verify that the media path reported by the server exists at
  the same path inside the PosterView container and is writable by PosterView.
- If an installed mobile web app looks stale, close and reopen it after the new container is
  running so its cached application assets can update.

