import {useEffect,useState} from "react";
import {useMutation,useQuery,useQueryClient} from "@tanstack/react-query";
import {Link} from "react-router-dom";
import {Tv,X} from "lucide-react";
import PluginCard from "../../components/PluginCard";
import {virtualTv} from "./client";

export default function VirtualTvPlugin(){
 const [open,setOpen]=useState(false),client=useQueryClient();
 useEffect(()=>{if(!open)return;const close=(event:KeyboardEvent)=>{if(event.key==="Escape")setOpen(false);};window.addEventListener("keydown",close);return()=>window.removeEventListener("keydown",close);},[open]);
 const settings=useQuery({queryKey:["virtual-tv-settings"],queryFn:virtualTv.settings});
 const save=useMutation({mutationFn:virtualTv.saveSettings,onSuccess:value=>{client.setQueryData(["virtual-tv-settings"],value);void client.invalidateQueries({queryKey:["virtual-tv-channels"]});}});
 return <><PluginCard title="Virtual TV" description="Create shared channels and a TV guide from your native libraries." coverSrc="/plugins/virtual-tv-cover.svg" branding={<Tv className="size-12 text-accent"/>} status={settings.data?.enabled?"Enabled":"Disabled"} onClick={()=>setOpen(true)}/>{open&&<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={()=>setOpen(false)}><section role="dialog" aria-modal="true" aria-label="Virtual TV configuration" className="w-full max-w-lg rounded-xl border border-border bg-sidebar p-6" onClick={event=>event.stopPropagation()}><header className="mb-5 flex items-center justify-between"><h2 className="text-lg font-semibold">Virtual TV</h2><button aria-label="Close Virtual TV" onClick={()=>setOpen(false)}><X/></button></header><p className="mb-5 text-sm text-muted">Administrators manage shared channels. Viewers only see channels when they can access every source library.</p>{settings.data&&<label className="flex items-center gap-3"><input type="checkbox" checked={settings.data.enabled} disabled={save.isPending} onChange={event=>save.mutate({enabled:event.target.checked})}/>Enable Virtual TV</label>}{(settings.error||save.error)&&<p role="alert" className="mt-3 text-red-400">{String(settings.error||save.error)}</p>}<Link to="/virtual-tv" onClick={()=>setOpen(false)} className="mt-6 inline-block rounded-lg border border-border px-4 py-2">Manage channels and guide</Link></section></div>}</>;
}
