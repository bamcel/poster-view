import {apiRequest} from "./client";
import type {NativeCatalogEntry} from "./nativeLibraries";

export interface WatchState {
  position_seconds:number; duration_seconds:number; watched:boolean; play_count:number;
  last_played_at:string|null; audio_index:number|null; subtitle_index:number|null;
  session_id:string|null; version:number;
}
export interface WatchRules {minimum_percentage:number;maximum_percentage:number;minimum_duration_seconds:number}
export interface PlaybackPreferences {
  audio_languages:string[]; subtitle_languages:string[]; prefer_default_audio:boolean;
  remember_audio:boolean; remember_subtitles:boolean;
  subtitle_mode:"default"|"smart"|"forced"|"hearing_impaired"|"always"|"off";
  autoplay_next:boolean; resume_rewind_seconds:number; skip_back_seconds:number; skip_forward_seconds:number;
  still_watching_minutes:number; up_next:boolean; subtitle_size:number;
}
export interface ContinueItem {library_id:string;library_name:string;item_id:string;title:string;kind:string;entry:NativeCatalogEntry;state:WatchState}
const itemUrl=(library:string,item:string)=>`/watch/native/${encodeURIComponent(library)}/${encodeURIComponent(item)}`;
export const watchApi={
  state:(library:string,item:string)=>apiRequest<WatchState>(itemUrl(library,item)),
  mark:(library:string,item:string,watched:boolean)=>apiRequest<WatchState>(itemUrl(library,item),{method:"PUT",body:JSON.stringify({watched})}),
  continue:()=>apiRequest<ContinueItem[]>("/watch/continue"),
  states:(library:string)=>apiRequest<Record<string,WatchState>>(`/watch/libraries/${encodeURIComponent(library)}/states`),
  preferences:()=>apiRequest<PlaybackPreferences>("/playback/preferences"),
  savePreferences:(settings:PlaybackPreferences)=>apiRequest<PlaybackPreferences>("/playback/preferences",{method:"PUT",body:JSON.stringify(settings)}),
  rules:(library:string)=>apiRequest<WatchRules>(`/watch/libraries/${encodeURIComponent(library)}/rules`),
  saveRules:(library:string,settings:WatchRules)=>apiRequest<WatchRules>(`/watch/libraries/${encodeURIComponent(library)}/rules`,{method:"PUT",body:JSON.stringify(settings)}),
};
