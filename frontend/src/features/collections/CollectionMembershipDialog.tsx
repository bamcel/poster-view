import {useEffect,useState} from "react";
import {useQueryClient} from "@tanstack/react-query";
import {useIsAdmin} from "../../lib/authContext";
import {collectionsApi,useCollections,type MemberRef} from "./client";
import {useCollectionDialog} from "./useCollectionDialog";
import {uniqueMembers} from "./grouping";

export default function CollectionMembershipDialog({members,onClose,onSaved}:{members:MemberRef[];onClose:()=>void;onSaved?:()=>void}){
 const admin=useIsAdmin(),client=useQueryClient(),query=useCollections();
 const [search,setSearch]=useState(""),[selected,setSelected]=useState(""),[title,setTitle]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState(""),[result,setResult]=useState("");
 const dialog=useCollectionDialog(onClose,busy);
 useEffect(()=>{if(result)dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();},[result,dialog]);
 if(!admin)return null;
 const save=async()=>{setBusy(true);setError("");try{
  const refs=uniqueMembers(members);
  if(selected){const current=query.data?.find(item=>item.id===selected);if(!current)throw new Error("Select a collection.");const response=await collectionsApi.addMembers(selected,{revision:current.revision,members:refs});setResult(`${response.added} added, ${response.existing} already included.`);}
  else{await collectionsApi.create({title:title.trim(),overview:"",ordering:"release",members:refs});setResult(`${refs.length} titles added to ${title.trim()}.`);}
  await client.invalidateQueries({queryKey:["collections"]});onSaved?.();
 }catch(error){setError(String(error));}finally{setBusy(false);}};
 return <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4"><section ref={dialog} role="dialog" aria-modal="true" aria-labelledby="collection-picker-title" className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-border bg-sidebar p-6 shadow-xl"><h2 id="collection-picker-title" className="text-xl font-semibold">Add to collection</h2>{!result&&<p className="mt-1 text-sm text-muted">{uniqueMembers(members).length} selected titles</p>}{result?<><p role="status" className="my-5">{result}</p><button className="btn-secondary" onClick={onClose}>Done</button></>:<><label className="mt-4 block">Find collection<input disabled={busy} autoFocus value={search} onChange={event=>setSearch(event.target.value)} className="mt-1 w-full rounded border border-border bg-input p-2"/></label><div className="my-3 max-h-56 space-y-2 overflow-y-auto">{query.isPending&&<p role="status">Loading collections…</p>}{query.error&&<p role="alert">{String(query.error)}</p>}{[...(query.data??[])].sort((a,b)=>b.updated_at.localeCompare(a.updated_at)).filter(item=>item.title.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(item=><label key={item.id} className="flex cursor-pointer gap-3 rounded border border-border p-3"><input disabled={busy} type="radio" name="collection" checked={selected===item.id} onChange={()=>setSelected(item.id)}/><span>{item.title}<small className="ml-2 text-muted">{item.members.length} titles</small></span></label>)}</div><label className="flex gap-2"><input disabled={busy} type="radio" name="collection" checked={!selected} onChange={()=>setSelected("")}/>Create new collection</label>{!selected&&<label className="mt-3 block">Collection name<input disabled={busy} value={title} onChange={event=>setTitle(event.target.value)} className="mt-1 w-full rounded border border-border bg-input p-2"/></label>}{error&&<p role="alert" className="my-3 text-red-400">{error}</p>}<div className="mt-5 flex gap-3"><button className="btn-secondary" disabled={busy||(!selected&&!title.trim())} onClick={()=>void save()}>{busy?"Saving…":"Add titles"}</button><button className="btn-secondary" disabled={busy} onClick={onClose}>Cancel</button></div></>}</section></div>;
}
