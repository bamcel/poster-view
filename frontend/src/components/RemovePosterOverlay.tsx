import {useState} from "react";
import {useQuery, useQueryClient} from "@tanstack/react-query";
import {Loader2, Trash2} from "lucide-react";
import {nativeLibraries} from "../api/nativeLibraries";
import {invalidateArtworkItems} from "../lib/artworkTarget";
import {useToast} from "../lib/toast";
import type {ItemDetail} from "../types";

export default function RemovePosterOverlay({serverId,item,disabled=false,onRemoved}: {serverId:number;item:ItemDetail;disabled?:boolean;onRemoved?:()=>void}) {
  const client=useQueryClient(); const toast=useToast(); const [busy,setBusy]=useState(false);
  const native=serverId===0 && item.id.startsWith("native:");
  const [,library,id]=item.id.split(":");
  const catalog=useQuery({queryKey:["native-catalog",library],queryFn:()=>nativeLibraries.catalog(library),enabled:native});
  const entry=catalog.data?.find(e=>e.id===id);
  const hasOverlay=!!(entry?.metadata.posteredit ?? entry?.metadata.poseredit);
  const remove=async()=>{
    setBusy(true);
    try {
      const fresh=(await nativeLibraries.catalog(library)).find(e=>e.id===id);
      if (!fresh) throw new Error("Library item is unavailable.");
      const result=await nativeLibraries.editItem(library,fresh,{posteredit:null,poseredit:null});
      client.setQueryData<typeof catalog.data>(["native-catalog",library],entries=>entries?.map(e=>e.id===id?result.entry:e));
      onRemoved?.();
      await invalidateArtworkItems(client,serverId,item.id);
      await client.invalidateQueries({queryKey:["item-detail",serverId,item.id]});
      toast.push("success","Logo overlay removed. Artwork kept.");
    } catch(error) {toast.push("error",(error as Error).message);} finally {setBusy(false);}
  };
  if (!native) return null;
  return <div className="space-y-2"><button type="button" disabled={disabled || busy || !hasOverlay} onClick={()=>void remove()} className="flex min-h-10 w-full items-center justify-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-muted hover:border-danger/50 hover:text-white disabled:opacity-50">{busy ? <Loader2 className="size-4 animate-spin"/> : <Trash2 className="size-4"/>}Remove Overlay</button><p className="text-xs text-faint">Removes the PosterView logo layer while keeping the artwork and logo files. Logos baked into an exported poster remain part of that image.</p></div>;
}
