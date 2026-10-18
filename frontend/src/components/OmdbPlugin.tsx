import AutoSaveStatus from "./AutoSaveStatus";
import PluginCard from "./PluginCard";
import NativeProviderCredentials from "./NativeProviderCredentials";
import {useState} from "react";
import PopupPage from "./PopupPage";
import {ACTION_BUTTON} from "./ui";
import {useQuery,useMutation,useQueryClient} from "@tanstack/react-query";
import {Database} from "lucide-react";
import {apiRequest} from "../api/client";
type Settings={omdb_enabled:boolean;omdb_configured:boolean};
export default function OmdbPlugin(){
 const [open,setOpen]=useState(false);
 const client=useQueryClient();
 const settings=useQuery({queryKey:["native-provider-settings"],queryFn:()=>apiRequest<Settings>("/native/providers/settings")});
 const save=useMutation({mutationFn:(enabled:boolean)=>apiRequest<Settings>("/native/providers/settings",{method:"PUT",body:JSON.stringify({omdb_enabled:enabled})}),onSuccess:value=>{client.setQueryData(["native-provider-settings"],value);void client.invalidateQueries({queryKey:["artwork-providers"]});}});
 return <><PluginCard title="The Open Movie Database" description="Optional movie, TV series, and episode metadata and poster images through OMDb." coverSrc="/plugins/omdb-cover.svg" branding={<Database className="size-10 text-accent"/>} status={settings.data?.omdb_enabled?"Enabled":"Disabled"} onClick={()=>setOpen(true)}/>{open&&<Popup onClose={()=>setOpen(false)}><label className="mb-6 flex items-center justify-between gap-4 text-sm">Enable OMDb<input type="checkbox" role="switch" aria-label="Enable OMDb" checked={settings.data?.omdb_enabled===true} disabled={!settings.data||save.isPending} onChange={event=>save.mutate(event.target.checked)}/></label><p className="mb-5 text-xs text-muted">Disabling hides OMDb from provider settings and stops its metadata and artwork requests. Saved credentials and existing metadata are kept.</p>{settings.data?.omdb_enabled&&<NativeProviderCredentials providerOnly="omdb"/>}<AutoSaveStatus status={save.isPending?"saving":save.isError?"error":save.isSuccess?"saved":"idle"} error={save.error}/></Popup>}</>;
}
function Popup({onClose,children}:{onClose:()=>void;children:React.ReactNode}){
 return <PopupPage title="The Open Movie Database" ariaLabel="OMDb configuration" closeLabel="Close OMDb" onClose={onClose} footer={<button className={ACTION_BUTTON} onClick={onClose}>Done</button>}>{children}</PopupPage>;
}
