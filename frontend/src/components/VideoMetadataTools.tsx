import { useState } from "react";
import { useMutation,useQuery,useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { enrichmentApi } from "../api/videoEnrichment";
import CastCrewPanel from "./CastCrewPanel";
const providers=[["tmdb","TMDB"],["tvdb","TheTVDB"],["anilist","AniList"],["mal","MyAnimeList (MAL)"],["imdb","IMDb"],["anidb","AniDB"]];
export default function VideoMetadataTools({serverId,itemId}:{serverId:number;itemId:string}) {
  const client=useQueryClient(); const [draft,setDraft]=useState<Record<string,string>>({});
  const item=useQuery({queryKey:["item-detail",serverId,itemId],queryFn:()=>api.getItemDetail(serverId,itemId)});
  const document=useQuery({queryKey:["video-enrichment",serverId,itemId],queryFn:()=>enrichmentApi.get(serverId,itemId)});
  const save=useMutation({mutationFn:()=>enrichmentApi.matches(serverId,itemId,draft),onSuccess:()=>{setDraft({}); for(const key of [["item-detail",serverId,itemId],["video-enrichment",serverId,itemId],["series-credits",serverId,itemId]])void client.invalidateQueries({queryKey:key});}});
  const ids=Object.fromEntries(Object.entries(item.data?.external_ids??{}).map(([k,v])=>[k.toLowerCase()==="myanimelist"?"mal":k.toLowerCase(),v]));
  const error=save.error||item.error||document.error;
  return <div className="space-y-4"><h3 className="font-medium">Provider matching</h3><p className="text-xs text-muted">Confirm the exact movie or series IDs. Changing a match clears previously imported fields and credits from that provider so the next fetch can correct them. Clearing an ID excludes that provider from automatic matching.</p>
    {error&&<p role="alert" className="text-sm text-danger">{error.message}</p>}
    {save.isSuccess&&<p role="status" className="text-xs text-accent">Matches saved. Run Find Missing Metadata to fill remaining fields.</p>}
    <form onSubmit={e=>{e.preventDefault();save.mutate();}} className="space-y-3"><div className="grid gap-3 sm:grid-cols-2">{providers.map(([id,name])=><label key={id} className="text-xs text-muted">{name} ID<input className="mt-1 w-full rounded-lg border border-border bg-input px-3 py-2 text-sm" maxLength={14} placeholder={id==="imdb"?"tt1234567":"Numeric ID"} value={draft[id]??document.data?.matches[id]??ids[id]??document.data?.ids[id]??""} onChange={e=>{setDraft({...draft,[id]:e.target.value.trim()});save.reset();}}/></label>)}</div><button disabled={save.isPending||!item.data||!document.data||!Object.keys(draft).length} className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-40">Save provider matches</button></form>
    {document.data&&Object.keys(document.data.fields).length>0&&<details><summary className="cursor-pointer text-sm">Metadata saved in PosterView</summary><dl className="mt-3 space-y-3">{Object.entries(document.data.fields).map(([key,value])=><div key={key}><dt className="text-xs font-medium capitalize">{key.replaceAll("_"," ")} <span className="font-normal text-muted">· {document.data!.sources[key]}</span></dt><dd className="whitespace-pre-wrap break-words text-sm text-muted">{Array.isArray(value)?value.join(", "):String(value)}</dd></div>)}</dl></details>}
    {item.data&&<CastCrewPanel key={itemId} serverId={serverId} item={item.data} editing />}
  </div>;
}
