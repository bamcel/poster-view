import {useEffect, useRef, useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {Folder} from "lucide-react";
import {nativeLibraries} from "../api/nativeLibraries";

export default function LibraryPosterStrip({library}: {library:string}) {
 const ref=useRef<HTMLDivElement>(null), track=useRef<HTMLDivElement>(null), progress=useRef(0);
 const [visible,setVisible]=useState(false),[reduced,setReduced]=useState(false);
 useEffect(()=>{const media=window.matchMedia?.("(prefers-reduced-motion: reduce)");const update=()=>setReduced(media?.matches??false);update();media?.addEventListener("change",update);return()=>media?.removeEventListener("change",update);},[]);
 useEffect(()=>{if(!window.IntersectionObserver){setVisible(true);return;}const observer=new IntersectionObserver(entries=>setVisible(entries[0]?.isIntersecting??false),{rootMargin:"100px"});if(ref.current)observer.observe(ref.current);return()=>observer.disconnect();},[]);
 const posters=useQuery({queryKey:["native-previews",library],queryFn:()=>nativeLibraries.previews(library),enabled:visible,staleTime:60_000});
 // Keep a bounded, fixed track mounted; moving it must never replace image URLs.
 const snapshot=useRef<{library:string;ids:string;items:NonNullable<typeof posters.data>}>({library,ids:"",items:[]});
 const ids=JSON.stringify((posters.data??[]).map(item=>item.id).sort());
 // Background refetches and metadata revisions must not change the displayed posters.
 if(posters.data && (snapshot.current.library!==library || snapshot.current.ids!==ids)) {
  const shuffled=[...posters.data];
  for(let index=shuffled.length-1;index>0;index--) {
   const other=Math.floor(Math.random()*(index+1));
   [shuffled[index],shuffled[other]]=[shuffled[other],shuffled[index]];
  }
  snapshot.current={library,ids,items:shuffled.slice(0,12)};
 }
 const items=snapshot.current.library===library?snapshot.current.items:[];
 const cycleLength=items.length ? Math.ceil(4/items.length)*items.length : 0;
 useEffect(()=>{
  progress.current=0;
  if(track.current)track.current.style.transform=`translateX(${-25*cycleLength}%)`;
  if(!visible||reduced||items.length<2)return;
  let frame=0,last:number|undefined;
  const animate=(time:number)=>{
   if(last!==undefined&&!document.hidden){progress.current+=Math.min(time-last,100)/5000;progress.current%=cycleLength;if(track.current)track.current.style.transform=`translateX(${-25*cycleLength+25*progress.current}%)`;}
   last=time;frame=requestAnimationFrame(animate);
  };
  frame=requestAnimationFrame(animate);return()=>cancelAnimationFrame(frame);
 },[visible,reduced,cycleLength,items.length]);
 return <div ref={ref} className="overflow-hidden" aria-label="Library poster preview">
  {items.length ? <div ref={track} className="flex will-change-transform" style={{transform:`translateX(${-25*cycleLength}%)`}}>{Array.from({length:cycleLength*2},(_,slot)=>{const item=items[slot%items.length];const src=nativeLibraries.artworkUrl(library,item.id,"poster")+`?v=${item.revision}`;return <div key={slot} className="w-1/4 shrink-0 px-px"><img src={src} alt={slot<cycleLength?item.title:""} loading="eager" decoding="async" className="aspect-[2/3] w-full object-cover"/><div aria-hidden="true" className="relative h-10 overflow-hidden"><img src={src} alt="" className="w-full -scale-y-100 opacity-30"/><div className="absolute inset-0 bg-gradient-to-b from-transparent to-window"/></div></div>;})}</div> : <div className="flex aspect-[3/1.5] items-center justify-center bg-base/30 text-faint"><Folder className="size-12"/></div>}
 </div>;
}
