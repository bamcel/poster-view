# Virtual TV

Enable **Settings → Plugins → Virtual TV**. The Media sidebar and mobile navigation
then include **Virtual TV**, with a three-hour program guide and local date/time
navigation. Administrators create, edit and delete shared channels on that page.
ServerConnect remains unchanged; channel sources are native video libraries only.

Choose one or more source libraries and optional shows, movies and genres. These
filters combine with OR; with no filters, every playable video in those libraries
is included. Book libraries are excluded. Selected videos require measured durations
from a library scan; rounded runtime labels are not used for schedule timing.

Channels support sequential order, shuffle without repeats within a lineup cycle,
and random show selection with each show's episodes in sequence. The start time is
entered locally and stored as UTC. The channel's saved lineup and seed repeat on
a wall-clock timeline and survive refreshes/restarts. Channel edits rebuild the
lineup immediately; save again after a library scan to include newly added media.
The guide is generated up to seven days per request, with bounded three-hour UI
requests and eight displayed channels at once. No background encoder runs for
unwatched channels. Existing playback policy and GPU support handle active viewers.

Watch live joins the current scheduled program and changes programs at its end.
Return to live restores the current channel position after pausing/seeking.
Virtual TV does not write personal watch history. Program transitions can include
a brief player reload; continuous M3U streaming and XMLTV export are not included.

Every viewer must have access to **all** libraries assigned to a channel, even if
one currently contributes no matching videos. Otherwise the whole channel is hidden.
Guide, tune-in, artwork and channel-bound playback requests enforce this on the
server. Rating restrictions still apply: restricted programs are redacted and
cannot be tuned. Missing/deleted source libraries hide affected channels. Existing
sessions are checked again as streams/segments/heartbeats are requested; owners can
always stop their sessions after losing access.

Configuration and frozen lineups are saved in the existing encrypted SQLite
settings store under `plugin-virtual-tv`, with revision checks for edits and
serialized writes. The application caches the document to avoid repeatedly loading
the catalog during playback. No media files or NFOs are modified.
