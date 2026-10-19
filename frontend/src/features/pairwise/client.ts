import {apiRequest} from "../../api/client";
import type {NativeCatalogEntry} from "../../api/nativeLibraries";

export interface RankingLibrary {id:string;name:string;title_count:number}
export interface RankingTitle {entry:NativeCatalogEntry;score:number|null;rank:number|null;comparisons:number;provisional:boolean;excluded:boolean}
export interface RankingPair {token:string;left_id:string;right_id:string}
export interface RankingView {library_id:string;revision:number;decision_count:number;ranked_count:number;excluded_count:number;titles:RankingTitle[];pair:RankingPair|null;can_undo:boolean}
export interface RankingAction {revision:number;action:"start"|"left"|"right"|"tie"|"skip"|"exclude"|"allow"|"undo";token?:string;item_id?:string}
export const pairwise={
 settings:()=>apiRequest<{enabled:boolean}>("/plugins/pairwise"),
 saveSettings:(settings:{enabled:boolean})=>apiRequest<{enabled:boolean}>("/plugins/pairwise",{method:"PUT",body:JSON.stringify(settings)}),
 libraries:()=>apiRequest<RankingLibrary[]>("/rankings/libraries"),
 ranking:(library:string)=>apiRequest<RankingView>(`/rankings/${encodeURIComponent(library)}`),
 action:(library:string,action:RankingAction)=>apiRequest<RankingView>(`/rankings/${encodeURIComponent(library)}/actions`,{method:"POST",body:JSON.stringify(action)}),
};
