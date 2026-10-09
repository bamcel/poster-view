export default function BookSeriesMetadata({metadata,count,unit="Volume"}:{metadata:Record<string,unknown>;count:number;unit?:"Volume"|"Chapter"}){
 const fields:[string,unknown][]=[["Year",metadata.year],["Publisher",metadata.publisher],["Translation",metadata.translation??metadata.translatedtitle],["Volumes",metadata.volumes],["Edition",metadata.edition],["Status",metadata.status],["Country",metadata.country],["Source",metadata.source_material??metadata.sourcematerial]];
 const total=Number(unit==="Chapter"?metadata.chapters:metadata.volumes),missing=Number.isFinite(total)?Math.max(0,total-count):0;
 return <div className="mt-4 flex max-w-2xl flex-wrap items-center gap-2" aria-label="Book metadata">
 {fields.filter(([,value])=>value!==undefined&&value!==null&&String(value).trim()!=="").map(([label,value])=><span key={label} className="inline-flex max-w-full items-center rounded-full border border-white/15 bg-black/20 px-3 py-1 text-xs text-white/80"><span className="truncate"><span className="text-white/50">{label}</span> · {Array.isArray(value)?value.join(", "):String(value)}</span></span>)}
 {missing>0&&<span className="rounded-full border border-amber-400/40 bg-amber-400/15 px-3 py-1 text-xs font-medium text-amber-200">{missing} {missing===1?unit:`${unit}s`} Missing</span>}
 {Number.isFinite(total)&&total>0&&missing===0&&<span className="rounded-full border border-emerald-400/40 bg-emerald-400/15 px-3 py-1 text-xs font-medium text-emerald-200">Complete</span>}
 </div>;
}
