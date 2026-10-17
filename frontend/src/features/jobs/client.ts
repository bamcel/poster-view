import {apiRequest} from "../../api/client";

export interface DurableJob {
 id:string;kind:string;title:string;status:"queued"|"running"|"cancelling"|"completed"|"failed"|"cancelled";
 attempt:number;max_attempts:number;available_at:number;created_at:number;updated_at:number;
 error:string|null;checkpoint_count:number;href:string;library_id?:string;task_id?:string;
 progress?:{phase:string;processed:number;total:number|null;current:string}|null;
}
export const jobActive=(job:DurableJob)=>["queued","running","cancelling"].includes(job.status);
export const durableJobs={
 list:()=>apiRequest<DurableJob[]>("/jobs"),
 cancel:(id:string)=>apiRequest<DurableJob>(`/jobs/${encodeURIComponent(id)}/cancel`,{method:"POST"}),
 retry:(id:string)=>apiRequest<DurableJob>(`/jobs/${encodeURIComponent(id)}/retry`,{method:"POST"}),
};
