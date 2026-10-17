import {expect,it} from "vitest";
import type {DurableJob} from "../jobs/client";
import {durableJobActivities} from "./durableJobActivities";
const now=1_800_000_000_000;
const job:DurableJob={id:"job",kind:"native_scan",title:"Anime library",status:"running",attempt:1,max_attempts:3,available_at:now/1000,created_at:now/1000,updated_at:now/1000,error:null,checkpoint_count:2,href:"/settings/libraries",progress:{phase:"metadata",processed:5,total:10,current:"/private/file.mkv"}};
it("maps safe progress and resumable controls without exposing paths or raw errors",()=>{
 const [item]=durableJobActivities([{...job,error:"secret token"}],now);
 expect(item.progress).toBe(50);expect(item.canCancel).toBe(true);expect(item.canRetry).toBe(false);
 expect(item.detail).toContain("Fetching metadata and artwork");expect(item.detail).toContain("2 checkpoints saved");
 expect(JSON.stringify(item)).not.toMatch(/secret|private/);
});
it("shows retry waits, cancellation and retryable terminal results",()=>{
 expect(durableJobActivities([{...job,status:"queued",available_at:now/1000+60,attempt:2}],now)[0].detail).toContain("Retry scheduled · attempt 2 of 3");
 const stopping=durableJobActivities([{...job,status:"cancelling"}],now)[0];expect(stopping.cancelling).toBe(true);expect(stopping.canCancel).toBe(false);
 for(const status of ["cancelled","failed"] as const){const item=durableJobActivities([{...job,status}],now)[0];expect(item.canRetry).toBe(true);expect(item.canCancel).toBe(false);}
});
it("drops old completion and bounds active percentages",()=>{
 expect(durableJobActivities([{...job,status:"completed",updated_at:(now-16*60_000)/1000}],now)).toEqual([]);
 expect(durableJobActivities([{...job,progress:{phase:"saving",processed:200,total:10,current:""}}],now)[0].progress).toBe(99);
});
