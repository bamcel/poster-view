"""Emby client.

Emby and Jellyfin share the same REST surface for everything PosterView needs
(``/System/Info``, ``/Library/MediaFolders``, ``/Items``, ``/Shows/{id}/Seasons``,
image upload, ``X-Emby-Token`` auth), so the Jellyfin client is reused as-is.
A distinct subclass keeps the door open for any future Emby-specific tweaks and
gives clearer error messages.
"""

from __future__ import annotations

from .jellyfin import JellyfinClient


class EmbyClient(JellyfinClient):
    server_label = "Emby"
