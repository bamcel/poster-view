"""Jellyfin client (and base class for the near-identical Emby API).

Auth is an API key sent as ``X-Emby-Token`` (accepted by both Jellyfin and
Emby). The one notable quirk: image uploads via ``POST /Items/{id}/Images/{type}``
expect the request **body to be base64-encoded text**, with ``Content-Type`` set
to the real image mime — sending raw binary yields "Incorrect ContentType".
"""

from __future__ import annotations

import asyncio
import base64
from typing import Optional

import httpx

from ..schemas import ItemDetail, NormalizedItem, NormalizedLibrary, NormalizedSeason
from .base import MediaClient, MediaError

_COLLECTION_TYPE = {"movies": "movie", "tvshows": "show", "homevideos": "movie"}
_IMAGE_TARGET = {"poster": "Primary", "background": "Backdrop", "logo": "Logo"}
# BoxSets (collections) aren't scoped to a single library folder, so they're
# exposed as one virtual library with this synthetic id (see get_libraries).
_COLLECTIONS_ID = "collections"


def _item_type(it: dict) -> str:
    t = it.get("Type")
    if t == "BoxSet":
        return "collection"
    return "show" if t == "Series" else "movie"


class JellyfinClient(MediaClient):
    server_label = "Jellyfin"

    def __init__(self, base_url: str, token: str):
        super().__init__(base_url, token)
        self._user_id: Optional[str] = None

    def _headers(self) -> dict[str, str]:
        return {"X-Emby-Token": self.token, "Accept": "application/json"}

    async def _get_json(self, client: httpx.AsyncClient, path: str, params: dict | None = None) -> dict:
        resp = await client.get(self.base_url + path, headers=self._headers(), params=params)
        if resp.status_code == 401:
            raise MediaError(f"{self.server_label} rejected the API key (401 Unauthorized).")
        resp.raise_for_status()
        return resp.json()

    async def _get_user_id(self, client: httpx.AsyncClient) -> str:
        """Resolve a user id; some item queries are user-scoped across versions."""
        if self._user_id:
            return self._user_id
        users = await self._get_json(client, "/Users")
        if not users:
            raise MediaError(f"{self.server_label} returned no users for this API key.")
        self._user_id = users[0]["Id"]
        return self._user_id

    async def test_connection(self) -> tuple[str, str]:
        try:
            async with self._client() as client:
                info = await self._get_json(client, "/System/Info")
        except MediaError:
            raise
        except httpx.HTTPError as exc:
            raise MediaError(f"Could not reach {self.server_label} at {self.base_url}: {exc}") from exc
        return info.get("ServerName", self.server_label), str(info.get("Version", ""))

    async def get_libraries(self) -> list[NormalizedLibrary]:
        async with self._client() as client:
            data = await self._get_json(client, "/Library/MediaFolders")
            libraries = [
                NormalizedLibrary(
                    id=it["Id"],
                    title=it.get("Name", "Library"),
                    type=_COLLECTION_TYPE.get(it.get("CollectionType", ""), "other"),
                )
                for it in data.get("Items", [])
            ]
            # BoxSets (collections) aren't tied to a single library folder, so
            # they're exposed as one virtual "Collections" entry — only if the
            # server actually has any (Limit=1 just to read TotalRecordCount).
            uid = await self._get_user_id(client)
            boxsets = await self._get_json(
                client,
                "/Items",
                {"IncludeItemTypes": "BoxSet", "Recursive": "true", "Limit": 1, "userId": uid},
            )
        if boxsets.get("TotalRecordCount", 0) > 0:
            libraries.append(NormalizedLibrary(id=_COLLECTIONS_ID, title="Collections", type="collection"))
        return libraries

    async def get_items(self, library_id: str, group_collections: bool = True) -> list[NormalizedItem]:
        is_collections = library_id == _COLLECTIONS_ID
        params = {
            "Recursive": "true",
            "IncludeItemTypes": "BoxSet" if is_collections else "Movie,Series",
            "Fields": "ProductionYear,DateCreated",
            "SortBy": "SortName",
            "SortOrder": "Ascending",
            "ImageTypeLimit": "1",
            "EnableImageTypes": "Primary",
        }
        if not is_collections:
            params["ParentId"] = library_id
        async with self._client() as client:
            uid = await self._get_user_id(client)
            params["userId"] = uid
            data = await self._get_json(client, "/Items", params)
            items_raw = data.get("Items", [])
            if not is_collections and group_collections:
                items_raw = await self._collapse_boxsets(client, uid, items_raw)
        return [
            NormalizedItem(
                id=it["Id"],
                title=it.get("Name", "Untitled"),
                year=it.get("ProductionYear"),
                type=_item_type(it),
                poster=self._image_ref(it, "Primary"),
                added_at=it.get("DateCreated"),
            )
            for it in items_raw
        ]

    async def _collapse_boxsets(self, client: httpx.AsyncClient, uid: str, items: list[dict]) -> list[dict]:
        """Replace movies/shows that belong to a collection with a single
        BoxSet tile, like Emby's own "group into collections" library view.

        Emby's own ``CollapseBoxSetItems`` query param doesn't reliably do
        this (tested live: it silently drops grouped items instead of
        replacing them with a tile), so the membership map is built by hand:
        list every BoxSet, fetch each one's direct children in parallel, then
        swap the first member encountered for its BoxSet and drop the rest.
        """
        boxsets = await self._get_json(
            client,
            "/Items",
            {
                "IncludeItemTypes": "BoxSet",
                "Recursive": "true",
                "Fields": "ProductionYear,DateCreated",
                "ImageTypeLimit": "1",
                "EnableImageTypes": "Primary",
                "userId": uid,
            },
        )
        boxset_list = boxsets.get("Items", [])
        if not boxset_list:
            return items

        children_lists = await asyncio.gather(
            *(
                self._get_json(
                    client,
                    "/Items",
                    {"ParentId": bs["Id"], "IncludeItemTypes": "Movie,Series", "userId": uid},
                )
                for bs in boxset_list
            ),
            return_exceptions=True,
        )
        member_to_boxset: dict[str, dict] = {}
        for bs, children in zip(boxset_list, children_lists):
            if not isinstance(children, dict):
                continue
            for child in children.get("Items", []):
                member_to_boxset.setdefault(child["Id"], bs)
        if not member_to_boxset:
            return items

        result: list[dict] = []
        seen_boxsets: set[str] = set()
        for it in items:
            bs = member_to_boxset.get(it["Id"])
            if bs is None:
                result.append(it)
                continue
            if bs["Id"] in seen_boxsets:
                continue  # drop later members of an already-emitted collection
            seen_boxsets.add(bs["Id"])
            result.append(bs)
        result.sort(key=lambda it: (it.get("Name") or "").lower())
        return result

    async def get_item_detail(self, item_id: str) -> ItemDetail:
        async with self._client() as client:
            uid = await self._get_user_id(client)
            data = await self._get_json(
                client,
                "/Items",
                {
                    "Ids": item_id,
                    "userId": uid,
                    # Emby's Ids lookup silently returns nothing for a BoxSet
                    # unless it's explicitly allow-listed here alongside the
                    # regular types.
                    "IncludeItemTypes": "Movie,Series,BoxSet",
                    "Fields": "Overview,ChildCount,ProductionYear,ProviderIds",
                },
            )
            items = data.get("Items", [])
            if not items:
                raise MediaError("Item not found.")
            it = items[0]
            external_ids = {k.lower(): str(v) for k, v in (it.get("ProviderIds") or {}).items() if v}
            kind = _item_type(it)
            seasons: list[NormalizedSeason] = []
            if kind == "show":
                sdata = await self._get_json(client, f"/Shows/{item_id}/Seasons", {"userId": uid})
                for s in sdata.get("Items", []):
                    seasons.append(
                        NormalizedSeason(
                            id=s["Id"],
                            title=s.get("Name", "Season"),
                            index=s.get("IndexNumber"),
                            poster=self._image_ref(s, "Primary"),
                            episode_count=s.get("ChildCount"),
                        )
                    )
            members: list[NormalizedItem] = []
            if kind == "collection":
                # A BoxSet's direct children are its member movies/shows — no
                # Recursive here, or Emby descends into shows' own episodes too.
                mdata = await self._get_json(
                    client,
                    "/Items",
                    {
                        "ParentId": item_id,
                        "IncludeItemTypes": "Movie,Series",
                        "Fields": "ProductionYear",
                        "SortBy": "SortName",
                        "SortOrder": "Ascending",
                        "ImageTypeLimit": "1",
                        "EnableImageTypes": "Primary",
                        "userId": uid,
                    },
                )
                members = [
                    NormalizedItem(
                        id=m["Id"],
                        title=m.get("Name", "Untitled"),
                        year=m.get("ProductionYear"),
                        type=_item_type(m),
                        poster=self._image_ref(m, "Primary"),
                    )
                    for m in mdata.get("Items", [])
                ]
        return ItemDetail(
            id=it["Id"],
            title=it.get("Name", "Untitled"),
            year=it.get("ProductionYear"),
            type=kind,
            poster=self._image_ref(it, "Primary"),
            background=self._image_ref(it, "Backdrop"),
            summary=it.get("Overview"),
            season_count=it.get("ChildCount") if kind == "show" else None,
            seasons=seasons,
            external_ids=external_ids,
            logo=self._image_ref(it, "Logo"),
            members=members,
        )

    async def set_image(self, item_id: str, target: str, data: bytes, content_type: str) -> None:
        image_type = _IMAGE_TARGET.get(target, "Primary")
        body = base64.b64encode(data)  # Jellyfin/Emby require a base64 text body.
        auth = {"X-Emby-Token": self.token}
        async with self._client() as client:
            # Backdrops are a LIST and POST appends a new one — so replacing the
            # background wouldn't change the displayed image (index 0). Clear the
            # existing backdrops first so the uploaded image becomes the only one.
            if image_type == "Backdrop":
                for _ in range(25):
                    d = await client.delete(
                        f"{self.base_url}/Items/{item_id}/Images/Backdrop/0", headers=auth
                    )
                    if d.status_code not in (200, 204):
                        break

            resp = await client.post(
                f"{self.base_url}/Items/{item_id}/Images/{image_type}",
                content=body,
                headers={**auth, "Content-Type": content_type},
            )
            if resp.status_code == 401:
                raise MediaError(f"{self.server_label} rejected the API key while uploading.")
            if resp.status_code >= 400:
                raise MediaError(
                    f"{self.server_label} upload failed ({resp.status_code}): {resp.text[:200]}"
                )

    async def fetch_image(self, ref: str) -> tuple[bytes, str]:
        async with self._client() as client:
            resp = await client.get(self.base_url + "/" + ref.lstrip("/"), headers=self._headers())
            resp.raise_for_status()
            return resp.content, resp.headers.get("content-type", "image/jpeg")

    # -- helpers ----------------------------------------------------------
    @staticmethod
    def _image_ref(item: dict, image_type: str) -> Optional[str]:
        item_id = item.get("Id")
        if not item_id:
            return None
        if image_type == "Backdrop":
            tags = item.get("BackdropImageTags") or []
            if not tags:
                return None
            return f"Items/{item_id}/Images/Backdrop?tag={tags[0]}"
        tag = (item.get("ImageTags") or {}).get(image_type)
        if not tag:
            return None
        return f"Items/{item_id}/Images/{image_type}?tag={tag}"
