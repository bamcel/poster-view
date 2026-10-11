import { useState } from "react";
import DOMPurify from "dompurify";
export default function DetailSynopsis({text,lines=3}:{text?:string|null;lines?:3|8}) {
  const [expanded,setExpanded]=useState(false);
  if(!text)return null;
  const clean=DOMPurify.sanitize(text.replace(/&lt;br\s*\/?\s*&gt;/gi,"\n").replace(/<\/(?:p|div)>/gi,"\n").replace(/<br\s*\/?\s*>/gi,"\n"),{ALLOWED_TAGS:[],ALLOWED_ATTR:[]});
  const doc=new DOMParser().parseFromString(clean,"text/html");
  const description = (doc.body.textContent ?? "").replace(/\r\n?/g,"\n").replace(/[\t ]*\n(?:[\t ]*\n)*[\t ]*/g,"\n").trim();
  return <div className="mt-5 max-w-5xl"><p className={`detail-synopsis whitespace-pre-line text-[1rem] leading-relaxed text-detail-text ${expanded?"":lines===8?"line-clamp-[8]":"line-clamp-3"}`}>{description}</p><button aria-expanded={expanded} onClick={()=>setExpanded(!expanded)} className="mt-1 text-sm font-semibold text-muted hover:text-white">{expanded?"Less":"More"}</button></div>;
}
