// Thin typed wrapper over fetch. All calls are same-origin (/api/...): in dev
// Vite proxies to the backend; in production the Axum server serves this bundle.

import type {
  ApplyHistoryEntry,
  ApplyResult,
  ArtworkProviderInfo,
  ArtworkCacheClearResult,
  ArtworkCacheSettings,
  ArtworkCacheStatus,
  ArtworkRefreshResult,
  ArtworkProviderTestRequest,
  ArtworkProviderTestResult,
  ArtworkResults,
  ArtworkSearchResults,
  ArtworkSettings,
  ConnectionTest,
  HistoryPurgeResult,
  HistorySettings,
  ImageTarget,
  ItemDetail,
  Library,
  MediaItem,
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
}

export interface SecuritySettings {
  idle_timeout_minutes: number | null;
  local_network_bypass: boolean;
}

export interface AuthSession {
  authenticated: boolean;
  password_required?: boolean;
  idle_timeout_minutes?: number | null;
}

export const api = {
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
  testServerSaved: (id: number) =>
    request<ConnectionTest>(`/servers/${id}/test`, { method: "POST" }),

  // -- libraries / items --
  getLibraries: (serverId: number) => request<Library[]>(`/servers/${serverId}/libraries`),
  getItems: (serverId: number, libraryId: string, groupCollections = true) =>
    request<MediaItem[]>(
      `/servers/${serverId}/libraries/${encodeURIComponent(libraryId)}/items?group_collections=${groupCollections}`,
    ),
  getItemDetail: (serverId: number, itemId: string) =>
    request<ItemDetail>(`/servers/${serverId}/items/${encodeURIComponent(itemId)}`),

  // -- posterdb --
  posterdbStatus: () => request<PosterDBStatus>("/posterdb/status"),
  setPosterdbCredentials: (email: string, password: string) =>
    request<PosterDBStatus>("/posterdb/credentials", {
      method: "PUT",
      body: JSON.stringify({ email, password }),
    }),
  posterdbLogin: () => request<PosterDBStatus>("/posterdb/login", { method: "POST" }),
  posterdbSearch: (term: string) =>
    request<PosterSearchResults>(`/posterdb/search?term=${encodeURIComponent(term)}`),
  posterdbSearchPreview: (term: string) =>
    request<PosterSearchResults | null>(
      `/posterdb/search/preview?term=${encodeURIComponent(term)}`,
    ),
  posterdbSet: (url: string) =>
    request<PosterSet>(`/posterdb/set?url=${encodeURIComponent(url)}`),
  posterdbVerify: (ids: string[]) =>
    request<Record<string, number>>("/posterdb/verify", {
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

  // -- artwork providers (Fanart / AniList / TVDB) --
  artworkProviders: () => request<ArtworkProviderInfo[]>("/artwork/providers"),
  getArtworkSettings: () => request<ArtworkSettings>("/artwork/settings"),
  setArtworkSettings: (data: {
    fanart_api_key?: string;
    tvdb_api_key?: string;
    tvdb_pin?: string;
    default_provider?: string;
    enabled_providers?: string[];
  }) => request<ArtworkSettings>("/artwork/settings", { method: "PUT", body: JSON.stringify(data) }),
  testArtworkProvider: (data: ArtworkProviderTestRequest) =>
    request<ArtworkProviderTestResult>("/artwork/test", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  getArtworkCache: () => request<ArtworkCacheStatus>("/artwork/cache"),
  setArtworkCache: (data: ArtworkCacheSettings) =>
    request<ArtworkCacheStatus>("/artwork/cache", {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  clearArtworkCache: () =>
    request<ArtworkCacheClearResult>("/artwork/cache", { method: "DELETE" }),
  refreshArtworkItem: (serverId: number, itemId: string) =>
    request<ArtworkRefreshResult>("/artwork/cache/refresh", {
      method: "POST",
      body: JSON.stringify({ server_id: serverId, item_id: itemId }),
    }),
  runArtworkWatchdog: () =>
    request<ArtworkRefreshResult>("/artwork/cache/watchdog/run", { method: "POST" }),
  getArtwork: (provider: string, serverId: number, itemId: string, idOverride?: string) =>
    request<ArtworkResults>(
      `/artwork?provider=${provider}&server_id=${serverId}&item_id=${encodeURIComponent(itemId)}` +
        (idOverride ? `&id_override=${encodeURIComponent(idOverride)}` : ""),
    ),
  searchArtwork: (provider: string, serverId: number, itemId: string, query: string) =>
    request<ArtworkSearchResults>(
      `/artwork/search?provider=${provider}&server_id=${serverId}&item_id=${encodeURIComponent(itemId)}&query=${encodeURIComponent(query)}`,
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

  // -- apply history (global feed + revert to a previously-applied image) --
  getHistory: (opts: { serverId?: number; itemId?: string; target?: ImageTarget; limit?: number } = {}) => {
    const p = new URLSearchParams();
    if (opts.serverId != null) p.set("server_id", String(opts.serverId));
    if (opts.itemId) p.set("item_id", opts.itemId);
    if (opts.target) p.set("target", opts.target);
    if (opts.limit != null) p.set("limit", String(opts.limit));
    return request<ApplyHistoryEntry[]>(`/history?${p.toString()}`);
  },
  revertHistory: (historyId: number) =>
    request<ApplyResult>(`/history/${historyId}/revert`, { method: "POST" }),
  getHistorySettings: () => request<HistorySettings>("/history/settings"),
  setHistorySettings: (settings: HistorySettings) =>
    request<HistorySettings>("/history/settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    }),
  purgeHistory: (days?: number) =>
    request<HistoryPurgeResult>(`/history/purge${days != null ? `?days=${days}` : ""}`, { method: "POST" }),
};
