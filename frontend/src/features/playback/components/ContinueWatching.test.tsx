import {cleanup,render,screen,within} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {MemoryRouter} from "react-router-dom";
import {afterEach,expect,it,vi} from "vitest";
import ContinueWatching from "./ContinueWatching";
import {watchApi} from "../api/watch";
vi.mock("../api/watch",()=>({watchApi:{continue:vi.fn()}}));
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it("keeps resume navigation and progress in the shared homepage row",async()=>{
 vi.mocked(watchApi.continue).mockResolvedValue([{library_id:"anime",item_id:"episode/1",title:"Episode One",kind:"episode",library_name:"Anime",entry:{id:"episode/1",title:"Episode One",kind:"episode",path:"episode.mkv",parent_path:null,available:true,artwork:[],revision:1,metadata:{},files:[],nfo_path:null},state:{position_seconds:300,duration_seconds:1200,watched:false,play_count:1,last_played_at:null,audio_index:null,subtitle_index:null,session_id:null,version:1}}] as Awaited<ReturnType<typeof watchApi.continue>>);
 render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MemoryRouter><ContinueWatching/></MemoryRouter></QueryClientProvider>);
 const row=await screen.findByRole("region",{name:"Continue watching"});
 expect(within(row).getByRole("heading",{name:"Continue Watching"})).toBeTruthy();
 expect(within(row).getByRole("link",{name:"Resume Episode One"}).getAttribute("href")).toBe("/play/native/anime/episode%2F1?return=%2F");
 expect(row.querySelector('[style="width: 25%;"]')).toBeTruthy();
});
