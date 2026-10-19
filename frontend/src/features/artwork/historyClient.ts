import {apiRequest} from "../../api/client";
import type {BackdropFraming} from "../../lib/backdropFraming";

export interface HistoryEntry {
 id:string; server_id:number; item_id:string; group_id:string; title:string; item_title:string;
 actor?:string|null; source?:string; kind:string; created_at:string; preview_url:string|null; has_image:boolean; adjustments:boolean;
 content_type?:string;
 preview_logo_url?:string|null;
 preview_settings?:{posteredit?:{mode?:"overlay"|"flattened";x:number;y:number;width:number;opacity:number;enabled:boolean};backdropedit?:BackdropFraming};
}
export interface HistoryGroup {server_id:number;group_id:string;title:string;poster_url:string|null;count:number;latest_at:string;}
export const artworkHistory = {
 entries:(serverId:number,itemId:string)=>apiRequest<HistoryEntry[]>(`/artwork/history?${new URLSearchParams({server_id:String(serverId),item_id:itemId})}`),
 groups:()=>apiRequest<HistoryGroup[]>("/artwork/history/groups"),
 restore:(id:string)=>apiRequest<{ok:boolean;message:string}>(`/artwork/history/${encodeURIComponent(id)}/restore`,{method:"POST",body:JSON.stringify({})}),
};
