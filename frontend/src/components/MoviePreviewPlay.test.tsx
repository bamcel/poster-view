import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {MemoryRouter,useLocation} from "react-router-dom";
import {afterEach,expect,it,vi} from "vitest";
import MoviePreviewPlay from "./MoviePreviewPlay";
import {watchApi,type WatchState} from "../features/playback/api/watch";
import type {HomeTitle} from "./HomeDiscovery";
vi.mock("../features/playback/api/watch",()=>({watchApi:{state:vi.fn()}}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
const state:WatchState={position_seconds:0,duration_seconds:1000,watched:false,play_count:0,last_played_at:null,audio_index:null,subtitle_index:null,session_id:null,version:1};
const title:HomeTitle={library:{id:"movie library",name:"Movies",library_type:"movies",anime_content:"both",paths:[],revision:1,created_at:"",updated_at:""},entry:{id:"movie/one",title:"Movie",kind:"movie",path:"/movie",parent_path:null,nfo_path:null,revision:1,available:true,metadata:{},artwork:[],files:[{path:"movie.mkv",size:1,extension:"mkv"}]}};
function Destination(){const location=useLocation();return <output role="status">{location.pathname}{location.search}</output>;}
function mount(){render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MemoryRouter><MoviePreviewPlay title={title}/><Destination/></MemoryRouter></QueryClientProvider>);}
it.each([true,false])("offers a popup before playing a previously watched movie (resume %s)",async resume=>{
 vi.mocked(watchApi.state).mockResolvedValue({...state,position_seconds:300,play_count:1});mount();
 await waitFor(()=>expect(screen.getByRole("button",{name:"Play Movie"}).hasAttribute("disabled")).toBe(false));
 expect(screen.queryByRole("button",{name:"Resume"})).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"Play Movie"}));
 expect(await screen.findByRole("dialog",{name:"Play video"})).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:resume?"Resume":"Play from beginning"}));
 expect(screen.getByRole("status").textContent).toBe(`/play/native/movie%20library/movie%2Fone?return=%2F${resume?"":"&start=0"}`);
});
it("plays an unwatched movie directly",async()=>{
 vi.mocked(watchApi.state).mockResolvedValue(state);mount();
 await waitFor(()=>expect(screen.getByRole("button",{name:"Play Movie"}).hasAttribute("disabled")).toBe(false));
 fireEvent.click(screen.getByRole("button",{name:"Play Movie"}));
 expect(screen.queryByRole("dialog")).toBeNull();
 expect(screen.getByRole("status").textContent).toContain("&start=0");
});
it("can cancel the choice without starting playback",async()=>{
 vi.mocked(watchApi.state).mockResolvedValue({...state,position_seconds:300});mount();
 await waitFor(()=>expect(screen.getByRole("button",{name:"Play Movie"}).hasAttribute("disabled")).toBe(false));
 fireEvent.click(screen.getByRole("button",{name:"Play Movie"}));
 fireEvent.click(await screen.findByRole("button",{name:"Close Play video"}));
 expect(screen.queryByRole("dialog")).toBeNull();
 expect(screen.getByRole("status").textContent).toBe("/");
});