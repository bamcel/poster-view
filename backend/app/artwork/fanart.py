"""Fanart.tv provider — posters, backgrounds, banners, logos for movies & TV."""

from __future__ import annotations

from typing import Optional

from ..db import get_setting
from ..schemas import ArtworkItem, ItemDetail
from .base import ArtworkError, ArtworkProvider

FANART_BASE = "https://webservice.fanart.tv/v3"

# field name -> (artwork type, is_seasonal)
_MOVIE_FIELDS = {
    "movieposter": ("poster", False),
    "moviebackground": ("background", False),
    "moviebanner": ("banner", False),
    "hdmovielogo": ("logo", False),
    "movielogo": ("logo", False),
}
_TV_FIELDS = {
    "tvposter": ("poster", False),
    "showbackground": ("background", False),
    "tvbanner": ("banner", False),
    "hdtvlogo": ("logo", False),
    "clearlogo": ("logo", False),
    "seasonposter": ("poster", True),
    "seasonbanner": ("banner", True),
}


def _to_int(value) -> int | None:
    return int(value) if str(value).isdigit() else None


class FanartProvider(ArtworkProvider):
    name = "fanart"
    label = "Fanart.tv"
    needs_key = True

    def _key(self) -> str:
        return get_setting("fanart_api_key")

    def is_configured(self) -> bool:
        return bool(self._key())

    async def fetch(self, item: ItemDetail, id_override: Optional[str] = None) -> list[ArtworkItem]:
        key = self._key()
        if not key:
            raise ArtworkError("Fanart.tv API key is not configured (add it in Settings).")

        if item.type == "movie":
            fid = id_override or item.external_ids.get("tmdb") or item.external_ids.get("imdb")
            if not fid:
                raise ArtworkError("This movie has no TMDB/IMDb id, which Fanart.tv needs.")
            endpoint, fields, kind = f"{FANART_BASE}/movies/{fid}", _MOVIE_FIELDS, "movie"
        else:
            fid = id_override or item.external_ids.get("tvdb")
            if not fid:
                raise ArtworkError("This show has no TheTVDB id, which Fanart.tv needs.")
            endpoint, fields, kind = f"{FANART_BASE}/tv/{fid}", _TV_FIELDS, "show"

        async with self._http() as client:
            resp = await client.get(endpoint, params={"api_key": key})
        if resp.status_code == 404:
            return []  # nothing on Fanart.tv for this id yet
        if resp.status_code in (401, 403):
            raise ArtworkError("Fanart.tv rejected the API key — double-check it in Settings.")
        if resp.status_code >= 400:
            raise ArtworkError(f"Fanart.tv error ({resp.status_code}).")

        data = resp.json()
        items: list[ArtworkItem] = []
        for field, (art_type, seasonal) in fields.items():
            for entry in data.get(field) or []:
                url = (entry.get("url") or "").replace("http://", "https://")
                if not url:
                    continue
                season = None
                item_kind = kind
                if seasonal:
                    item_kind = "season"
                    raw = str(entry.get("season", "")).lower()
                    season = 0 if raw in ("specials", "0") else _to_int(raw)
                items.append(
                    ArtworkItem(
                        id=str(entry.get("id") or url),
                        provider="fanart",
                        type=art_type,
                        kind=item_kind,
                        season_number=season,
                        title=item.title,
                        lang=(entry.get("lang") or None),
                        likes=_to_int(entry.get("likes")),
                        thumb_url=url,
                        download_url=url,
                        applyable=art_type in ("poster", "background", "logo"),
                    )
                )
        # Most-liked first within each type (the UI groups by type).
        items.sort(key=lambda a: (a.type, -(a.likes or 0)))
        return items
