import { apiRequest } from "./client";

export type NativeLibraryType = "movies" | "shows" | "anime" | "books";
export interface ServerSyncOptions { enabled:boolean; mode?:"two_way"|"import_only"|"push_only"; server_id:number|null; library_id:string; override_locked:boolean; write_nfo:boolean; push_to_all:boolean; push_server_ids:number[]; }
export const defaultServerSync:ServerSyncOptions={enabled:false,mode:"two_way",server_id:null,library_id:"",override_locked:false,write_nfo:false,push_to_all:true,push_server_ids:[]};
export interface NativeLibraryOptions {
  server_sync?:ServerSyncOptions;
  show_missing_files?:boolean; show_missing_specials?:boolean;
  read_nfo: boolean; save_nfo: boolean; local_artwork: boolean; save_artwork: boolean; fetch_missing: boolean;
  metadata_language: string; certification_country: string; image_language: string;
  prefer_embedded_titles: boolean; real_time_monitor: boolean; sample_ignore_mb: number; allow_adult_metadata: boolean;
  metadata_providers: Record<string, string[]>; image_providers: Record<string, string[]>; image_types: string[];
}
export const defaultNativeOptions: NativeLibraryOptions = {
  server_sync:defaultServerSync,show_missing_files:true,show_missing_specials:false,
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
  syncStatus:(id:string)=>apiRequest<SyncStatus>(`/native/libraries/${encodeURIComponent(id)}/sync`),
  sync:(id:string,input:Record<string,unknown>={})=>apiRequest<{status:string}>(`/native/libraries/${encodeURIComponent(id)}/sync`,{method:"POST",body:JSON.stringify(input)}),
  previews: (id: string) => apiRequest<{id:string;title:string;revision:number}[]>(`/native/libraries/${encodeURIComponent(id)}/previews`),
  list: () => apiRequest<NativeLibrary[]>("/native/libraries"),
  save: (input: NativeLibraryInput, id?: string) => apiRequest<NativeLibrary>(
    `/native/libraries${id ? `/${encodeURIComponent(id)}` : ""}`,
    { method: id ? "PUT" : "POST", body: JSON.stringify(input) },
  ),
  scanFolder: (library:string,item:string,refreshMetadata=false,options?:{replaceMetadata:boolean;replaceImages:boolean}) => apiRequest<void>(`/native/libraries/${encodeURIComponent(library)}/items/${encodeURIComponent(item)}/scan${refreshMetadata?`?refresh_metadata=true&replace_metadata=${options?.replaceMetadata??false}&replace_images=${options?.replaceImages??false}`:""}`,{method:"POST"}),
  scan: (id: string) => apiRequest<void>(`/native/libraries/${encodeURIComponent(id)}/scan`, {method: "POST"}),
  status: (id: string) => apiRequest<NativeScanStatus>(`/native/libraries/${encodeURIComponent(id)}/scan`),
  catalog: (id: string) => apiRequest<NativeCatalogEntry[]>(`/native/libraries/${encodeURIComponent(id)}/items`),
  remove: (id: string, revision: number) => apiRequest<void>(`/native/libraries/${encodeURIComponent(id)}`, {method: "DELETE", body: JSON.stringify({revision})}),
  metadataPreview: (library:string,item:string,provider:string) => apiRequest<{provider:string;fields:Record<string,unknown>}>(`/native/libraries/${encodeURIComponent(library)}/items/${encodeURIComponent(item)}/metadata/preview`,{method:"POST",body:JSON.stringify({provider})}),
  editItem: (library: string, item: NativeCatalogEntry, metadata: Record<string, unknown>) => apiRequest<{entry: NativeCatalogEntry; warnings: string[]}>(`/native/libraries/${encodeURIComponent(library)}/items/${encodeURIComponent(item.id)}`, {method: "PUT", body: JSON.stringify({revision: item.revision, metadata})}),
  identifyResolve: (library:string,item:string,provider:string,id:string) => apiRequest<{identifiers:Record<string,string>;candidates:IdentificationCandidate[];warnings:string[]}>(`/native/libraries/${encodeURIComponent(library)}/items/${encodeURIComponent(item)}/identify/resolve`,{method:"POST",body:JSON.stringify({provider,id})}),
  identifySearch: (library: string, item: string, title:string, year:number|null,criteria?:{provider?:string;tvdb_id?:string;imdb_id?:string;tmdb_id?:string;providers?:string[]}) => apiRequest<{groups:IdentificationGroup[]}>(`/native/libraries/${encodeURIComponent(library)}/items/${encodeURIComponent(item)}/identify/search`, {method:"POST",body:JSON.stringify({title,year,...criteria})}),
  identify: (library:string,item:string,input:{revision:number;title:string;year:number|null;identifiers:Record<string,string>;rewrite_metadata?:boolean;replace_artwork?:boolean}) => apiRequest<{entry:NativeCatalogEntry;warnings:string[];message:string}>(`/native/libraries/${encodeURIComponent(library)}/items/${encodeURIComponent(item)}/identify`,{method:"POST",body:JSON.stringify(input)}),
  refreshArtwork: (library:string,item:string) => apiRequest<{updated:number;warnings:string[]}>(`/native/libraries/${encodeURIComponent(library)}/items/${encodeURIComponent(item)}/artwork/refresh`,{method:"POST"}),
  artworkUrl: (library: string, item: string, kind: string) => `/api/native/libraries/${encodeURIComponent(library)}/items/${encodeURIComponent(item)}/artwork/${encodeURIComponent(kind)}`,
  removeVariant:(library:string,item:string,kind:string)=>apiRequest<void>(`/native/libraries/${encodeURIComponent(library)}/items/${encodeURIComponent(item)}/artwork/${encodeURIComponent(kind)}`,{method:"DELETE"}),
  upload: (library: string, item: string, kind: string, file: File) => {const body = new FormData(); body.append("file", file); return apiRequest<void>(`/native/libraries/${encodeURIComponent(library)}/items/${encodeURIComponent(item)}/artwork/${encodeURIComponent(kind)}`, {method: "POST", body, headers: {}});},
  folders: (path: string) => apiRequest<FolderList>(`/metadata/folders?path=${encodeURIComponent(path)}`),
};

export interface NativeArtwork { kind: string; path: string; source: string; }
export interface NativeCatalogEntry { id: string; path: string; kind: string; parent_path: string | null; title: string; metadata: Record<string, unknown>; artwork: NativeArtwork[]; files: {path: string; size: number; extension: string; media_info?: {format?: Record<string, unknown>; streams?: Record<string,unknown>[]} }[]; nfo_path: string | null; available: boolean; revision: number; }
export interface NativeScanStatus { manual_queued?:boolean; artwork_revision?: string; show_progress?: boolean; progress?: {phase: string; processed: number; total: number | null; current: string}; status: string; count: number; warnings: string[]; }

export interface IdentificationCandidate {publisher?:string|null;volume_count?:number|null;poster?:string|null;provider:string;id:string;title:string;year:number|null;format:string|null;overview:string|null;identifiers:Record<string,string>}
export interface IdentificationGroup {provider:string;results:IdentificationCandidate[];error?:string}

export interface SyncStatus {enabled:boolean;status:string;retry_at?:string|null;retry_attempts?:number;last_success:string|null;pending:number;matched:number;unmatched:number;failed:number;notices:string[];activity:string[];}
