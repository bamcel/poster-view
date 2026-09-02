"""Plex Media Server client.

Plex returns JSON when ``Accept: application/json`` is sent. Auth is a single
``X-Plex-Token`` applied to every request (including image fetches). Poster /
background uploads accept the raw image bytes in the request body and the
newly-uploaded asset becomes the selected one automatically.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Optional

import httpx

from ..schemas import ItemDetail, NormalizedItem, NormalizedLibrary, NormalizedSeason
from .base import MediaClient, MediaError

_LIBRARY_TYPE = {"movie": "movie", "show": "show"}
# Plex collections are scoped per library section, not one global list — they're
# aggregated across every movie/show section into one virtual library with this
# synthetic id (see get_libraries/get_items).
_COLLECTIONS_ID = "collections"


def _item_type(m: dict) -> str:
    t = m.get("type")
    if t == "collection":
        return "collection"
    return "show" if t == "show" else "movie"


def _added_at(m: dict) -> Optional[str]:
    """Plex's addedAt is a Unix timestamp (seconds); normalize to ISO 8601
    like Jellyfin/Emby's DateCreated so the frontend can parse either."""
    ts = m.get("addedAt")
    if not ts:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


class PlexClient(MediaClient):
    def _headers(self, json: bool = True) -> dict[str, str]:
        h = {"X-Plex-Token": self.token}
        if json:
            h["Accept"] = "application/json"
        return h

    async def _get_json(self, client: httpx.AsyncClient, path: str) -> dict:
        resp = await client.get(self.base_url + path, headers=self._headers())
        if resp.status_code == 401:
            raise MediaError("Plex rejected the token (401 Unauthorized).")
        resp.raise_for_status()
        return resp.json().get("MediaContainer", {})

    async def test_connection(self) -> tuple[str, str]:
        try:
            async with self._client() as client:
                mc = await self._get_json(client, "/")
        except MediaError:
            raise
        except httpx.HTTPError as exc:
            raise MediaError(f"Could not reach Plex at {self.base_url}: {exc}") from exc
        return mc.get("friendlyName", "Plex"), str(mc.get("version", ""))

    async def get_libraries(self) -> list[NormalizedLibrary]:
        async with self._client() as client:
            mc = await self._get_json(client, "/library/sections")
            sections = mc.get("Directory", [])
            libraries = [
                NormalizedLibrary(
                    id=str(d["key"]),
                    title=d.get("title", "Library"),
                    type=_LIBRARY_TYPE.get(d.get("type", ""), "other"),
                )
                for d in sections
            ]
            collections = await self._all_collections(client, sections)
        if collections:
            libraries.append(NormalizedLibrary(id=_COLLECTIONS_ID, title="Collections", type="collection"))
        return libraries

    async def get_items(self, library_id: str, group_collections: bool = True) -> list[NormalizedItem]:
        is_collections = library_id == _COLLECTIONS_ID
        async with self._client() as client:
            if is_collections:
                sections = (await self._get_json(client, "/library/sections")).get("Directory", [])
                metadata = await self._all_collections(client, sections)
            else:
                mc = await self._get_json(client, f"/library/sections/{library_id}/all")
                metadata = mc.get("Metadata", [])
                if group_collections:
                    metadata = await self._collapse_collections(client, library_id, metadata)
        return [
            NormalizedItem(
                id=str(m["ratingKey"]),
                title=m.get("title", "Untitled"),
                year=m.get("year"),
                type=_item_type(m),
                poster=self._ref(m.get("thumb")),
                added_at=_added_at(m),
            )
            for m in metadata
        ]

    async def _all_collections(self, client: httpx.AsyncClient, sections: list[dict]) -> list[dict]:
        """Fetch every collection across all movie/show sections, in parallel."""
        movie_show = [d for d in sections if d.get("type") in _LIBRARY_TYPE]
        results = await asyncio.gather(
            *(self._get_json(client, f"/library/sections/{d['key']}/collections") for d in movie_show),
            return_exceptions=True,
        )
        return [m for r in results if isinstance(r, dict) for m in r.get("Metadata", [])]

    async def _collapse_collections(
        self, client: httpx.AsyncClient, library_id: str, items: list[dict]
    ) -> list[dict]:
        """Replace movies/shows that belong to a collection with a single
        collection tile, mirroring JellyfinClient._collapse_boxsets.

        Plex collections are already scoped to one section, so this only
        needs that section's own collections (no global scan like Emby's
        BoxSets need) — fetch them, fetch each one's children in parallel,
        then substitute the first member encountered for its collection and
        drop the rest.
        """
        collections = (await self._get_json(client, f"/library/sections/{library_id}/collections")).get(
            "Metadata", []
        )
        if not collections:
            return items

        children_lists = await asyncio.gather(
            *(self._get_json(client, f"/library/collections/{c['ratingKey']}/children") for c in collections),
            return_exceptions=True,
        )
        member_to_collection: dict[str, dict] = {}
        for coll, children in zip(collections, children_lists):
            if not isinstance(children, dict):
                continue
            for child in children.get("Metadata", []):
                member_to_collection.setdefault(str(child["ratingKey"]), coll)
        if not member_to_collection:
            return items

        result: list[dict] = []
        seen: set[str] = set()
        for it in items:
            coll = member_to_collection.get(str(it["ratingKey"]))
            if coll is None:
                result.append(it)
                continue
            if coll["ratingKey"] in seen:
                continue  # drop later members of an already-emitted collection
            seen.add(coll["ratingKey"])
            result.append(coll)
        result.sort(key=lambda it: (it.get("title") or "").lower())
        return result

    async def get_item_detail(self, item_id: str) -> ItemDetail:
        async with self._client() as client:
            mc = await self._get_json(client, f"/library/metadata/{item_id}")
            meta = (mc.get("Metadata") or [{}])[0]
            kind = _item_type(meta)
            seasons: list[NormalizedSeason] = []
            members: list[NormalizedItem] = []
            if kind == "show":
                cmc = await self._get_json(client, f"/library/metadata/{item_id}/children")
                for s in cmc.get("Metadata", []):
                    if s.get("type") != "season":
                        continue
                    seasons.append(
                        NormalizedSeason(
                            id=str(s["ratingKey"]),
                            title=s.get("title", "Season"),
                            index=s.get("index"),
                            poster=self._ref(s.get("thumb")),
                            episode_count=s.get("leafCount"),
                        )
                    )
            elif kind == "collection":
                cmc = await self._get_json(client, f"/library/collections/{item_id}/children")
                members = [
                    NormalizedItem(
                        id=str(m["ratingKey"]),
                        title=m.get("title", "Untitled"),
                        year=m.get("year"),
                        type=_item_type(m),
                        poster=self._ref(m.get("thumb")),
                    )
                    for m in cmc.get("Metadata", [])
                ]
        return ItemDetail(
            id=str(meta.get("ratingKey", item_id)),
            title=meta.get("title", "Untitled"),
            year=meta.get("year"),
            type=kind,
            poster=self._ref(meta.get("thumb")),
            background=self._ref(meta.get("art")),
            summary=meta.get("summary"),
            season_count=meta.get("childCount") if kind == "show" else None,
            seasons=seasons,
            external_ids=self._external_ids(meta),
            logo=self._logo_ref(meta),
            members=members,
        )

    @staticmethod
    def _logo_ref(meta: dict) -> Optional[str]:
        """Plex's clear-logo art lives in the ``Image`` array as type clearLogo."""
        for img in meta.get("Image", []):
            if img.get("type") == "clearLogo" and img.get("url"):
                return img["url"].lstrip("/")
        return None

    @staticmethod
    def _external_ids(meta: dict) -> dict[str, str]:
        """Parse Plex's Guid array (e.g. ``tmdb://603``) into {scheme: id}."""
        ids: dict[str, str] = {}
        for g in meta.get("Guid", []):
            raw = g.get("id", "")
            if "://" in raw:
                scheme, _, value = raw.partition("://")
                if value:
                    ids[scheme.lower()] = value
        return ids

    async def set_image(self, item_id: str, target: str, data: bytes, content_type: str) -> None:
        # Same upload pattern for all three: posters, arts (background), and
        # clearLogos — Plex's newer (4.17+) clear-logo endpoint.
        endpoint = {"poster": "posters", "background": "arts", "logo": "clearLogos"}.get(target, "posters")
        url = f"{self.base_url}/library/metadata/{item_id}/{endpoint}"
        async with self._client() as client:
            resp = await client.post(
                url,
                content=data,
                headers={**self._headers(json=False), "Content-Type": content_type},
            )
            if resp.status_code == 401:
                raise MediaError("Plex rejected the token while uploading.")
            if resp.status_code >= 400:
                raise MediaError(f"Plex upload failed ({resp.status_code}): {resp.text[:200]}")

    async def fetch_image(self, ref: str) -> tuple[bytes, str]:
        async with self._client() as client:
            resp = await client.get(self.base_url + "/" + ref.lstrip("/"), headers=self._headers(json=False))
            resp.raise_for_status()
            return resp.content, resp.headers.get("content-type", "image/jpeg")

    # -- helpers ----------------------------------------------------------
    @staticmethod
    def _ref(path: str | None) -> str | None:
        """Plex thumb/art values are already clean relative paths.

        Kept raw (not percent-encoded) here: the frontend encodes the ref into
        the proxy query string and httpx encodes it once when fetching, so
        pre-encoding would double-escape it.
        """
        if not path:
            return None
        return path.lstrip("/")
