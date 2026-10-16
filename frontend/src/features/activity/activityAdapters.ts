import {activeYtdlJob,ytdlPhase} from "../settings/ytdl/jobPresentation";
import type {NativeLibrary,NativeScanStatus} from "../../api/nativeLibraries";
import type {MaintenanceTask} from "../../components/ScheduledTasks";
import type {YtdlJob} from "../settings/ytdl/client";
import type {ActivityItem} from "./ActivityContext";

const RECENT_MS=15*60*1000;
const recent=(at:number,now:number)=>Number.isFinite(at)&&at>0&&at<=now+60_000&&now-at<=RECENT_MS;
const percent=(value:number|null|undefined)=>value==null||!Number.isFinite(value)?null:Math.max(0,Math.min(99,value));
export const activeYoutubeJob=activeYtdlJob;
export function youtubeActivities(jobs:YtdlJob[],now=Date.now(),completedAt:ReadonlyMap<string,number>=new Map()):ActivityItem[]{
 return jobs.flatMap(job=>{
  const terminal=!activeYoutubeJob(job.status),at=completedAt.get(job.id)??Date.parse(job.created_at);
  if(terminal&&!recent(at,now))return [];
  const state:ActivityItem["state"]=job.status==="completed"?"completed":job.status==="completed_with_warnings"?"warning":job.status==="failed"||job.status==="interrupted"?"failed":job.status==="cancelled"?"warning":["queued","pending","waiting"].includes(job.status)?"queued":"running";
  const phase=job.metadata_only||job.status==="completed_with_warnings"?ytdlPhase(job):job.status==="processing"?"Encoding video":job.status==="downloading"?"Downloading video":job.status==="completed"?"Download completed":job.status==="failed"||job.status==="interrupted"?"Download failed. Open the download queue for details.":job.status==="cancelled"?"Download cancelled":state==="queued"?"Waiting in download queue":"Preparing download";
  const count=job.total_videos&&job.total_videos>1?` · ${Math.max(0,Math.min(job.total_videos,job.completed_videos??0))} of ${job.total_videos} videos processed`:"";
  return [{id:`youtube:${job.id}`,title:job.title||"YouTube download",detail:phase+count,state,progress:state==="completed"?100:state!=="running"?null:percent(job.status==="processing"?job.encoding_progress:job.progress),event:"posterview:open-ytdl-downloads",adminOnly:true,...(terminal?{updatedAt:at}:{})}];
 });
}
const phases:Record<string,string>={discovering:"Discovering files",inspecting:"Inspecting media files",reading:"Reading metadata and media info",metadata:"Fetching metadata and artwork",capturing:"Capturing video thumbnails",saving:"Saving library changes"};
export function scanActivity(library:Pick<NativeLibrary,"id"|"name">,status:NativeScanStatus|undefined):ActivityItem[]{
 if(!status)return [];
 const running=status.status==="scanning",queued=status.manual_queued&&!running,failed=["failed","error"].includes(status.status);
 // Completed scans do not expose a timestamp. Do not resurrect old results.
 if(!running&&!queued&&!failed)return [];
 const progress=status.progress;
 return [{id:`scan:${library.id}`,title:`${library.name} library`,detail:queued?"Scan queued":failed?"Library scan failed. Open library settings for details.":phases[progress?.phase??""]??"Starting library scan",state:queued?"queued":failed?"failed":"running",progress:running&&progress?.total&&progress.total>0?percent(progress.processed/progress.total*100):null,href:"/settings/libraries",adminOnly:true}];
}
export function taskActivities(tasks:MaintenanceTask[],now=Date.now()):ActivityItem[]{
 return tasks.flatMap(task=>{
  const at=task.last_run*1000;
  if(!task.running&&!recent(at,now))return [];
  const failed=/^failed\b/i.test(task.last_result);
  return [{id:`task:${task.id}`,title:task.title,detail:task.running?"Scheduled task running":failed?"Scheduled task failed. Open scheduled tasks for details.":"Scheduled task completed",state:task.running?"running":failed?"failed":"completed",progress:task.running?null:failed?null:100,href:"/settings/tasks",adminOnly:true,...(!task.running?{updatedAt:at}:{})}];
 });
}
export function unavailableActivity(id:string,title:string):ActivityItem{return {id,title,detail:"Status unavailable. Try again later.",state:"warning",adminOnly:true};}
