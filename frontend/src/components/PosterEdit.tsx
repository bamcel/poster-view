import {useEffect, useRef, useState} from "react";
import {useQuery, useQueryClient} from "@tanstack/react-query";
import {Download, Loader2, RotateCcw} from "lucide-react";
import AnimatedArtwork, {artworkFormat, stillArtwork} from "./AnimatedArtwork";
import {api} from "../api/client";
import {nativeLibraries} from "../api/nativeLibraries";
import {invalidateArtworkItems} from "../lib/artworkTarget";
import {useToast} from "../lib/toast";
import type {ItemDetail} from "../types";

type Placement = {mode?:"overlay" | "flattened";poster_path?:string;x:number; y:number; width:number; opacity:number; enabled:boolean};
const defaults: Placement = {x:15,y:72,width:70,opacity:100,enabled:true};
const loadImage = (src:string) => new Promise<HTMLImageElement>((resolve,reject) => {
  const image = new Image(); image.crossOrigin="anonymous";
  image.onload=()=>resolve(image); image.onerror=()=>reject(new Error("Unable to load artwork for export.")); image.src=src;
});
export default function PosterEdit({serverId,item}: {serverId:number;item:ItemDetail}) {
  const client=useQueryClient(); const toast=useToast(); const preview=useRef<HTMLDivElement>(null);
  const [placement,setPlacement]=useState<Placement>(defaults); const [busy,setBusy]=useState(false);
  const native=serverId===0 && item.id.startsWith("native:");
  const [,library,id]=item.id.split(":");
  const catalog=useQuery({queryKey:["native-catalog",library],queryFn:()=>nativeLibraries.catalog(library),enabled:native});
  const entry=catalog.data?.find(e=>e.id===id);
  const saved=(entry?.metadata.posteredit ?? entry?.metadata.poseredit) as Placement | undefined;
  useEffect(()=>setPlacement(saved ? {...defaults,...saved} : defaults),[item.id,saved]);
  const current=item.poster?.split("&logoOverlay=")[0];
  const animated=["gif","webm"].includes(artworkFormat(current));
  const original=saved?.poster_path === entry?.artwork.find(a=>a.kind==="poster")?.path ? entry?.artwork.find(a=>a.kind==="poster-edit-original") : undefined;
  const source=!animated && original ? `${nativeLibraries.artworkUrl(library,id,original.kind)}?v=${entry?.revision}` : current;
  const logo=item.logo;
  const update=(key:keyof Placement,value:number)=>setPlacement(p=>({...p,[key]:value}));
  const drag=(event:React.PointerEvent<HTMLImageElement>)=>{
    const bounds=preview.current?.getBoundingClientRect(); if (!bounds) return;
    const start={x:event.clientX,y:event.clientY,placement};
    event.currentTarget.setPointerCapture(event.pointerId);
    const move=(e:PointerEvent)=>setPlacement(p=>({...p,x:Math.max(0,Math.min(100-p.width,start.placement.x+(e.clientX-start.x)/bounds.width*100)),y:Math.max(0,Math.min(100,start.placement.y+(e.clientY-start.y)/bounds.height*100))}));
    const element=event.currentTarget;
    const stop=()=>{element.removeEventListener("pointermove",move);element.removeEventListener("pointerup",stop);element.removeEventListener("pointercancel",stop);};
    element.addEventListener("pointermove",move);element.addEventListener("pointerup",stop);element.addEventListener("pointercancel",stop);
  };
  const save=async()=>{
    if (!native || !entry) return;
    setBusy(true);
    try {
      const fresh=(await nativeLibraries.catalog(library)).find(e=>e.id===id);
      if (!fresh) throw new Error("Library item is unavailable.");
      const result=await nativeLibraries.editItem(library,fresh,{posteredit:{...placement,mode:"overlay",poster_path:fresh.artwork.find(a=>a.kind==="poster")?.path},poseredit:null});
      client.setQueryData<typeof catalog.data>(["native-catalog",library],entries=>entries?.map(e=>e.id===id?result.entry:e));
      await invalidateArtworkItems(client,serverId,item.id);
      await client.invalidateQueries({queryKey:["item-detail",serverId,item.id]});
      toast.push("success","Poster overlay saved. Original artwork unchanged.");
    } catch(error) {toast.push("error",(error as Error).message);} finally {setBusy(false);}
  };
  const download=async()=>{
    if (!source || !logo) return;
    setBusy(true);
    try {
      const [poster,mark]=await Promise.all([loadImage(animated?stillArtwork(source):source),loadImage(logo)]);
      const canvas=document.createElement("canvas");canvas.width=poster.naturalWidth;canvas.height=poster.naturalHeight;
      const context=canvas.getContext("2d");if (!context) throw new Error("Image export is unavailable.");
      context.drawImage(poster,0,0);
      if (native && !original) {
        const originalBlob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error("Original poster export failed.")),"image/png"));
        await nativeLibraries.upload(library,id,"poster-edit-original",new File([originalBlob],"original.png",{type:"image/png"}));
      }
      if (placement.enabled) {
        const width=canvas.width*placement.width/100;context.globalAlpha=placement.opacity/100;
        context.drawImage(mark,canvas.width*placement.x/100,canvas.height*placement.y/100,width,width*mark.naturalHeight/mark.naturalWidth);
      }
      const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error("Poster export failed.")),"image/png"));
      const applied=await api.applyUpload({server_id:serverId,item_id:item.id,target:"poster",file:new File([blob],"poster.png",{type:"image/png"}),item_title:item.title});
      if (!applied.ok) throw new Error(applied.message);
      if (native) {
        const fresh=(await nativeLibraries.catalog(library)).find(e=>e.id===id);
        if (!fresh) throw new Error("Poster saved, but its editing settings could not be updated.");
        await nativeLibraries.editItem(library,fresh,{posteredit:{...placement,mode:"flattened",poster_path:fresh.artwork.find(a=>a.kind==="poster")?.path},poseredit:null});
      }
      await invalidateArtworkItems(client,serverId,item.id,"poster");
      await client.invalidateQueries({queryKey:["item-detail",serverId,item.id]});
      toast.push("success",applied.message);
      const url=URL.createObjectURL(blob);const link=document.createElement("a");
      link.href=url;link.download=`${item.title.replace(/[<>:"/\\|?*\x00-\x1f]/g,"_").trim() || "poster"}-poster.png`;
      document.body.appendChild(link);link.click();link.remove();window.setTimeout(()=>URL.revokeObjectURL(url),60_000);
    } catch(error) {toast.push("error",(error as Error).message);} finally {setBusy(false);}
  };
  if (!source || !logo) return <p className="text-sm text-muted">Add a poster and a series logo in Artwork before using PosterEdit.</p>;
  return <div className="space-y-4">
    <p className="text-xs leading-5 text-muted">Drag the logo to position it. Save Overlay stores its placement in PosterView without replacing artwork. Download applies and downloads a new PNG poster, following your artwork storage and sync settings{animated ? " using the animation’s static preview frame" : ""}.{!native && " Overlay saving is available for manual libraries; connected-server posters can be replaced and downloaded."}</p>
    <div ref={preview} className="relative aspect-[2/3] overflow-hidden rounded-xl bg-black">
      <AnimatedArtwork src={source} alt={item.title} className="h-full w-full object-cover"/>
      {placement.enabled && <img src={logo} alt="Drag series logo" draggable={false} onPointerDown={drag} className="absolute cursor-move touch-none select-none" style={{left:`${placement.x}%`,top:`${placement.y}%`,width:`${placement.width}%`,opacity:placement.opacity/100}}/>}
    </div>
    <label className="flex items-center justify-between text-sm text-muted">Display logo<input type="checkbox" checked={placement.enabled} onChange={e=>setPlacement(p=>({...p,enabled:e.target.checked}))}/></label>
    {([['x','Horizontal position'],['y','Vertical position'],['width','Logo size'],['opacity','Opacity']] as const).map(([key,label])=><label key={key} className="block text-xs text-muted">{label} · {Math.round(placement[key])}%<input aria-label={label} type="range" min={key==='width'?5:0} max={100} value={placement[key]} onChange={e=>update(key,Number(e.target.value))} className="mt-2 w-full accent-accent"/></label>)}
    <div className="flex gap-2"><button type="button" onClick={()=>setPlacement(p=>({...p,x:(100-p.width)/2}))} className="rounded-lg border border-border px-3 py-2 text-sm">Center</button><button type="button" onClick={()=>setPlacement(defaults)} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm"><RotateCcw className="size-4"/>Reset</button></div>
    <button type="button" disabled={busy || !native || !entry} onClick={()=>void save()} className="flex min-h-10 w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-black disabled:opacity-50">{busy&&<Loader2 className="size-4 animate-spin"/>}Save Overlay</button>
    <button type="button" disabled={busy || (native && !entry)} onClick={()=>void download()} className="flex min-h-10 w-full items-center justify-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm font-semibold text-white hover:border-accent disabled:opacity-50"><Download className="size-4"/>Download</button>
  </div>;
}
