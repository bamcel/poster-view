import {mediaDescription} from "../../lib/mediaDescription";
import {ACTION_BUTTON} from "../../components/ui";
import PopupPage from "../../components/PopupPage";
import SearchField from "../../components/SearchField";
import {useEffect,useState} from "react";
import {useQueryClient} from "@tanstack/react-query";
import {collectionsApi,type Collection,type MetadataCandidate} from "./client";
import {useActivity} from "../activity/ActivityContext";
const button=ACTION_BUTTON;
const field="mt-1 w-full rounded border border-border bg-input p-2";
const fields=["title","overview","poster","backdrop"];
export default function CollectionMetadataDialog({collection,mode,onClose}:{collection:Collection;mode:"identify"|"refresh"|"locks";onClose:()=>void}){
 const client=useQueryClient(),{publish}=useActivity();
 const [searched,setSearched]=useState(false);
 const [provider,setProvider]=useState<"tmdb"|"tvdb">(collection.metadata?.provider==="tvdb"?"tvdb":"tmdb"),[query,setQuery]=useState(collection.title),[results,setResults]=useState<MetadataCandidate[]>([]),[preview,setPreview]=useState<Awaited<ReturnType<typeof collectionsApi.previewMetadata>>|null>(null),[locks,setLocks]=useState<string[]>(collection.metadata?.locks??[]),[addMembers,setAddMembers]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState("");
 const activity=(state:"running"|"completed"|"failed",detail:string)=>{if(mode==="locks")publish(`collection-metadata:${collection.id}`,[{id:collection.id,title:`${collection.title} field locks`,detail,state,adminOnly:true,href:`/collections/${encodeURIComponent(collection.id)}`,updatedAt:Date.now()}]);};
 const load=async(candidate:Pick<MetadataCandidate,"provider"|"provider_id">)=>{setBusy(true);setError("");try{setPreview(await collectionsApi.previewMetadata(collection.id,candidate));}catch{setError("Could not preview collection metadata. Please try again.");}finally{setBusy(false);}};
 useEffect(()=>{if(mode==="refresh"&&collection.metadata?.provider_id)void load({provider:collection.metadata.provider as "tmdb"|"tvdb",provider_id:collection.metadata.provider_id});},[]);
 const search=async()=>{setBusy(true);setError("");setPreview(null);try{setResults(await collectionsApi.searchMetadata(provider,query.trim()));setSearched(true);}catch{setError("Could not search this metadata provider. Please try again.");}finally{setBusy(false);}};
 const save=async()=>{setBusy(true);setError("");activity("running",mode==="locks"?"Saving field locks":"Applying collection metadata");try{
  if(mode==="locks")await collectionsApi.saveMetadataLocks(collection.id,{revision:collection.revision,locks});
  else if(preview)await collectionsApi.applyMetadata(collection.id,{revision:collection.revision,provider:preview.metadata.provider as "tmdb"|"tvdb",provider_id:preview.metadata.provider_id,locks,add_members:addMembers});
  else return;
  await client.invalidateQueries({queryKey:["collections"]});
  if(mode!=="locks")await client.invalidateQueries({queryKey:["durable-jobs"]});
  activity("completed","Field locks saved");onClose();
 }catch{setError("Could not save collection metadata. Refresh the collection and try again.");activity("failed","Collection metadata could not be updated");}finally{setBusy(false);}};
 return <PopupPage title={mode==="locks"?"Collection field locks":mode==="refresh"?"Refresh collection metadata":"Identify collection"} description={mode!=="locks"?"Uses the credentials configured in Search Providers. Locked fields retain their current values.":undefined} closeDisabled={busy} onClose={onClose} footer={<><button className={button} disabled={busy} onClick={onClose}>Cancel</button><button className={button} disabled={busy||(mode!=="locks"&&!preview)} onClick={()=>void save()}>{mode==="locks"?"Save locks":"Apply metadata"}</button></>}>
  {mode==="identify"&&<form className="mt-4 space-y-3" onSubmit={event=>{event.preventDefault();void search();}}><label className="block">Provider<select className={field} disabled={busy} value={provider} onChange={event=>{setProvider(event.target.value as "tmdb"|"tvdb");setResults([]);setPreview(null);setSearched(false);}}><option value="tmdb">TMDB</option><option value="tvdb">TVDB</option></select></label><label className="block">{provider==="tvdb"?"List name, slug, or ID":"Search collections"}<SearchField containerClassName="mt-1" disabled={busy} value={query} onChange={event=>setQuery(event.target.value)}/></label>{provider==="tvdb"&&<p className="text-sm text-muted">TVDB uses an exact list lookup. Names are converted to a list slug.</p>}<button className={button} disabled={busy||!query.trim()}>Search</button></form>}
  {mode==="refresh"&&!collection.metadata?.provider_id&&<p className="mt-3 text-muted">Identify this collection before refreshing its metadata.</p>}
  {mode==="identify"&&searched&&!results.length&&!busy&&<p className="mt-3 text-muted">No matching collections found.</p>}
  {mode!=="locks"&&results.length>0&&<ul className="mt-4 space-y-2">{results.map(candidate=><li key={`${candidate.provider}:${candidate.provider_id}`}><button className={`${button} w-full text-left`} disabled={busy} onClick={()=>void load(candidate)}>{candidate.title} <small className="text-muted">{candidate.provider.toUpperCase()} · {candidate.provider_id}</small></button></li>)}</ul>}
  {preview&&<div className="mt-4 space-y-3 rounded-lg border border-border p-4"><h3 className="font-semibold">{preview.metadata.title}</h3><p className="whitespace-pre-line text-sm text-muted">{mediaDescription(preview.metadata.overview)}</p><div className="flex gap-3">{preview.metadata.poster_url&&<img alt="Provider poster preview" src={preview.metadata.poster_url} className="h-32 rounded object-contain"/>}{preview.metadata.backdrop_url&&<img alt="Provider backdrop preview" src={preview.metadata.backdrop_url} className="h-32 min-w-0 rounded object-contain"/>}</div><p className="text-sm">{preview.matches.length} local matches · {preview.unmatched} unmatched provider titles</p><label className="flex gap-2 text-sm"><input type="checkbox" disabled={busy} checked={addMembers} onChange={event=>setAddMembers(event.target.checked)}/>Add matching local movies and series</label></div>}
  {preview&&preview.matches.length>0&&<details className="mt-3 text-sm"><summary className="cursor-pointer">Review matched library titles</summary><ul className="mt-2 max-h-40 overflow-y-auto rounded border border-border p-3">{preview.matches.map(member=><li key={`${member.library_id}:${member.item_id}`} className="py-1">{member.entry.title}<span className="ml-2 text-xs text-muted">{member.library_name}</span></li>)}</ul></details>}
  <fieldset className="mt-5"><legend className="font-medium">Locked fields</legend><p className="mt-1 text-sm text-muted">Locked fields keep their current values when metadata is applied.</p><div className="mt-2 flex flex-wrap gap-4">{fields.map(name=><label key={name} className="flex items-center gap-2 capitalize"><input type="checkbox" disabled={busy} checked={locks.includes(name)} onChange={event=>setLocks(previous=>event.target.checked?[...previous,name]:previous.filter(value=>value!==name))}/>{name}</label>)}</div></fieldset>
  {busy&&<p role="status" className="mt-3">Working…</p>}{error&&<p role="alert" className="mt-3 text-danger">{error}</p>}

 </PopupPage>;
}
