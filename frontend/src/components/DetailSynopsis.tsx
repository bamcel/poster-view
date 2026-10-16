import { useState } from "react";
import { mediaDescription } from "../lib/mediaDescription";
export default function DetailSynopsis({text,lines=3}:{text?:string|null;lines?:3|8}) {
  const [expanded,setExpanded]=useState(false);
  if(!text)return null;
  const description = mediaDescription(text);
  return <div className="mt-5 max-w-5xl"><p className={`detail-synopsis whitespace-pre-line text-[1rem] leading-relaxed text-detail-text ${expanded?"":lines===8?"line-clamp-[8]":"line-clamp-3"}`}>{description}</p><button aria-expanded={expanded} onClick={()=>setExpanded(!expanded)} className="mt-1 text-sm font-semibold text-muted hover:text-white">{expanded?"Less":"More"}</button></div>;
}
