import {useEffect,useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {watchApi,type WatchRules} from "../api/watch";
export default function LibraryWatchRules({library}:{library?:string}) {
  return library?<SavedWatchRules library={library}/>:<p className="text-sm text-muted">Save the library first to configure resume and completion rules.</p>;
}
function SavedWatchRules({library}:{library:string}) {
  const query=useQuery({queryKey:["watch-rules",library],queryFn:()=>watchApi.rules(library!),enabled:!!library});
  const [settings,setSettings]=useState<WatchRules>(),[message,setMessage]=useState(""),[error,setError]=useState(""),[saving,setSaving]=useState(false);
  useEffect(()=>{setSettings(query.data);},[query.data]);
  if(!library)return <p className="text-sm text-muted">Save the library first to configure resume and completion rules.</p>;
  if(query.isError)return <p role="alert" className="text-sm text-danger">{query.error.message}</p>;
  if(!settings)return <p role="status" className="text-sm text-muted">Loading playback rules…</p>;
  return <div className="space-y-4">{([
    ["minimum_percentage","Minimum resume percentage","Earlier stops do not appear in Continue Watching.",0,50],
    ["maximum_percentage","Maximum resume percentage","Completion threshold, subject to actual playback progress.",50,100],
    ["minimum_duration_seconds","Minimum resume duration (seconds)","Videos shorter than this total duration are not resumable.",0,86400],
  ] as const).map(([key,label,help,min,max])=><label key={key} className="block text-sm">{label}<input aria-label={label} type="number" min={min} max={max} value={settings[key]} className="mt-2 w-full rounded border border-border bg-input px-3 py-2 text-white" onChange={e=>{setSettings({...settings,[key]:Number(e.target.value)});setMessage("");}}/><span className="mt-1 block text-xs text-muted">{help}</span></label>)}
  <button type="button" disabled={saving} className="rounded-full border border-border bg-input px-4 py-2 text-sm disabled:opacity-40" onClick={async()=>{setSaving(true);setError("");try{setSettings(await watchApi.saveRules(library,settings));setMessage("Playback rules saved.");}catch(e){setError(e instanceof Error?e.message:"Could not save playback rules.");}finally{setSaving(false);}}}>{saving?"Saving…":"Save playback rules"}</button>
  {message&&<p role="status" className="text-xs text-accent">{message}</p>}{error&&<p role="alert" className="text-xs text-danger">{error}</p>}</div>;
}
