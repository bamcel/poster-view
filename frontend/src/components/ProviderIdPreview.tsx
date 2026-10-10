import {useEffect,useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {ImageOff,Loader2} from "lucide-react";
import {nativeLibraries} from "../api/nativeLibraries";
import {apiRequest} from "../api/client";

export default function ProviderIdPreview({library,item,provider,id,label}:{library:string;item:string;provider:string;id:string;label:string}){
 const value=id.trim();
 const [settled,setSettled]=useState(value);
 useEffect(()=>{const timer=setTimeout(()=>setSettled(value),400);return ()=>clearTimeout(timer);},[value]);
 const match=useQuery({queryKey:["identify-id-preview",library,item,provider,settled],queryFn:()=>nativeLibraries.identifyResolve(library,item,provider,settled),enabled:!!settled&&settled===value,staleTime:300000,retry:false});
 const candidate=match.data?.candidates.find(c=>provider==="imdb"?c.identifiers.imdb===settled:c.provider===provider);
 const anidb=useQuery({queryKey:["anidb-identify-poster",settled],queryFn:()=>apiRequest<{poster:string|null}>(`/native/identify/anidb/${encodeURIComponent(settled)}/poster`),enabled:!!candidate&&provider==="anidb"&&!candidate.poster&&settled===value,staleTime:86400000,retry:false});
 const poster=candidate?.poster??anidb.data?.poster;
 const [failed,setFailed]=useState(false);
 useEffect(()=>setFailed(false),[poster]);
 if(!value)return null;
 const loading=settled!==value||match.isFetching;
 return <div aria-label={`${label} ID preview`} className="mt-2 flex items-center gap-3 rounded-lg border border-border bg-surface-2 p-2">
 <div className="h-20 w-14 shrink-0 overflow-hidden rounded bg-input">{!loading&&poster&&!failed?<img src={poster} alt={`${label}: ${candidate?.title} poster`} className="size-full object-cover" loading="lazy" referrerPolicy="no-referrer" onError={()=>setFailed(true)}/>:<div className="grid size-full place-items-center text-faint">{loading||anidb.isFetching?<Loader2 className="size-4 animate-spin"/>:<ImageOff className="size-5"/>}</div>}</div>
 <div className="min-w-0 text-xs"><p className="break-all text-muted">{label} · {value}</p>{loading?<p role="status" className="mt-1 text-muted">Looking up ID…</p>:candidate?<><p className="mt-1 line-clamp-2 font-medium text-white">{candidate.title}</p><p className="mt-1 text-muted">{candidate.year??"Unknown year"}{provider==="imdb"?" · Linked TVDB record":""}{candidate.publisher?` · ${candidate.publisher}`:""}{candidate.volume_count!=null?` · ${candidate.volume_count} volumes`:""}</p>{(!poster||failed)&&<p className="mt-1 text-muted">Poster unavailable</p>}</>:<p className="mt-1 text-muted">{match.error?.message??"No matching record available"}</p>}</div>
 </div>;
}
