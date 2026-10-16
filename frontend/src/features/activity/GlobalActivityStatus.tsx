import {useState} from "react";
import {Link} from "react-router-dom";
import {ChevronLeft, ChevronRight, X} from "lucide-react";
import {useActivity, type ActivityItem} from "./ActivityContext";

const finished = (item:ActivityItem) => !["running", "queued"].includes(item.state);
const percentage = (item:ActivityItem) => typeof item.progress === "number" && Number.isFinite(item.progress)
  ? Math.round(Math.max(0, Math.min(100, item.progress))) : null;
const stateLabel = (item:ActivityItem) => ({running:"In progress", queued:"Queued", completed:"Completed", failed:"Failed", warning:"Needs attention"})[item.state];

function ActivityRow({item, dismiss, showPercent=true}:{item:ActivityItem; dismiss:(id:string)=>void; showPercent?:boolean}) {
  const percent = percentage(item);
  const content = <><span className="block truncate text-xs font-medium text-white" title={item.title}>{item.title}</span><span title={item.detail} className="mt-1 line-clamp-2 break-words text-[11px] leading-relaxed text-muted">{item.detail || stateLabel(item)}</span></>;
  const className = "block min-w-0 flex-1 rounded text-left focus-visible:outline-2 focus-visible:outline-accent";
  return <div className="flex h-full min-w-0 flex-col py-2">
    <div className="flex items-start gap-2">
      {item.href?.startsWith("/") && !item.href.startsWith("//")
        ? <Link to={item.href} className={className}>{content}</Link>
        : item.event?.startsWith("posterview:")
          ? <button type="button" className={className} onClick={()=>window.dispatchEvent(new Event(item.event!))}>{content}</button>
          : <div className={className}>{content}</div>}
      {finished(item) && <button type="button" aria-label={`Dismiss ${item.title}`} onClick={()=>dismiss(item.id)} className="grid size-6 shrink-0 place-items-center rounded text-muted hover:bg-input-hover hover:text-white focus-visible:outline-2 focus-visible:outline-accent"><X size={13} aria-hidden="true"/></button>}
    </div>
    <div className="mt-auto flex items-center justify-between gap-2 pt-2 text-[10px] text-muted"><span>{stateLabel(item)}</span>{showPercent && percent!==null && <span>{percent}%</span>}</div>
    <div className="mt-1 h-1 shrink-0">{(percent!==null || item.state==="running") && <div role="progressbar" aria-label={item.title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent??undefined} className="h-1 overflow-hidden rounded-full bg-input"><div className={`h-full rounded-full bg-accent transition-[width] ${percent===null?"opacity-50":""}`} style={{width:percent===null?"30%":`${percent}%`}}/></div>}</div>
  </div>;
}

export default function GlobalActivityStatus() {
  const {items, dismiss, clearFinished} = useActivity();
  const [selectedId,setSelectedId]=useState<string|null>(null);
  const index=Math.max(0,items.findIndex(item=>item.id===selectedId));
  const first = items[index];
  const move=(offset:number)=>{if(items.length>1)setSelectedId(items[(index+offset+items.length)%items.length].id);};
  const percent = first ? percentage(first) : null;
  return <section aria-label="Activity status" className="flex h-48 min-w-0 flex-col rounded-xl border border-white/10 bg-black/10 px-3 py-2" onKeyDown={event=>{if(items.length>1&&(event.key==="ArrowLeft"||event.key==="ArrowRight")){event.preventDefault();move(event.key==="ArrowLeft"?-1:1);}}}>
    <div className="flex items-center justify-between gap-2 text-xs font-semibold text-muted"><h2>Status</h2>{percent!==null && <span aria-hidden="true">{percent}%</span>}</div>
    <div className="min-h-0 flex-1 overflow-hidden">{!first?<p className="py-3 text-xs text-faint">No current activity</p>:<div className="flex h-full transition-transform duration-300 ease-out motion-reduce:transition-none" style={{transform:`translateX(-${index*100}%)`}}>{items.map((item,itemIndex)=><div key={item.id} aria-hidden={itemIndex!==index} inert={itemIndex!==index} className="h-full w-full min-w-0 shrink-0"><ActivityRow item={item} dismiss={dismiss} showPercent={false}/></div>)}</div>}</div>
    <div className="flex h-7 shrink-0 items-center justify-between gap-1">
     {items.some(finished)?<button type="button" onClick={clearFinished} className="rounded py-1 text-[10px] text-muted hover:text-white focus-visible:outline-2 focus-visible:outline-accent">Clear finished</button>:<span/>}
     {items.length>1&&<div className="flex items-center gap-1"><button type="button" aria-label="Previous activity" onClick={()=>move(-1)} className="grid size-7 place-items-center rounded text-muted hover:text-white focus-visible:outline-2 focus-visible:outline-accent"><ChevronLeft size={15}/></button><span aria-live="polite" aria-atomic="true" className="whitespace-nowrap text-[10px] text-muted">{index+1} / {items.length}</span><button type="button" aria-label="Next activity" onClick={()=>move(1)} className="grid size-7 place-items-center rounded text-muted hover:text-white focus-visible:outline-2 focus-visible:outline-accent"><ChevronRight size={15}/></button></div>}
    </div>
  </section>;
}
