import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, MoreHorizontal, Search, X } from "lucide-react";
import { enrichmentApi } from "../api/videoEnrichment";
import { useActionMenu } from "../lib/actionMenu";

export function MissingMetadataMenu({onFind}:{onFind:()=>void}) {
  const [open,setOpen]=useState(false);
  const trigger=useRef<HTMLButtonElement>(null); const menu=useRef<HTMLDivElement>(null);
  const keys=useActionMenu(open,()=>setOpen(false),trigger,menu);
  useEffect(()=>{if(!open)return;const close=(e:MouseEvent)=>{if(!menu.current?.contains(e.target as Node)&&!trigger.current?.contains(e.target as Node))setOpen(false);};window.addEventListener("click",close);return()=>window.removeEventListener("click",close);},[open]);
  return <div className="relative shrink-0"><button ref={trigger} aria-label="Title options" aria-haspopup="menu" aria-expanded={open} onClick={()=>setOpen(!open)} className="grid min-h-11 min-w-11 place-items-center rounded-full border border-border text-muted hover:text-white"><MoreHorizontal className="size-5"/></button>{open&&<div ref={menu} role="menu" tabIndex={-1} onKeyDown={keys} className="absolute right-0 top-full z-30 mt-2 w-max rounded-lg border border-border bg-elevated p-1 shadow-xl"><button role="menuitem" tabIndex={-1} className="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-surface-2" onClick={()=>{setOpen(false);trigger.current?.focus();onFind();}}><Search className="size-4"/>Find Missing Metadata</button></div>}</div>;
}
export default function FindMissingMetadata({serverId,itemId,title,onClose,onEdit}:{serverId:number;itemId:string;title:string;onClose:()=>void;onEdit:()=>void}) {
  const client=useQueryClient(); const started=useRef(false);
  const fetch=useMutation({mutationFn:()=>enrichmentApi.find(serverId,itemId),onSuccess:()=>{
    for(const key of [["item-detail",serverId,itemId],["series-credits",serverId,itemId],["video-enrichment",serverId,itemId]])void client.invalidateQueries({queryKey:key});
  }});
  useEffect(()=>{if(!started.current){started.current=true;fetch.mutate();}},[]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(()=>{const escape=(e:KeyboardEvent)=>{if(e.key==="Escape"&&!fetch.isPending)onClose();};window.addEventListener("keydown",escape);return()=>window.removeEventListener("keydown",escape);},[fetch.isPending,onClose]);
  return createPortal(<div className="fixed inset-0 z-[60] grid place-items-center bg-black/70 p-4 backdrop-blur-sm"><section role="dialog" aria-modal="true" aria-label="Find Missing Metadata" className="max-h-[90dvh] w-full max-w-lg space-y-4 overflow-y-auto rounded-2xl border border-border bg-surface p-5 shadow-2xl"><header className="flex items-start justify-between gap-4"><div><h2 className="font-semibold">Find Missing Metadata</h2><p className="text-sm text-muted">{title}</p></div><button autoFocus disabled={fetch.isPending} aria-label="Close metadata results" onClick={onClose} className="rounded p-1 disabled:opacity-40"><X className="size-5"/></button></header>
    {fetch.isPending&&<p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin"/>Fetching missing fields and cast &amp; crew…</p>}
    <p className="text-xs text-muted">Existing values and saved credits are kept. Results are stored in PosterView; NFO files and media servers are not changed.</p>
    {fetch.error&&<p role="alert" className="text-sm text-danger">{fetch.error.message}</p>}
    {fetch.data&&<><p role="status" className="text-sm">{fetch.data.filled.length} fields filled · {fetch.data.credits_added} credits added.</p>{fetch.data.filled.length>0&&<p className="text-xs text-muted">{fetch.data.filled.map(s=>s.replaceAll("_"," ")).join(", ")}</p>}{fetch.data.issues.length>0&&<div><h3 className="mb-2 text-sm font-medium">Needs attention</h3><ul className="space-y-2 text-xs text-muted">{fetch.data.issues.map((issue,i)=><li key={i}>{issue}</li>)}</ul></div>}</>}
    {!fetch.isPending&&<footer className="flex flex-wrap justify-end gap-2"><button className="rounded-lg border border-border px-3 py-2 text-sm" onClick={()=>fetch.mutate()}>Run again</button><button className="rounded-lg border border-border px-3 py-2 text-sm" onClick={onEdit}>Edit Metadata</button><button className="rounded-lg bg-accent px-3 py-2 text-sm text-black" onClick={onClose}>Done</button></footer>}
  </section></div>,document.body);
}
