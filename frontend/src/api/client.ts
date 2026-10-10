// Thin typed wrapper over fetch. All calls are same-origin (/api/...): in dev
// Vite proxies to the backend; in production the Axum server serves this bundle.

import type {
  AppearanceSettings,
  ApplyResult,
  ArtworkProviderInfo,
  ArtworkRefreshResult,
  ArtworkProviderTestRequest,
  ArtworkProviderTestResult,
  ArtworkResults,
  ArtworkSearchResults,
  ArtworkSettings,
  ConnectionTest,
  ImageTarget,
  ItemDetail,
  Library,
  LibraryVisibility,
  MediaItem,
  NfoMetadata,
  PosterDBStatus,
  PosterSearchResults,
  PosterSet,
  Server,
  ServerType,
} from "../types";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new Event("posterview:unauthorized"));
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body.detail ?? detail;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export { request as apiRequest };

/** Build the proxied image URL for a normalized image ref. */
export function imageUrl(serverId: number, ref?: string | null): string | undefined {
  if (!ref) return undefined;
  return `/api/servers/${serverId}/image?ref=${encodeURIComponent(ref)}`;
}

export interface ServerInput {
  name: string;
  type: ServerType;
  base_url: string;
  token: string;
  is_default: boolean;
  nfo_metadata_enabled: boolean;
}

export interface SecuritySettings {
  idle_timeout_minutes: number | null;
  local_network_bypass: boolean;
  login_backdrop_enabled: boolean;
}

export interface LoginBackdropManifest { rows: { posters: string[] }[]; }

export interface AuthSession {
  username?: string;
  authenticated: boolean;
  password_required?: boolean;
  idle_timeout_minutes?: number | null;
}

