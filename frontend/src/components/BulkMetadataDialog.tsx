import {useRef, useState} from "react";
import {nativeLibraries} from "../api/nativeLibraries";
import PopupPage from "./PopupPage";

type Props={libraryId:string;itemIds:string[];onClose:()=>void;onSaved:()=>void};
type Result={id:string;title:string;error?:string;warnings:string[];changed:boolean};
function terms(value:string):string[]{return value.split(/[,\n]/).map(term=>term.trim()).filter(Boolean);}
function merge(existing:unknown, additions:string[]):string[]{
 const values=Array.isArray(existing)?existing.map(String):typeof existing==="string"?[existing]:[];
 const seen=new Set(values.map(value=>value.trim().toLowerCase()));
 for(const value of additions){const key=value.toLowerCase();if(!seen.has(key)){seen.add(key);values.push(value);}}
 return values;
}

export default function BulkMetadataDialog({libraryId,itemIds,onClose,onSaved}:Props){
 const [ids]=useState(()=>[...new Set(itemIds)]);
 const [tags,setTags]=useState(""),[genres,setGenres]=useState("");
 const [pending,setPending]=useState(false),[progress,setProgress]=useState("");
 const [results,setResults]=useState<Result[]>([]),[completed,setCompleted]=useState(false);
 const running=useRef(false);
 const valid=terms(tags).length>0||terms(genres).length>0;
 async function apply(targets:string[]){
  if(running.current||!valid||!targets.length)return;
  running.current=true;setPending(true);
  const additions={tags:terms(tags),genres:terms(genres)};
  const next=results.filter(result=>!targets.includes(result.id));
  try{
   for(const [index,id] of targets.entries()){
    setProgress(`Processing ${index+1} of ${targets.length}`);
    let title=id;
    try{
     const fresh=await nativeLibraries.item(libraryId,id);title=fresh.title;
     const metadata:Record<string,unknown>={};
     for(const field of ["tags","genres"] as const){
      if(!additions[field].length)continue;
      const merged=merge(fresh.metadata[field],additions[field]);
      const previous=Array.isArray(fresh.metadata[field])?fresh.metadata[field]:typeof fresh.metadata[field]==="string"?[fresh.metadata[field]]:[];
      if(merged.length!==previous.length)metadata[field]=merged;
     }
     const changed=Object.keys(metadata).length>0;
     const response=changed?await nativeLibraries.editItem(libraryId,fresh,metadata):null;
     next.push({id,title,changed,warnings:response?.warnings??[]});
    }catch(error){next.push({id,title,changed:false,warnings:[],error:error instanceof Error?error.message:String(error)});}
    setResults([...next]);
   }
   setCompleted(true);setProgress("Batch complete");onSaved();
  }finally{running.current=false;setPending(false);}
 }
 const failed=results.filter(result=>result.error);
 return <PopupPage title="Edit tags and genres" onClose={onClose} closeDisabled={pending}
  description={`${ids.length} unique ${ids.length===1?"item":"items"} selected. Add tags and genres while preserving existing values and all other metadata.`}
  footer={<>{completed&&failed.length>0?<button type="button" disabled={pending} onClick={()=>void apply(failed.map(result=>result.id))}>Retry failed items ({failed.length})</button>:null}
   {!completed&&<button type="button" disabled={pending||!valid||!ids.length} onClick={()=>void apply(ids)}>{pending?"Applying…":"Apply"}</button>}
   <button type="button" disabled={pending} onClick={onClose}>{completed?"Done":"Cancel"}</button></>}>
  <div className="space-y-5">
   <p className="text-sm text-muted">Separate values with commas or new lines. Matching values are not added twice.</p>
   <label className="block">Tags to add<textarea className="mt-2 w-full rounded-lg border border-edge bg-transparent p-3" value={tags} disabled={pending||completed} onChange={event=>setTags(event.target.value)}/></label>
   <label className="block">Genres to add<textarea className="mt-2 w-full rounded-lg border border-edge bg-transparent p-3" value={genres} disabled={pending||completed} onChange={event=>setGenres(event.target.value)}/></label>
   <p role="status" aria-live="polite">{progress}{completed?` — ${results.filter(result=>!result.error).length} succeeded, ${failed.length} failed.`:""}</p>
   {results.length>0&&<ul className="space-y-3" aria-label="Bulk edit results">{results.map(result=><li key={result.id}><strong>{result.title}</strong>: {result.error?`Failed: ${result.error}. Retry fetches the latest metadata before applying again.`:result.changed?"Updated":"Already contains these values"}{result.warnings.map((warning,index)=><p key={index} className="text-sm">Warning: {warning}</p>)}</li>)}</ul>}
  </div>
 </PopupPage>;
}
