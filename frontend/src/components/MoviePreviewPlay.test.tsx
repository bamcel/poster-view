import {cleanup,render,screen} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {MemoryRouter} from "react-router-dom";
import {afterEach,expect,it,vi} from "vitest";
import MoviePreviewPlay from "./MoviePreviewPlay";
import {watchApi,type WatchState} from "../features/playback/api/watch";
import type {HomeTitle} from "./HomeDiscovery";
vi.mock("../features/playback/api/watch",()=>({watchApi:{state:vi.fn()}}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
const state:WatchState={position_seconds:0,duration_seconds:1000,watched:false,play_count:0,last_played_at:null,audio_index:null,subtitle_index:null,session_id:null,version:1};
const title={library:{id:"movie library"},entry:{id:"movie/one",title:"Movie",kind:"movie",available:true,metadata:{},files:[{path:"movie.mkv"}]}} as HomeTitle;
function mount(){render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MemoryRouter><MoviePreviewPlay title={title}/></MemoryRouter></QueryClientProvider>);}
it("always starts movies from zero and directly offers Resume for saved progress",async()=>{
 vi.mocked(watchApi.state).mockResolvedValue({...state,position_seconds:300,play_count:1});mount();
 expect((await screen.findByRole("link",{name:"Resume Movie"})).getAttribute("href")).toBe("/play/native/movie%20library/movie%2Fone?return=%2F");
 expect(screen.getByRole("link",{name:"Play Movie"}).getAttribute("href")).toBe("/play/native/movie%20library/movie%2Fone?return=%2F&start=0");
 expect(screen.queryByRole("button",{name:"Cancel"})).toBeNull();
});
it("shows a single Play action without history",async()=>{
 vi.mocked(watchApi.state).mockResolvedValue(state);mount();
 expect(await screen.findByRole("link",{name:"Play Movie"})).toBeTruthy();
 expect(screen.queryByRole("link",{name:"Resume Movie"})).toBeNull();
});
