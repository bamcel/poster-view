import {useEffect,useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {apiRequest} from "../api/client";
type Settings={hardware_enabled:boolean;hardware_backend:string;preferred_encoder:string;allow_hevc:boolean;allow_av1:boolean;software_fallback:boolean;max_resolution:number;max_concurrent:number;threads:number;temporary_path:string;cache_gb:number;throttle:boolean;buffer_seconds:number;subtitle_extraction:boolean;font_extraction:boolean;audio_boost:number};
const input="mt-2 w-full rounded-lg border border-border bg-input px-3 py-2 text-sm";
export default function TranscodingSettings(){
 const [testHardware,setTestHardware]=useState(false);
 const hardware=useQuery({queryKey:["playback-hardware"],queryFn:()=>apiRequest<{encoders:{name:string;backend:string;codec:string;available:boolean;detail:string}[]}>("/playback/capabilities"),enabled:testHardware,retry:false,staleTime:0});
 const query=useQuery({queryKey:["transcoding-settings"],queryFn:()=>apiRequest<Settings>("/transcoding/settings")});
 const [settings,setSettings]=useState<Settings>();const [saving,setSaving]=useState(false);const [message,setMessage]=useState("");const [error,setError]=useState("");
 useEffect(()=>{if(query.data)setSettings(query.data);},[query.data]);
 if(query.isError)return <p role="alert" className="text-danger">{query.error.message}</p>;
 if(!settings)return <p className="text-muted">Loading transcoding settings…</p>;
 const set=<K extends keyof Settings>(key:K,value:Settings[K])=>{setSettings({...settings,[key]:value});setMessage("");setError("");};
 const toggle=(key:keyof Settings,label:string,help:string)=><label className="flex items-start justify-between gap-6 py-3"><span><span className="block text-sm font-medium">{label}</span><span className="mt-1 block text-xs text-muted">{help}</span></span><input type="checkbox" role="switch" aria-label={label} checked={Boolean(settings[key])} onChange={e=>{const next={...settings,[key]:e.target.checked};if((key==="allow_hevc"&&settings.preferred_encoder==="hevc"||key==="allow_av1"&&settings.preferred_encoder==="av1")&&!e.target.checked)next.preferred_encoder="avc";setSettings(next);setMessage("");}} className="mt-1 accent-accent"/></label>;
 const number=(key:keyof Settings,label:string,min:number,max:number,help?:string)=><label className="block text-sm">{label}<input type="number" min={min} max={max} step={key==="audio_boost"?.1:1} value={Number(settings[key])} onChange={e=>set(key,Number(e.target.value) as never)} className={input}/>{help&&<span className="mt-1 block text-xs text-muted">{help}</span>}</label>;
 return <form className="max-w-3xl space-y-6" onSubmit={async e=>{e.preventDefault();setSaving(true);setError("");try{const saved=await apiRequest<Settings>("/transcoding/settings",{method:"PUT",body:JSON.stringify(settings)});setSettings(saved);setMessage("Transcoding settings saved.");}catch(e){setError(e instanceof Error?e.message:"Could not save settings.");}finally{setSaving(false);}}}>
 <p role="status" className="rounded-xl border border-border bg-surface p-4 text-sm text-muted">Compatible files play directly. These settings control conversion only when required by the browser, selected tracks, or quality limit.</p>
 <fieldset className="rounded-xl border border-border p-5"><legend className="px-2 font-semibold">Hardware acceleration</legend>
 {toggle("hardware_enabled","Enable hardware transcoding when available","Use a compatible GPU when the playback engine confirms that it is usable.")}
 <label className="block text-sm">Hardware backend<select className={input} value={settings.hardware_backend} disabled={!settings.hardware_enabled} onChange={e=>set("hardware_backend",e.target.value)}><option value="auto">Automatic</option><option value="qsv">Intel Quick Sync (QSV)</option><option value="vaapi">VA-API (Intel / AMD on Linux)</option><option value="nvenc">NVIDIA NVENC</option></select></label>
 <p className="mt-2 text-xs text-muted">Unraid must expose the selected GPU to the container. Selecting a backend does not verify driver or device access.</p>
 {toggle("software_fallback","Allow software encoding fallback","Permit CPU encoding when hardware encoding cannot be used.")}
 <button type="button" disabled={hardware.isFetching} className="mt-2 rounded-full border border-border px-4 py-2 text-sm disabled:opacity-50" onClick={()=>{if(testHardware)void hardware.refetch();else setTestHardware(true);}}>{hardware.isFetching?"Testing hardware encoders…":"Test hardware encoders"}</button>
 {hardware.error&&<p role="alert" className="mt-3 text-sm text-danger">{hardware.error.message}</p>}
 {hardware.data&&<div className="mt-4 space-y-2" aria-label="Hardware encoder results">{hardware.data.encoders.map(encoder=><div key={encoder.name} className="flex items-center justify-between gap-4 rounded-lg bg-white/5 px-3 py-2 text-sm"><span>{encoder.name}<span className="ml-2 text-xs text-muted">{encoder.codec.toUpperCase()}</span></span><span className={encoder.available?"text-accent":"text-muted"}>{encoder.available?"Test passed":"Unavailable"}</span></div>)}<p className="text-xs text-muted">Each result comes from a small real encode. Full-file decoding, filtering, and tone mapping can have additional requirements. Results are cached for five minutes.</p></div>}
 </fieldset>
 <fieldset className="rounded-xl border border-border p-5"><legend className="px-2 font-semibold">Video encoders</legend>
 <p className="text-sm text-muted">AVC (H.264) is always allowed as the compatibility encoder. Codec preference applies only when transcoding is needed; original compatible video should direct play.</p>
 {toggle("allow_hevc","Allow HEVC (H.265) encoding","Use only when both the encoder and client support HEVC.")}
 {toggle("allow_av1","Allow AV1 encoding","Requires a compatible encoder and client. Not every GPU supports AV1 encoding.")}
 <label className="block text-sm">Preferred encoder<select className={input} value={settings.preferred_encoder} onChange={e=>set("preferred_encoder",e.target.value)}><option value="avc">AVC (H.264)</option><option value="hevc" disabled={!settings.allow_hevc}>HEVC (H.265)</option><option value="av1" disabled={!settings.allow_av1}>AV1</option></select></label>
 <label className="mt-4 block text-sm">Maximum transcoding resolution<select className={input} value={settings.max_resolution} onChange={e=>set("max_resolution",Number(e.target.value))}>{[[0,"No limit"],[2160,"4K / 2160p"],[1080,"1080p"],[720,"720p"],[480,"480p"]].map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label></fieldset>
 <fieldset className="space-y-4 rounded-xl border border-border p-5"><legend className="px-2 font-semibold">Resources and temporary storage</legend>
 <label className="block text-sm">Transcoding temporary path<input className={input} value={settings.temporary_path} placeholder="Default server temporary directory" onChange={e=>set("temporary_path",e.target.value)}/><span className="mt-1 block text-xs text-muted">Absolute path inside the container. An SSD-backed directory is recommended. Saving does not create or delete files.</span></label>
 <div className="grid gap-4 sm:grid-cols-2">{number("max_concurrent","Maximum concurrent transcodes",1,16)}{number("threads","Software encoding threads",0,128,"0 lets the encoder choose.")}{number("cache_gb","Temporary storage limit (GB)",1,1024)}{number("buffer_seconds","Encode-ahead buffer (seconds)",10,600)}</div>
 {toggle("throttle","Enable transcoding throttling","Limit encoding ahead of playback to reduce sustained server load.")}</fieldset>
 <fieldset className="rounded-xl border border-border p-5"><legend className="px-2 font-semibold">Subtitles and audio</legend>
 {toggle("subtitle_extraction","Allow subtitle extraction","Extract compatible subtitle tracks to avoid burning them into video.")}
 {toggle("font_extraction","Allow embedded font extraction","Preserve fonts used by styled ASS / SSA subtitles.")}
 {number("audio_boost","Audio boost when downmixing",1,4,"1 preserves original volume. Larger values may cause clipping.")}</fieldset>
 {error&&<p role="alert" className="text-sm text-danger">{error}</p>}{message&&<p role="status" className="text-sm text-accent">{message}</p>}
 <button disabled={saving} className="rounded-lg bg-accent px-5 py-2 text-sm font-medium text-black disabled:opacity-50">{saving?"Saving…":"Save configuration"}</button>
 </form>;
}
