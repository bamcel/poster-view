# Movie and series NFO metadata

Open a movie or series and choose **Edit Metadata** to review the existing NFO in its media folder. This editor uses Emby-style `<movie>` and `<tvshow>` XML.

- Series: `tvshow.nfo` or a sidecar matching the series folder name (for example, `Justfied/Justfied.nfo`). Filename matching is case-insensitive. When both exist, `tvshow.nfo` is the default; use the file selector to edit the named sidecar. Both must contain `<tvshow>` XML.
- Movies: the video basename with `.nfo`, then `movie.nfo`. If both exist, the editor displays a file selector and saves only the selected file.
- Missing NFOs are reported; this editor does not create them.

The media server must provide the filesystem location and PosterView must have access to the same files through its configured media directory (`POSTERVIEW_MEDIA_DIR`). Server paths under `/media/` or `/mnt/user/` map beneath that directory. Linked paths are rejected. Plex series use their folder location; items with multiple distinct Plex paths require a specific location and cannot currently be edited.

Review is available even when NFO writes are disabled. Enable **NFO metadata** for the server in **Settings → Server Setup** to save. The mounted directory must also be writable.

Edit titles, description, dates, ratings, provider IDs, genres, tags, studios, countries, directors, writing credits, and trailer links. Repeated fields use one value per line. Review the proposed changes, then choose **Save NFO**. Saving updates the existing file atomically and rejects a save if the file has changed since it was opened. Reloading discards your draft.

The editor displays existing NFO cast and the complete XML. Cast, artwork references, media stream details, lock fields, nested ratings, and unknown elements remain intact when other fields are edited. XML formatting may change. Language-specific provider credits in **Cast & Crew** remain separate; this editor does not invent language tags or export those credits into the NFO. Season and episode NFO editing is not included.

Saving changes the local NFO only. Refresh metadata in your media server to load the changes there. Provider enrichment and pushing metadata through Plex, Emby, or Jellyfin APIs are separate work.
