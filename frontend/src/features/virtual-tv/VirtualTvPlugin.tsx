import PopupPage from "../../components/PopupPage";
import {ACTION_BUTTON} from "../../components/ui";
import {useState} from "react";
import {useMutation,useQuery,useQueryClient} from "@tanstack/react-query";
import {Link} from "react-router-dom";
import {Tv} from "lucide-react";
import PluginCard from "../../components/PluginCard";
import {virtualTv} from "./client";

export default function VirtualTvPlugin(){
 const [open,setOpen]=useState(false),client=useQueryClient();
 const settings=useQuery({queryKey:["virtual-tv-settings"],queryFn:virtualTv.settings});
 const save=useMutation({mutationFn:virtualTv.saveSettings,onSuccess:value=>{client.setQueryData(["virtual-tv-settings"],value);void client.invalidateQueries({queryKey:["virtual-tv-channels"]});}});
 return <><PluginCard title="Virtual TV" description="Create shared channels and a TV guide from your native libraries." coverSrc="/plugins/virtual-tv-cover.svg" branding={<Tv className="size-12 text-accent"/>} status={settings.data?.enabled?"Enabled":"Disabled"} onClick={()=>setOpen(true)}/>{open&&<PopupPage title="Virtual TV configuration" description="Administrators manage shared channels. Viewers only see channels when they can access every source library." closeDisabled={save.isPending} onClose={()=>setOpen(false)} footer={<button className={ACTION_BUTTON} disabled={save.isPending} onClick={()=>setOpen(false)}>Done</button>}>{settings.data&&<label className="flex items-center gap-3"><input type="checkbox" checked={settings.data.enabled} disabled={save.isPending} onChange={event=>save.mutate({enabled:event.target.checked})}/>Enable Virtual TV</label>}{save.isPending&&<p role="status" className="mt-3 text-xs text-muted">Saving changes…</p>}{save.isSuccess&&<p role="status" className="mt-3 text-xs text-muted">Changes saved automatically</p>}{(settings.error||save.error)&&<p role="alert" className="mt-3 text-red-400">{String(settings.error||save.error)}</p>}<Link to="/virtual-tv" onClick={()=>setOpen(false)} className={`${ACTION_BUTTON} mt-6 inline-block`}>Manage channels and guide</Link></PopupPage>}</>;
}
