import {useState,type CSSProperties,type ReactNode} from "react";
import TimelinePreview from "./TimelinePreview";

type Props={library:string;item:string;duration:number;position:number;buffered:number;scrubbing:number|null;disabled:boolean;children:ReactNode};
export default function PlaybackTimeline({library,item,duration,position,buffered,scrubbing,disabled,children}:Props){
  // Keep high-frequency hover updates outside the player/session component.
  const [hover,setHover]=useState<number|null>(null);
  return <div className="pv-timeline" onPointerMove={event=>{
    const rect=event.currentTarget.getBoundingClientRect();
    if(rect.width>0)setHover(Math.max(0,Math.min(duration,(event.clientX-rect.left)/rect.width*duration)));
  }} onPointerLeave={()=>setHover(null)} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setHover(null);}}
    style={{"--buffered":`${duration?Math.min(100,buffered/duration*100):0}%`,"--position":`${duration?Math.min(100,position/duration*100):0}%`} as CSSProperties}>
    {children}
    <TimelinePreview library={library} item={item} seconds={disabled?null:scrubbing??hover} duration={duration}/>
  </div>;
}
