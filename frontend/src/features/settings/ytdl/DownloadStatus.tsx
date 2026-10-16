import {useQuery} from "@tanstack/react-query";
import {FolderOpen} from "lucide-react";
import {ytdl} from "./client";

export const openDownloadsEvent="posterview:open-ytdl-downloads";
export const activeDownload=(status:string)=>!["completed","failed","cancelled","interrupted"].includes(status);
export function useDownloadJobs(){
 return useQuery({queryKey:["ytdl-jobs"],queryFn:ytdl.jobs,refetchInterval:query=>query.state.data?.some(job=>activeDownload(job.status))?2000:10000});
}
export default function DownloadStatus({compact=false}:{compact?:boolean}){
 const jobs=useDownloadJobs();
 const active=jobs.data?.filter(job=>activeDownload(job.status))??[];
 const visible=compact?(active.length?active:jobs.data?.slice(-1)??[]):jobs.data??[];
 if(compact&&!visible.length&&!jobs.error)return null;
 if(compact){
  const job=visible[0];
  const percentage=job?.progress??(job?.status==="completed"?100:null);
  return <section aria-label="YouTube download status" className="rounded-xl border border-border bg-window p-3">
   <div className="flex items-center justify-between gap-2 text-xs"><h2 className="uppercase tracking-wide text-muted">Status</h2><span aria-label="Overall completion" className="font-medium tabular-nums text-accent">{percentage==null?"—":`${Math.round(percentage)}%`}</span></div>
   {job&&<><p title={job.title||job.url} className="mt-1 truncate text-xs font-medium">{job.title||job.url}</p><p className="truncate text-xs text-muted">{job.metadata_only?"NFO update · ":""}{job.status.replaceAll("_"," ")}{job.total_videos?` · ${job.completed_videos??0}/${job.total_videos} complete`:""}{active.length>1?` · +${active.length-1} active`:""}</p><progress aria-label={`Download progress for ${job.title||job.id}`} max={100} value={percentage??undefined} className="block h-1 w-full accent-accent"/></>}
   {jobs.error&&<p role="alert" className="truncate text-xs text-danger">Download status unavailable</p>}
  </section>;
 }
 return <section aria-label="YouTube download status" className={`rounded-xl border border-border bg-window ${compact?"p-3":"p-5"}`}>
  <div className="mb-3 flex items-center justify-between gap-2"><h2 className={compact?"text-xs uppercase tracking-wide text-muted":"font-semibold"}>{compact?"Status":"YouTube downloads"}</h2><button type="button" className="text-xs text-accent hover:underline" onClick={()=>window.dispatchEvent(new Event(openDownloadsEvent))}>Open queue</button></div>
  {jobs.isPending&&<p className="text-sm text-muted">Loading downloads…</p>}
  {jobs.error&&<p role="alert" className="text-xs text-danger">Download status unavailable: {jobs.error.message}</p>}
  {!compact&&jobs.data?.length===0&&<p className="text-sm text-muted">No downloads yet.</p>}
  <div className="space-y-3">{visible.map(job=><article key={job.id} className="min-w-0 space-y-2">
   <p className="break-words text-sm font-medium">{job.title||job.url}</p>
   {!!job.total_videos&&<p className="text-xs text-muted">{job.completed_videos??0} of {job.total_videos} videos complete{job.current_video_title?` · ${job.current_video_title}`:""}</p>}
   <p className={`text-xs ${job.status==="completed"?"text-accent":"text-muted"}`}>{job.metadata_only?"NFO update · ":""}{job.status.replaceAll("_"," ")}{job.progress!=null?` · ${Math.round(job.progress)}%`:""}{job.speed?` · ${job.speed}`:""}{job.eta?` · ETA ${job.eta}`:""}</p>
   {!job.metadata_only&&job.status==="processing"&&<div className="space-y-1"><p className="text-xs text-accent">Encoding{job.encoding_progress!=null?` · ${job.encoding_progress.toFixed(1)}%`:" · Waiting for encoder progress…"}</p><progress aria-label={`Encoding progress for ${job.title||job.id}`} className="h-2 w-full accent-accent" max={100} value={job.encoding_progress??undefined}/></div>}
   {activeDownload(job.status)&&<progress aria-label={`Download progress for ${job.title||job.id}`} max={100} value={job.progress??undefined} className="h-2 w-full accent-accent"/>}
   <p className="flex items-start gap-2 break-all text-xs text-muted"><FolderOpen className="size-3 shrink-0"/>/media/{job.settings.directory}</p>
   {job.error&&<p className="break-words text-xs text-danger">{job.error}</p>}
  </article>)}</div>
 </section>;
}
