import {watchApi} from "./api/watch";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {MemoryRouter,Route,Routes,useNavigate,type NavigateFunction} from "react-router-dom";
import {StrictMode} from "react";
import PlayerPage from "./PlayerPage";
import {playbackApi,defaultPlaybackPreferences,type PlaybackInfo,type PlaybackSession} from "./api/playback";
vi.mock("./api/playback",async importOriginal=>{
 const original=await importOriginal<typeof import("./api/playback")>();
 return {...original,playbackApi:{info:vi.fn(),create:vi.fn(),stop:vi.fn(),heartbeat:vi.fn(),subtitle:vi.fn()}};
});
vi.mock("./api/watch",()=>({watchApi:{preferences:vi.fn(),state:vi.fn(),begin:vi.fn(),progress:vi.fn()}}));
const renderer=vi.hoisted(()=>({construct:vi.fn(),destroy:vi.fn()}));
vi.mock("jassub",()=>({default:class {ready=Promise.resolve();constructor(options:unknown){renderer.construct(options);}destroy(){renderer.destroy();return Promise.resolve();}}}));
const fakeHls=vi.hoisted(()=>({supported:false,errors:[] as ((event:string,data:{fatal:boolean;type:string;details:string})=>void)[],destroy:vi.fn(),recover:vi.fn()}));
vi.mock("hls.js",()=>({default:class {
 static Events={ERROR:"error"};static ErrorTypes={MEDIA_ERROR:"mediaError"};static isSupported(){return fakeHls.supported;}
 on(_event:string,listener:(event:string,data:{fatal:boolean;type:string;details:string})=>void){fakeHls.errors.push(listener);}
 attachMedia(){}loadSource(){}destroy(){fakeHls.destroy();}recoverMediaError(){fakeHls.recover();}
}}));
const info:PlaybackInfo={title:"Maomao",series_title:"The Apothecary Diaries",season:1,episode:1,duration_seconds:1200,chapters:[{title:"Opening",start_seconds:90}],tracks:[{index:1,kind:"video",codec:"h264",width:1920,height:1080},{index:2,kind:"audio",codec:"aac",language:"ja",default:true},{index:3,kind:"audio",codec:"aac",language:"en"}],next:{library_id:"anime",item_id:"two",title:"Episode two"}};
const session:PlaybackSession={id:"playback-one",method:"direct",reason:"Browser supports the source",url:"/api/playback/sessions/one/file",mime:"video/mp4",offset_seconds:0,duration_seconds:1200};
const state={session_id:null,version:0,position_seconds:300,duration_seconds:1200,watched:false,play_count:0,last_played_at:null,audio_index:null,subtitle_index:null};
let navigateInTest:NavigateFunction|undefined;
function CaptureNavigation(){navigateInTest=useNavigate();return null;}
function player(strict=false){const content=<MemoryRouter initialEntries={["/play/native/anime/one?return=%2Fmedia%2FAnime"]}><CaptureNavigation/><Routes><Route path="/play/native/:libraryId/:itemId" element={<PlayerPage/>}/><Route path="/media/Anime" element={<p>Media page</p>}/></Routes></MemoryRouter>;return render(strict?<StrictMode>{content}</StrictMode>:content);}
async function ready(){await waitFor(()=>expect(playbackApi.create).toHaveBeenCalled());const video=document.querySelector("video")!;fireEvent.loadedMetadata(video);await waitFor(()=>expect(screen.getByRole("heading",{name:"S1:E1 – Maomao"})).toBeTruthy());return video;}
beforeEach(()=>{
 fakeHls.supported=false;fakeHls.errors.length=0;
 vi.clearAllMocks();vi.spyOn(HTMLMediaElement.prototype,"load").mockImplementation(()=>{});vi.spyOn(HTMLMediaElement.prototype,"pause").mockImplementation(()=>{});vi.spyOn(HTMLMediaElement.prototype,"play").mockResolvedValue();vi.spyOn(HTMLMediaElement.prototype,"canPlayType").mockReturnValue("probably");
 vi.mocked(playbackApi.info).mockResolvedValue(info);vi.mocked(watchApi.preferences).mockResolvedValue(defaultPlaybackPreferences);vi.mocked(watchApi.state).mockResolvedValue(state);vi.mocked(watchApi.begin).mockResolvedValue({session_id:"watch-one",state});vi.mocked(playbackApi.create).mockResolvedValue(session);vi.mocked(playbackApi.stop).mockResolvedValue();vi.mocked(watchApi.progress).mockResolvedValue({...state,audio_index:2,subtitle_index:-1});vi.mocked(playbackApi.heartbeat).mockResolvedValue();
});
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
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
 it("retries failed watch initialization before creating any playable session",async()=>{
  vi.mocked(watchApi.begin).mockRejectedValueOnce(new Error("Watch store temporarily unavailable")).mockResolvedValueOnce({session_id:"watch-retried",state});
  player();await screen.findByText("Watch store temporarily unavailable");expect(playbackApi.create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:"Retry compatible playback"}));const video=await ready();video.currentTime=310;fireEvent.timeUpdate(video);fireEvent.pause(video);
  expect(watchApi.begin).toHaveBeenCalledTimes(2);expect(playbackApi.create).toHaveBeenCalledTimes(1);
  expect(watchApi.progress).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({session_id:"watch-retried",position_seconds:310}),false);
 });
 it("retries the information stage rather than leaving the retry button ineffective",async()=>{
  vi.mocked(playbackApi.info).mockRejectedValueOnce(new Error("Video information unavailable")).mockResolvedValueOnce(info);
  player();await screen.findByText("Video information unavailable");fireEvent.click(screen.getByRole("button",{name:"Retry compatible playback"}));await ready();
  expect(playbackApi.info).toHaveBeenCalledTimes(2);expect(watchApi.begin).toHaveBeenCalledTimes(1);expect(playbackApi.create).toHaveBeenCalledTimes(1);
 });
 it("stops the previous direct source and blocks old controls while the next episode loads",async()=>{
  let resolveNext!:(value:PlaybackInfo)=>void;
  vi.mocked(playbackApi.info).mockResolvedValueOnce(info).mockImplementationOnce(()=>new Promise(resolve=>{resolveNext=resolve;}));
  vi.mocked(watchApi.begin).mockResolvedValueOnce({session_id:"watch-one",state}).mockResolvedValueOnce({session_id:"watch-next",state:{...state,position_seconds:0}});
  player();const video=await ready();video.currentTime=450;fireEvent.timeUpdate(video);vi.mocked(video.pause).mockClear();
  fireEvent.click(screen.getByRole("button",{name:"Next episode"}));
  await waitFor(()=>expect(playbackApi.info).toHaveBeenLastCalledWith("anime","two",expect.any(AbortSignal)));
  expect(video.pause).toHaveBeenCalled();expect(video.getAttribute("src")).toBeNull();
  expect((screen.getByRole("button",{name:"Play"}) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button",{name:"Playback quality"}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button",{name:"Playback quality"}));fireEvent.keyDown(document,{key:"ArrowRight"});fireEvent.click(video);
  expect(playbackApi.create).toHaveBeenCalledTimes(1);
  await act(async()=>resolveNext({...info,title:"Next episode",episode:2,next:null}));
  await waitFor(()=>expect(playbackApi.create).toHaveBeenLastCalledWith("anime","two",expect.objectContaining({position_seconds:0})));
  fireEvent.loadedMetadata(video);expect(watchApi.progress).toHaveBeenLastCalledWith("anime","two",expect.objectContaining({session_id:"watch-next",position_seconds:0}),false);
 });
 it("ignores information arriving for an episode after its route has been replaced",async()=>{
  let resolvePrevious!:(value:PlaybackInfo)=>void;
  vi.mocked(playbackApi.info).mockImplementationOnce(()=>new Promise(resolve=>{resolvePrevious=resolve;})).mockResolvedValueOnce({...info,title:"Next episode",episode:2,next:null});
  player();await waitFor(()=>expect(playbackApi.info).toHaveBeenCalled());await act(async()=>{void navigateInTest?.("/play/native/anime/two?return=%2Fmedia%2FAnime");});
  await waitFor(()=>expect(playbackApi.create).toHaveBeenCalledTimes(1));await act(async()=>resolvePrevious(info));
  expect(playbackApi.create).toHaveBeenLastCalledWith("anime","two",expect.any(Object));expect(watchApi.begin).toHaveBeenCalledTimes(1);expect(watchApi.begin).toHaveBeenCalledWith("anime","two");
 });
 it("preserves the actual playback position at EOF when probe duration is unknown",async()=>{
  vi.mocked(playbackApi.info).mockResolvedValue({...info,duration_seconds:0,next:null});vi.mocked(playbackApi.create).mockResolvedValue({...session,duration_seconds:0});
  player();const video=await ready();video.currentTime=77;fireEvent.ended(video);
  expect(watchApi.progress).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({position_seconds:77,ended:true}),false);
 });
 it("applies plain-text cue appearance and placement while preserving source timing after a seek",async()=>{
  const cue={startTime:300,endTime:310,line:35,snapToLines:false,position:25,align:"end"} as VTTCue;
  const textTrack={mode:"disabled",cues:[cue],removeCue:vi.fn()};
  const create=document.createElement.bind(document);
  vi.spyOn(document,"createElement").mockImplementation((tag,options)=>{const element=create(tag,options);if(tag==="track")Object.defineProperty(element,"track",{value:textTrack});return element;});
  const OriginalURL=URL;vi.stubGlobal("URL",class extends OriginalURL {static createObjectURL(){return "blob:subtitles";}static revokeObjectURL(){}});
  vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response("WEBVTT\n\n00:05:00.000 --> 00:05:10.000\nHello"));
  vi.mocked(watchApi.preferences).mockResolvedValue({...defaultPlaybackPreferences,subtitle_color:"#ffee00",subtitle_shadow:"outline",subtitle_background:"none",subtitle_position:"top"});
  vi.mocked(playbackApi.info).mockResolvedValue({...info,tracks:[...info.tracks,{index:4,kind:"subtitle",codec:"subrip",subtitle_format:"vtt",default:true,url:"/subtitle.vtt"}]});
  vi.mocked(playbackApi.create).mockResolvedValue({...session,method:"remux",offset_seconds:290,mime:"application/vnd.apple.mpegurl"});
  player();await ready();await waitFor(()=>expect(document.querySelector("track")).toBeTruthy());fireEvent.load(document.querySelector("track")!);
  expect(cue.startTime).toBe(10);expect(cue.endTime).toBe(20);expect(cue.line).toBe(0);expect(cue.snapToLines).toBe(true);expect(cue.position).toBe(25);expect(cue.align).toBe("end");
  const styles=(document.querySelector(".pv-player") as HTMLElement).style;
  expect(styles.getPropertyValue("--subtitle-color")).toBe("#ffee00");expect(styles.getPropertyValue("--subtitle-background")).toBe("transparent");expect(styles.getPropertyValue("--subtitle-shadow")).toContain("1px 1px 0 #000");
  expect(renderer.construct).not.toHaveBeenCalled();
 });
 it("keeps ASS rendering and embedded fonts independent of plain-text appearance preferences",async()=>{
  vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response("[Script Info]\n[Events]\n"));
  vi.mocked(watchApi.preferences).mockResolvedValue({...defaultPlaybackPreferences,subtitle_color:"#ffee00",subtitle_shadow:"outline",subtitle_background:"light",subtitle_position:"top"});
  vi.mocked(playbackApi.info).mockResolvedValue({...info,tracks:[...info.tracks,{index:4,kind:"subtitle",codec:"ass",subtitle_format:"ass",default:true,url:"/subtitle.ass"}],fonts:[{index:5,name:"Font.ttf",url:"/font.ttf"}]});
  player();const video=await ready();await waitFor(()=>expect(renderer.construct).toHaveBeenCalled());
  expect(renderer.construct).toHaveBeenCalledWith({video,subContent:"[Script Info]\n[Events]\n",fonts:["/font.ttf"],timeOffset:0,queryFonts:false});
  expect(document.querySelector("track")).toBeNull();
 });
 it("stops a terminal native decode failure, flushes once, and resumes heartbeats only after Retry",async()=>{
  vi.useFakeTimers({shouldAdvanceTime:true});
  vi.mocked(playbackApi.create).mockResolvedValueOnce({...session,method:"transcode"}).mockResolvedValueOnce({...session,id:"retried-job",method:"transcode"});
  player();const video=await ready();video.currentTime=310;fireEvent.timeUpdate(video);vi.mocked(video.pause).mockClear();const before=vi.mocked(watchApi.progress).mock.calls.length;
  fireEvent.error(video);await screen.findByRole("alert");
  expect(video.pause).toHaveBeenCalled();expect(playbackApi.stop).toHaveBeenCalledWith("playback-one");
  expect(video.getAttribute("src")).toBeNull();
  expect((screen.getByRole("button",{name:"Play"}) as HTMLButtonElement).disabled).toBe(true);
  vi.mocked(video.play).mockClear();fireEvent.click(video);fireEvent.keyDown(document,{key:"k"});expect(video.play).not.toHaveBeenCalled();
  expect(watchApi.progress).toHaveBeenCalledTimes(before+1);expect(watchApi.progress).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({session_id:"watch-one",position_seconds:310}),false);
  await act(async()=>{await vi.advanceTimersByTimeAsync(20_000);});expect(playbackApi.heartbeat).not.toHaveBeenCalled();expect(watchApi.progress).toHaveBeenCalledTimes(before+1);
  fireEvent.click(screen.getByRole("button",{name:"Retry compatible playback"}));await waitFor(()=>expect(playbackApi.create).toHaveBeenCalledTimes(2));fireEvent.loadedMetadata(video);
  expect(watchApi.begin).toHaveBeenCalledTimes(1);expect(playbackApi.create).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({position_seconds:310,force_transcode:true}));
  await act(async()=>{await vi.advanceTimersByTimeAsync(10_000);});expect(playbackApi.heartbeat).toHaveBeenCalledWith("retried-job",310,true);
 });
 it("stops terminal HLS failures after one compatible fallback and ignores duplicate stale errors",async()=>{
  fakeHls.supported=true;
  vi.mocked(playbackApi.create).mockResolvedValueOnce({...session,method:"remux",mime:"application/vnd.apple.mpegurl"}).mockResolvedValueOnce({...session,id:"converted",method:"transcode",mime:"application/vnd.apple.mpegurl"}).mockResolvedValueOnce({...session,id:"retry",method:"transcode",mime:"application/vnd.apple.mpegurl"});
  player();const video=await ready();video.currentTime=320;fireEvent.timeUpdate(video);
  await act(async()=>fakeHls.errors[0]("error",{fatal:true,type:"networkError",details:"fragLoadError"}));await waitFor(()=>expect(playbackApi.create).toHaveBeenCalledTimes(2));fireEvent.loadedMetadata(video);
  const last=fakeHls.errors[1],before=vi.mocked(watchApi.progress).mock.calls.length;vi.mocked(video.pause).mockClear();
  await act(async()=>last("error",{fatal:true,type:"networkError",details:"fragLoadError"}));expect(screen.getByRole("alert")).toBeTruthy();expect(video.pause).toHaveBeenCalled();expect(playbackApi.stop).toHaveBeenCalledWith("converted");expect(fakeHls.destroy).toHaveBeenCalledTimes(2);
  await act(async()=>last("error",{fatal:true,type:"networkError",details:"fragLoadError"}));expect(watchApi.progress).toHaveBeenCalledTimes(before+1);expect(playbackApi.create).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button",{name:"Retry compatible playback"}));await waitFor(()=>expect(playbackApi.create).toHaveBeenCalledTimes(3));expect(watchApi.begin).toHaveBeenCalledTimes(1);
 });
});
