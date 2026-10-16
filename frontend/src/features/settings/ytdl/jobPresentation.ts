import type {YtdlJob} from "./client";
export const activeYtdlJob=(status:string)=>!["completed","completed_with_warnings","failed","cancelled","interrupted"].includes(status);
export function ytdlPhase(job:YtdlJob){
 if(job.metadata_only&&["downloading","processing","importing"].includes(job.status))return "Updating metadata";
 return ({importing:"Writing metadata",processing:"Encoding video",inspecting:"Checking source",completed_with_warnings:"Completed with warnings"} as Record<string,string>)[job.status]??job.status.replaceAll("_"," ");
}
export function ytdlOutcomes(job:YtdlJob){
 return ([['downloaded_videos','downloaded'],['existing_videos','already present'],['updated_videos','metadata updated'],['skipped_videos','skipped'],['failed_videos','failed']] as const).filter(([key])=>job[key]!==undefined).map(([key,label])=>({label,count:job[key]??0}));
}
