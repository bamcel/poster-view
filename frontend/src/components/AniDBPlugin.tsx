import {useAutoSave} from "../lib/useAutoSave";
import PluginCard from "./PluginCard";
import {useEffect,useRef,useState} from "react";
import {createPortal} from "react-dom";
import {useQuery,useMutation,useQueryClient} from "@tanstack/react-query";
import {Database,X} from "lucide-react";
import {apiRequest} from "../api/client";
type Settings={anidb_enabled?:boolean;anidb_client:string;anidb_client_version:string};
const query={queryKey:["native-provider-settings"],queryFn:()=>apiRequest<Settings>("/native/providers/settings")};
export default function AniDBPlugin(){
 const [open,setOpen]=useState(false);const settings=useQuery(query);
 return <><PluginCard title="AniDB" description="Anime metadata, provider IDs, credits, and artwork using your registered AniDB HTTP client." status={settings.data?.anidb_enabled===false?"Disabled · Saved settings kept":settings.data?.anidb_client&&settings.data.anidb_client_version?"Client credentials saved":"Configure client connection"} onClick={()=>setOpen(true)} bannerClassName="bg-gradient-to-br from-[#304d72] to-[#152334]" branding={<div className="flex items-center gap-3 text-white"><Database className="size-10"/><span className="text-4xl font-semibold">AniDB</span></div>}/>{open&&<AniDBPopup onClose={()=>setOpen(false)}/>}</>;
}
export function AniDBPopup({onClose}:{onClose:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null),client=useQueryClient();
 const initialized=useRef(false);
 const settings=useQuery(query);const [name,setName]=useState("");const [version,setVersion]=useState("");const [enabled,setEnabled]=useState(true);
 useEffect(()=>{dialog.current?.showModal();},[]);
 useEffect(()=>{if(settings.data&&!initialized.current){initialized.current=true;setEnabled(settings.data.anidb_enabled!==false);setName(settings.data.anidb_client);setVersion(settings.data.anidb_client_version);}},[settings.data]);
 const valid=!enabled||(!!name.trim()&&/^\d+$/.test(version)&&Number(version)>=1);
 const save=useAutoSave({value:{anidb_enabled:enabled,anidb_client:name.trim(),anidb_client_version:version.trim()},enabled:initialized.current,save:async draft=>{if(draft.anidb_enabled&&(!draft.anidb_client||!/^\d+$/.test(draft.anidb_client_version)||Number(draft.anidb_client_version)<1))throw new Error("Enter a client name and a positive numeric version to save changes.");const value=await apiRequest<Settings>("/native/providers/settings",{method:"PUT",body:JSON.stringify(draft)});client.setQueryData(query.queryKey,value);void client.invalidateQueries({queryKey:["artwork-providers"]});}});
 const test=useMutation({mutationFn:()=>apiRequest<{ok:boolean;message:string}>("/native/providers/test/anidb",{method:"POST"})});
 const busy=test.isPending;const dirty=enabled!==(settings.data?.anidb_enabled!==false)||save.status==="pending"||save.status==="saving"||name.trim()!==settings.data?.anidb_client||version.trim()!==settings.data?.anidb_client_version;
 return createPortal(<dialog ref={dialog} onCancel={onClose} aria-label="AniDB configuration" className="fixed inset-0 m-auto max-h-[85dvh] w-[min(36rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl border border-border bg-sidebar p-6 text-white shadow-2xl backdrop:bg-black/60">
 <header className="mb-6 flex items-center justify-between"><h2 className="text-lg font-semibold">AniDB</h2><button aria-label="Close AniDB" onClick={onClose} data-icon-button="true"><X className="size-5"/></button></header>
 <div className="space-y-5"><p className="text-sm text-muted">Connect your registered AniDB HTTP client name and numeric version. These are application credentials; an AniDB account password is not required.</p><a href="https://wiki.anidb.net/HTTP_API_Definition" target="_blank" rel="noreferrer" className="text-sm text-accent hover:underline">AniDB client registration and API setup</a>
 <label className="flex items-center justify-between text-sm">Enable AniDB<input type="checkbox" role="switch" aria-label="Enable AniDB" checked={enabled} disabled={busy||!settings.data} onChange={event=>{setEnabled(event.target.checked);test.reset();}}/></label><p className="text-xs text-muted">Disabling hides AniDB from Identify and pauses metadata and artwork requests. Saved credentials, IDs, and metadata remain.</p>
 <label className="block text-sm">Registered client name<input aria-label="AniDB registered client name" autoComplete="off" disabled={busy||!settings.data} value={name} onChange={event=>{setName(event.target.value);test.reset();}} className="mt-2 w-full rounded-lg border border-border bg-input px-3 py-2"/></label>
 <label className="block text-sm">Client version<input aria-label="AniDB client version" type="number" min={1} step={1} disabled={busy||!settings.data} value={version} onChange={event=>{setVersion(event.target.value);test.reset();}} className="mt-2 w-full rounded-lg border border-border bg-input px-3 py-2"/></label>
 <div className="flex flex-wrap gap-3"><button disabled={busy||dirty||!settings.data?.anidb_client||!settings.data.anidb_client_version} onClick={()=>test.mutate()} className="rounded-lg border border-border px-4 py-2 text-sm disabled:opacity-50">{test.isPending?"Testing…":"Test connection"}</button></div>
 {dirty&&<p className="text-xs text-muted">Changes must finish saving before testing. The test uses the saved client credentials.</p>}
 <p role="status" className="text-sm text-muted">{!valid?"Enter a client name and a positive numeric version to save changes.":save.status==="saved"?"Changes saved automatically":save.status==="saving"?"Saving changes…":save.status==="pending"?"Changes waiting to save…":"Changes save automatically."}</p>{save.status==="error"&&<button onClick={save.retry}>Retry saving</button>}
 {test.isPending&&<p role="status" className="text-sm text-muted">Testing AniDB connection…</p>}
 {test.data&&<p role={test.data.ok?"status":"alert"} className={`rounded-lg border p-3 text-sm ${test.data.ok?"border-accent/40 text-accent":"border-danger/40 text-danger"}`}>{test.data.message}</p>}
 {(settings.error||save.error||test.error)&&<p role="alert" className="text-sm text-danger">{(settings.error||save.error||test.error)?.message}</p>}
 <p className="text-xs text-muted">Enable AniDB in your anime library’s metadata providers. Requests are rate limited and cached. Episode lookup supports season 1 and specials; sequel seasons require separate anime identification. Existing client settings are preserved.</p>
 </div></dialog>,document.body);
}
