# Seasons and episodes

Select a season poster on a series page to open its season detail page.

The header displays the season poster, backdrop, title, year range, episode count, and overview. When season artwork or an overview is unavailable, the page uses the series information. Season zero is labeled **Specials**.

Episodes appear as image cards in episode order, with titles, episode numbers, air dates, runtime, rating, and a short synopsis where available. **Episode details** expands the full synopsis and available director, writer, and cast names. Use the search field to find an episode by title or number and the season selector to switch seasons. **Back to series** retains your library navigation context.

Information is read from the selected Plex, Emby, or Jellyfin server. This page does not edit episode metadata or NFO files. Missing images get a placeholder; empty seasons and connection errors have explicit states. **Refresh season** reloads server metadata.

The authenticated API is `GET /api/servers/{serverId}/shows/{seriesId}/seasons/{seasonId}`. It checks the season's series association, loads paginated episode results, and normalizes server-specific runtime and artwork fields.
