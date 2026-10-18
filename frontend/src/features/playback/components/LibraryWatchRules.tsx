import {useAutoSave} from "../../../lib/useAutoSave";
import {useEffect,useRef,useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {watchApi,type WatchRules} from "../api/watch";
export const defaultWatchRules:WatchRules={minimum_percentage:2,maximum_percentage:90,minimum_duration_seconds:120};
export function validWatchRules(rules:WatchRules) {
  return Object.values(rules).every(Number.isFinite)&&rules.minimum_percentage>=0&&rules.minimum_percentage<=100&&rules.maximum_percentage>=0&&rules.maximum_percentage<=100&&rules.minimum_percentage<rules.maximum_percentage&&rules.minimum_duration_seconds>=0&&rules.minimum_duration_seconds<=86400;
}
export default function LibraryWatchRules({library,draft,onDraftChange}:{library?:string;draft?:WatchRules;onDraftChange?:(rules:WatchRules)=>void}) {
  if(draft&&onDraftChange)return <div className="space-y-4"><WatchRuleFields settings={draft} onChange={onDraftChange}/><p className="text-xs text-muted">Playback rules are saved with the library.</p>{!validWatchRules(draft)&&<p role="alert" className="text-xs text-danger">Enter ordered percentages from 0 to 100 and a duration from 0 to 86400 seconds.</p>}</div>;
  return library?<SavedWatchRules library={library}/>:<p className="text-sm text-muted">Save the library first to configure resume and completion rules.</p>;
}
function WatchRuleFields({settings,onChange}:{settings:WatchRules;onChange:(rules:WatchRules)=>void}) {
  return <>{([
    ["minimum_percentage","Minimum resume percentage","Earlier stops do not appear in Continue Watching.",0,100],
    ["maximum_percentage","Maximum resume percentage","Completion threshold, subject to actual playback progress.",0,100],
    ["minimum_duration_seconds","Minimum resume duration (seconds)","Videos shorter than this total duration are not resumable.",0,86400],
  ] as const).map(([key,label,help,min,max])=><label key={key} className="block text-sm">{label}<input aria-label={label} type="number" min={min} max={max} value={settings[key]} className="mt-2 w-full rounded border border-border bg-input px-3 py-2 text-white" onChange={e=>onChange({...settings,[key]:Number(e.target.value)})}/><span className="mt-1 block text-xs text-muted">{help}</span></label>)}</>;
}
function SavedWatchRules({library}:{library:string}) {
  const query=useQuery({queryKey:["watch-rules",library],queryFn:()=>watchApi.rules(library!),enabled:!!library});
  const [settings,setSettings]=useState<WatchRules>();
  const hydrated=useRef(false);
  useEffect(()=>{if(query.data&&!hydrated.current){hydrated.current=true;setSettings(query.data);}},[query.data]);
  const autoSave=useAutoSave({value:settings,enabled:!!settings,save:async value=>{if(!value)return;if(!validWatchRules(value))throw new Error("Enter ordered percentages from 0 to 100 and a duration from 0 to 86400 seconds.");await watchApi.saveRules(library,value);}});
  if(!library)return <p className="text-sm text-muted">Save the library first to configure resume and completion rules.</p>;
  if(query.isError)return <p role="alert" className="text-sm text-danger">{query.error.message}</p>;
  if(!settings)return <p role="status" className="text-sm text-muted">Loading playback rules…</p>;
  return <div className="space-y-4"><WatchRuleFields settings={settings} onChange={setSettings}/>
  <p role="status" className="text-xs text-muted">{autoSave.status==="saved"?"Changes saved automatically":autoSave.status==="saving"?"Saving changes…":autoSave.status==="pending"?"Changes will save automatically…":"Changes save automatically"}</p>
  {autoSave.error&&<p role="alert" className="text-xs text-danger">{autoSave.error.message} <button type="button" onClick={autoSave.retry}>Retry</button></p>}</div>;
}
