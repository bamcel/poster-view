import {useEffect,useRef} from "react";
import {useMutation,useQuery,useQueryClient} from "@tanstack/react-query";
import {createPortal} from "react-dom";
import {Server, X} from "lucide-react";
import {apiRequest,api} from "../api/client";
import {ServersSection} from "../pages/SettingsPage";
export interface PluginSettings {enabled:boolean;pinned:boolean}
export function useServerConnectPlugin(){return useQuery({queryKey:["plugin-server-connect"],queryFn:()=>apiRequest<PluginSettings>("/plugins/server-connect")});}
export function ServerConnectPopup({onClose}:{onClose:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null);
 const settings=useServerConnectPlugin();const client=useQueryClient();
 const save=useMutation({mutationFn:(value:PluginSettings)=>apiRequest<PluginSettings>("/plugins/server-connect",{method:"PUT",body:JSON.stringify(value)}),onSuccess:value=>client.setQueryData(["plugin-server-connect"],value)});
 useEffect(()=>{dialog.current?.showModal();},[]);
 return createPortal(<dialog ref={dialog} onCancel={onClose} onClick={event=>{if(event.target===event.currentTarget)onClose();}} aria-label="Server Connect configuration" className="fixed inset-0 m-auto max-h-[85dvh] w-[min(64rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl border border-border bg-sidebar p-6 text-white shadow-2xl backdrop:bg-black/60"><header className="mb-6 flex items-center justify-between"><h2 className="flex items-center gap-2 text-lg font-semibold"><Server className="size-5"/>Server Connect</h2><button aria-label="Close Server Connect" onClick={onClose} className="rounded-lg p-2 text-muted hover:bg-elevated"><X className="size-5"/></button></header>{settings.data&&<div className="mb-6 space-y-4 rounded-xl bg-window p-4">{([['enabled','Enable Server Connect'],['pinned','Pin to Settings']] as const).map(([key,label])=><label key={key} className="flex items-center justify-between text-sm"><span>{label}</span><input role="switch" aria-label={label} type="checkbox" disabled={save.isPending} checked={settings.data![key]} onChange={event=>save.mutate({...settings.data!,[key]:event.target.checked})} className="size-5 accent-accent"/></label>)}<p className="text-xs text-muted">Disabling pauses library metadata and artwork synchronization. Saved connections and mappings are preserved. Pinning only adds a Settings shortcut.</p></div>}{(settings.error||save.error)&&<p role="alert" className="mb-4 text-danger">{(settings.error||save.error)?.message}</p>}<ServersSection/></dialog>,document.body);
}
export default function PluginsPage({open=false,onOpen,onClose}:{open?:boolean;onOpen:()=>void;onClose:()=>void}){
 const plugin=useServerConnectPlugin();const servers=useQuery({queryKey:["servers"],queryFn:api.listServers});
 return <div className="h-full overflow-y-auto"><button onClick={onOpen} className="w-full max-w-sm rounded-2xl border border-border bg-window p-6 text-left transition-colors hover:border-accent focus-visible:outline-accent"><Server className="mb-4 size-9 text-accent"/><h2 className="text-lg font-semibold">Server Connect</h2><p className="mt-2 text-sm text-muted">Import and synchronize shared metadata and static artwork with connected media servers.</p><p className="mt-4 text-xs text-muted">Built-in · {plugin.data?plugin.data.enabled?"Enabled":"Disabled":"Loading…"} · {servers.data?.length??0} connections</p></button>{open&&<ServerConnectPopup onClose={onClose}/>}</div>;
}
