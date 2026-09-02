"""ThePosterDB (theposterdb.com) client.

ThePosterDB has no public API, so this scrapes the site while authenticated
with the user's own account (stored encrypted). The login flow mirrors the
Laravel CSRF form; the page-scraping selectors mirror the structure used by the
established community tools (poster ids live on ``div.overlay[data-poster-id]``,
the media type on a tooltip ``<a>``, the title on ``p.p-0.mb-1.text-break``).

Two things to know about the site:

* It sits behind Cloudflare. We send browser-like headers and reuse the logged
  in session, which is enough in most cases; if a hard bot-challenge is served
  we detect it and raise a clear error instead of silently returning nothing.
* The same poster-grid markup appears on set pages, user-upload pages and search
  results, so one parser (:meth:`_parse_grid`) covers all three.

Parsing lives in one place on purpose — if the site's markup changes, adjust
``_parse_grid`` / ``_asset_from_card`` and nothing else.
"""

from __future__ import annotations

import asyncio
import logging
import re
from collections import OrderedDict
from typing import Optional
from urllib.parse import quote

import httpx
from bs4 import BeautifulSoup

from ..config import HTTP_TIMEOUT, POSTERDB_BASE_URL, USER_AGENT
from ..db import get_setting
from ..schemas import (
    PosterAsset,
    PosterCategory,
    PosterSearchResults,
    PosterSet,
    PosterTitleResult,
)

logger = logging.getLogger("posterview.posterdb")

_SET_ID_RE = re.compile(r"/set/(\d+)")
_POSTER_ID_RE = re.compile(r"/poster/(\d+)")
_SEASON_NUM_RE = re.compile(r"season\s+(\d+)", re.IGNORECASE)
_SECTION_RE = re.compile(r"section=(movies|shows|collections)")
_TITLE_HREF_RE = re.compile(r"/(posters|set|collection)/(\d+)")
_SEARCH_SECTIONS = ("movies", "shows", "collections")
_LOGIN_FAIL_PHRASES = (
    "these credentials do not match",
    "the provided credentials",
    "do not match our records",
)
_BLOCK_MARKERS = ("just a moment", "cf-chl", "challenge-platform", "attention required!")

# Only these hosts may be proxied for thumbnails (SSRF guard).
_THUMB_HOSTS = ("https://images.theposterdb.com/", "https://theposterdb.com/")
# Cap concurrent outbound requests to ThePosterDB so a big grid doesn't hammer
# it (which triggers rate-limiting), and cache thumbnails so reloads are free.
_MAX_CONCURRENCY = 6
_THUMB_CACHE_MAX = 400

# Browser-like headers help get past Cloudflare's lighter bot heuristics.
_BROWSER_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-User": "?1",
}


class PosterDBError(Exception):
    """Raised on login or scraping failures."""


def _asset_url(asset_id: str) -> str:
    return f"{POSTERDB_BASE_URL}/api/assets/{asset_id}"


def _proxy_thumb(image_url: str) -> str:
    # Served through our own backend so the browser doesn't need a TPDB session
    # (TPDB's image CDN refuses cross-origin requests without one).
    return f"/api/posterdb/image?url={quote(image_url, safe='')}"


def _classify(media_type: str, title: str) -> tuple[str, Optional[int]]:
    """Map (media_type, title) to our (kind, season_number)."""
    mt = (media_type or "").strip().lower()
    title = title or ""
    if mt == "movie":
        return "movie", None
    if mt == "collection":
        return "collection", None
    if mt == "show":
        return _show_kind(title)
    # Unknown/blank media type: infer from the title text.
    return _show_kind(title, default="unknown")


def _show_kind(title: str, default: str = "show") -> tuple[str, Optional[int]]:
    low = title.lower()
    if " - " in title:
        tail = title.rsplit(" - ", 1)[-1].strip().lower()
        if tail == "specials":
            return "season", 0
        if tail.startswith("season"):
            m = _SEASON_NUM_RE.search(tail)
            return "season", (int(m.group(1)) if m else None)
    if "specials" in low:
        return "season", 0
    m = _SEASON_NUM_RE.search(low)
    if m:
        return "season", int(m.group(1))
    if "collection" in low:
        return "collection", None
    return default, None


