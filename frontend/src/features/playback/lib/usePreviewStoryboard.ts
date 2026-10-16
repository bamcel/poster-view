import {useEffect,useRef,useState} from "react";
import {ApiError,apiRequest} from "../../../api/client";

export type StoryboardFrame={url:string;x:number;y:number;width:number;height:number;columns:number;rows:number};
type Manifest={interval:number;width:number;height:number;columns:number;frames_per_sheet:number;complete?:boolean;sheets:{index:number;url:string}[]};
type Sheet={url:string;bytes:number;manifest:Manifest};
const MAX_SHEETS=8,MAX_BYTES=16*1024*1024,MAX_SHEET_BYTES=2*1024*1024;

function validManifest(value:unknown,prefix:string,duration:number,versionQuery=""):value is Manifest {
  if(!value||typeof value!=="object")return false;
  const m=value as Manifest;
  return m.interval===10&&m.width===240&&m.height===136&&m.columns===6&&m.frames_per_sheet===30&&
    (m.complete===undefined||typeof m.complete==="boolean")&&Array.isArray(m.sheets)&&m.sheets.length<=Math.ceil(duration/300)+1&&
    m.sheets.every(s=>Number.isSafeInteger(s.index)&&s.index>=0&&s.index<Math.ceil(duration/300)&&s.url.split("?")[0]===`${prefix}/preview-sheet/${s.index}`&&new URLSearchParams(s.url.split("?")[1]??"").toString()===new URLSearchParams(versionQuery).toString())&&
    new Set(m.sheets.map(s=>s.index)).size===m.sheets.length;
}

/** Prepared images only: looking up a frame never starts network or decoding work. */
export function usePreviewStoryboard(library:string,item:string,duration:number,accountRevision:number,targetSeconds:number|null=null,versionId?:string) {
  const identity=`${library}/${item}/${versionId??""}/${accountRevision}`;
  const cache=useRef<{identity:string;sheets:Map<number,Sheet>}>({identity,sheets:new Map()});
  const [,changed]=useState(0);
  const target=useRef(targetSeconds);target.current=targetSeconds;
  const requestTarget=useRef<(()=>void)|null>(null);
  const targetSheet=targetSeconds!==null&&Number.isFinite(targetSeconds)&&targetSeconds>=0&&targetSeconds<duration?Math.floor(targetSeconds/300):null;
  useEffect(()=>{
    const controller=new AbortController();let timer:number|undefined;let bytes=0;let busy=false;let pending=false;
    const visited=new Set<number>(),urls=new Set<string>();
    const sheets=new Map<number,Sheet>();cache.current={identity,sheets};
    const prefix=`/api/playback/native/${encodeURIComponent(library)}/${encodeURIComponent(item)}`;
    const versionQuery=versionId?`?version_id=${encodeURIComponent(versionId)}`:"";
    const started=Date.now();
    const load=async()=>{
      if(controller.signal.aborted)return;
      if(busy){pending=true;return;}busy=true;clearTimeout(timer);
      try {
        const manifest=await apiRequest<unknown>(`${prefix.slice(4)}/preview-storyboard${versionQuery}`,{signal:controller.signal});
        if(controller.signal.aborted||!validManifest(manifest,prefix,duration,versionQuery))return;
        const desired=target.current!==null&&Number.isFinite(target.current)&&target.current>=0&&target.current<duration?Math.floor(target.current/300):null;
        const candidates=manifest.sheets.filter(entry=>entry.index===desired||entry.index<MAX_SHEETS&&!visited.has(entry.index));
        candidates.sort((a,b)=>Number(b.index===desired)-Number(a.index===desired)||a.index-b.index);
        for(const entry of candidates){
          if(controller.signal.aborted)break;
          if(sheets.has(entry.index))continue;
          const response=await fetch(entry.url,{signal:controller.signal,priority:"low"});
          if(!response.ok)continue;
          const length=Number(response.headers.get("Content-Length"));
          if(length>MAX_SHEET_BYTES)continue;
          const blob=await response.blob();
          if(controller.signal.aborted)return;
          if(blob.size>MAX_SHEET_BYTES||!blob.type.startsWith("image/"))continue;
          while(sheets.size>=MAX_SHEETS||bytes+blob.size>MAX_BYTES){
            const oldest=[...sheets.entries()].find(([index])=>index!==desired);
            if(!oldest)break;
            sheets.delete(oldest[0]);bytes-=oldest[1].bytes;URL.revokeObjectURL(oldest[1].url);urls.delete(oldest[1].url);
          }
          const url=URL.createObjectURL(blob);urls.add(url);
          try {
            const image=new Image();image.src=url;await image.decode();
            if(controller.signal.aborted){URL.revokeObjectURL(url);return;}
            if(image.naturalWidth!==manifest.width*manifest.columns||image.naturalHeight!==manifest.height*Math.ceil(manifest.frames_per_sheet/manifest.columns)){
              URL.revokeObjectURL(url);continue;
            }
          }catch{URL.revokeObjectURL(url);continue;}
          bytes+=blob.size;visited.add(entry.index);sheets.set(entry.index,{url,bytes:blob.size,manifest});changed(value=>value+1);
        }
        if(manifest.complete||sheets.size>=MAX_SHEETS&&(desired===null||sheets.has(desired)))return;
      }catch(error){if(controller.signal.aborted||error instanceof ApiError&&[401,403,404].includes(error.status))return;}
      finally{busy=false;if(pending&&!controller.signal.aborted){pending=false;void load();}}
      if(!controller.signal.aborted&&Date.now()-started<10*60*1000)timer=window.setTimeout(()=>{void load();},5000);
    };
    requestTarget.current=()=>{void load();};
    if(Number.isFinite(duration)&&duration>0&&duration<=7*24*3600)void load();
    return()=>{controller.abort();clearTimeout(timer);requestTarget.current=null;for(const url of urls)URL.revokeObjectURL(url);urls.clear();sheets.clear();};
  },[library,item,duration,accountRevision,identity]);
  useEffect(()=>{if(targetSheet!==null&&!cache.current.sheets.has(targetSheet))requestTarget.current?.();},[targetSheet]);
  return {frame:(seconds:number):StoryboardFrame|null=>{
    if(cache.current.identity!==identity||!Number.isFinite(seconds)||seconds<0||seconds>=duration)return null;
    const frame=Math.floor(seconds/10),sheet=cache.current.sheets.get(Math.floor(frame/30));
    if(!sheet)return null;
    const index=Math.floor(frame/30);cache.current.sheets.delete(index);cache.current.sheets.set(index,sheet);
    const m=sheet.manifest,offset=frame%30;
    return {url:sheet.url,x:offset%m.columns*m.width,y:Math.floor(offset/m.columns)*m.height,width:m.width,height:m.height,columns:m.columns,rows:Math.ceil(m.frames_per_sheet/m.columns)};
  }};
}
