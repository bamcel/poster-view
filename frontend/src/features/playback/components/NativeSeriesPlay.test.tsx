import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {MemoryRouter,Route,Routes,useParams} from "react-router-dom";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import NativeSeriesPlay from "./NativeSeriesPlay";
import {watchApi,type WatchState} from "../api/watch";
import type {NativeCatalogEntry} from "../../../api/nativeLibraries";
vi.mock("../api/watch",()=>({watchApi:{continue:vi.fn(),states:vi.fn()}}));
const state:WatchState={position_seconds:0,duration_seconds:1200,watched:true,play_count:1,last_played_at:null,audio_index:null,subtitle_index:null,session_id:null,version:1};
const episode=(number:number):NativeCatalogEntry=>({id:`episode-${number}`,path:`anime/show/Season 01/Episode ${number}.mkv`,parent_path:"anime/show/Season 01",kind:"episode",title:`Episode ${number}`,metadata:{season:1,episode:number},artwork:[],files:[{path:`episode-${number}.mkv`,extension:"mkv",size:10}],nfo_path:null,available:true,revision:0});
const entries=[episode(1),episode(2),episode(3)];
function Destination(){const {itemId}=useParams();return <p>Playing {itemId}</p>;}
function setup(){render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MemoryRouter initialEntries={["/media/anime/show"]}><Routes><Route path="/media/anime/show" element={<NativeSeriesPlay library="anime" path="anime/show" entries={entries}/>}/><Route path="/play/native/:libraryId/:itemId" element={<Destination/>}/></Routes></MemoryRouter></QueryClientProvider>);}
beforeEach(()=>{vi.clearAllMocks();vi.mocked(watchApi.continue).mockResolvedValue([]);vi.mocked(watchApi.states).mockResolvedValue({});});
afterEach(cleanup);
describe("series playback selection",()=>{
 it("plays the first unplayed episode after completed episodes",async()=>{vi.mocked(watchApi.states).mockResolvedValue({"episode-1":state});setup();await waitFor(()=>expect(screen.getByRole("button",{name:"Play"})).toBeTruthy());fireEvent.click(screen.getByRole("button",{name:"Play"}));expect(screen.getByText("Playing episode-2")).toBeTruthy();});
 it("prefers resumable progress, including an interrupted rewatch, over the first unplayed item",async()=>{
  vi.mocked(watchApi.states).mockResolvedValue({"episode-3":state});vi.mocked(watchApi.continue).mockResolvedValue([{library_id:"anime",library_name:"Anime",item_id:"episode-3",title:"Episode 3",kind:"episode",entry:episode(3),state:{...state,position_seconds:200}}]);
  setup();await waitFor(()=>expect(screen.getByRole("button",{name:"Resume"})).toBeTruthy());fireEvent.click(screen.getByRole("button",{name:"Resume"}));expect(screen.getByText("Playing episode-3")).toBeTruthy();
 });
 it("offers the first episode for a rewatch when all episodes are played",async()=>{vi.mocked(watchApi.states).mockResolvedValue(Object.fromEntries(entries.map(entry=>[entry.id,state])));setup();await waitFor(()=>expect(screen.getByRole("button",{name:"Play"})).toBeTruthy());fireEvent.click(screen.getByRole("button",{name:"Play"}));expect(screen.getByText("Playing episode-1")).toBeTruthy();});
});
