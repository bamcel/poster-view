import {mediaDescription} from "../../../lib/mediaDescription";
import {ACTION_BUTTON} from "../../../components/ui";
import {useEffect,useRef,useState} from "react";
import PopupPage from "../../../components/PopupPage";
import {useMutation,useQuery,useQueryClient} from "@tanstack/react-query";
import {Video} from "lucide-react";

import {useAutoSave} from "../../../lib/useAutoSave";
import PluginCard from "../../../components/PluginCard";
import {ytdl,type YtdlSettings} from "./client";
import YtdlSubscriptions from "./YtdlSubscriptions";
import {useDownloadJobs} from "./DownloadStatus";
import YtdlSettingsEditor,{invalidEncoding} from "./YtdlSettingsEditor";
import YtdlActivity from "./YtdlActivity";
import YtdlCookieSettings from "./YtdlCookieSettings";
const input="mt-2 w-full rounded-lg border border-border bg-input px-3 py-2 text-sm";
const button=ACTION_BUTTON;
const configKey=["plugin-ytdl"];
const active=(status:string)=>!["completed","completed_with_warnings","failed","cancelled","interrupted"].includes(status);
export default function YtdlPlugin(){
 const [open,setOpen]=useState(false);
 const config=useQuery({queryKey:configKey,queryFn:ytdl.configuration});
 return <><PluginCard title="YTDL" description="Download YouTube videos and playlists with local descriptions, artwork, and NFO metadata." coverSrc="/plugins/ytdl-cover.svg" branding={<Video className="size-12 text-red-500"/>} status={config.data?config.data.settings.enabled?"Enabled · Administrator downloads":"Disabled":"Configure YouTube downloads"} onClick={()=>setOpen(true)}/>{open&&<YtdlPopup onClose={()=>setOpen(false)}/>}</>;
}
export function YtdlPopup({onClose,initialTab="Download"}:{onClose:()=>void;initialTab?:string}){
 const client=useQueryClient();
 const config=useQuery({queryKey:configKey,queryFn:ytdl.configuration});
 const [draft,setDraft]=useState<YtdlSettings|null>(null),[override,setOverride]=useState<YtdlSettings|null>(null),[useOverride,setUseOverride]=useState(false);
 const [tab,setTab]=useState(({Queue:"Activity",Configuration:"Settings",Downloads:"Download"} as Record<string,string>)[initialTab]??initialTab),[url,setUrl]=useState(""),[selected,setSelected]=useState<string[]>([]),[operation,setOperation]=useState("download");

 const initialized=useRef(false);
 useEffect(()=>{if(config.data&&!initialized.current){initialized.current=true;setDraft({...config.data.settings,library_id:""});}},[config.data]);
 const jobs=useDownloadJobs(),restoredQueue=useRef(false);
 useEffect(()=>{if(!restoredQueue.current&&jobs.data){restoredQueue.current=true;if(jobs.data.some(job=>active(job.status)))setTab("Activity");}},[jobs.data]);
 const normalize=(value:YtdlSettings)=>({...value,subtitle_languages:value.subtitle_languages.map(value=>value.trim()).filter(Boolean)});
 const save=useAutoSave({value:draft,enabled:!!draft,save:async value=>{if(invalidEncoding(value!))throw new Error("Select a supported GPU video codec before changes can save.");const settings=await ytdl.save(normalize(value!));client.setQueryData(configKey,{...config.data!,settings});}});
 const effective=useOverride&&override?override:config.data?.settings;
 const inspect=useMutation({mutationFn:(source:string)=>ytdl.inspect(source.trim()),onSuccess:info=>setSelected(info.entries.map(entry=>entry.id))});
 const metadataOnly=operation==="metadata";
 const submit=useMutation({mutationFn:()=>ytdl.submit(url.trim(),metadataOnly&&inspect.data?.kind==="channel"?[]:selected,normalize(effective!),metadataOnly),onSuccess:()=>{void client.invalidateQueries({queryKey:["ytdl-jobs"]});setTab("Activity");}});
 const action=useMutation({mutationFn:({id,operation}:{id:string;operation:"cancel"|"retry"|"retry-failed"})=>ytdl.action(id,operation),onSuccess:()=>{void client.invalidateQueries({queryKey:["ytdl-jobs"]});}});
 const remove=useMutation({mutationFn:ytdl.remove,onSuccess:()=>{void client.invalidateQueries({queryKey:["ytdl-jobs"]});}});
 const error=config.error||save.error||inspect.error||submit.error||jobs.error||action.error||remove.error;
 const busy=submit.isPending||inspect.isPending;
 const canSubmit=!!effective?.enabled&&!!url.trim()&&!busy&&(metadataOnly?(!inspect.data||inspect.data.kind==="channel"||selected.length>0):!!inspect.data&&inspect.data.kind!=="channel"&&selected.length>0&&!invalidEncoding(effective));
 return <PopupPage title="YTDL" ariaLabel="YTDL configuration" closeLabel="Close YTDL" onClose={onClose} description="Administrator-only downloads. Jobs continue in the background when closed." navigation={<div className="flex flex-wrap gap-2">{["Download","Activity","Subscriptions","Settings"].map(name=><button key={name} aria-pressed={tab===name} className={`${button} ${tab===name?"text-accent":"text-muted"}`} onClick={()=>setTab(name)}>{name}</button>)}</div>} footer={<><p className="text-xs text-muted">{tab==="Settings"?"Valid changes save automatically.":tab==="Download"?"Configure media libraries separately in Library settings.":"Jobs continue in the background."}</p>{tab==="Download"?<button className={`${button} bg-accent text-black`} disabled={!canSubmit} onClick={()=>submit.mutate()}>{submit.isPending?"Queueing…":metadataOnly?"Refresh existing NFOs":`Download ${selected.length} selected`}</button>:<button className={button} onClick={onClose}>Done</button>}</>}>
 {config.isPending&&<p role="status">Loading configuration…</p>}
 {tab==="Subscriptions"&&<YtdlSubscriptions/>}
 {tab==="Activity"&&<YtdlActivity jobs={jobs.data??[]} loading={jobs.isPending} busy={action.isPending||remove.isPending} onRemove={id=>remove.mutate(id)} onAction={(id,operation)=>action.mutate({id,operation})}/>}
 {tab==="Settings"&&draft&&<div className="space-y-5"><p className="text-sm text-muted">Saved defaults apply to future downloads, metadata refreshes, and subscription checks. Queued jobs retain their original settings.</p><label className="flex justify-between text-sm">Enable YTDL<input aria-label="Enable YTDL" type="checkbox" checked={draft.enabled} onChange={event=>{setDraft({...draft,enabled:event.target.checked});}}/></label><YtdlSettingsEditor value={draft} onChange={value=>{setDraft(value);}} dependencies={config.data?.dependencies}/><p role="status" className="text-sm text-muted">{save.status==="saved"?"Changes saved automatically":save.status==="saving"?"Saving changes…":save.status==="pending"?"Changes waiting to save…":"Changes save automatically."}</p>{save.status==="error"&&<button className={button} onClick={save.retry}>Retry saving</button>}<YtdlCookieSettings/></div>}
 {tab==="Download"&&effective&&<div className="space-y-4"><label className="block text-sm">Operation<select aria-label="Operation" className={input} value={operation} onChange={event=>{setOperation(event.target.value);submit.reset();}}><option value="download">Download videos</option><option value="metadata">Refresh existing NFOs</option></select></label><label className="block text-sm">Video, playlist, or channel URL<input aria-label="YouTube URL" className={input} value={url} onChange={event=>{setUrl(event.target.value);inspect.reset();setSelected([]);submit.reset();}}/></label><button className={button} disabled={!url.trim()||busy||!effective.enabled} onClick={()=>inspect.mutate(url)}>{inspect.isPending?"Fetching info…":"Fetch Info"}</button>
 <div className="rounded-xl border border-border p-3 text-sm"><p>Destination: /media/{effective.directory}</p><p className="text-xs text-muted">Existing metadata: {effective.skip_existing_metadata!==false?"Skip valid NFOs":"Refresh and overwrite NFOs"}</p>{!metadataOnly&&<><p>{(effective.quality??effective.max_height)?`${effective.quality??effective.max_height}p`:"Highest Available"} · {effective.download_mode==="direct"?"Direct download · Source codecs":"Custom download"} · {effective.skip_existing?"Skip existing videos":"Check existing videos"}</p><p className="mt-1 text-xs text-muted">Using {useOverride?"overrides for this job":"saved defaults"}. Queued jobs retain their original settings.</p></>}{metadataOnly&&<p className="text-xs text-muted">Update NFO metadata for existing downloaded videos. Missing videos are skipped. Media and artwork are not downloaded or renamed. Fetch Info is optional for a whole channel.</p>}</div>
 <label className="flex items-center gap-2 text-sm"><input aria-label="Override for this job" type="checkbox" checked={useOverride} onChange={event=>{setUseOverride(event.target.checked);if(event.target.checked&&!override)setOverride({...config.data!.settings});}}/>Override for this job</label>{useOverride&&override&&<div className="rounded-xl border border-border p-4"><p className="mb-4 text-xs text-muted">These changes affect this job only and do not save defaults.</p><YtdlSettingsEditor value={override} onChange={setOverride} metadataOnly={metadataOnly}/></div>}
 {!metadataOnly&&invalidEncoding(effective)&&<p role="alert" className="text-sm text-danger">GPU encoding requires H.264, HEVC, or AV1. Change saved defaults or override this job.</p>}
 {inspect.data&&<><h3 className="font-semibold">{inspect.data.title}</h3><p className="text-sm text-muted">{inspect.data.channel}</p><p className="max-h-40 overflow-auto whitespace-pre-wrap text-sm text-muted">{mediaDescription(inspect.data.description)}</p>{inspect.data.formats.length>0&&<details><summary className="text-sm">Available source formats</summary><ul className="max-h-40 overflow-auto text-xs text-muted">{inspect.data.formats.map(format=><li key={format.format_id}>{format.height?`${format.height}p`:"Audio"} · {format.fps??"—"} fps · {format.vcodec} / {format.acodec} · {format.ext}</li>)}</ul></details>}<div className="flex gap-2"><button className={button} onClick={()=>setSelected(inspect.data!.entries.map(entry=>entry.id))}>Select all</button><button className={button} onClick={()=>setSelected([])}>Clear selection</button></div><ul className="max-h-80 divide-y divide-border overflow-auto">{inspect.data.entries.map((entry,index)=><li key={`${entry.id}-${index}`} className="py-3"><label className="flex items-start gap-3">{inspect.data!.kind==="channel"?<button aria-label={`Open playlist ${entry.title}`} className={button} onClick={()=>{setUrl(entry.url);inspect.mutate(entry.url);}}>Open playlist</button>:<input aria-label={`Select ${entry.title}`} type="checkbox" checked={selected.includes(entry.id)} onChange={event=>setSelected(previous=>event.target.checked?[...new Set([...previous,entry.id])]:previous.filter(id=>id!==entry.id))}/>}<span><span className="block text-sm">{entry.title}</span><span className="text-xs text-muted">{entry.playlist_title||entry.channel} · {entry.upload_date}{entry.duration!=null?` · ${Math.round(entry.duration/60)} min`:""}</span>{entry.description&&<span className="mt-1 line-clamp-2 block text-xs text-muted">{mediaDescription(entry.description)}</span>}</span></label></li>)}</ul></>}
 {!effective.enabled&&<p className="text-sm text-muted">Enable YTDL in Settings before inspecting or downloading.</p>}</div>}
 {error&&<p role="alert" className="mt-4 text-sm text-danger">{error.message}</p>}
 </PopupPage>;
}
