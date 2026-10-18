import "./GlobalActivityStatus.css";
import {useState} from "react";
import {Link} from "react-router-dom";
import {ChevronLeft, ChevronRight, X} from "lucide-react";
import {useActivity, type ActivityItem} from "./ActivityContext";
import {useQueryClient} from "@tanstack/react-query";
import {durableJobs} from "../jobs/client";
import {useIsAdmin} from "../../lib/authContext";

function JobControl({item}:{item:ActivityItem}){
 const client=useQueryClient(),admin=useIsAdmin();
 const [pending,setPending]=useState(false),[error,setError]=useState(false);
 if(!admin||!item.jobId||!item.canCancel&&!item.canRetry&&!item.cancelling)return null;
 const action=async()=>{
  if(pending)return;setPending(true);setError(false);
  try{await (item.canCancel?durableJobs.cancel(item.jobId!):durableJobs.retry(item.jobId!));await client.invalidateQueries({queryKey:["durable-jobs"]});}
  catch{setError(true);}finally{setPending(false);}
 };
 return <div className="flex h-4 shrink-0 items-center gap-2 text-[10px]">
  <button type="button" disabled={pending||item.cancelling} onClick={()=>void action()} className="rounded border border-white/15 h-4 px-2 leading-none text-muted hover:text-white disabled:opacity-50">{pending?"Updating…":item.cancelling?"Stopping…":item.canCancel?"Cancel":"Retry"}</button>
  {error&&<span role="alert" className="truncate text-muted">Unable to update. Try again.</span>}
 </div>;
}

const finished = (item:ActivityItem) => !["running", "queued"].includes(item.state);
const percentage = (item:ActivityItem) => typeof item.progress === "number" && Number.isFinite(item.progress)
  ? Math.round(Math.max(0, Math.min(100, item.progress))) : null;
const stateLabel = (item:ActivityItem) => ({running:"In progress", queued:"Queued", completed:"Completed", failed:"Failed", warning:"Needs attention"})[item.state];

function ActivityRow({item, dismiss, showPercent=true}:{item:ActivityItem; dismiss:(id:string)=>void; showPercent?:boolean}) {
  const percent = percentage(item);
  const content = <><span className="block truncate text-xs leading-[14px] font-medium text-white" title={item.title}>{item.title}</span><span title={item.detail} className="block truncate text-[10px] leading-3 text-muted">{item.detail || stateLabel(item)}</span></>;
  const className = "block min-w-0 flex-1 rounded text-left focus-visible:outline-2 focus-visible:outline-accent";
  return <div className="flex h-full min-w-0 flex-col">
    <div className="flex min-w-0 items-start gap-1">
      {item.href?.startsWith("/") && !item.href.startsWith("//")
        ? <Link to={item.href} className={className}>{content}</Link>
        : item.event?.startsWith("posterview:")
          ? <button type="button" className={className} onClick={()=>window.dispatchEvent(new Event(item.event!))}>{content}</button>
          : <div className={className}>{content}</div>}
      {finished(item) && <button type="button" aria-label={`Dismiss ${item.title}`} onClick={()=>dismiss(item.id)} className="grid size-4 shrink-0 place-items-center rounded text-muted hover:bg-input-hover hover:text-white focus-visible:outline-2 focus-visible:outline-accent"><X size={13} aria-hidden="true"/></button>}
    </div>
    {item.jobId&&<JobControl item={item}/>}
    {showPercent && percent!==null && <span className="text-[10px] text-muted">{percent}%</span>}
    <div className="mt-auto h-1 shrink-0">{(percent!==null || item.state==="running") && <div role="progressbar" aria-label={item.title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent??undefined} className="h-1 overflow-hidden rounded-full bg-input"><div className={`h-full rounded-full bg-accent transition-[width] ${percent===null?"opacity-50":""}`} style={{width:percent===null?"30%":`${percent}%`}}/></div>}</div>
  </div>;
}

export default function GlobalActivityStatus() {
  const {items, dismiss, clearFinished} = useActivity();
  const [selectedId,setSelectedId]=useState<string|null>(null);
  const index=Math.max(0,items.findIndex(item=>item.id===selectedId));
  const first = items[index];
  const move=(offset:number)=>{if(items.length>1)setSelectedId(items[(index+offset+items.length)%items.length].id);};
  const percent = first ? percentage(first) : null;
  return <section aria-label="Activity status" className="pv-activity-status grid h-24 min-w-0 grid-rows-[16px_minmax(0,1fr)_18px] gap-y-0.5 rounded-xl border border-white/10 bg-transparent px-3 py-1.5" onKeyDown={event=>{if(items.length>1&&(event.key==="ArrowLeft"||event.key==="ArrowRight")){event.preventDefault();move(event.key==="ArrowLeft"?-1:1);}}}>
    <div className="flex h-4 shrink-0 items-center justify-between gap-1 text-xs font-semibold text-muted"><h2>Status</h2>{first&&<span className="min-w-0 truncate text-[10px] font-normal">{stateLabel(first)}</span>}{percent!==null && <span aria-hidden="true">{percent}%</span>}</div>
    <div className="min-h-0 flex-1 overflow-hidden">{!first?<p className="py-3 text-xs text-faint">No current activity</p>:<div className="flex h-full transition-transform duration-300 ease-out motion-reduce:transition-none" style={{transform:`translateX(-${index*100}%)`}}>{items.map((item,itemIndex)=><div key={item.id} aria-hidden={itemIndex!==index} inert={itemIndex!==index} className="h-full w-full min-w-0 shrink-0"><ActivityRow item={item} dismiss={dismiss} showPercent={false}/></div>)}</div>}</div>
    <div className="pv-activity-footer flex min-w-0 items-center justify-between gap-2">
     {items.some(finished)?<button type="button" onClick={clearFinished} className="rounded leading-3 text-[10px] text-muted hover:text-white focus-visible:outline-2 focus-visible:outline-accent">Clear finished</button>:<span/>}
     {items.length>1&&<div className="flex items-center gap-1"><button type="button" aria-label="Previous activity" onClick={()=>move(-1)} className="grid size-5 place-items-center rounded text-muted hover:text-white focus-visible:outline-2 focus-visible:outline-accent"><ChevronLeft size={15}/></button><span aria-live="polite" aria-atomic="true" className="whitespace-nowrap text-[10px] text-muted">{index+1} / {items.length}</span><button type="button" aria-label="Next activity" onClick={()=>move(1)} className="grid size-5 place-items-center rounded text-muted hover:text-white focus-visible:outline-2 focus-visible:outline-accent"><ChevronRight size={15}/></button></div>}
    </div>
  </section>;
}
