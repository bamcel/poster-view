// Shapes mirror the backend Pydantic models in backend/app/schemas.py.

export type ServerType = "plex" | "jellyfin" | "emby";
export type ImageTarget = "poster" | "background" | "logo";

export interface Server {
  id: number;
  name: string;
  type: ServerType;
  base_url: string;
  is_default: boolean;
  has_token: boolean;
  created_at: string;
  updated_at: string;
}

export interface ConnectionTest {
  ok: boolean;
  message: string;
  server_name?: string | null;
  version?: string | null;
}

export interface Library {
  id: string;
  title: string;
  type: "movie" | "show" | "collection" | "other";
}

export interface MediaItem {
  id: string;
  title: string;
  year?: number | null;
  type: "movie" | "show" | "collection";
  poster?: string | null;
  background?: string | null;
  added_at?: string | null;
}

export interface Season {
  id: string;
  title: string;
  index?: number | null;
  poster?: string | null;
  episode_count?: number | null;
}

export interface ItemDetail extends MediaItem {
  summary?: string | null;
  season_count?: number | null;
  seasons: Season[];
  external_ids: Record<string, string>;
  logo?: string | null;
  members: MediaItem[];
}

// --- Artwork providers (Fanart.tv / AniList / TheTVDB) ---

export type ArtworkType = "poster" | "background" | "banner" | "logo";

export interface ArtworkItem {
  id: string;
  provider: string;
  type: ArtworkType;
  kind: "movie" | "show" | "season" | "collection";
  season_number?: number | null;
  title?: string | null;
  lang?: string | null;
  likes?: number | null;
  thumb_url: string;
  download_url: string;
  applyable: boolean;
  source_url?: string | null;
}

export interface ArtworkResults {
  provider: string;
  item_title?: string | null;
  items: ArtworkItem[];
  message?: string | null;
}

export interface ArtworkSearchResult {
  id: string;
  name: string;
  year?: string | null;
  thumb_url?: string | null;
}

export interface ArtworkSearchResults {
  provider: string;
  results: ArtworkSearchResult[];
  message?: string | null;
}

export interface ArtworkProviderInfo {
  name: string;
  label: string;
  configured: boolean;
  needs_key: boolean;
  enabled: boolean;
}

export interface ArtworkSettings {
  fanart_configured: boolean;
  tvdb_configured: boolean;
  default_provider: string;
  enabled_providers: string[];
}

export interface ArtworkCacheSettings {
  max_mb: number;
  ttl_days: number;
  watchdog_enabled: boolean;
  watchdog_interval_hours: number;
}

export interface ArtworkCacheStatus extends ArtworkCacheSettings {
  used_bytes: number;
  file_count: number;
  watchdog_running: boolean;
  watchdog_last_run?: string | null;
  watchdog_last_message?: string | null;
  watchdog_progress_current: number;
  watchdog_progress_total: number;
  watchdog_current_title?: string | null;
}

export interface ArtworkCacheClearResult {
  cleared_bytes: number;
  cleared_files: number;
}

export interface ArtworkRefreshResult {
  ok: boolean;
  message: string;
  providers_warmed: number;
}

export interface ArtworkProviderTestRequest {
  provider: "fanart" | "tvdb";
  fanart_api_key?: string;
  tvdb_api_key?: string;
  tvdb_pin?: string;
}

export interface ArtworkProviderTestResult {
  ok: boolean;
  message: string;
}

export type PosterKind = "show" | "movie" | "season" | "collection" | "background" | "unknown";

export interface PosterAsset {
  id: string;
  title: string;
  kind: PosterKind;
  season_number?: number | null;
  thumb_url: string;
  download_url: string;
  set_size?: number | null;
  set_url?: string | null;
}

export interface PosterSet {
  set_url: string;
  title?: string | null;
  posters: PosterAsset[];
}

export interface PosterTitleResult {
  title: string;
  url: string;
  media_id: string;
}

export interface PosterCategory {
  name: string;
  count: number;
  results: PosterTitleResult[];
}

export interface PosterSearchResults {
  term: string;
  categories: PosterCategory[];
}

export interface PosterDBStatus {
  configured: boolean;
  email: string;
  logged_in: boolean;
  message: string;
}

export interface ApplyResult {
  ok: boolean;
  message: string;
}

export interface ApplyHistoryEntry {
  id: number;
  server_id: number;
  server_name: string;
  item_id: string;
  item_title: string;
  target: ImageTarget;
  provider: string;
  applied_at: string;
  thumb_url: string;
}

export interface HistorySettings {
  purge_days: number;
  max_entries: number;
}

export interface HistoryPurgeResult {
  purged: number;
}
