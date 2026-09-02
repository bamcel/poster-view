"""MediUX provider — posters/backgrounds scraped from mediux.pro's own
server-rendered movie/show/collection pages.

MediUX's REST API is still developer-beta/invite-only, but the website itself
needs no login and (unlike some third-party scraper READMEs assume) no
headless browser: a plain browser-like GET gets through Cloudflare, and each
movie/show/collection page is server-rendered with every uploaded poster/
backdrop embedded directly in the HTML. There's no explicit type label in the
markup, so images are classified by their wrapping Tailwind aspect class —
``aspect-2/3`` (poster) vs ``aspect-video`` (background); anything else is
skipped rather than guessed at.

Looked up by the item's own TMDB id: MediUX addresses everything by it
(``/movies/{id}``, ``/shows/{id}``, ``/collections/{id}``) — confirmed live
that a collection's TMDB id (e.g. Star Wars Collection = 10) resolves too.

Thumbnails go through MediUX's own Next.js image proxy
(``mediux.pro/_next/image?url=...``), which 403s without a same-origin
Referer — so, like ThePosterDB, thumbnails are proxied through our backend
rather than loaded directly by the browser (see ``fetch_thumb`` + the
``/api/artwork/mediux/image`` route). The full-resolution asset host
(``api.mediux.pro``) has no such restriction and is used directly for
applying via the shared ``download_public_image`` helper.
"""

from __future__ import annotations

import asyncio
import re
from collections import OrderedDict
from typing import Optional
from urllib.parse import quote, unquote, urlencode

from bs4 import BeautifulSoup

from ..schemas import ArtworkItem, ItemDetail
from .base import ArtworkError, ArtworkProvider

BASE = "https://mediux.pro"
_PATH_BY_KIND = {"movie": "movies", "show": "shows", "collection": "collections"}
_ASPECT_TYPE = {"2/3": "poster", "video": "background"}
_CARD_SELECTOR = "div.border-b.border-border.py-6"

# SSRF guard: only MediUX's own image proxy may be fetched through fetch_thumb.
_THUMB_HOSTS = (f"{BASE}/_next/image",)
_MAX_CONCURRENCY = 6
_THUMB_CACHE_MAX = 400


def _thumb_proxy_url(asset_url: str) -> str:
    # Next.js's image optimizer only allows specific whitelisted widths (its
    # default imageSizes/deviceSizes tiers) — 256 is one of them, a good
    # thumbnail size; an arbitrary width like 300 gets a 400.
    next_image_url = f"{BASE}/_next/image?{urlencode({'url': asset_url, 'w': '256', 'q': '75'})}"
    return f"/api/artwork/mediux/image?url={quote(next_image_url, safe='')}"


def _parse(html: str, item: ItemDetail) -> list[ArtworkItem]:
    soup = BeautifulSoup(html, "html.parser")
    items: list[ArtworkItem] = []
    seen: set[str] = set()
    for card in soup.select(_CARD_SELECTOR):
        title_el = card.select_one('a[href^="/sets/"]')
        set_title = title_el.get_text(strip=True) if title_el else item.title
        set_href = title_el.get("href") if title_el else None
        for img in card.find_all("img"):
            wrapper = img.parent.parent if img.parent else None
            classes = " ".join(wrapper.get("class") or []) if wrapper else ""
            m = re.search(r"aspect-(\S+)", classes)
            art_type = _ASPECT_TYPE.get(m.group(1)) if m else None
            if not art_type:
                continue
            src = img.get("src") or ""
            url_match = re.search(r"[?&]url=([^&]+)", src)
            if not url_match:
                continue
            asset_url = unquote(url_match.group(1))
            if asset_url in seen:
                continue
            seen.add(asset_url)
            items.append(
                ArtworkItem(
                    id=asset_url,
                    provider="mediux",
                    type=art_type,
                    kind=item.type,
                    title=set_title,
                    thumb_url=_thumb_proxy_url(asset_url),
                    download_url=asset_url,
                    applyable=art_type in ("poster", "background", "logo"),
                    source_url=f"{BASE}{set_href}" if set_href else None,
                )
            )
    return items


class MediuxProvider(ArtworkProvider):
    name = "mediux"
    label = "MediUX"
    needs_key = False

    def __init__(self) -> None:
        self._sem = asyncio.Semaphore(_MAX_CONCURRENCY)
        self._thumb_cache: "OrderedDict[str, tuple[bytes, str]]" = OrderedDict()

    def is_configured(self) -> bool:
        return True  # no account/API key needed — it's scraped, like ThePosterDB

    async def fetch(self, item: ItemDetail, id_override: Optional[str] = None) -> list[ArtworkItem]:
        tmdb_id = id_override or item.external_ids.get("tmdb")
        if not tmdb_id:
            raise ArtworkError("This item has no TMDB id, which MediUX needs.")
        path = _PATH_BY_KIND.get(item.type, "movies")

        async with self._http() as client:
            resp = await client.get(
                f"{BASE}/{path}/{tmdb_id}",
                headers={"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"},
            )
        if resp.status_code == 404:
            return []
        if resp.status_code >= 400:
            raise ArtworkError(f"MediUX error ({resp.status_code}).")
        return _parse(resp.text, item)

    async def fetch_thumb(self, url: str) -> tuple[bytes, str]:
        """Fetch a (small) thumbnail through MediUX's image proxy, with an
        in-memory LRU cache. Only MediUX's own proxy host is allowed."""
        if not url.startswith(_THUMB_HOSTS):
            raise ArtworkError("Refusing to proxy a non-MediUX URL.")
        cached = self._thumb_cache.get(url)
        if cached is not None:
            self._thumb_cache.move_to_end(url)
            return cached
        async with self._sem:
            async with self._http() as client:
                resp = await client.get(
                    url,
                    headers={
                        "Referer": f"{BASE}/",
                        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
                    },
                )
        if resp.status_code >= 400:
            raise ArtworkError(f"MediUX image proxy error ({resp.status_code}).")
        result = (resp.content, resp.headers.get("content-type", "image/jpeg"))
        self._thumb_cache[url] = result
        self._thumb_cache.move_to_end(url)
        while len(self._thumb_cache) > _THUMB_CACHE_MAX:
            self._thumb_cache.popitem(last=False)
        return result
