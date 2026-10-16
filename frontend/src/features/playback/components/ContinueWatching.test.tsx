import {cleanup,render,screen,within,fireEvent,waitFor} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {MemoryRouter,Routes,Route} from "react-router-dom";
import {afterEach,expect,it,vi} from "vitest";
import ContinueWatching from "./ContinueWatching";
import {watchApi} from "../api/watch";
vi.mock("../api/watch",()=>({watchApi:{continue:vi.fn(),mark:vi.fn(),dismissContinue:vi.fn()}}));
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it("keeps resume navigation and progress in the shared homepage row",async()=>{
 vi.mocked(watchApi.continue).mockResolvedValue([{library_id:"anime",item_id:"episode/1",title:"Episode One",kind:"episode",library_name:"Anime",entry:{id:"episode/1",title:"Episode One",kind:"episode",path:"episode.mkv",parent_path:null,available:true,artwork:[],revision:1,metadata:{},files:[],nfo_path:null},state:{position_seconds:300,duration_seconds:1200,watched:false,play_count:1,last_played_at:null,audio_index:null,subtitle_index:null,session_id:null,version:1}}] as Awaited<ReturnType<typeof watchApi.continue>>);
 render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MemoryRouter><ContinueWatching/></MemoryRouter></QueryClientProvider>);
 const row=await screen.findByRole("region",{name:"Continue watching"});
 expect(within(row).getByRole("heading",{name:"Continue Watching"})).toBeTruthy();
 expect(within(row).getByRole("link",{name:"Resume Episode One"}).getAttribute("href")).toBe("/play/native/anime/episode%2F1?return=%2F");
 expect(row.querySelector('[style="width: 25%;"]')).toBeTruthy();
});

const fixture={library_id:"anime",item_id:"episode",series_item_id:"series",title:"Pilot",kind:"episode",library_name:"Anime",entry:{id:"episode",title:"Pilot",kind:"episode",path:"s/e.mkv",parent_path:"s",available:true,artwork:[],revision:1,metadata:{},files:[],nfo_path:null},state:{position_seconds:300,duration_seconds:1200,watched:false,play_count:0,last_played_at:null,audio_index:null,subtitle_index:null,session_id:null,version:1}};
function mountActions(){return render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MemoryRouter><Routes><Route path="/" element={<ContinueWatching/>}/><Route path="/media/:library" element={<p>Series detail</p>}/></Routes></MemoryRouter></QueryClientProvider>);}
it.each(["Mark played","Remove from Continue Watching"])("%s updates only the selected user's item",async label=>{
 vi.mocked(watchApi.continue).mockResolvedValue([fixture] as Awaited<ReturnType<typeof watchApi.continue>>);
 vi.mocked(watchApi.mark).mockResolvedValue(fixture.state);vi.mocked(watchApi.dismissContinue).mockResolvedValue();
 mountActions();fireEvent.contextMenu(await screen.findByRole("link",{name:"Resume Pilot"}));
 vi.mocked(watchApi.continue).mockResolvedValue([]);
 fireEvent.click(screen.getByRole("menuitem",{name:label}));
 await waitFor(()=>expect(screen.queryByRole("link",{name:"Resume Pilot"})).toBeNull());
 if(label==="Mark played")expect(watchApi.mark).toHaveBeenCalledWith("anime","episode",true);
 else expect(watchApi.dismissContinue).toHaveBeenCalledWith("anime","episode");
});
it("opens the parent series instead of the episode",async()=>{
 vi.mocked(watchApi.continue).mockResolvedValue([fixture] as Awaited<ReturnType<typeof watchApi.continue>>);mountActions();
 fireEvent.contextMenu(await screen.findByRole("link",{name:"Resume Pilot"}));fireEvent.click(screen.getByRole("menuitem",{name:"Go to series"}));
 expect(await screen.findByText("Series detail")).toBeTruthy();
});
it("shows action failures and keeps the resume card",async()=>{
 vi.mocked(watchApi.continue).mockResolvedValue([fixture] as Awaited<ReturnType<typeof watchApi.continue>>);vi.mocked(watchApi.dismissContinue).mockRejectedValue(new Error("Could not hide title"));mountActions();
 fireEvent.contextMenu(await screen.findByRole("link",{name:"Resume Pilot"}));fireEvent.click(screen.getByRole("menuitem",{name:"Remove from Continue Watching"}));
 expect(await screen.findByRole("alert")).toHaveProperty("textContent",expect.stringContaining("Could not hide title"));
 expect(screen.getByRole("link",{name:"Resume Pilot"})).toBeTruthy();
});
