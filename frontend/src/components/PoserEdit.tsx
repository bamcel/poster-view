import {useEffect, useRef, useState} from "react";
import {useQuery, useQueryClient} from "@tanstack/react-query";
import {Loader2, RotateCcw} from "lucide-react";
import AnimatedArtwork, {artworkFormat} from "./AnimatedArtwork";
import {api} from "../api/client";
import {nativeLibraries} from "../api/nativeLibraries";
import {invalidateArtworkItems} from "../lib/artworkTarget";
import {useToast} from "../lib/toast";
import type {ItemDetail} from "../types";

type Placement = {poster_path?:string;x:number; y:number; width:number; opacity:number; enabled:boolean};
const defaults: Placement = {x:15,y:72,width:70,opacity:100,enabled:true};
const loadImage = (src:string) => new Promise<HTMLImageElement>((resolve,reject) => {
  const image = new Image(); image.crossOrigin="anonymous";
  image.onload=()=>resolve(image); image.onerror=()=>reject(new Error("Unable to load artwork for export.")); image.src=src;
});
export default function PoserEdit({serverId,item}: {serverId:number;item:ItemDetail}) {
  const client=useQueryClient(); const toast=useToast(); const preview=useRef<HTMLDivElement>(null);
  const [placement,setPlacement]=useState<Placement>(defaults); const [busy,setBusy]=useState(false);
  const native=serverId===0 && item.id.startsWith("native:");
  const [,library,id]=item.id.split(":");
  const catalog=useQuery({queryKey:["native-catalog",library],queryFn:()=>nativeLibraries.catalog(library),enabled:native});
  const entry=catalog.data?.find(e=>e.id===id);
  const saved=entry?.metadata.poseredit as Placement | undefined;
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
    if (!source || !logo || (native && !entry)) return;
    setBusy(true);
    try {
      if (!animated) {
        const [poster,mark]=await Promise.all([loadImage(source),loadImage(logo)]);
        const canvas=document.createElement("canvas"); canvas.width=poster.naturalWidth;canvas.height=poster.naturalHeight;
        const context=canvas.getContext("2d"); if (!context) throw new Error("Image export is unavailable.");
        context.drawImage(poster,0,0);
        if (native && !original) {
          const originalBlob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error("Original poster export failed.")),"image/png"));
          await nativeLibraries.upload(library,id,"poster-edit-original",new File([originalBlob],"original.png",{type:"image/png"}));
        }
        if (placement.enabled) {
          const width=canvas.width*placement.width/100;
          context.globalAlpha=placement.opacity/100;
          context.drawImage(mark,canvas.width*placement.x/100,canvas.height*placement.y/100,width,width*mark.naturalHeight/mark.naturalWidth);
        }
        const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error("Poster export failed.")),"image/png"));
        const result=await api.applyUpload({server_id:serverId,item_id:item.id,target:"poster",file:new File([blob],"poster.png",{type:"image/png"}),item_title:item.title});
        if (!result.ok) throw new Error(result.message);
      }
      if (native) {
        const fresh=(await nativeLibraries.catalog(library)).find(e=>e.id===id);
        if (!fresh) throw new Error("Library item is unavailable.");
        await nativeLibraries.editItem(library,fresh,{poseredit:{...placement,poster_path:fresh.artwork.find(a=>a.kind==="poster")?.path}});
      }
      await invalidateArtworkItems(client,serverId,item.id);
      await client.invalidateQueries({queryKey:["item-detail",serverId,item.id]});
      toast.push("success",animated?"Animated poster overlay saved.":"Poster saved.");
    } catch(error) {toast.push("error",(error as Error).message);} finally {setBusy(false);}
  };
  if (!source || !logo) return <p className="text-sm text-muted">Add a poster and a series logo in Artwork before using PoserEdit.</p>;
  return <div className="space-y-4">
    <p className="text-xs leading-5 text-muted">Drag the logo to position it. Resize and adjust opacity below. {animated ? "The animation stays unchanged; its overlay is displayed in PosterView." : native ? "Your original poster is preserved for further edits." : "Saving updates the connected server’s poster. Editable placement is available for manual libraries."}</p>
    <div ref={preview} className="relative aspect-[2/3] overflow-hidden rounded-xl bg-black">
      <AnimatedArtwork src={source} alt={item.title} className="h-full w-full object-cover"/>
      {placement.enabled && <img src={logo} alt="Drag series logo" draggable={false} onPointerDown={drag} className="absolute cursor-move touch-none select-none" style={{left:`${placement.x}%`,top:`${placement.y}%`,width:`${placement.width}%`,opacity:placement.opacity/100}}/>}
    </div>
    <label className="flex items-center justify-between text-sm text-muted">Display logo<input type="checkbox" checked={placement.enabled} onChange={e=>setPlacement(p=>({...p,enabled:e.target.checked}))}/></label>
    {([['x','Horizontal position'],['y','Vertical position'],['width','Logo size'],['opacity','Opacity']] as const).map(([key,label])=><label key={key} className="block text-xs text-muted">{label} · {Math.round(placement[key])}%<input aria-label={label} type="range" min={key==='width'?5:0} max={100} value={placement[key]} onChange={e=>update(key,Number(e.target.value))} className="mt-2 w-full accent-accent"/></label>)}
    <div className="flex gap-2"><button type="button" onClick={()=>setPlacement(p=>({...p,x:(100-p.width)/2}))} className="rounded-lg border border-border px-3 py-2 text-sm">Center</button><button type="button" onClick={()=>setPlacement(defaults)} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm"><RotateCcw className="size-4"/>Reset</button></div>
    <button type="button" disabled={busy || (native && !entry) || (animated && !native)} onClick={()=>void save()} className="flex min-h-10 w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-black disabled:opacity-50">{busy&&<Loader2 className="size-4 animate-spin"/>}Save poster</button>
  </div>;
}
