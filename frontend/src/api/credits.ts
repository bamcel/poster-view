import { apiRequest } from "./client";

export interface Credit {
  person_id: string; name: string; image: string | null; person_url: string | null;
  character_id: string | null; character: string | null; character_image: string | null;
  category: "cast" | "crew"; role: string; language: string | null;
  dub_group: string | null; notes: string | null; order: number;
}
export interface CreditSource {
  provider: string; external_id: string; title: string; source_url: string;
  original_language: string | null; fetched_at: string | null; credits: Credit[];
}
export interface SeriesCredits { catalog_id: string | null; original_language: string | null; sources: CreditSource[]; }
export interface CreditMatch { id: string; title: string; year: number | null; image: string | null; }
export interface CreditSettings { tmdb_configured: boolean; tvdb_configured: boolean; }
const path = (server: number, item: string) => `/servers/${server}/items/${encodeURIComponent(item)}/credits`;
export const creditsApi = {
  get: (server: number, item: string) => apiRequest<SeriesCredits>(path(server, item)),
  import: (server: number, item: string, provider: string, external_id: string) => apiRequest<SeriesCredits>(path(server, item), { method: "POST", body: JSON.stringify({ provider, external_id }) }),
  language: (server: number, item: string, original_language: string | null) => apiRequest<SeriesCredits>(path(server, item), { method: "PUT", body: JSON.stringify({ original_language }) }),
  remove: (server: number, item: string, provider: string, external_id: string) => apiRequest<SeriesCredits>(`${path(server, item)}?${new URLSearchParams({ provider, external_id })}`, { method: "DELETE" }),
  search: (provider: string, query: string) => apiRequest<CreditMatch[]>(`/credits/search?${new URLSearchParams({ provider, query })}`),
  settings: () => apiRequest<CreditSettings>("/credits/settings"),
  saveToken: (tmdb_access_token: string) => apiRequest<CreditSettings>("/credits/settings", { method: "PUT", body: JSON.stringify({ tmdb_access_token }) }),
};
