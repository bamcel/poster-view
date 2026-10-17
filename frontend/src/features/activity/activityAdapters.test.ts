import {expect,it} from "vitest";
import type {NativeScanStatus} from "../../api/nativeLibraries";
import type {MaintenanceTask} from "../../components/ScheduledTasks";
import type {YtdlJob} from "../settings/ytdl/client";
import {scanActivity,taskActivities,unavailableActivity,youtubeActivities} from "./activityAdapters";
const now=Date.parse("2026-10-16T12:00:00Z");
it("reports actual metadata task counts while future work is unresolved",()=>{
 const item=scanActivity({id:"anime",name:"Anime"},{status:"scanning",count:2558,warnings:[],progress:{phase:"metadata",processed:15,total:null,current:""}})[0];
 expect(item.detail).toBe("Fetching metadata and artwork · 15 tasks processed");
 expect(item.progress).toBeNull();
});
const job=(patch:Partial<YtdlJob>={}):YtdlJob=>({id:"download",title:"Example video",status:"downloading",progress:40,created_at:new Date(now-60000).toISOString(),url:"https://example.org/video",speed:null,eta:null,error:null,settings:{} as YtdlJob["settings"],...patch});
const scan=(patch:Partial<NativeScanStatus>={}):NativeScanStatus=>({status:"scanning",count:20,warnings:[],...patch});
const task=(patch:Partial<MaintenanceTask>={}):MaintenanceTask=>({id:"cleanup",title:"Cleanup",description:"",enabled:true,interval_days:1,retention_days:1,cleanup_artwork:false,cleanup_cache:false,cleanup_temporary:false,last_run:(now-60000)/1000,last_result:"Completed",...patch});
it("keeps queued downloads indeterminate and uses encoder progress during processing",()=>{
 const items=youtubeActivities([job({id:"q",status:"queued",progress:100}),job({id:"encoding",status:"processing",progress:100,encoding_progress:24})],now);
 expect(items[0]).toMatchObject({state:"queued",progress:null});expect(items[1]).toMatchObject({state:"running",progress:24,detail:"Encoding video",event:"posterview:open-ytdl-downloads"});
 expect(youtubeActivities([job({status:"processing",progress:100,encoding_progress:null})],now)[0].progress).toBeNull();
});
it.each([-10,150,NaN,Infinity])("bounds active download progress %s without reporting completion",progress=>{
 const item=youtubeActivities([job({progress})],now)[0];
 if(Number.isFinite(progress))expect(item.progress).toBe(progress<0?0:99);else expect(item.progress).toBeNull();
 expect(item.state).toBe("running");
});
it("includes recent terminal results, discards old or undated history, and hides raw errors",()=>{
 const items=youtubeActivities([job({status:"completed"}),job({id:"failed",status:"failed",error:"/private/path error"}),job({id:"old",status:"completed",created_at:"2020-01-01"}),job({id:"undated",status:"failed",created_at:""})],now);
 expect(items).toHaveLength(2);expect(items[0]).toMatchObject({state:"completed",progress:100,updatedAt:now-60000});expect(items[1].state).toBe("failed");expect(JSON.stringify(items)).not.toContain("/private/path");
});
it("keeps a long-running download's newly observed completion",()=>{
 const items=youtubeActivities([job({status:"completed",created_at:"2020-01-01"})],now,new Map([["download",now]]));
 expect(items[0]).toMatchObject({state:"completed",progress:100,updatedAt:now});
});
it("maps scan phases without exposing filenames or inventing completion timestamps",()=>{
 const library={id:"anime",name:"Anime"};
 expect(scanActivity(library,scan({status:"idle"}))).toEqual([]);
 expect(scanActivity(library,scan({status:"completed",warnings:["old notice"]}))).toEqual([]);
 expect(scanActivity(library,scan({status:"idle",manual_queued:true}))[0]).toMatchObject({state:"queued",progress:null});
 const item=scanActivity(library,scan({progress:{phase:"reading",processed:150,total:100,current:"/private/file.mkv"}}))[0];
 expect(item).toMatchObject({state:"running",progress:99,detail:"Reading metadata and media info"});expect(JSON.stringify(item)).not.toContain("/private");
 expect(scanActivity(library,scan({progress:{phase:"saving",processed:1,total:null,current:""}}))[0].progress).toBeNull();
});
it("maps scheduled tasks as indeterminate while running and recent completed or failed afterward",()=>{
 const items=taskActivities([task({id:"active",running:true,last_run:0}),task(),task({id:"failed",last_result:"Failed: /private/path"}),task({id:"old",last_run:1})],now);
 expect(items).toHaveLength(3);expect(items[0]).toMatchObject({state:"running",progress:null});expect(items[1]).toMatchObject({state:"completed",progress:100,updatedAt:now-60000});expect(items[2].state).toBe("failed");expect(JSON.stringify(items)).not.toContain("/private");
});
it("uses a safe warning when a management status request fails",()=>{
 expect(unavailableActivity("scan:unavailable","Library scans")).toMatchObject({state:"warning",adminOnly:true,detail:"Status unavailable. Try again later."});
});

it("uses durable completion time across observation and reload for every terminal status",()=>{
 for(const status of ["completed","completed_with_warnings","failed","cancelled","interrupted"]){
  const jobs=[job({status,created_at:"2020-01-01",finished_at:new Date(now-1000).toISOString()})];
  const observed=youtubeActivities(jobs,now,new Map([["download",now]]));
  const reloaded=youtubeActivities(jobs,now+10000);
  expect(observed).toEqual(reloaded);
  expect(observed[0].updatedAt).toBe(now-1000);
 }
});
it("uses the legacy fallback when completion time is missing or malformed",()=>{
 for(const finished_at of [null,undefined,"invalid"]){
  expect(youtubeActivities([job({status:"completed",finished_at})],now)[0].updatedAt).toBe(now-60000);
 }
});
