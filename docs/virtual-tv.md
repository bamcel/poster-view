# Virtual TV

Enable **Settings → Plugins → Virtual TV**. The Media sidebar and mobile navigation
then include **Virtual TV**, with a three-hour program guide and local date/time
navigation. Administrators create, edit and delete shared channels on that page.
Use **Create channel** to add a channel, or **Edit channels** beside it to open
the management list with Edit and Remove actions. Viewing uses the guide grid;
each channel row includes Watch live, without a second program-card queue below.
Selecting a guide program shows its details and thumbnail in the top preview.
The guide background uses the selected series or movie backdrop at full resolution,
with a dark overlay for readability. Missing backdrops keep the dark background.
Selecting a channel shows its current program. Images come from library artwork;
there is no separate static channel-image editor.

Open **Preferences** in the guide to enable **Live preview** for all channels in
this browser (off by default). After a short selection delay, the selected airing
program starts a muted preview. Its full-resolution thumbnail remains loaded until
a video frame is ready, then fades into the preview. Future and past programs
remain thumbnail-only. Switching programs/channels, disabling previews, hiding the
tab, leaving the guide, or losing channel access stops the session. Unsupported
playback or preview failure falls back to the thumbnail; previews use original
playback or lossless stream copying without starting an encoder.
ServerConnect remains unchanged; channel sources are native video libraries only.

Choose one or more source libraries and optional shows, movies and genres. These
filters combine with OR; with no filters, every playable video in those libraries
is included. Book libraries are excluded. Selected videos require measured durations
from a library scan; rounded runtime labels are not used for schedule timing.
Special episodes are included only with valid Special Episode Info (airs during/
before a season, optionally before an episode, or after a season). Unplaced specials
are excluded, and ordered channels insert placed specials at their specified position.
Re-save existing channels to refresh their stored special-placement metadata.

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
Virtual TV uses the regular media player, including its audio-track and subtitle
menus, subtitle appearance controls, and supported subtitle renderers. It does
not write personal watch history or resume positions. Program transitions can include
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
