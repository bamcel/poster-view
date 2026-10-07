import {useEffect,useState} from "react";
import {useQuery,useQueryClient} from "@tanstack/react-query";
import {RotateCcw,Save} from "lucide-react";
import AnimatedArtwork from "./AnimatedArtwork";
import {nativeLibraries} from "../api/nativeLibraries";
import {invalidateArtworkItems} from "../lib/artworkTarget";
import {useToast} from "../lib/toast";
import {backdropFramingUrl,backdropFramingEvent,defaultFraming,validFraming,type BackdropFraming} from "../lib/backdropFraming";
import type {ItemDetail} from "../types";
export default function BackdropEdit({serverId,item}:{serverId:number;item:ItemDetail}) {
 const client=useQueryClient();const toast=useToast();const native=serverId===0 && item.id.startsWith("native:");
 const [,library,id]=item.id.split(":");const key=`posterview.backdropEdit.${serverId}.${item.id}`;
 const catalog=useQuery({queryKey:["native-catalog",library],queryFn:()=>nativeLibraries.catalog(library),enabled:native});
 const entry=catalog.data?.find(e=>e.id===id);
 const [framing,setFraming]=useState<BackdropFraming>(defaultFraming);const [busy,setBusy]=useState(false);
 useEffect(()=>{try{setFraming(validFraming(native ? entry?.metadata.backdropedit : JSON.parse(localStorage.getItem(key)??"null"))??defaultFraming);}catch{setFraming(defaultFraming);}},[key,native,entry?.metadata.backdropedit]);
 const source=item.background?.replace(/[?&]backdrop(?:Edit|Key)=[^&]*/g,"");
 const logoDefaults={src:item.logo??"",enabled:true,x:15,y:72,width:70,opacity:100};
 const logo=framing.logo;
 const updateLogo=(patch:Partial<typeof logoDefaults>)=>setFraming(p=>({...p,logo:{...logoDefaults,...p.logo,...patch,src:item.logo??p.logo?.src??""}}));
 const dragLogo=(event:React.PointerEvent<HTMLImageElement>)=>{
  event.stopPropagation();if(event.button!==0)return;
  const element=event.currentTarget,bounds=element.parentElement!.getBoundingClientRect(),start={x:event.clientX,y:event.clientY,logo:logo??logoDefaults};
  element.setPointerCapture(event.pointerId);
  const move=(e:PointerEvent)=>updateLogo({x:Math.max(0,Math.min(100-start.logo.width,start.logo.x+(e.clientX-start.x)/bounds.width*100)),y:Math.max(0,Math.min(100,start.logo.y+(e.clientY-start.y)/bounds.height*100))});
  const stop=()=>{element.removeEventListener("pointermove",move);element.removeEventListener("pointerup",stop);element.removeEventListener("pointercancel",stop);};
  element.addEventListener("pointermove",move);element.addEventListener("pointerup",stop);element.addEventListener("pointercancel",stop);
 };
 const drag=(event:React.PointerEvent<HTMLDivElement>)=>{
  if(event.button!==0)return;
  const element=event.currentTarget;const bounds=element.getBoundingClientRect();if(!bounds.width || !bounds.height)return;
  const start={x:event.clientX,y:event.clientY,framing};element.setPointerCapture(event.pointerId);
  const move=(e:PointerEvent)=>setFraming(p=>({...p,x:Math.round(Math.max(0,Math.min(100,start.framing.x-(e.clientX-start.x)/bounds.width*100))),y:Math.round(Math.max(0,Math.min(100,start.framing.y-(e.clientY-start.y)/bounds.height*100)))}));
  const stop=()=>{element.removeEventListener("pointermove",move);element.removeEventListener("pointerup",stop);element.removeEventListener("pointercancel",stop);};
  element.addEventListener("pointermove",move);element.addEventListener("pointerup",stop);element.addEventListener("pointercancel",stop);
 };
 const save=async(reset=false)=>{
  setBusy(true);
  try{
   const value=reset?null:framing;
   if(native){const fresh=(await nativeLibraries.catalog(library)).find(e=>e.id===id);if(!fresh)throw new Error("Library item is unavailable.");const result=await nativeLibraries.editItem(library,fresh,{backdropedit:value});client.setQueryData<typeof catalog.data>(["native-catalog",library],entries=>entries?.map(e=>e.id===id?result.entry:e));await invalidateArtworkItems(client,serverId,item.id);await client.invalidateQueries({queryKey:["item-detail",serverId,item.id]});}
   else {if(value)localStorage.setItem(key,JSON.stringify(value));else localStorage.removeItem(key);window.dispatchEvent(new Event(backdropFramingEvent));}
   if(reset)setFraming(defaultFraming);
   toast.push("success",reset?"Backdrop adjustments removed.":"Backdrop adjustments saved.");
  }catch(error){toast.push("error",(error as Error).message);}finally{setBusy(false);}
 };
 if(!source)return <p className="text-sm text-muted">Add a backdrop in Artwork before using BackdropEdit.</p>;
 return <div className="space-y-4"><p className="text-xs leading-5 text-muted">Drag the backdrop or use the controls to adjust it inside its boundary. Static and animated artwork use the same framing. {native?"Saved per item in PosterView’s database.":"Saved per item in this browser."} Original artwork and connected servers are unchanged.</p>
 <div onPointerDown={drag} className="relative aspect-[3/2] cursor-move touch-none overflow-hidden rounded-xl bg-black"><AnimatedArtwork src={backdropFramingUrl(source,{...framing,logo:undefined})!} alt={`${item.title} backdrop preview`} fill className="h-full w-full object-cover"/>{logo?.enabled&&item.logo&&<img src={item.logo} alt="Drag backdrop logo" draggable={false} onPointerDown={dragLogo} className="absolute cursor-move touch-none select-none" style={{left:`${logo.x}%`,top:`${logo.y}%`,width:`${logo.width}%`,opacity:logo.opacity/100}}/>}</div>
 <label className="block text-sm text-muted">Fit<select aria-label="Backdrop fit" value={framing.fit} onChange={e=>setFraming(p=>({...p,fit:e.target.value as BackdropFraming["fit"]}))} className="mt-2 h-10 w-full rounded-lg border border-border bg-input px-3"><option value="cover">Fill container</option><option value="contain">Fit entire image</option></select></label>
 {([["x","Horizontal position"],["y","Vertical position"],["zoom","Zoom"]] as const).map(([key,label])=><label key={key} className="block text-xs text-muted">{label} · {framing[key]}%<input aria-label={`Backdrop ${label.toLowerCase()}`} type="range" min={key==="zoom"?100:0} max={key==="zoom"?200:100} value={framing[key]} onChange={e=>setFraming(p=>({...p,[key]:Number(e.target.value)}))} className="mt-2 w-full accent-accent"/></label>)}
 {item.logo ? <div className="space-y-3 border-t border-border pt-4"><label className="flex items-center justify-between text-sm text-muted">Display logo<input aria-label="Display backdrop logo" type="checkbox" checked={logo?.enabled??false} onChange={e=>updateLogo({enabled:e.target.checked})}/></label>{logo?.enabled&&([["x","Logo horizontal position"],["y","Logo vertical position"],["width","Logo width"],["opacity","Logo opacity"]] as const).map(([key,label])=><label key={key} className="block text-xs text-muted">{label} · {logo[key]}%<input aria-label={label} type="range" min={key==="width"?1:0} max="100" value={logo[key]} onChange={e=>updateLogo({[key]:Number(e.target.value)})} className="mt-2 w-full accent-accent"/></label>)}</div> : <p className="text-xs text-muted">Add a series logo in Artwork to enable the logo overlay.</p>}
 <button disabled={busy || (native && !entry)} onClick={()=>void save()} className="flex min-h-10 w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-black disabled:opacity-50"><Save className="size-4"/>Save Adjustments</button>
 <button disabled={busy || (native && !entry)} onClick={()=>void save(true)} className="flex min-h-10 w-full items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50"><RotateCcw className="size-4"/>Reset Adjustments</button>
 </div>;
}
