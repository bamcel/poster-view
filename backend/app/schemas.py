"""Pydantic models describing the HTTP API contract.

The ``Normalized*`` models are the server-agnostic shapes the frontend
consumes; each media-client implementation maps Plex/Jellyfin/Emby responses
into them so the UI never has to branch on server type.
"""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

ServerType = Literal["plex", "jellyfin", "emby"]
ImageTarget = Literal["poster", "background", "logo"]


# ---------------------------------------------------------------------------
# Media servers
# ---------------------------------------------------------------------------

class ServerCreate(BaseModel):
    name: str
    type: ServerType
    base_url: str = Field(..., description="e.g. http://192.168.1.10:32400")
    token: str = Field(..., description="Plex token, or Jellyfin/Emby API key")
    is_default: bool = False


class ServerUpdate(BaseModel):
    name: Optional[str] = None
    type: Optional[ServerType] = None
    base_url: Optional[str] = None
    # Empty string = keep the stored token untouched.
    token: Optional[str] = None
    is_default: Optional[bool] = None


class ServerOut(BaseModel):
    id: int
    name: str
    type: ServerType
    base_url: str
    is_default: bool
    has_token: bool
    created_at: str
    updated_at: str


class ConnectionTest(BaseModel):
    ok: bool
    message: str
    server_name: Optional[str] = None
    version: Optional[str] = None


# ---------------------------------------------------------------------------
# Normalized media shapes
# ---------------------------------------------------------------------------

class NormalizedLibrary(BaseModel):
    id: str
    title: str
    type: Literal["movie", "show", "collection", "other"]


class NormalizedItem(BaseModel):
    id: str
    title: str
    year: Optional[int] = None
    type: Literal["movie", "show", "collection"]
    poster: Optional[str] = None      # image proxy ref
    # Only populated on item DETAIL (the library grid never shows backdrops).
    background: Optional[str] = None  # image proxy ref
    # ISO 8601 timestamp the item was added to the media server's library —
    # lets the UI flag titles added since your last visit that still have no
    # poster (see LibraryPage's "new + missing artwork" badge).
    added_at: Optional[str] = None


class NormalizedSeason(BaseModel):
    id: str
    title: str
    index: Optional[int] = None
    poster: Optional[str] = None
    episode_count: Optional[int] = None


class ItemDetail(NormalizedItem):
    summary: Optional[str] = None
    season_count: Optional[int] = None
    seasons: list[NormalizedSeason] = Field(default_factory=list)
    # External provider ids used to query Fanart.tv / TheTVDB, e.g.
    # {"tmdb": "603", "tvdb": "78901", "imdb": "tt0133093"}.
    external_ids: dict[str, str] = Field(default_factory=dict)
    # The item's own clear-logo artwork (as already stored by the media server
    # itself), if any — shown instead of a plain text title, image proxy ref.
    logo: Optional[str] = None
    # Only populated when type == "collection": its member movies/shows, each
    # a full library item you can drill into and edit like any other title.
    members: list[NormalizedItem] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Artwork providers (Fanart.tv / AniList / TheTVDB) — multi-type artwork
# ---------------------------------------------------------------------------

ArtworkType = Literal["poster", "background", "banner", "logo"]


class ArtworkItem(BaseModel):
    id: str
    provider: str                       # "fanart" | "anilist" | "tvdb" | "mediux"
    type: ArtworkType
    kind: Literal["movie", "show", "season", "collection"] = "show"
    season_number: Optional[int] = None
    title: Optional[str] = None
    lang: Optional[str] = None
    likes: Optional[int] = None
    thumb_url: str                      # preview URL (loaded directly by browser)
    download_url: str                   # full-res URL the backend fetches to apply
    # Only poster/background are wired to apply for now; banners/logos are shown
    # but not yet applyable (per current scope).
    applyable: bool = True
    source_url: Optional[str] = None


class ArtworkResults(BaseModel):
    provider: str
    item_title: Optional[str] = None
    items: list[ArtworkItem] = Field(default_factory=list)
    message: Optional[str] = None


class ArtworkSearchResult(BaseModel):
    id: str                             # the id this provider needs to fetch artwork
    name: str
    year: Optional[str] = None
    thumb_url: Optional[str] = None


class ArtworkSearchResults(BaseModel):
    provider: str
    results: list[ArtworkSearchResult] = Field(default_factory=list)
    message: Optional[str] = None


class ArtworkProviderInfo(BaseModel):
    name: str
    label: str
    configured: bool
    needs_key: bool


class ArtworkSettings(BaseModel):
    fanart_configured: bool = False
    tvdb_configured: bool = False


class ArtworkSettingsUpdate(BaseModel):
    fanart_api_key: Optional[str] = None
    tvdb_api_key: Optional[str] = None
    tvdb_pin: Optional[str] = None


# ---------------------------------------------------------------------------
# ThePosterDB
# ---------------------------------------------------------------------------

class PosterDBCredentials(BaseModel):
    email: str = ""
    # Write-only; never echoed back to the client.
    password: str = ""


class PosterDBStatus(BaseModel):
    configured: bool
    email: str = ""
    logged_in: bool = False
    message: str = ""


PosterKind = Literal["show", "movie", "season", "collection", "background", "unknown"]


class PosterAsset(BaseModel):
    id: str
    title: str
    kind: PosterKind = "unknown"
    season_number: Optional[int] = None
    thumb_url: str           # proxied preview URL
    download_url: str        # URL the backend uses to fetch the bytes
    # Only on title-page cards: how many posters are in this cover's set, and the
    # direct set URL to open it.
    set_size: Optional[int] = None
    set_url: Optional[str] = None


class PosterSet(BaseModel):
    set_url: str
    title: Optional[str] = None
    posters: list[PosterAsset] = Field(default_factory=list)


class PosterTitleResult(BaseModel):
    """A single title (movie/show/collection) matched by a search."""
    title: str
    url: str        # the TPDb title page (/posters/{id}) to open
    media_id: str


class PosterCategory(BaseModel):
    name: str       # "Movies" | "Shows" | "Collections"
    count: int
    results: list[PosterTitleResult] = Field(default_factory=list)


class PosterSearchResults(BaseModel):
    term: str
    categories: list[PosterCategory] = Field(default_factory=list)


class VerifyTitlesRequest(BaseModel):
    ids: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Apply
# ---------------------------------------------------------------------------

class ApplyRequest(BaseModel):
    server_id: int
    item_id: str
    target: ImageTarget = "poster"
    # Which source the image comes from — decides how the backend downloads it
    # ("posterdb" uses the authenticated TPDb session; others are public URLs).
    provider: str = "posterdb"
    download_url: str  # the full image URL to fetch
    # The frontend already has this in hand (it's the item/season/member the
    # apply panel is open on) — stored on the history row so a global history
    # feed can show it without re-fetching from the media server.
    item_title: str = ""


class ApplyResult(BaseModel):
    ok: bool
    message: str


# ---------------------------------------------------------------------------
# Apply history (revert-to-previous-image)
# ---------------------------------------------------------------------------

class ApplyHistoryEntry(BaseModel):
    id: int
    server_id: int
    server_name: str = ""
    item_id: str
    item_title: str = ""
    target: ImageTarget
    provider: str
    applied_at: str
    thumb_url: str


class HistorySettings(BaseModel):
    # Max age in days before an entry is auto-purged (only entries OLDER
    # than this are ever touched); 0 = disabled, only max_entries applies.
    purge_days: int = 0
    # Hard ceiling on total history rows, globally — oldest pruned first
    # once exceeded.
    max_entries: int = 50


class HistoryPurgeResult(BaseModel):
    purged: int
