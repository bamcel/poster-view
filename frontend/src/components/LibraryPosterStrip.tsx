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
 // Share one random selection between Home and Settings for this catalog membership.
 const ids=JSON.stringify((posters.data??[]).map(item=>item.id).sort());
 const selection=useQuery({
  queryKey:["native-preview-track",library,ids],
  enabled:false,
  staleTime:Infinity,
  gcTime:Infinity,
  initialData:()=>{
   if(!posters.data)return undefined;
   const shuffled=[...posters.data];
   for(let index=shuffled.length-1;index>0;index--) {
    const other=Math.floor(Math.random()*(index+1));
    [shuffled[index],shuffled[other]]=[shuffled[other],shuffled[index]];
   }
   return shuffled.slice(0,12);
  },
 });
 const items=selection.data??[];
 const cycleLength=items.length ? Math.ceil(4/items.length)*items.length : 0;
 useEffect(()=>{progress.current=0;},[items]);
 useEffect(()=>{
  if(track.current)track.current.style.transform=`translate3d(${-25*cycleLength+25*progress.current}%,0,0)`;
  if(!visible||reduced||items.length<2)return;
  let frame=0,last:number|undefined,stopped=false;
  const animate=(time:number)=>{
   if(last!==undefined&&!document.hidden){progress.current+=Math.min(time-last,100)/5000;progress.current%=cycleLength;if(track.current)track.current.style.transform=`translate3d(${-25*cycleLength+25*progress.current}%,0,0)`;}
   last=time;frame=requestAnimationFrame(animate);
  };
  // Start only after posters and reflections have decoded, avoiding blank moving slots.
  const images=Array.from(track.current?.querySelectorAll("img")??[]);
  void Promise.all(images.map(image=>typeof image.decode==="function"?image.decode().catch(()=>{}):Promise.resolve())).then(()=>{
   if(!stopped)frame=requestAnimationFrame(animate);
  });
  return()=>{stopped=true;cancelAnimationFrame(frame);};
 },[visible,reduced,cycleLength,items]);
 return <div ref={ref} className="overflow-hidden" aria-label="Library poster preview">
  {items.length ? <div ref={track} className="flex will-change-transform" style={{transform:`translate3d(${-25*cycleLength}%,0,0)`}}>{Array.from({length:cycleLength*2},(_,slot)=>{const item=items[slot%items.length];const src=nativeLibraries.artworkUrl(library,item.id,"poster")+`?v=${item.revision}`;return <div key={slot} className="w-1/4 shrink-0 px-px"><img src={src} alt={slot<cycleLength?item.title:""} loading="eager" decoding="async" className="aspect-[2/3] w-full object-cover"/><div aria-hidden="true" className="relative h-10 overflow-hidden"><img src={src} alt="" className="w-full -scale-y-100 opacity-30"/><div className="absolute inset-0 bg-gradient-to-b from-transparent to-window"/></div></div>;})}</div> : <div className="flex aspect-[3/1.5] items-center justify-center bg-base/30 text-faint"><Folder className="size-12"/></div>}
 </div>;
}
