import type {SeriesTrackPreferences} from "../lib/seriesTracks";
import {apiRequest} from "../../../api/client";
import type {WatchState, PlaybackPreferences, WatchRules, ContinueItem} from "../types";
export type {WatchState, PlaybackPreferences, WatchRules, ContinueItem} from "../types";

const itemUrl=(library:string,item:string)=>`/watch/native/${encodeURIComponent(library)}/${encodeURIComponent(item)}`;
export const watchApi={
  clearTrackSelections:()=>apiRequest<void>("/playback/track-selections",{method:"DELETE"}),
  seriesTracks:(library:string,item:string,signal?:AbortSignal)=>apiRequest<SeriesTrackPreferences>(`${itemUrl(library,item)}/series-tracks`,{signal}),
  saveSeriesTracks:(library:string,item:string,body:SeriesTrackPreferences)=>apiRequest<SeriesTrackPreferences>(`${itemUrl(library,item)}/series-tracks`,{method:"PUT",body:JSON.stringify(body)}),
  state:(library:string,item:string,signal?:AbortSignal)=>apiRequest<WatchState>(itemUrl(library,item),{signal}),
  begin:(library:string,item:string,versionId?:string)=>apiRequest<{session_id:string;state:WatchState}>(`${itemUrl(library,item)}/begin${versionId?`?version_id=${encodeURIComponent(versionId)}`:""}`,{method:"POST"}),
  progress:(library:string,item:string,body:Record<string,unknown>,keepalive=false)=>apiRequest<WatchState>(`${itemUrl(library,item)}/progress`,{method:"PUT",body:JSON.stringify(body),keepalive}),
  mark:(library:string,item:string,watched:boolean)=>apiRequest<WatchState>(itemUrl(library,item),{method:"PUT",body:JSON.stringify({watched})}),
  history:()=>apiRequest<ContinueItem[]>("/watch/history"),
  continue:()=>apiRequest<ContinueItem[]>("/watch/continue"),
  states:(library:string)=>apiRequest<Record<string,WatchState>>(`/watch/libraries/${encodeURIComponent(library)}/states`),
  preferences:(signal?:AbortSignal)=>apiRequest<PlaybackPreferences>("/playback/preferences",{signal}),
  savePreferences:(settings:PlaybackPreferences)=>apiRequest<PlaybackPreferences>("/playback/preferences",{method:"PUT",body:JSON.stringify(settings)}),
  rules:(library:string)=>apiRequest<WatchRules>(`/watch/libraries/${encodeURIComponent(library)}/rules`),
  saveRules:(library:string,settings:WatchRules)=>apiRequest<WatchRules>(`/watch/libraries/${encodeURIComponent(library)}/rules`,{method:"PUT",body:JSON.stringify(settings)}),
};