export const api = {
  appearanceSettings: () => request<AppearanceSettings>("/appearance/settings"),
  saveAppearanceSettings: (settings: AppearanceSettings) => request<AppearanceSettings>("/appearance/settings", {
    method: "PUT", body: JSON.stringify(settings),
  }),
  loginBackdrop: () => request<LoginBackdropManifest>("/login-backdrop"),
  securitySettings: () => request<SecuritySettings>("/security/settings"),
  saveSecuritySettings: (settings: SecuritySettings) => request<SecuritySettings>("/security/settings", {
    method: "PUT", body: JSON.stringify(settings),
  }),
  authActivity: () => request<void>("/auth/activity", { method: "POST" }),
  authStatus: () => request<AuthSession>("/auth/status"),
  authLogin: (username: string, password: string) =>
    request<AuthSession>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  authLogout: () =>
    request<{ authenticated: boolean }>("/auth/logout", { method: "POST" }),

  // -- servers --
  listServers: () => request<Server[]>("/servers"),
  createServer: (data: ServerInput) =>
    request<Server>("/servers", { method: "POST", body: JSON.stringify(data) }),
  updateServer: (id: number, data: Partial<ServerInput>) =>
    request<Server>(`/servers/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteServer: (id: number) => request<void>(`/servers/${id}`, { method: "DELETE" }),
  testServerAdhoc: (data: ServerInput) =>
    request<ConnectionTest>("/servers/test", { method: "POST", body: JSON.stringify(data) }),
  testServerSaved: (id: number, data?: Partial<ServerInput>) =>
    request<ConnectionTest>(`/servers/${id}/test`, { method: "POST", ...(data ? { body: JSON.stringify(data) } : {}) }),

  // -- libraries / items --
  getIntegrationLibraries: async (serverId: number) => (await request<LibraryVisibility>(`/servers/${serverId}/library-visibility`)).libraries,
  getLibraries: (serverId: number) => request<Library[]>(`/servers/${serverId}/libraries`),
  getLibraryVisibility: (serverId: number) =>
    request<LibraryVisibility>(`/servers/${serverId}/library-visibility`),
  setLibraryVisibility: (serverId: number, hiddenLibraryIds: string[]) =>
    request<void>(`/servers/${serverId}/library-visibility`, {
      method: "PUT",
      body: JSON.stringify({ hidden_library_ids: hiddenLibraryIds }),
    }),
  getItems: (serverId: number, libraryId: string, groupCollections = true, parentId?: string) =>
    request<MediaItem[]>(
      `/servers/${serverId}/libraries/${encodeURIComponent(libraryId)}/items?group_collections=${groupCollections}` + (parentId ? `&parent_id=${encodeURIComponent(parentId)}` : ""),
    ),
  getItemDetail: (serverId: number, itemId: string) =>
    request<ItemDetail>(`/servers/${serverId}/items/${encodeURIComponent(itemId)}`),
  getNfoMetadata: (serverId: number, itemId: string) =>
    request<NfoMetadata | null>(`/metadata/item?server_id=${serverId}&item_id=${encodeURIComponent(itemId)}`),
  updateNfoMetadata: (serverId: number, itemId: string, fields: NfoMetadata) =>
    request<NfoMetadata>("/metadata/item", {
      method: "PUT",
      body: JSON.stringify({ server_id: serverId, item_id: itemId, fields }),
    }),
  useComicVineMetadata: (serverId: number, itemId: string, volumeId: string) =>
    request<NfoMetadata>("/metadata/comicvine", {
      method: "POST",
      body: JSON.stringify({ server_id: serverId, item_id: itemId, volume_id: volumeId }),
    }),
  previewComicVineMetadata: (serverId: number, itemId: string, volumeId: string) =>
    request<NfoMetadata>("/metadata/comicvine/preview", {
      method: "POST",
      body: JSON.stringify({ server_id: serverId, item_id: itemId, volume_id: volumeId }),
    }),
  useAniListMangaMetadata: (serverId: number, itemId: string, anilistId: string) =>
    request<NfoMetadata>("/metadata/anilist-manga", {
      method: "POST",
      body: JSON.stringify({ server_id: serverId, item_id: itemId, anilist_id: anilistId }),
    }),
  previewAniListMangaMetadata: (serverId: number, itemId: string, anilistId: string) =>
    request<NfoMetadata>("/metadata/anilist-manga/preview", {
      method: "POST",
      body: JSON.stringify({ server_id: serverId, item_id: itemId, anilist_id: anilistId }),
    }),

  // -- posterdb --
  posterdbStatus: () => request<PosterDBStatus>("/posterdb/status"),
  setPosterdbCredentials: (email: string, password: string) =>
    request<PosterDBStatus>("/posterdb/credentials", {
      method: "PUT",
      body: JSON.stringify({ email, password }),
    }),
  posterdbLogin: () => request<PosterDBStatus>("/posterdb/login", { method: "POST" }),
  posterdbSearch: (serverId: number, term: string) =>
    request<PosterSearchResults>(`/posterdb/search?server_id=${serverId}&term=${encodeURIComponent(term)}`),
  posterdbSearchPreview: (serverId: number, term: string) =>
    request<PosterSearchResults | null>(
      `/posterdb/search/preview?server_id=${serverId}&term=${encodeURIComponent(term)}`,
    ),
  posterdbSet: (serverId: number, url: string) =>
    request<PosterSet>(`/posterdb/set?server_id=${serverId}&url=${encodeURIComponent(url)}`),
  posterdbVerify: (serverId: number, ids: string[]) =>
    request<Record<string, number>>(`/posterdb/verify?server_id=${serverId}`, {
      method: "POST",
      body: JSON.stringify({ ids }),
    }),
  applyPoster: (data: {
    server_id: number;
    item_id: string;
    target: ImageTarget;
    provider?: string;
    download_url: string;
    item_title?: string;
  }) => request<ApplyResult>("/posterdb/apply", { method: "POST", body: JSON.stringify(data) }),
  removeArtwork: (data: { server_id: number; item_id: string; target: ImageTarget }) =>
    request<ApplyResult>("/artwork/remove", { method: "POST", body: JSON.stringify(data) }),

  // -- artwork providers (Fanart / AniList / TVDB) --
  artworkProviders: () => request<ArtworkProviderInfo[]>("/artwork/providers"),
  getArtworkSettings: () => request<ArtworkSettings>("/artwork/settings"),
  setArtworkSettings: (data: {
    tmdb_access_token?: string;
    fanart_api_key?: string;
    tvdb_api_key?: string;
    tvdb_pin?: string;
    comicvine_api_key?: string;
    default_provider?: string;
    ereader_default_provider?: string;
    enabled_providers?: string[];
  }) => request<ArtworkSettings>("/artwork/settings", { method: "PUT", body: JSON.stringify(data) }),
  testArtworkProvider: (data: ArtworkProviderTestRequest) =>
    request<ArtworkProviderTestResult>("/artwork/test", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  refreshArtworkItem: (serverId: number, itemId: string) =>
    request<ArtworkRefreshResult>("/artwork/cache/refresh", {
      method: "POST",
      body: JSON.stringify({ server_id: serverId, item_id: itemId }),
    }),
  mangaSelection: (serverId: number, itemId: string) =>
    request<import("../types").MangaSelection>(`/artwork/mangadex/selection?server_id=${serverId}&item_id=${encodeURIComponent(itemId)}`),
  saveMangaSelection: (serverId: number, itemId: string, selection: import("../types").MangaSelection) =>
    request<import("../types").MangaSelection>(`/artwork/mangadex/selection?server_id=${serverId}&item_id=${encodeURIComponent(itemId)}`, { method: "PUT", body: JSON.stringify(selection) }),
  getArtwork: (provider: string, serverId: number, itemId: string, idOverride?: string, refresh = false) =>
    request<ArtworkResults>(
      `/artwork?provider=${provider}&server_id=${serverId}&item_id=${encodeURIComponent(itemId)}` +
        (idOverride ? `&id_override=${encodeURIComponent(idOverride)}` : "") + (refresh ? "&refresh=true" : ""),
    ),
  searchArtwork: (provider: string, serverId: number, itemId: string, query: string, refresh = false) =>
    request<ArtworkSearchResults>(
      `/artwork/search?provider=${provider}&server_id=${serverId}&item_id=${encodeURIComponent(itemId)}&query=${encodeURIComponent(query)}` + (refresh ? "&refresh=true" : ""),
    ),

  // Manual image upload (multipart — let the browser set the boundary).
  applyUpload: async (data: {
    server_id: number;
    item_id: string;
    target: ImageTarget;
    file: File;
    item_title?: string;
  }): Promise<ApplyResult> => {
    const fd = new FormData();
    fd.append("server_id", String(data.server_id));
    fd.append("item_id", data.item_id);
    fd.append("target", data.target);
    fd.append("file", data.file);
    if (data.item_title) fd.append("item_title", data.item_title);
    const res = await fetch("/api/artwork/upload", { method: "POST", body: fd });
    if (!res.ok) {
      let detail = res.statusText;
      try {
        detail = (await res.json()).detail ?? detail;
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, typeof detail === "string" ? detail : JSON.stringify(detail));
    }
    return res.json();
  },

};
