"""Artwork providers (Fanart.tv, AniList, TheTVDB).

Unlike ThePosterDB (which is scraped and searched by title), these are proper
APIs queried by the item's external ids (or title, for AniList). Each provider
maps its response into the shared ``ArtworkItem`` shape so the UI can present
posters / backgrounds / banners / logos uniformly.
"""

from .factory import PROVIDERS, get_provider, provider_infos

__all__ = ["PROVIDERS", "get_provider", "provider_infos"]
