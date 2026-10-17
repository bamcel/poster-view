import type {DurableJob} from "../jobs/client";
import type {ActivityItem} from "./ActivityContext";

const phaseNames:Record<string,string>={discovering:"Discovering files",inspecting:"Inspecting media",reading:"Reading metadata",metadata:"Fetching metadata and artwork",capturing:"Capturing thumbnails",saving:"Saving changes"};
export function durableJobActivities(jobs:DurableJob[],now=Date.now()):ActivityItem[]{
 return jobs.flatMap(job=>{
  if(job.status==="completed"&&now-job.updated_at*1000>15*60_000)return [];
  const queued=job.status==="queued",active=["queued","running","cancelling"].includes(job.status);
  const waiting=queued&&job.available_at*1000>now;
  const p=job.progress;
  const phase=p?(phaseNames[p.phase]??"Processing background task"):"Processing background task";
  const detail=job.status==="cancelling"?"Stopping safely…":waiting?`Retry scheduled · attempt ${job.attempt} of ${job.max_attempts}`:queued?"Waiting to start":job.status==="failed"?"Task failed. Retry to continue saved work.":job.status==="cancelled"?"Cancelled. Saved work can be resumed with Retry.":job.status==="completed"?"Task completed":`${phase}${p?` · ${p.processed}${p.total!==null?` / ${p.total}`:""}`:""}`;
  return [{id:job.id,jobId:job.id,title:job.title,detail:detail+(job.checkpoint_count>0&&active?` · ${job.checkpoint_count} checkpoints saved`:""),state:queued?"queued":active?"running":job.status==="completed"?"completed":job.status==="failed"?"failed":"warning",progress:job.status==="completed"?100:job.status==="running"&&p?.total&&p.total>0?Math.min(99,Math.max(0,p.processed/p.total*100)):null,href:job.href,updatedAt:job.updated_at*1000,adminOnly:true,canCancel:job.status==="queued"||job.status==="running",canRetry:job.status==="failed"||job.status==="cancelled",cancelling:job.status==="cancelling"}];
 });
}
