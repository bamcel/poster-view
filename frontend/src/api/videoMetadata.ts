import { apiRequest } from "./client";

export interface VideoDocument {
  kind: "movie" | "tvshow";
  target: string;
  choices: string[];
  can_write: boolean;
  revision: string;
  xml: string;
  fields: Record<string, string>;
  actors: { name: string; role: string }[];
}
export interface VideoUpdate {
  server_id: number;
  item_id: string;
  target: string;
  revision: string;
  fields: Record<string, string>;
}
export const videoMetadataApi = {
  get: (server: number, item: string, target?: string) => {
    const query = new URLSearchParams({ server_id: String(server), item_id: item });
    if (target) query.set("target", target);
    return apiRequest<VideoDocument>(`/metadata/video?${query}`);
  },
  preview: (input: VideoUpdate) => apiRequest<VideoDocument>("/metadata/video/preview", { method: "POST", body: JSON.stringify(input) }),
  save: (input: VideoUpdate) => apiRequest<VideoDocument>("/metadata/video", { method: "PUT", body: JSON.stringify(input) }),
};
