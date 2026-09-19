import { apiRequest } from "./client";

export interface MetadataFields {
  title: string;
  year: string;
  publisher: string;
  edition: string;
  volumes: string;
  status: string;
  plot: string;
  anilist_id: string;
}
export interface MetadataDocument {
  path: string;
  target: string;
  fields: MetadataFields;
  revision: string | null;
  xml: string;
}
export interface MetadataFolder { name: string; path: string; has_nfo: boolean }
export interface MetadataRequest { path: string; fields: MetadataFields; revision: string | null }
export const metadataApi = {
  folders: (path: string) => apiRequest<{ root: string; path: string; folders: MetadataFolder[] }>(`/metadata/folders?path=${encodeURIComponent(path)}`),
  read: (path: string) => apiRequest<MetadataDocument>(`/metadata/document?path=${encodeURIComponent(path)}`),
  preview: (request: MetadataRequest) => apiRequest<MetadataDocument>("/metadata/preview", { method: "POST", body: JSON.stringify(request) }),
  save: (request: MetadataRequest) => apiRequest<MetadataDocument>("/metadata/document", { method: "PUT", body: JSON.stringify(request) }),
  search: (query: string) => apiRequest<MetadataFields[]>(`/metadata/search?query=${encodeURIComponent(query)}`),
};
