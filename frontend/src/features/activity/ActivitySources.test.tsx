import {act,cleanup,render,screen} from "@testing-library/react";
import {QueryClient,QueryClientProvider,focusManager} from "@tanstack/react-query";
import {afterEach,expect,it,vi} from "vitest";
import type {AuthSession} from "../../api/client";
import {apiRequest} from "../../api/client";
import {nativeLibraries} from "../../api/nativeLibraries";
import {AuthSessionContext} from "../../lib/authContext";
import {ytdl} from "../settings/ytdl/client";
import {ActivityProvider,useActivity} from "./ActivityContext";
import ActivitySources from "./ActivitySources";
vi.mock("../../api/client",()=>({apiRequest:vi.fn()}));
vi.mock("../../api/nativeLibraries",()=>({nativeLibraries:{list:vi.fn(),status:vi.fn()}}));
vi.mock("../settings/ytdl/client",()=>({ytdl:{jobs:vi.fn()}}));
const viewer:AuthSession={authenticated:true,user:{id:"viewer",username:"viewer",display_name:"Viewer",role:"user",enabled:true,revision:1,created_at:"",permissions:{all_libraries:true,library_ids:[],max_movie_rating:null,max_tv_rating:null,allow_unrated:false}}};
function ActivityProbe(){return <output data-testid="activities">{JSON.stringify(useActivity().items)}</output>;}
afterEach(()=>{cleanup();focusManager.setFocused(undefined);vi.useRealTimers();vi.clearAllMocks();});
it.each([false,true])("never queries or publishes management activity for viewers with cached admin data=%s",async cached=>{
 vi.useFakeTimers();
 const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});
 if(cached){
  client.setQueryData(["native-libraries"],[{id:"private",name:"Private library",library_type:"movies"}]);
  client.setQueryData(["native-scan","private"],{status:"scanning",count:1,warnings:[]});
  client.setQueryData(["ytdl-jobs"],[{id:"private-job",title:"Private download",status:"downloading",progress:50,created_at:new Date().toISOString()}]);
  client.setQueryData(["scheduled-tasks"],[{id:"private-task",title:"Private maintenance",running:true,last_run:0,last_result:""}]);
 }
 render(<QueryClientProvider client={client}><AuthSessionContext.Provider value={viewer}><ActivityProvider><ActivitySources/><ActivityProbe/></ActivityProvider></AuthSessionContext.Provider></QueryClientProvider>);
 await act(async()=>{await vi.advanceTimersByTimeAsync(65000);focusManager.setFocused(false);focusManager.setFocused(true);await vi.advanceTimersByTimeAsync(1000);});
 expect(ytdl.jobs).not.toHaveBeenCalled();expect(nativeLibraries.list).not.toHaveBeenCalled();expect(nativeLibraries.status).not.toHaveBeenCalled();expect(apiRequest).not.toHaveBeenCalled();
 expect(screen.getByTestId("activities").textContent).toBe("[]");
 client.clear();
});
