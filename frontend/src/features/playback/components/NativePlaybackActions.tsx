import {useState} from "react";
import {useQuery,useQueryClient} from "@tanstack/react-query";
import {useLocation,useNavigate} from "react-router-dom";
import {Check,Play} from "lucide-react";
import {watchApi} from "../api/watch";

export default function NativePlaybackActions({library,item}:{library:string;item:string}) {
  const navigate=useNavigate(),location=useLocation(),client=useQueryClient();
  const state=useQuery({queryKey:["watch-state",library,item],queryFn:()=>watchApi.state(library,item),retry:false,staleTime:0});
  const [saving,setSaving]=useState(false),[error,setError]=useState("");
  const resume=!!state.data&&state.data.position_seconds>0;
  return <div className="mt-4 flex flex-wrap items-center gap-3">
    <button className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-black focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" onClick={()=>navigate(`/play/native/${encodeURIComponent(library)}/${encodeURIComponent(item)}?return=${encodeURIComponent(location.pathname+location.search)}`)}><Play className="size-5 fill-current"/>{resume?"Resume":"Play"}</button>
    <button disabled={saving||!state.data} aria-label={state.data?.watched?"Mark unplayed":"Mark played"} aria-pressed={state.data?.watched??false} title={state.data?.watched?"Mark unplayed":"Mark played"} className={`inline-flex size-11 items-center justify-center rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-40 ${state.data?.watched?"text-accent":"text-white"}`} onClick={async()=>{setSaving(true);setError("");try{const next=await watchApi.mark(library,item,!state.data?.watched);client.setQueryData(["watch-state",library,item],next);void client.invalidateQueries({queryKey:["continue-watching"]});void client.invalidateQueries({queryKey:["watch-library-states",library]});}catch(e){setError(e instanceof Error?e.message:"Could not update watch status.");}finally{setSaving(false);}}}><Check className="size-5"/></button>
    {resume&&<span className="text-xs text-muted">Resume from {Math.floor(state.data!.position_seconds/60)}:{String(Math.floor(state.data!.position_seconds%60)).padStart(2,"0")}</span>}
    {error&&<p role="alert" className="w-full text-sm text-danger">{error}</p>}
  </div>;
}
