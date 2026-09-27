# Server-backed detail pages

The selective development port adds the series hero, horizontal season posters, dedicated
season/episode page, on-demand artwork panel, themed About pills, and Appearance split preview.

Title metadata and episode information are read from the connected media server. There are
no added cast/crew displays, character profiles, people-credit imports, third-party metadata
fetchers, local video metadata editors, or scheduled tasks. Provider links in About are only
links derived from IDs/URLs already returned by the server; they do not fetch metadata.

Season requests validate the season belongs to the selected series and page through episodes.
The route uses the existing authentication and server connection protections. Missing server
fields are omitted or shown as unavailable rather than filled from another source.

Appearance adds Media Detail Titles, Text, Metadata, Links, and shared Pills Background,
Border, and Text color roles. Pill opacity is saved with existing server-side appearance
settings, defaults to 5%, and leaves text and borders visible. Legacy custom themes receive
defaults for the new roles. Split View previews the actual library/series/season pages without
navigating away from Settings.

The existing reader, book tracking, colored editions, and bulk Edition editing are retained.
