import {useEffect, useRef, useState} from "react";

/** Selection is scoped to the library, but survives searches within that library. */
export function useLibrarySelection(libraryId:string, visibleIds:string[], enabled:boolean) {
  const [ids,setIds]=useState<Set<string>>(()=>new Set());
  const [active,setActive]=useState(false);
  const anchor=useRef<string|null>(null);
  const clear=()=>{setIds(new Set());setActive(false);anchor.current=null;};
  useEffect(()=>{clear();},[libraryId,enabled]);
  const toggle=(id:string,range=false)=>{
    setActive(true);
    const start=anchor.current?visibleIds.indexOf(anchor.current):-1;
    const end=visibleIds.indexOf(id);
    setIds(previous=>{
      const next=new Set(previous);
      if(range&&start>=0&&end>=0)visibleIds.slice(Math.min(start,end),Math.max(start,end)+1).forEach(value=>next.add(value));
      else if(next.has(id))next.delete(id);else next.add(id);
      return next;
    });
    anchor.current=id;
  };
  const selectAll=()=>{setActive(true);setIds(previous=>new Set([...previous,...visibleIds]));};
  useEffect(()=>{
    if(!enabled||!active)return;
    const key=(event:KeyboardEvent)=>{
      const target=event.target;
      if(target instanceof HTMLElement&&target.closest('input,textarea,select,[contenteditable="true"]'))return;
      if(event.key==="Escape"){event.preventDefault();clear();}
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="a"){event.preventDefault();selectAll();}
    };
    window.addEventListener("keydown",key);
    return()=>window.removeEventListener("keydown",key);
  });
  return {ids,active,toggle,selectAll,clear,start:()=>setActive(true),hidden:[...ids].filter(id=>!visibleIds.includes(id)).length};
}

export default function LibrarySelection({count,hidden,onAll,onClear,onAdd,onEdit}:{count:number;hidden:number;onAll:()=>void;onClear:()=>void;onAdd?:()=>void;onEdit?:()=>void}){
  return <div role="toolbar" aria-label="Library selection" className="sticky top-0 z-20 mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-2 p-3 text-sm">
    <span aria-live="polite">{count} selected{hidden>0?` (${hidden} hidden by filters)`:""}</span>
    <button type="button" onClick={onAll} className="rounded-full border border-border px-3 py-2">Select all visible</button>
    <button type="button" onClick={onClear} className="rounded-full border border-border px-3 py-2">Clear</button>
    {onEdit&&<button type="button" disabled={!count} onClick={onEdit} className="rounded-full border border-border px-3 py-2 disabled:opacity-50">Edit tags and genres…</button>}
    {onAdd&&<button type="button" disabled={!count} onClick={onAdd} className="rounded-full border border-border px-3 py-2 disabled:opacity-50">Add to collection…</button>}
  </div>;
}
