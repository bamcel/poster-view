import {useMemo,useRef} from "react";
import {useQueries,useQuery} from "@tanstack/react-query";
import {apiRequest} from "../../api/client";
import {nativeLibraries} from "../../api/nativeLibraries";
import type {MaintenanceTask} from "../../components/ScheduledTasks";
import {useIsAdmin} from "../../lib/authContext";
import {ytdl} from "../settings/ytdl/client";
import {useActivitySource} from "./ActivityContext";
import {activeYoutubeJob,scanActivity,taskActivities,unavailableActivity,youtubeActivities} from "./activityAdapters";

/** Management sources mount once inside the real application's ActivityProvider. */
export default function ActivitySources(){
 const admin=useIsAdmin();
 const observedJobs=useRef(new Map<string,{active:boolean;completedAt?:number}>());
 const jobs=useQuery({queryKey:["ytdl-jobs"],queryFn:ytdl.jobs,enabled:admin,refetchInterval:query=>query.state.data?.some(job=>activeYoutubeJob(job.status))?2000:15000,refetchIntervalInBackground:false});
 const libraries=useQuery({queryKey:["native-libraries"],queryFn:nativeLibraries.list,enabled:admin,staleTime:30000,refetchInterval:30000,refetchIntervalInBackground:false});
 const scans=useQueries({queries:admin?(libraries.data??[]).map(library=>({queryKey:["native-scan",library.id],queryFn:()=>nativeLibraries.status(library.id),enabled:admin,refetchInterval:(query:{state:{data?:{status:string;manual_queued?:boolean}}})=>query.state.data?.status==="scanning"||query.state.data?.manual_queued?2500:30000,refetchIntervalInBackground:false})):[]});
 const tasks=useQuery({queryKey:["scheduled-tasks"],queryFn:()=>apiRequest<MaintenanceTask[]>("/tasks"),enabled:admin,refetchInterval:query=>query.state.data?.some(task=>task.running)?2500:30000,refetchIntervalInBackground:false});
 const youtube=useMemo(()=>{
  if(!admin){observedJobs.current.clear();return [];}
  const previous=observedJobs.current,next=new Map<string,{active:boolean;completedAt?:number}>(),completedAt=new Map<string,number>();
  for(const job of jobs.data??[]){
   const active=activeYoutubeJob(job.status),old=previous.get(job.id);
   const at=active?undefined:old?.active?Date.now():old?.completedAt;
   next.set(job.id,{active,completedAt:at});if(at!==undefined)completedAt.set(job.id,at);
  }
  observedJobs.current=next;
  return [...youtubeActivities(jobs.data??[],Date.now(),completedAt),...(jobs.error?[unavailableActivity("youtube:unavailable","YouTube downloads")]:[])];
 },[jobs.data,jobs.error,admin]);
 const maintenance=useMemo(()=>[...taskActivities(tasks.data??[]),...(tasks.error?[unavailableActivity("tasks:unavailable","Scheduled tasks")]:[])],[tasks.data,tasks.error]);
 const libraryItems=(libraries.data??[]).flatMap((library,index)=>[...scanActivity(library,scans[index]?.data),...(scans[index]?.error?[unavailableActivity(`scan:${library.id}:unavailable`,`${library.name} library`)]:[])]);
 if(libraries.error)libraryItems.push(unavailableActivity("scans:unavailable","Library scans"));
 useActivitySource("youtube",youtube,admin);
 useActivitySource("library-scans",libraryItems,admin);
 useActivitySource("scheduled-tasks",maintenance,admin);
 return null;
}
