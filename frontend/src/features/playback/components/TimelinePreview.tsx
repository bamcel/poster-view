import {useEffect,useState} from "react";
import {playbackTime} from "../lib/playback";
import {currentChapter,type Chapter} from "../lib/chapters";

export default function TimelinePreview({library,item,seconds,duration,chapters=[]}:{library:string;item:string;seconds:number|null;duration:number;chapters?:readonly Chapter[]}) {
  const bucket=seconds===null?null:Math.floor(Math.max(0,seconds)/10)*10;
  const [image,setImage]=useState<{key:string;url:string}|null>(null);
  const key=bucket===null?null:`${library}/${item}/${bucket}`;
  useEffect(()=>{
    setImage(null);
    if(bucket===null||key===null)return;
    const controller=new AbortController();let objectUrl:string|undefined;
    // Only deliberate timeline inspection generates a frame. Never fetch on play/seek.
    const timer=window.setTimeout(()=>{void(async()=>{
      try{
        const response=await fetch(`/api/playback/native/${encodeURIComponent(library)}/${encodeURIComponent(item)}/preview?seconds=${bucket}`,{signal:controller.signal});
        if(!response.ok)return;
        const blob=await response.blob();if(controller.signal.aborted)return;
        objectUrl=URL.createObjectURL(blob);setImage({key,url:objectUrl});
      }catch{ /* A busy preview worker or cancellation must not affect playback. */ }
    })();},350);
    return()=>{clearTimeout(timer);controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);};
  },[library,item,bucket,key]);
  if(seconds===null||duration<=0)return null;
  const chapter=currentChapter(chapters,seconds,duration);
  return <figure className="pv-timeline-preview" style={{left:`clamp(85px,${Math.max(0,Math.min(100,seconds/duration*100))}%,calc(100% - 85px))`}} aria-label="Timeline preview">
    {image?.key===key&&<img src={image.url} alt={`Preview near ${playbackTime(bucket??0)}`}/>}
    <figcaption><time>{playbackTime(seconds)}</time>{chapter&&<span className="pv-preview-chapter">{chapter.title}</span>}</figcaption>
  </figure>;
}
