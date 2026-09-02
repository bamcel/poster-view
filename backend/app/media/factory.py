"""Construct the right :class:`MediaClient` for a stored server row."""

from __future__ import annotations

from typing import Any

from .base import MediaClient, MediaError
from .emby import EmbyClient
from .jellyfin import JellyfinClient
from .plex import PlexClient

_CLIENTS = {
    "plex": PlexClient,
    "jellyfin": JellyfinClient,
    "emby": EmbyClient,
}


def client_for(server: dict[str, Any]) -> MediaClient:
    """Build a client from a server dict that includes the decrypted token."""
    cls = _CLIENTS.get(server["type"])
    if cls is None:
        raise MediaError(f"Unsupported server type: {server['type']!r}")
    return cls(server["base_url"], server.get("token", ""))
