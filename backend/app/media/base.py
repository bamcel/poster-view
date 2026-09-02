"""Abstract media-server client.

Every concrete client (Plex/Jellyfin/Emby) maps its server's native API onto
this interface and onto the ``Normalized*`` schemas, so routers and the
frontend stay completely server-agnostic.

Image handling note: rather than exposing raw, auth-bearing image URLs to the
browser, list/detail methods return an opaque ``ref`` (a relative path on the
origin server). The backend image-proxy endpoint resolves a ref back to bytes
via :meth:`MediaClient.fetch_image`, which also injects the right auth. This
solves both CORS and credential-leakage in one place.
"""

from __future__ import annotations

import abc

import httpx

from ..config import HTTP_TIMEOUT, USER_AGENT
from ..schemas import (
    ItemDetail,
    NormalizedItem,
    NormalizedLibrary,
)


class MediaError(Exception):
    """Raised for any media-server interaction failure (auth, network, parse)."""


class MediaClient(abc.ABC):
    def __init__(self, base_url: str, token: str):
        self.base_url = base_url.rstrip("/")
        self.token = token

    # -- helpers ----------------------------------------------------------
    def _client(self) -> httpx.AsyncClient:
        # verify=False: self-hosted servers commonly use self-signed certs.
        return httpx.AsyncClient(
            timeout=HTTP_TIMEOUT,
            verify=False,
            headers={"User-Agent": USER_AGENT},
            follow_redirects=True,
        )

    # -- contract ---------------------------------------------------------
    @abc.abstractmethod
    async def test_connection(self) -> tuple[str, str]:
        """Return ``(server_name, version)`` or raise :class:`MediaError`."""

    @abc.abstractmethod
    async def get_libraries(self) -> list[NormalizedLibrary]:
        ...

    @abc.abstractmethod
    async def get_items(self, library_id: str, group_collections: bool = True) -> list[NormalizedItem]:
        """``group_collections`` replaces a collection's member movies/shows
        with a single collection tile, like Emby's own library view (only
        Jellyfin/Emby implement this; Plex ignores the flag for now)."""

    @abc.abstractmethod
    async def get_item_detail(self, item_id: str) -> ItemDetail:
        ...

    @abc.abstractmethod
    async def set_image(self, item_id: str, target: str, data: bytes, content_type: str) -> None:
        """Upload ``data`` as the item's poster or background and select it."""

    @abc.abstractmethod
    async def fetch_image(self, ref: str) -> tuple[bytes, str]:
        """Resolve an image ``ref`` (from a Normalized* field) to ``(bytes, mime)``."""
