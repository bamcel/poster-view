import { useState } from "react";
import DOMPurify from "dompurify";
export default function DetailSynopsis({text}:{text?:string|null}) {
  const [expanded,setExpanded]=useState(false);
  if(!text)return null;
  const clean=DOMPurify.sanitize(text.replace(/<br\s*\/?\s*>/gi,"\n"),{ALLOWED_TAGS:[],ALLOWED_ATTR:[]});
  const doc=new DOMParser().parseFromString(clean,"text/html");
  return <div className="mt-5 max-w-5xl"><p className={`whitespace-pre-line text-[1rem] leading-relaxed text-accent sm:text-lg ${expanded?"":"line-clamp-3"}`}>{doc.body.textContent}</p><button aria-expanded={expanded} onClick={()=>setExpanded(!expanded)} className="mt-1 text-sm font-semibold text-muted hover:text-white">{expanded?"Less":"More"}</button></div>;
}

