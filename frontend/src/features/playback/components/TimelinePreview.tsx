import {useEffect,useRef,useState} from "react";
import {playbackTime} from "../lib/playback";
import {currentChapter,type Chapter} from "../lib/chapters";
import {usePreviewStoryboard} from "../lib/usePreviewStoryboard";

type PreviewImage={key:string;url:string;bytes:number};
const MAX_IMAGE_BYTES=1024*1024,MAX_CACHE_BYTES=4*1024*1024,MAX_CACHE_IMAGES=12;
const RETRY_DELAYS=[250,500,1000,1500];

export default function TimelinePreview({library,item,seconds,duration,position=0,chapters=[],versionId}:{library:string;item:string;seconds:number|null;duration:number;position?:number;chapters?:readonly Chapter[];versionId?:string}) {
  const bucket=seconds===null?null:Math.floor(Math.max(0,seconds)/10)*10;
  const cache=useRef(new Map<string,PreviewImage>());
  const activeRequest=useRef<AbortController|null>(null);
  const [accountRevision,setAccountRevision]=useState(0);
  const storyboard=usePreviewStoryboard(library,item,duration,accountRevision,seconds??position,versionId);
  const prepared=seconds===null?null:storyboard.frame(seconds);
  const preparedUrl=prepared?.url;
  const [image,setImage]=useState<PreviewImage|null>(null);
  const key=bucket===null?null:`${accountRevision}/${library}/${item}/${versionId??""}/${bucket}`;
  useEffect(()=>{
    const clear=()=>{for(const entry of cache.current.values())URL.revokeObjectURL(entry.url);cache.current.clear();};
    const accountChanged=()=>{activeRequest.current?.abort();clear();setImage(null);setAccountRevision(value=>value+1);};
    window.addEventListener("posterview:account-changed",accountChanged);
    return()=>{activeRequest.current?.abort();window.removeEventListener("posterview:account-changed",accountChanged);clear();};
  },[library,item,versionId]);
  useEffect(()=>{
    setImage(null);
    if(bucket===null||key===null||preparedUrl)return;
    const cached=cache.current.get(key);
    if(cached){cache.current.delete(key);cache.current.set(key,cached);setImage(cached);return;}
    const controller=new AbortController();let timer:number;
    activeRequest.current=controller;
    const request=async(attempt:number)=>{
      if(controller.signal.aborted)return;
      try{
        const response=await fetch(`/api/playback/native/${encodeURIComponent(library)}/${encodeURIComponent(item)}/preview?seconds=${bucket}${versionId?`&version_id=${encodeURIComponent(versionId)}`:""}`,{signal:controller.signal});
        if(controller.signal.aborted)return;
        if(response.status===429&&attempt<RETRY_DELAYS.length){timer=window.setTimeout(()=>{void request(attempt+1);},RETRY_DELAYS[attempt]);return;}
        if(!response.ok)return;
        const blob=await response.blob();if(controller.signal.aborted||blob.size>MAX_IMAGE_BYTES)return;
        const entry={key,url:URL.createObjectURL(blob),bytes:blob.size};
        cache.current.set(key,entry);
        let bytes=Array.from(cache.current.values()).reduce((total,value)=>total+value.bytes,0);
        while(cache.current.size>MAX_CACHE_IMAGES||bytes>MAX_CACHE_BYTES){
          const oldest=cache.current.entries().next().value!;
          cache.current.delete(oldest[0]);bytes-=oldest[1].bytes;URL.revokeObjectURL(oldest[1].url);
        }
        setImage(entry);
      }catch{ /* Preview work must never interfere with playback. */ }
    };
    // Fetch only during deliberate inspection, with one current target and bounded retries.
    timer=window.setTimeout(()=>{void request(0);},120);
    return()=>{clearTimeout(timer);controller.abort();if(activeRequest.current===controller)activeRequest.current=null;};
  },[library,item,bucket,key,accountRevision,preparedUrl,versionId]);
  if(seconds===null||duration<=0)return null;
  const chapter=currentChapter(chapters,seconds,duration);
  return <figure className="pv-timeline-preview" style={{left:`clamp(calc(var(--preview-width) / 2 + 12px - var(--timeline-left,0px)),${Math.max(0,Math.min(100,seconds/duration*100))}%,calc(100vw - var(--timeline-left,0px) - var(--preview-width) / 2 - 12px))`}} aria-label="Timeline preview">
    <div className="pv-preview-image">{prepared?<div role="img" aria-label={`Preview near ${playbackTime(bucket??0)}`} style={{width:"100%",height:"100%",backgroundImage:`url("${prepared.url}")`,backgroundSize:`${prepared.columns*100}% ${prepared.rows*100}%`,backgroundPosition:`${prepared.x/prepared.width/(prepared.columns-1)*100}% ${prepared.y/prepared.height/(prepared.rows-1)*100}%`}}/>:image?.key===key&&<img src={image.url} alt={`Preview near ${playbackTime(bucket??0)}`}/>}</div>
    <figcaption><time>{playbackTime(seconds)}</time>{chapter&&<span className="pv-preview-chapter">{chapter.title}</span>}</figcaption>
  </figure>;
}
