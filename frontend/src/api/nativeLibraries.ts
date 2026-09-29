import { apiRequest } from "./client";

export type NativeLibraryType = "movies" | "shows" | "anime" | "books";
export interface NativeLibraryInput {
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
  folders: (path: string) => apiRequest<FolderList>(`/metadata/folders?path=${encodeURIComponent(path)}`),
};
