import { useLayoutEffect, useRef, useState } from "react";
import { mediaDescription } from "../lib/mediaDescription";
export default function DetailSynopsis({text,lines=3}:{text?:string|null;lines?:3|8}) {
  const description = mediaDescription(text);
  const [expanded,setExpanded]=useState(false);
  const [overflow,setOverflow]=useState(false);
  const paragraph=useRef<HTMLParagraphElement>(null);
  useLayoutEffect(()=>{setExpanded(false);},[description,lines]);
  useLayoutEffect(()=>{
    const element=paragraph.current;
    if(!element)return;
    let mounted=true;
    const measure=()=>{
      if(!mounted)return;
      const lineHeight=Number.parseFloat(getComputedStyle(element).lineHeight);
      const clipped=expanded
        ? Number.isFinite(lineHeight)&&element.scrollHeight>lineHeight*lines+1
        : element.scrollHeight>element.clientHeight+1;
      setOverflow(clipped);
      if(!clipped&&expanded)setExpanded(false);
    };
    measure();
    const observer=typeof ResizeObserver!=="undefined"?new ResizeObserver(measure):undefined;
    observer?.observe(element);
    window.addEventListener("resize",measure);
    void document.fonts?.ready.then(measure);
    return()=>{mounted=false;observer?.disconnect();window.removeEventListener("resize",measure);};
  },[description,lines,expanded]);
  if(!description)return null;
  return <div className="mt-5 max-w-5xl"><p ref={paragraph} className={`detail-synopsis whitespace-pre-line text-[1rem] leading-relaxed text-detail-text ${expanded?"":lines===8?"line-clamp-[8]":"line-clamp-3"}`}>{description}</p>{overflow&&<button type="button" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)} className="mt-1 text-sm font-semibold text-muted hover:text-white">{expanded?"Less":"More"}</button>}</div>;
}