class PosterDBClient:
    """Singleton-style client holding one authenticated session in memory."""

    def __init__(self) -> None:
        self._client: Optional[httpx.AsyncClient] = None
        self._lock = asyncio.Lock()
        self._sem = asyncio.Semaphore(_MAX_CONCURRENCY)
        self._thumb_cache: "OrderedDict[str, tuple[bytes, str]]" = OrderedDict()
        self._title_count_cache: dict[str, int] = {}  # media_id -> poster count
        self._logged_in = False
        self._email = ""

    # -- session management ----------------------------------------------
    def _new_http(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=POSTERDB_BASE_URL,
            timeout=HTTP_TIMEOUT,
            follow_redirects=True,
            headers=dict(_BROWSER_HEADERS),
        )

    async def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = self._new_http()
        return self._client

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None
            self._logged_in = False

    def reset(self) -> None:
        """Drop the session so the next call re-authenticates (e.g. creds changed)."""
        self._logged_in = False
        self._email = ""

    # -- auth -------------------------------------------------------------
    @staticmethod
    def _credentials() -> tuple[str, str]:
        return get_setting("posterdb_email"), get_setting("posterdb_password")

    def is_configured(self) -> bool:
        email, password = self._credentials()
        return bool(email and password)

    async def login(self) -> None:
        email, password = self._credentials()
        if not (email and password):
            raise PosterDBError("ThePosterDB credentials are not configured.")

        # Reuse the persistent client and just refresh cookies — closing it here
        # would tear down any other requests in flight (e.g. a grid of thumbnails
        # loading concurrently), which is the classic "images don't appear" bug.
        client = await self._http()
        client.cookies.clear()

        try:
            page = await client.get("/login")
        except httpx.HTTPError as exc:
            raise PosterDBError(f"Could not reach ThePosterDB: {exc}") from exc
        if self._is_blocked(page):
            raise PosterDBError(
                "ThePosterDB blocked the login with a bot challenge (Cloudflare). "
                "Try again shortly; a headless-browser mode may be needed if it persists."
            )

        token = self._extract_csrf(page.text)
        form = {
            "_token": token or "",
            "email": email,
            "login": email,  # the site has used either field name historically
            "password": password,
            "remember": "on",
        }
        try:
            resp = await client.post(
                "/login", data=form, headers={"Referer": f"{POSTERDB_BASE_URL}/login"}
            )
        except httpx.HTTPError as exc:
            raise PosterDBError(f"Login request failed: {exc}") from exc

        body = resp.text.lower()
        landed_on_login = str(resp.url).rstrip("/").endswith("/login")
        if any(p in body for p in _LOGIN_FAIL_PHRASES) or (landed_on_login and "password" in body):
            self._logged_in = False
            raise PosterDBError("Login failed — check the email and password.")

        self._logged_in = True
        self._email = email
        logger.info("ThePosterDB login OK for %s", email)

    async def ensure_login(self) -> None:
        if self._logged_in:
            return
        async with self._lock:
            if not self._logged_in:
                await self.login()

    async def status(self) -> dict:
        email, password = self._credentials()
        return {
            "configured": bool(email and password),
            "email": email,
            "logged_in": self._logged_in,
            "message": "",
        }

    # -- public scraping API ---------------------------------------------
    async def search(self, term: str) -> PosterSearchResults:
        """Return search hits grouped into Movies / Shows / Collections.

        TPDb's search page is server-rendered (the per-title list is in the
        HTML even though an individual title's set list is JS-rendered), so we
        fetch each category section in parallel and parse the title links.
        """
        await self.ensure_login()
        soups = await asyncio.gather(
            *[self.fetch_page(f"/search?term={quote(term)}&section={s}") for s in _SEARCH_SECTIONS],
            return_exceptions=True,
        )
        counts: dict[str, int] = {}
        categories: list[PosterCategory] = []
        for section, soup in zip(_SEARCH_SECTIONS, soups):
            if isinstance(soup, Exception):
                logger.warning("search section %s failed: %s", section, soup)
                continue
            if not counts:
                counts = self._parse_tab_counts(soup)
            results = self._parse_title_results(soup)
            categories.append(
                PosterCategory(
                    name=section.capitalize(),
                    count=counts.get(section, len(results)),
                    results=results,
                )
            )
        logger.info("search %r -> %s", term, {c.name: len(c.results) for c in categories})
        return PosterSearchResults(term=term, categories=categories)

    @staticmethod
    def _parse_tab_counts(soup: BeautifulSoup) -> dict[str, int]:
        # The category tabs read "Movies 237" / "Shows 15" etc. Require the link
        # text to start with the section name so pagination links (which also
        # carry section=… but read "2", "3", "›") don't clobber the count.
        counts: dict[str, int] = {}
        for a in soup.find_all("a", href=_SECTION_RE):
            text = a.get_text(" ", strip=True)
            sec = _SECTION_RE.search(a["href"])
            name = re.match(r"(movies|shows|collections)\b", text, re.IGNORECASE)
            num = re.search(r"(\d[\d,]*)", text)
            if sec and name and num:
                counts[sec.group(1)] = int(num.group(1).replace(",", ""))
        return counts

    @staticmethod
    def _parse_title_results(soup: BeautifulSoup) -> list[PosterTitleResult]:
        # The title link is the labelled button in each result row.
        anchors = soup.select("a.btn-dark-lighter[href]")
        if not anchors:
            anchors = [a for a in soup.find_all("a", href=True) if _TITLE_HREF_RE.search(a["href"])]
        results: list[PosterTitleResult] = []
        seen: set[str] = set()
        for a in anchors:
            m = _TITLE_HREF_RE.search(a.get("href", ""))
            if not m:
                continue
            text = a.get_text(" ", strip=True)
            if not text or m.group(0) in seen:
                continue
            seen.add(m.group(0))
            href = a["href"]
            results.append(
                PosterTitleResult(
                    title=text,
                    url=href if href.startswith("http") else f"{POSTERDB_BASE_URL}{href}",
                    media_id=m.group(2),
                )
            )
            if len(results) >= 48:
                break
        return results

    async def get_set(self, url_or_id: str) -> PosterSet:
        path = self._normalize_path(url_or_id)
        soup = await self.fetch_page(path)

        # A single-poster page: hop to its parent set for the full collection.
        if path.startswith("/poster/"):
            set_link = self._get_set_link(soup)
            if set_link:
                path = self._to_path(set_link)
                soup = await self.fetch_page(path)

        posters = self._parse_grid(soup)

        # Fallback: a lone poster page with no set — surface just that poster.
        if not posters and path.startswith("/poster/"):
            pid = path.rsplit("/", 1)[-1]
            posters = [self._single_asset(pid, soup)]

        title_el = soup.find(["h1", "h2"])
        logger.info("get_set %s -> %d posters", path, len(posters))
        return PosterSet(
            set_url=f"{POSTERDB_BASE_URL}{path}",
            title=title_el.get_text(strip=True) if title_el else None,
            posters=posters,
        )

    async def download(self, asset_id_or_url: str) -> tuple[bytes, str]:
        """Fetch a full-resolution asset (used when applying a poster)."""
        url = asset_id_or_url if asset_id_or_url.startswith("http") else _asset_url(asset_id_or_url)
        return await self._fetch_image(url)

    async def fetch_thumb(self, url: str) -> tuple[bytes, str]:
        """Fetch a (small, optimized) thumbnail, with an in-memory LRU cache.

        Only ThePosterDB hosts are allowed (SSRF guard).
        """
        if not url.startswith(_THUMB_HOSTS):
            raise PosterDBError("Refusing to proxy a non-ThePosterDB URL.")
        cached = self._thumb_cache.get(url)
        if cached is not None:
            self._thumb_cache.move_to_end(url)
            return cached
        result = await self._fetch_image(url)
        self._thumb_cache[url] = result
        self._thumb_cache.move_to_end(url)
        while len(self._thumb_cache) > _THUMB_CACHE_MAX:
            self._thumb_cache.popitem(last=False)
        return result

    async def _fetch_image(self, url: str) -> tuple[bytes, str]:
        """Fetch image bytes via the authenticated session.

        Bounded concurrency + retry-with-backoff on rate limits. Crucially, a
        rate limit (429) is NOT treated as a logged-out session — re-logging in
        on 429 used to close the shared client and kill in-flight requests.
        """
        await self.ensure_login()
        async with self._sem:
            client = await self._http()
            headers = {"Referer": f"{POSTERDB_BASE_URL}/"}
            resp = None
            for attempt in range(3):
                try:
                    resp = await client.get(url, headers=headers)
                except httpx.HTTPError as exc:
                    if attempt == 2:
                        raise PosterDBError(f"Image request failed: {exc}") from exc
                    await asyncio.sleep(0.4 * (attempt + 1))
                    continue
                if resp.status_code in (429, 503):  # rate-limited / transient
                    await asyncio.sleep(0.5 * (attempt + 1))
                    continue
                if self._looks_logged_out(resp):
                    self._logged_in = False
                    await self.ensure_login()
                    continue
                break
            if resp is None or resp.status_code >= 400:
                raise PosterDBError(f"Download failed ({resp.status_code if resp else 'no response'}).")
            ctype = resp.headers.get("content-type", "image/jpeg")
            if "image" not in ctype:
                raise PosterDBError("ThePosterDB did not return an image (session may have expired).")
            return resp.content, ctype

    # -- fetching ---------------------------------------------------------
    async def _get_html(self, path: str) -> str:
        await self.ensure_login()
        async with self._sem:  # bound concurrency (search + verification fan-out)
            client = await self._http()
            resp = await client.get(path)
            if self._looks_logged_out(resp):
                self._logged_in = False
                await self.ensure_login()
                resp = await client.get(path)
        if self._is_blocked(resp):
            raise PosterDBError(
                "ThePosterDB blocked the request with a bot challenge (Cloudflare). "
                "Wait a moment and retry; if it persists, the site is requiring a real browser."
            )
        resp.raise_for_status()
        logger.info("GET %s -> %d (%d bytes)", path, resp.status_code, len(resp.text))
        return resp.text

    async def fetch_page(self, path: str) -> BeautifulSoup:
        return BeautifulSoup(await self._get_html(path), "html.parser")

    async def verify_titles(self, ids: list[str]) -> dict[str, int]:
        """Return ``{media_id: poster_count}`` for title pages.

        Search results come from TMDB and include titles nobody has uploaded
        posters for. The frontend uses these counts to hide the empty ones.
        Counts are cached so repeat searches/category switches are instant; a
        value of ``-1`` means "couldn't determine" (kept visible, not hidden).
        """
        ordered: list[str] = []
        for i in ids:
            if i not in ordered:
                ordered.append(i)

        async def one(mid: str) -> tuple[str, int]:
            cached = self._title_count_cache.get(mid)
            if cached is not None:
                return mid, cached
            try:
                html = await self._get_html(f"/posters/{mid}")
                count = len(re.findall(r"data-poster-id", html))
            except Exception as exc:  # noqa: BLE001 - don't hide a title on error
                logger.warning("verify title %s failed: %s", mid, exc)
                return mid, -1
            if len(self._title_count_cache) > 3000:
                self._title_count_cache.clear()
            self._title_count_cache[mid] = count
            return mid, count

        results = await asyncio.gather(*[one(m) for m in ordered[:48]])
        return dict(results)

    # -- parsing ----------------------------------------------------------
    def _parse_grid(self, soup: BeautifulSoup) -> list[PosterAsset]:
        cards = soup.select("div.col-6.col-lg-2.p-1")
        if not cards:
            # Resilient fallback: treat each data-poster-id holder's card as a unit.
            cards = [el.find_parent("div") for el in soup.select("[data-poster-id]")]

        assets: list[PosterAsset] = []
        seen: set[str] = set()
        for card in cards:
            if card is None:
                continue
            asset = self._asset_from_card(card)
            if asset and asset.id not in seen:
                seen.add(asset.id)
                assets.append(asset)
        return assets

    def _asset_from_card(self, card) -> Optional[PosterAsset]:
        holder = card.select_one("[data-poster-id]")
        if holder is None:
            return None
        poster_id = holder.get("data-poster-id")
        if not poster_id:
            return None

        type_a = card.select_one('a.text-white[data-toggle="tooltip"]') or card.select_one("a[title]")
        media_type = (type_a.get("title") if type_a else "") or ""

        title_el = (
            card.select_one("p.p-0.mb-1.text-break")
            or card.select_one("p.text-break")
            or card.find("p")
        )
        title = title_el.get_text(strip=True) if title_el else f"Poster {poster_id}"

        kind, season = _classify(media_type, title)
        # Prefer TPDb's small optimized webp thumbnail; fall back to full-res.
        thumb = self._extract_thumb(card) or _asset_url(poster_id)

        # On title-page cards, a badge gives the set's poster count + set URL.
        set_size: Optional[int] = None
        set_url: Optional[str] = None
        badge = card.select_one("a.set_poster_count")
        if badge:
            text = badge.get_text(strip=True)
            if text.isdigit():
                set_size = int(text)
            href = badge.get("href")
            if href:
                set_url = href if href.startswith("http") else f"{POSTERDB_BASE_URL}{href}"

        return PosterAsset(
            id=str(poster_id),
            title=title,
            kind=kind,
            season_number=season,
            thumb_url=_proxy_thumb(thumb),
            download_url=_asset_url(poster_id),
            set_size=set_size,
            set_url=set_url,
        )

    @staticmethod
    def _extract_thumb(card) -> Optional[str]:
        """Pull the optimized thumbnail URL from a card's <picture>/<img>.

        TPDb lazy-loads the real image into a ``<picture><source srcset>`` (a
        ~60 KB webp on its CDN); the ``<img src>`` is a placeholder. Using this
        instead of the full-res PNG (often 2–5 MB) is what stops a big grid from
        rate-limiting the site.
        """
        pic = card.find("picture")
        if pic:
            source = pic.find("source")
            if source and source.get("srcset"):
                first = source["srcset"].split(",")[0].strip().split(" ")[0]
                if first.startswith("http"):
                    return first
        img = card.find("img")
        if img:
            cand = img.get("data-src") or img.get("src") or ""
            if cand.startswith("http") and "missing_poster" not in cand:
                return cand
        return None

    def _single_asset(self, poster_id: str, soup: BeautifulSoup) -> PosterAsset:
        title_tag = soup.find("title")
        title = title_tag.get_text(strip=True).split(" - ")[0] if title_tag else f"Poster {poster_id}"
        return PosterAsset(
            id=str(poster_id),
            title=title,
            kind="unknown",
            thumb_url=_proxy_thumb(_asset_url(poster_id)),
            download_url=_asset_url(poster_id),
        )

    @staticmethod
    def _get_set_link(soup: BeautifulSoup) -> Optional[str]:
        link = soup.find("a", attrs={"data-toggle": "tooltip", "title": "View Set Page"})
        if link and link.get("href"):
            return link["href"]
        link = soup.find("a", class_="rounded view_all")
        if link and link.get("href"):
            return link["href"]
        return None

    # -- helpers ----------------------------------------------------------
    @staticmethod
    def _is_blocked(resp: httpx.Response) -> bool:
        # A genuine Cloudflare challenge is an HTML page with telltale markers
        # (or a 503). We deliberately do NOT treat a bare 403/429 as "blocked":
        # 429 is rate-limiting (handled with backoff) and shouldn't force a
        # re-login that tears down the shared client.
        if resp.status_code == 503:
            return True
        if "html" not in resp.headers.get("content-type", "") and resp.status_code == 200:
            return False
        head = resp.text[:4000].lower()
        return any(m in head for m in _BLOCK_MARKERS)

    @staticmethod
    def _looks_logged_out(resp: httpx.Response) -> bool:
        if resp.status_code in (401, 419):
            return True
        return str(resp.url).rstrip("/").endswith("/login")

    @staticmethod
    def _extract_csrf(html: str) -> Optional[str]:
        soup = BeautifulSoup(html, "html.parser")
        meta = soup.find("meta", attrs={"name": "csrf-token"})
        if meta and meta.get("content"):
            return meta["content"]
        hidden = soup.find("input", attrs={"name": "_token"})
        if hidden and hidden.get("value"):
            return hidden["value"]
        return None

    @staticmethod
    def _to_path(url: str) -> str:
        if url.startswith(POSTERDB_BASE_URL):
            return url[len(POSTERDB_BASE_URL):] or "/"
        if url.startswith("http"):
            return url
        return url if url.startswith("/") else f"/{url}"

    @classmethod
    def _normalize_path(cls, url_or_id: str) -> str:
        s = url_or_id.strip()
        if s.isdigit():
            return f"/set/{s}"
        m = _SET_ID_RE.search(s)
        if m:
            return f"/set/{m.group(1)}"
        m = _POSTER_ID_RE.search(s)
        if m:
            return f"/poster/{m.group(1)}"
        return cls._to_path(s)


# Module-level singleton reused across requests so the login session persists.
posterdb = PosterDBClient()
