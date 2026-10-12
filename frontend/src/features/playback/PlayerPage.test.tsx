import {watchApi} from "./api/watch";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {MemoryRouter,Route,Routes} from "react-router-dom";
import {StrictMode} from "react";
import PlayerPage from "./PlayerPage";
import {playbackApi,defaultPlaybackPreferences,type PlaybackInfo,type PlaybackSession} from "./api/playback";
vi.mock("./api/playback",async importOriginal=>{
 const original=await importOriginal<typeof import("./api/playback")>();
 return {...original,playbackApi:{info:vi.fn(),create:vi.fn(),stop:vi.fn(),heartbeat:vi.fn(),subtitle:vi.fn()}};
});
vi.mock("./api/watch",()=>({watchApi:{preferences:vi.fn(),state:vi.fn(),begin:vi.fn(),progress:vi.fn()}}));
const info:PlaybackInfo={title:"Maomao",series_title:"The Apothecary Diaries",season:1,episode:1,duration_seconds:1200,chapters:[{title:"Opening",start_seconds:90}],tracks:[{index:1,kind:"video",codec:"h264",width:1920,height:1080},{index:2,kind:"audio",codec:"aac",language:"ja",default:true},{index:3,kind:"audio",codec:"aac",language:"en"}],next:{library_id:"anime",item_id:"two",title:"Episode two"}};
const session:PlaybackSession={id:"playback-one",method:"direct",reason:"Browser supports the source",url:"/api/playback/sessions/one/file",mime:"video/mp4",offset_seconds:0,duration_seconds:1200};
const state={session_id:null,version:0,position_seconds:300,duration_seconds:1200,watched:false,play_count:0,last_played_at:null,audio_index:null,subtitle_index:null};
function player(strict=false){const content=<MemoryRouter initialEntries={["/play/native/anime/one?return=%2Fmedia%2FAnime"]}><Routes><Route path="/play/native/:libraryId/:itemId" element={<PlayerPage/>}/><Route path="/media/Anime" element={<p>Media page</p>}/></Routes></MemoryRouter>;return render(strict?<StrictMode>{content}</StrictMode>:content);}
async function ready(){await waitFor(()=>expect(playbackApi.create).toHaveBeenCalled());const video=document.querySelector("video")!;fireEvent.loadedMetadata(video);await waitFor(()=>expect(screen.getByRole("heading",{name:"S1:E1 – Maomao"})).toBeTruthy());return video;}
beforeEach(()=>{
 vi.clearAllMocks();vi.spyOn(HTMLMediaElement.prototype,"load").mockImplementation(()=>{});vi.spyOn(HTMLMediaElement.prototype,"pause").mockImplementation(()=>{});vi.spyOn(HTMLMediaElement.prototype,"play").mockResolvedValue();vi.spyOn(HTMLMediaElement.prototype,"canPlayType").mockReturnValue("probably");
 vi.mocked(playbackApi.info).mockResolvedValue(info);vi.mocked(watchApi.preferences).mockResolvedValue(defaultPlaybackPreferences);vi.mocked(watchApi.state).mockResolvedValue(state);vi.mocked(watchApi.begin).mockResolvedValue({session_id:"watch-one",state});vi.mocked(playbackApi.create).mockResolvedValue(session);vi.mocked(playbackApi.stop).mockResolvedValue();vi.mocked(watchApi.progress).mockResolvedValue({...state,audio_index:2,subtitle_index:-1});vi.mocked(playbackApi.heartbeat).mockResolvedValue();
});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
describe("native player",()=>{
 it("resumes at source time and reports source watch progress with a separate watch session",async()=>{
  player();const video=await ready();expect(video.currentTime).toBe(295);
  Object.defineProperty(video,"currentTime",{value:307,writable:true});fireEvent.timeUpdate(video);fireEvent.pause(video);
  await waitFor(()=>expect(watchApi.progress).toHaveBeenCalledWith("anime","one",expect.objectContaining({session_id:"watch-one",position_seconds:307,playback_session_id:"playback-one"}),false));
  expect(screen.getByRole("slider",{name:"Seek"})).toBeTruthy();expect(screen.getByRole("button",{name:"Playback quality"})).toBeTruthy();
 });
 it("keeps one watch session when changing audio and restarts at the current source position",async()=>{
  player();const video=await ready();video.currentTime=410;fireEvent.timeUpdate(video);fireEvent.click(screen.getByRole("button",{name:"Audio"}));fireEvent.click(screen.getByRole("button",{name:/English/}));
  await waitFor(()=>expect(playbackApi.create).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({position_seconds:410,audio_index:3})));
  expect(watchApi.begin).toHaveBeenCalledTimes(1);expect(playbackApi.stop).toHaveBeenCalledWith("playback-one");
 });
 it("aligns resumed copy playback to the prior keyframe while preserving source time",async()=>{
  vi.mocked(playbackApi.create).mockResolvedValue({...session,method:"remux",offset_seconds:290,mime:"application/vnd.apple.mpegurl"});
  player();await waitFor(()=>expect(playbackApi.create).toHaveBeenCalled());const video=document.querySelector("video")!;fireEvent.loadedMetadata(video);
  expect(video.currentTime).toBe(5);video.currentTime=17;fireEvent.timeUpdate(video);fireEvent.pause(video);
  expect(watchApi.progress).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({position_seconds:307}),false);
 });
 it("starts one conversion and watch lifecycle under StrictMode",async()=>{player(true);await ready();expect(playbackApi.create).toHaveBeenCalledTimes(1);expect(watchApi.begin).toHaveBeenCalledTimes(1);});
 it("offers chapters and seeks with an explicit non-watch-credit report",async()=>{
  player();const video=await ready();fireEvent.click(screen.getByRole("button",{name:"Chapters"}));fireEvent.click(screen.getByRole("button",{name:/Opening/}));expect(video.currentTime).toBe(90);
  expect(watchApi.progress).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({position_seconds:90,seeking:true}),false);
 });
 it("cleans up a server session created after navigation away",async()=>{
  let resolve!:(value:PlaybackSession)=>void;vi.mocked(playbackApi.create).mockImplementation(()=>new Promise(value=>{resolve=value;}));
  const rendered=player();await waitFor(()=>expect(playbackApi.create).toHaveBeenCalled());rendered.unmount();resolve(session);
  await waitFor(()=>expect(playbackApi.stop).toHaveBeenCalledWith("playback-one"));
 });
 it("begins a new watch session when a completed movie is replayed",async()=>{
  vi.mocked(playbackApi.info).mockResolvedValue({...info,next:null});
  player();const video=await ready();video.currentTime=1200;fireEvent.timeUpdate(video);fireEvent.ended(video);
  vi.mocked(watchApi.begin).mockResolvedValue({session_id:"watch-two",state:{...state,position_seconds:0}});
  fireEvent.click(screen.getByRole("button",{name:"Play again"}));
  await waitFor(()=>expect(watchApi.begin).toHaveBeenCalledTimes(2));await waitFor(()=>expect(playbackApi.create).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({position_seconds:0})));
  fireEvent.loadedMetadata(video);expect(watchApi.progress).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({session_id:"watch-two",sequence:1,position_seconds:0}),false);
 });
 it("does not display an obsolete watch error after a newer report succeeds",async()=>{
  let rejectOld!:(error:Error)=>void,resolveNew!:(value:typeof state)=>void;
  vi.mocked(watchApi.progress).mockImplementationOnce(()=>new Promise((_resolve,reject)=>{rejectOld=reject;})).mockImplementationOnce(()=>new Promise(resolve=>{resolveNew=resolve;}));
  player();const video=await ready();fireEvent.pause(video);
  await act(async()=>{resolveNew(state);rejectOld(new Error("Stale progress report"));});
  expect(screen.queryByText(/Watch progress could not be saved/)).toBeNull();
 });
 it("clears completed playback and begins a fresh watch session when seeking into a finished movie",async()=>{
  vi.mocked(playbackApi.info).mockResolvedValue({...info,next:null});player();const video=await ready();video.currentTime=1200;fireEvent.timeUpdate(video);fireEvent.ended(video);
  vi.mocked(watchApi.begin).mockResolvedValue({session_id:"watch-two",state:{...state,position_seconds:0}});
  const seek=screen.getByRole("slider",{name:"Seek"});fireEvent.change(seek,{target:{value:"90"}});fireEvent.pointerUp(seek);
  await waitFor(()=>expect(watchApi.begin).toHaveBeenCalledTimes(2));await waitFor(()=>expect(playbackApi.create).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({position_seconds:90})));
  expect(screen.queryByText("Playback completed")).toBeNull();
 });
 it("uses one decode fallback even if the original video fails before metadata loads",async()=>{
  vi.mocked(playbackApi.create).mockResolvedValueOnce(session).mockResolvedValueOnce({...session,id:"converted",method:"transcode"});
  player();await waitFor(()=>expect(playbackApi.create).toHaveBeenCalled());const video=document.querySelector("video")!;fireEvent.error(video);
  await waitFor(()=>expect(playbackApi.create).toHaveBeenCalledTimes(2));expect(playbackApi.create).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({force_transcode:true,position_seconds:295}));
  fireEvent.error(video);await waitFor(()=>expect(screen.getByRole("alert")).toBeTruthy());expect(playbackApi.create).toHaveBeenCalledTimes(2);
 });
});
