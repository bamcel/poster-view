import { apiRequest } from "./client";
export interface ImdbStatus { enabled: boolean; ready: boolean; updated_at: number | null; titles: number; ratings: number; }
export interface ImdbTitle { id: string; title_type: string; title: string; original_title: string; year: number | null; end_year: number | null; runtime_minutes: number | null; genres: string[]; rating: number | null; votes: number | null; }
export const imdbApi = {
  status: () => apiRequest<ImdbStatus>("/imdb/settings"),
  enable: (enabled: boolean) => apiRequest<ImdbStatus>("/imdb/settings", { method: "PUT", body: JSON.stringify({ enabled }) }),
  search: (q: string) => apiRequest<ImdbTitle[]>(`/imdb/search?${new URLSearchParams({ q })}`),
};
