import PluginCard from "./PluginCard";
import NativeProviderCredentials from "./NativeProviderCredentials";
import {useEffect,useRef,useState} from "react";
import {createPortal} from "react-dom";
import {useQuery,useMutation,useQueryClient} from "@tanstack/react-query";
import {Database,X} from "lucide-react";
import {apiRequest} from "../api/client";
type Settings={omdb_enabled:boolean;omdb_configured:boolean};
export default function OmdbPlugin(){
 const [open,setOpen]=useState(false);
 const client=useQueryClient();
 const settings=useQuery({queryKey:["native-provider-settings"],queryFn:()=>apiRequest<Settings>("/native/providers/settings")});
 const save=useMutation({mutationFn:(enabled:boolean)=>apiRequest<Settings>("/native/providers/settings",{method:"PUT",body:JSON.stringify({omdb_enabled:enabled})}),onSuccess:value=>{client.setQueryData(["native-provider-settings"],value);void client.invalidateQueries({queryKey:["artwork-providers"]});}});
 return <><PluginCard title="The Open Movie Database" description="Optional movie, TV series, and episode metadata and poster images through OMDb." coverSrc="/plugins/omdb-cover.svg" branding={<Database className="size-10 text-accent"/>} status={settings.data?.omdb_enabled?"Enabled":"Disabled"} onClick={()=>setOpen(true)}/>{open&&<Popup onClose={()=>setOpen(false)}><label className="mb-6 flex items-center justify-between gap-4 text-sm">Enable OMDb<input type="checkbox" role="switch" aria-label="Enable OMDb" checked={settings.data?.omdb_enabled===true} disabled={!settings.data||save.isPending} onChange={event=>save.mutate(event.target.checked)}/></label><p className="mb-5 text-xs text-muted">Disabling hides OMDb from provider settings and stops its metadata and artwork requests. Saved credentials and existing metadata are kept.</p>{settings.data?.omdb_enabled&&<NativeProviderCredentials providerOnly="omdb"/>}{save.error&&<p role="alert">{save.error.message}</p>}</Popup>}</>;
}
function Popup({onClose,children}:{onClose:()=>void;children:React.ReactNode}){
 const ref=useRef<HTMLDialogElement>(null);useEffect(()=>{ref.current?.showModal();return()=>ref.current?.close();},[]);
 return createPortal(<dialog ref={ref} onCancel={onClose} aria-label="OMDb configuration" className="m-auto max-h-[85dvh] w-[min(36rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl border border-border bg-sidebar p-6 text-white backdrop:bg-black/60"><header className="mb-6 flex items-center justify-between"><h2 className="text-lg font-semibold">The Open Movie Database</h2><button aria-label="Close OMDb" data-icon-button="true" onClick={onClose}><X className="size-4"/></button></header>{children}</dialog>,document.body);
}
