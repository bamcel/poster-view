"""Artwork provider registry."""

from __future__ import annotations

from typing import Optional

from ..schemas import ArtworkProviderInfo
from .anilist import AniListProvider
from .base import ArtworkProvider
from .fanart import FanartProvider
from .mediux import MediuxProvider
from .tvdb import TVDBProvider

# Instantiated once; providers read settings fresh on each call and cache tokens.
PROVIDERS: dict[str, ArtworkProvider] = {
    p.name: p for p in (FanartProvider(), TVDBProvider(), AniListProvider(), MediuxProvider())
}


def get_provider(name: str) -> Optional[ArtworkProvider]:
    return PROVIDERS.get(name)


def provider_infos() -> list[ArtworkProviderInfo]:
    return [
        ArtworkProviderInfo(
            name=p.name, label=p.label, configured=p.is_configured(), needs_key=p.needs_key
        )
        for p in PROVIDERS.values()
    ]
