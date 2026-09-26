import { apiRequest } from "./client";
export interface VideoMetadataDocument { fields: Record<string, unknown>; sources: Record<string,string>; ids: Record<string,string>; matches: Record<string,string>; }
export interface MetadataFetchResult { filled: string[]; credits_added: number; issues: string[]; needs_matching: boolean; }
const path=(server:number,item:string)=>`/servers/${server}/items/${encodeURIComponent(item)}/metadata`;
export const enrichmentApi={
  get:(server:number,item:string)=>apiRequest<VideoMetadataDocument>(path(server,item)),
  find:(server:number,item:string)=>apiRequest<MetadataFetchResult>(path(server,item),{method:"POST"}),
  matches:(server:number,item:string,matches:Record<string,string>)=>apiRequest<VideoMetadataDocument>(path(server,item),{method:"PUT",body:JSON.stringify(matches)}),
};
