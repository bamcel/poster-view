import { apiRequest } from "./client";

export interface EpisodeDetail {
  id: string; title: string; index: number | null; index_end: number | null;
  image: string | null; summary: string | null; aired: string | null;
  runtime_minutes: number | null; rating: number | null;
  directors: string[]; writers: string[]; cast: string[];
}
export interface SeasonDetail {
  id: string; series_id: string; title: string; index: number | null;
  poster: string | null; background: string | null; summary: string | null;
  episodes: EpisodeDetail[];
}
export const seasonsApi = {
  get: (server: number, series: string, season: string) => apiRequest<SeasonDetail>(`/servers/${server}/shows/${encodeURIComponent(series)}/seasons/${encodeURIComponent(season)}`),
};
