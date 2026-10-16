import {useId, useState} from "react";
import {Link} from "react-router-dom";
import {ChevronDown, X} from "lucide-react";
import {useActivity, type ActivityItem} from "./ActivityContext";

const finished = (item:ActivityItem) => !["running", "queued"].includes(item.state);
const percentage = (item:ActivityItem) => typeof item.progress === "number" && Number.isFinite(item.progress)
  ? Math.round(Math.max(0, Math.min(100, item.progress))) : null;
const stateLabel = (item:ActivityItem) => ({running:"In progress", queued:"Queued", completed:"Completed", failed:"Failed", warning:"Needs attention"})[item.state];

function ActivityRow({item, dismiss, showPercent=true}:{item:ActivityItem; dismiss:(id:string)=>void; showPercent?:boolean}) {
  const percent = percentage(item);
  const content = <><span className="block truncate text-xs font-medium text-white" title={item.title}>{item.title}</span><span className="mt-1 block break-words text-[11px] leading-relaxed text-muted">{item.detail || stateLabel(item)}</span></>;
  const className = "block min-w-0 flex-1 rounded text-left focus-visible:outline-2 focus-visible:outline-accent";
  return <div className="min-w-0 py-2">
    <div className="flex items-start gap-2">
      {item.href?.startsWith("/") && !item.href.startsWith("//")
        ? <Link to={item.href} className={className}>{content}</Link>
        : item.event?.startsWith("posterview:")
          ? <button type="button" className={className} onClick={()=>window.dispatchEvent(new Event(item.event!))}>{content}</button>
          : <div className={className}>{content}</div>}
      {finished(item) && <button type="button" aria-label={`Dismiss ${item.title}`} onClick={()=>dismiss(item.id)} className="grid size-6 shrink-0 place-items-center rounded text-muted hover:bg-input-hover hover:text-white focus-visible:outline-2 focus-visible:outline-accent"><X size={13} aria-hidden="true"/></button>}
    </div>
    <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-muted"><span>{stateLabel(item)}</span>{showPercent && percent!==null && <span>{percent}%</span>}</div>
    {(percent!==null || item.state==="running") && <div role="progressbar" aria-label={item.title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent??undefined} className="mt-1 h-1 overflow-hidden rounded-full bg-input"><div className={`h-full rounded-full bg-accent transition-[width] ${percent===null?"opacity-50":""}`} style={{width:percent===null?"30%":`${percent}%`}}/></div>}
  </div>;
}

export default function GlobalActivityStatus() {
  const {items, dismiss, clearFinished} = useActivity();
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const first = items[0];
  const percent = first ? percentage(first) : null;
  return <section aria-label="Activity status" className="min-w-0 rounded-xl border border-white/10 bg-black/10 px-3 py-2">
    <div className="flex items-center justify-between gap-2 text-xs font-semibold text-muted"><h2>Status</h2>{percent!==null && <span aria-hidden="true">{percent}%</span>}</div>
    {!first ? <p className="py-3 text-xs text-faint">No current activity</p> : <ActivityRow item={first} dismiss={dismiss} showPercent={false}/>}
    {items.length>1 && <>
      <button type="button" aria-expanded={expanded} aria-controls={listId} onClick={()=>setExpanded(value=>!value)} className="flex w-full items-center justify-between gap-2 rounded py-2 text-left text-[11px] text-muted hover:text-white focus-visible:outline-2 focus-visible:outline-accent"><span>{expanded ? "Show fewer activities" : `${items.length-1} more ${items.length===2 ? "activity" : "activities"}`}</span><ChevronDown size={13} aria-hidden="true" className={expanded?"rotate-180":""}/></button>
      {expanded && <div id={listId} className="max-h-64 overflow-y-auto overscroll-contain border-t border-white/10 divide-y divide-white/10">{items.slice(1).map(item=><ActivityRow key={item.id} item={item} dismiss={dismiss}/>)}</div>}
    </>}
    {items.some(finished) && <button type="button" onClick={clearFinished} className="mt-1 rounded py-1 text-[11px] text-muted hover:text-white focus-visible:outline-2 focus-visible:outline-accent">Clear finished</button>}
  </section>;
}
