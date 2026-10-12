import {apiRequest} from "../../../api/client";
import type {WatchState, PlaybackPreferences, WatchRules, ContinueItem} from "../types";
export type {WatchState, PlaybackPreferences, WatchRules, ContinueItem} from "../types";

const itemUrl=(library:string,item:string)=>`/watch/native/${encodeURIComponent(library)}/${encodeURIComponent(item)}`;
export const watchApi={
  state:(library:string,item:string,signal?:AbortSignal)=>apiRequest<WatchState>(itemUrl(library,item),{signal}),
  begin:(library:string,item:string)=>apiRequest<{session_id:string;state:WatchState}>(`${itemUrl(library,item)}/begin`,{method:"POST"}),
  progress:(library:string,item:string,body:Record<string,unknown>,keepalive=false)=>apiRequest<WatchState>(`${itemUrl(library,item)}/progress`,{method:"PUT",body:JSON.stringify(body),keepalive}),
  mark:(library:string,item:string,watched:boolean)=>apiRequest<WatchState>(itemUrl(library,item),{method:"PUT",body:JSON.stringify({watched})}),
  continue:()=>apiRequest<ContinueItem[]>("/watch/continue"),
  states:(library:string)=>apiRequest<Record<string,WatchState>>(`/watch/libraries/${encodeURIComponent(library)}/states`),
  preferences:(signal?:AbortSignal)=>apiRequest<PlaybackPreferences>("/playback/preferences",{signal}),
  savePreferences:(settings:PlaybackPreferences)=>apiRequest<PlaybackPreferences>("/playback/preferences",{method:"PUT",body:JSON.stringify(settings)}),
  rules:(library:string)=>apiRequest<WatchRules>(`/watch/libraries/${encodeURIComponent(library)}/rules`),
  saveRules:(library:string,settings:WatchRules)=>apiRequest<WatchRules>(`/watch/libraries/${encodeURIComponent(library)}/rules`,{method:"PUT",body:JSON.stringify(settings)}),
};
