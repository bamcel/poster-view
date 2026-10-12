import { apiRequest } from "../../../api/client";
import type {PlaybackInfo, PlaybackRequest, PlaybackSession, PlaybackSeek} from "../types";
export type {PlaybackInfo, PlaybackTrack, PlaybackRequest, PlaybackSession, WatchState, PlaybackPreferences} from "../types";
export {defaultPlaybackPreferences} from "../types";

const itemPath = (library: string, item: string) => `/native/${encodeURIComponent(library)}/${encodeURIComponent(item)}`;
export const playbackApi = {
  info: (library: string, item: string, signal?: AbortSignal) => apiRequest<PlaybackInfo>(`/playback${itemPath(library,item)}`, {signal}),
  create: (library: string, item: string, body: PlaybackRequest) => apiRequest<PlaybackSession>(`/playback${itemPath(library,item)}/sessions`, {method:"POST", body:JSON.stringify(body)}),
  seek: (session:string,body:PlaybackSeek) => apiRequest<PlaybackSession>(`/playback/sessions/${encodeURIComponent(session)}/seek`,{method:"POST",body:JSON.stringify(body)}),
  stop: (session: string) => apiRequest<void>(`/playback/sessions/${encodeURIComponent(session)}`, {method:"DELETE"}),
  heartbeat: (session: string, position_seconds: number, paused = false, generation?:number, speed?:number) => apiRequest<void>(`/playback/sessions/${encodeURIComponent(session)}/heartbeat`, {method:"POST", body:JSON.stringify({position_seconds,paused,...(generation===undefined?{}:{generation}),...(speed===undefined?{}:{speed})})}),
  subtitle: (library: string, item: string, index: number) => `/api/playback${itemPath(library,item)}/subtitles/${index}`,
};
