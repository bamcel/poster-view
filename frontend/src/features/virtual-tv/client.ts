import {apiRequest} from "../../api/client";

export interface VirtualTvSettings {enabled:boolean}
export interface ChannelInput {
  name:string; number:number; library_ids:string[]; show_ids:string[]; movie_ids:string[]; collection_ids?:string[];
  genres:string[]; order:"sequential"|"random"|"random_shows"; start_at:string; revision?:number;
}
export interface Channel extends ChannelInput {id:string; revision:number}
export interface Program {
  id:string; library_id:string; item_id:string; title:string; series_title:string|null;
  season:number|null; episode:number|null; starts_at:string; ends_at:string; artwork_url:string|null;
}
export interface TuneResult {library_id:string;item_id:string;position_seconds:number;ends_at:string;program_id:string}
const channelPath=(id:string)=>`/virtual-tv/channels/${encodeURIComponent(id)}`;
export const virtualTv={
  settings:()=>apiRequest<VirtualTvSettings>("/plugins/virtual-tv"),
  saveSettings:(value:VirtualTvSettings)=>apiRequest<VirtualTvSettings>("/plugins/virtual-tv",{method:"PUT",body:JSON.stringify(value)}),
  channels:()=>apiRequest<Channel[]>("/virtual-tv/channels"),
  save:(value:ChannelInput,id?:string)=>apiRequest<Channel>(id?channelPath(id):"/virtual-tv/channels",{method:id?"PUT":"POST",body:JSON.stringify(value)}),
  remove:(id:string)=>apiRequest<void>(channelPath(id),{method:"DELETE"}),
  guide:(id:string,from?:string,until?:string)=>{
    const query=new URLSearchParams();if(from)query.set("from",from);if(until)query.set("until",until);
    return apiRequest<Program[]>(`${channelPath(id)}/guide${query.size?`?${query}`:""}`);
  },
  tune:(id:string)=>apiRequest<TuneResult>(`${channelPath(id)}/tune`,{method:"POST"}),
};
