import { apiRequest } from "./client";

export type NativeLibraryType = "movies" | "shows" | "anime" | "books";
export interface NativeLibraryOptions {
  read_nfo: boolean; save_nfo: boolean; local_artwork: boolean; save_artwork: boolean; fetch_missing: boolean;
  metadata_language: string; certification_country: string; image_language: string;
  prefer_embedded_titles: boolean; real_time_monitor: boolean; sample_ignore_mb: number; allow_adult_metadata: boolean;
  metadata_providers: Record<string, string[]>; image_providers: Record<string, string[]>; image_types: string[];
}
export const defaultNativeOptions: NativeLibraryOptions = {
  read_nfo: true, save_nfo: false, local_artwork: true, save_artwork: false, fetch_missing: true,
  metadata_language: "en", certification_country: "US", image_language: "en", prefer_embedded_titles: false, real_time_monitor: false,
  sample_ignore_mb: 300, allow_adult_metadata: false, metadata_providers: {}, image_providers: {},
  image_types: ["poster", "backdrop", "thumb", "logo", "banner"],
};
export interface NativeLibraryInput {
  options?: NativeLibraryOptions;
  name: string;
  library_type: NativeLibraryType;
  anime_content: "both" | "shows" | "movies";
  paths: string[];
  revision: number | null;
}
export interface NativeLibrary extends NativeLibraryInput {
  id: string;
  revision: number;
  created_at: string;
  updated_at: string;
}
export interface FolderList {
  root: string;
  path: string;
  folders: { name: string; path: string; has_nfo: boolean }[];
}
export const nativeLibraries = {
  list: () => apiRequest<NativeLibrary[]>("/native/libraries"),
  save: (input: NativeLibraryInput, id?: string) => apiRequest<NativeLibrary>(
    `/native/libraries${id ? `/${encodeURIComponent(id)}` : ""}`,
    { method: id ? "PUT" : "POST", body: JSON.stringify(input) },
  ),
  scan: (id: string) => apiRequest<void>(`/native/libraries/${encodeURIComponent(id)}/scan`, {method: "POST"}),
  status: (id: string) => apiRequest<NativeScanStatus>(`/native/libraries/${encodeURIComponent(id)}/scan`),
  catalog: (id: string) => apiRequest<NativeCatalogEntry[]>(`/native/libraries/${encodeURIComponent(id)}/items`),
  remove: (id: string, revision: number) => apiRequest<void>(`/native/libraries/${encodeURIComponent(id)}`, {method: "DELETE", body: JSON.stringify({revision})}),
  editItem: (library: string, item: NativeCatalogEntry, metadata: Record<string, unknown>) => apiRequest<{entry: NativeCatalogEntry; warnings: string[]}>(`/native/libraries/${encodeURIComponent(library)}/items/${encodeURIComponent(item.id)}`, {method: "PUT", body: JSON.stringify({revision: item.revision, metadata})}),
  artworkUrl: (library: string, item: string, kind: string) => `/api/native/libraries/${encodeURIComponent(library)}/items/${encodeURIComponent(item)}/artwork/${encodeURIComponent(kind)}`,
  upload: (library: string, item: string, kind: string, file: File) => {const body = new FormData(); body.append("file", file); return apiRequest<void>(`/native/libraries/${encodeURIComponent(library)}/items/${encodeURIComponent(item)}/artwork/${encodeURIComponent(kind)}`, {method: "POST", body, headers: {}});},
  folders: (path: string) => apiRequest<FolderList>(`/metadata/folders?path=${encodeURIComponent(path)}`),
};

export interface NativeArtwork { kind: string; path: string; source: string; }
export interface NativeCatalogEntry { id: string; path: string; kind: string; parent_path: string | null; title: string; metadata: Record<string, unknown>; artwork: NativeArtwork[]; files: {path: string; size: number; extension: string; media_info?: {format?: Record<string, unknown>; streams?: Record<string,unknown>[]} }[]; nfo_path: string | null; available: boolean; revision: number; }
export interface NativeScanStatus { status: string; count: number; warnings: string[]; }
