import {useEffect, useRef, useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {Folder} from "lucide-react";
import {nativeLibraries} from "../api/nativeLibraries";

export default function LibraryPosterStrip({library, paused=false}: {library:string;paused?:boolean}) {
 const ref=useRef<HTMLDivElement>(null);
 const [visible,setVisible]=useState(false),[hover,setHover]=useState(false),[index,setIndex]=useState(0),[moving,setMoving]=useState(false),[reduced,setReduced]=useState(false);
 useEffect(()=>{const media=window.matchMedia?.("(prefers-reduced-motion: reduce)");const update=()=>setReduced(media?.matches??false);update();media?.addEventListener("change",update);return()=>media?.removeEventListener("change",update);},[]);
 useEffect(()=>{if(!window.IntersectionObserver){setVisible(true);return;}const observer=new IntersectionObserver(entries=>setVisible(entries[0]?.isIntersecting??false),{rootMargin:"100px"});if(ref.current)observer.observe(ref.current);return()=>observer.disconnect();},[]);
 const posters=useQuery({queryKey:["native-previews",library],queryFn:()=>nativeLibraries.previews(library),enabled:visible,staleTime:60_000});
 const items=posters.data??[];
 useEffect(()=>{if(!visible||hover||paused||reduced||items.length<=4)return;let timeout:ReturnType<typeof setTimeout>|undefined;const timer=setInterval(()=>{if(document.hidden)return;setMoving(true);timeout=setTimeout(()=>{setIndex(i=>(i-1+items.length)%items.length);setMoving(false);},700);},5000);return()=>{clearInterval(timer);clearTimeout(timeout);setMoving(false);};},[visible,hover,paused,reduced,items.length]);
 return <div ref={ref} onMouseEnter={()=>setHover(true)} onMouseLeave={()=>setHover(false)} className="overflow-hidden" aria-label="Library poster preview">
  {items.length ? <div className="flex" style={{transform:`translateX(${moving?0:-25}%)`,transition:moving?"transform 700ms ease-in-out":"none"}}>{Array.from({length:5},(_,slot)=>{const item=items[(index+slot-1+items.length)%items.length];const src=nativeLibraries.artworkUrl(library,item.id,"poster")+`?v=${item.revision}`;return <div key={slot} className="w-1/4 shrink-0 px-px"><img src={src} alt={slot===0?"":item.title} loading="lazy" decoding="async" className="aspect-[2/3] w-full object-cover"/><div aria-hidden="true" className="relative h-10 overflow-hidden"><img src={src} alt="" className="w-full -scale-y-100 opacity-30"/><div className="absolute inset-0 bg-gradient-to-b from-transparent to-panel"/></div></div>;})}</div> : <div className="flex aspect-[3/1.5] items-center justify-center bg-base/30 text-faint"><Folder className="size-12"/></div>}
 </div>;
}
