import {useRef,useState} from "react";
import {useMutation,useQuery,useQueryClient} from "@tanstack/react-query";
import {Link} from "react-router-dom";
import {Scale} from "lucide-react";
import PluginCard from "../../components/PluginCard";
import PopupPage from "../../components/PopupPage";
import {ACTION_BUTTON,Switch} from "../../components/ui";
import {pairwise} from "./client";

export default function PairwisePlugin(){
 const [open,setOpen]=useState(false),client=useQueryClient();
 const saving=useRef(false);
 const settings=useQuery({queryKey:["pairwise-settings"],queryFn:pairwise.settings});
 const save=useMutation({mutationFn:pairwise.saveSettings,onSuccess:value=>{client.setQueryData(["pairwise-settings"],value);void client.invalidateQueries({queryKey:["pairwise-libraries"]});}});
 return <><PluginCard title="PairWise Ranking" description="Build personal movie and series rankings by comparing two titles at a time." branding={<Scale className="size-16 text-accent"/>} status={settings.data?.enabled?"Enabled":"Disabled"} onClick={()=>setOpen(true)}/>{open&&<PopupPage title="PairWise Ranking configuration" description="Each user has private rankings for libraries they can access." closeDisabled={save.isPending} onClose={()=>setOpen(false)} footer={<button className={ACTION_BUTTON} disabled={save.isPending} onClick={()=>setOpen(false)}>Done</button>}>{settings.data&&<div className="flex items-center justify-between gap-4"><span>Enable PairWise Ranking</span><Switch label="Enable PairWise Ranking" checked={settings.data.enabled} disabled={save.isPending} onChange={()=>{if(saving.current)return;saving.current=true;save.mutate({enabled:!settings.data.enabled},{onSettled:()=>{saving.current=false;}});}}/></div>}{save.isPending&&<p role="status">Saving changes…</p>}{save.isSuccess&&<p role="status" className="mt-3 text-sm text-muted">Changes saved automatically</p>}{(settings.error||save.error)&&<p role="alert" className="mt-3 text-danger">{String(settings.error||save.error)}</p>}<Link className={`${ACTION_BUTTON} mt-6`} to="/rankings" onClick={()=>setOpen(false)}>Open personal rankings</Link></PopupPage>}</>;
}
