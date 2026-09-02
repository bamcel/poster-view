"""TheTVDB v4 provider — posters, backgrounds, banners, clearlogos.

Auth: POST /login with {apikey, pin?} -> bearer token (valid ~1 month, cached).
Artwork ``type`` is a numeric id; we resolve it to a slug via /artwork/types and
classify by slug so we don't depend on hard-coded (and version-specific) numbers.
"""

from __future__ import annotations

from typing import Optional

from ..db import get_setting
from ..schemas import ArtworkItem, ItemDetail
from .base import ArtworkError, ArtworkProvider

TVDB_BASE = "https://api4.thetvdb.com/v4"
_ARTWORK_HOST = "https://artworks.thetvdb.com/"


def _slug_to_type(slug: str) -> Optional[str]:
    slug = slug.lower()
    if "poster" in slug:
        return "poster"
    if "banner" in slug:
        return "banner"
    if "background" in slug or "fanart" in slug:
        return "background"
    if "clearlogo" in slug or slug == "logo":
        return "logo"
    return None


def _abs(url: str) -> str:
    if not url:
        return url
    return url if url.startswith("http") else _ARTWORK_HOST + url.lstrip("/")


def remote_id(candidate: dict, source_name: str) -> Optional[str]:
    """Pull a correlated id (e.g. "TheMovieDB.com", "IMDB") out of a TVDB
    /search result's ``remote_ids`` list — TVDB indexes these even though its
    own artwork API only ever wants a TVDB id itself. Fanart.tv's movie
    endpoint needs TMDB/IMDb, not TVDB, so this is how its title search
    resolves a candidate to the id Fanart actually wants."""
    for r in candidate.get("remote_ids") or []:
        if r.get("sourceName") == source_name:
            return str(r.get("id"))
    return None


class TVDBProvider(ArtworkProvider):
    name = "tvdb"
    label = "TheTVDB"
    needs_key = True

    def __init__(self) -> None:
        self._token: Optional[str] = None
        self._types: Optional[dict[int, str]] = None  # type id -> slug

    def _key(self) -> str:
        return get_setting("tvdb_api_key")

    def is_configured(self) -> bool:
        return bool(self._key())

    async def _login(self, client) -> None:
        body: dict[str, str] = {"apikey": self._key()}
        pin = get_setting("tvdb_pin")
        if pin:
            body["pin"] = pin
        resp = await client.post(f"{TVDB_BASE}/login", json=body)
        if resp.status_code >= 400:
            raise ArtworkError("TheTVDB rejected the API key/PIN — check them in Settings.")
        self._token = resp.json()["data"]["token"]

    async def _auth_get(self, client, path: str, params=None):
        if not self._token:
            await self._login(client)
        headers = {"Authorization": f"Bearer {self._token}"}
        resp = await client.get(f"{TVDB_BASE}{path}", headers=headers, params=params)
        if resp.status_code == 401:  # token expired -> re-login once
            await self._login(client)
            resp = await client.get(
                f"{TVDB_BASE}{path}", headers={"Authorization": f"Bearer {self._token}"}, params=params
            )
        return resp

    async def _load_types(self, client) -> None:
        if self._types is not None:
            return
        resp = await self._auth_get(client, "/artwork/types")
        self._types = {
            t["id"]: (t.get("slug") or t.get("name") or "").lower()
            for t in resp.json().get("data", [])
        }

    async def search(self, query: str, kind: str) -> list[dict]:
        if not self._key():
            raise ArtworkError(
                "Title search needs a TheTVDB API key (Settings) — it's the only title search "
                "available (Fanart.tv itself has no search API)."
            )
        async with self._http() as client:
            resp = await self._auth_get(client, "/search", params={"query": query, "type": kind})
        if resp.status_code >= 400:
            raise ArtworkError(f"TheTVDB error ({resp.status_code}).")
        return resp.json().get("data") or []

    async def fetch(self, item: ItemDetail, id_override: Optional[str] = None) -> list[ArtworkItem]:
        if not self._key():
            raise ArtworkError("TheTVDB API key is not configured (add it in Settings).")
        tvdb_id = id_override or item.external_ids.get("tvdb")
        if not tvdb_id:
            raise ArtworkError("This item has no TheTVDB id (TVDB works best for shows).")
        record = "movies" if item.type == "movie" else "series"

        async with self._http() as client:
            await self._load_types(client)
            resp = await self._auth_get(client, f"/{record}/{tvdb_id}/extended")
            if resp.status_code == 404:
                return []
            if resp.status_code >= 400:
                raise ArtworkError(f"TheTVDB error ({resp.status_code}).")
            artworks = (resp.json().get("data") or {}).get("artworks") or []

        kind = "movie" if item.type == "movie" else "show"
        items: list[ArtworkItem] = []
        for a in artworks:
            slug = (self._types or {}).get(a.get("type"), "")
            art_type = _slug_to_type(slug)
            if not art_type:
                continue
            url = _abs(a.get("image", ""))
            if not url:
                continue
            score = a.get("score")
            items.append(
                ArtworkItem(
                    id=str(a.get("id") or url),
                    provider="tvdb",
                    type=art_type,
                    kind=kind,
                    title=item.title,
                    lang=(a.get("language") or None),
                    likes=int(score) if str(score).isdigit() else None,
                    thumb_url=_abs(a.get("thumbnail") or a.get("image", "")),
                    download_url=url,
                    applyable=art_type in ("poster", "background", "logo"),
                )
            )
        items.sort(key=lambda a: (a.type, -(a.likes or 0)))
        return items
