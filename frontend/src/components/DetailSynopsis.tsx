import { useState } from "react";
import DOMPurify from "dompurify";
export default function DetailSynopsis({text}:{text?:string|null}) {
  const [expanded,setExpanded]=useState(false);
  if(!text)return null;
  const clean=DOMPurify.sanitize(text.replace(/<\/(?:p|div)>/gi,"\n").replace(/<br\s*\/?\s*>/gi,"\n"),{ALLOWED_TAGS:[],ALLOWED_ATTR:[]});
  const doc=new DOMParser().parseFromString(clean,"text/html");
  const description = (doc.body.textContent ?? "").replace(/\r\n?/g,"\n").replace(/[\t ]*\n(?:[\t ]*\n)*[\t ]*/g,"\n").trim();
  return <div className="mt-5 max-w-5xl"><p className={`whitespace-pre-line text-[1rem] leading-snug text-detail-text sm:text-lg ${expanded?"":"line-clamp-3"}`}>{description}</p><button aria-expanded={expanded} onClick={()=>setExpanded(!expanded)} className="mt-1 text-sm font-semibold text-muted hover:text-white">{expanded?"Less":"More"}</button></div>;
}

