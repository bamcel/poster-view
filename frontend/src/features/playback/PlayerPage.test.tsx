import {watchApi} from "./api/watch";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {MemoryRouter,Route,Routes,useNavigate,type NavigateFunction} from "react-router-dom";
import {StrictMode} from "react";
import PlayerPage from "./PlayerPage";
import {playbackApi,defaultPlaybackPreferences,type PlaybackInfo,type PlaybackSession} from "./api/playback";
import type {NativeAudioList} from "./lib/nativeAudio";
vi.mock("./api/playback",async importOriginal=>{
 const original=await importOriginal<typeof import("./api/playback")>();
 return {...original,playbackApi:{info:vi.fn(),create:vi.fn(),stop:vi.fn(),heartbeat:vi.fn(),subtitle:vi.fn()}};
});
vi.mock("./api/watch",()=>({watchApi:{preferences:vi.fn(),state:vi.fn(),begin:vi.fn(),progress:vi.fn()}}));
const renderer=vi.hoisted(()=>({construct:vi.fn(),destroy:vi.fn()}));
vi.mock("jassub",()=>({default:class {ready=Promise.resolve();constructor(options:unknown){renderer.construct(options);}destroy(){renderer.destroy();return Promise.resolve();}}}));
type HlsFailure={fatal:boolean;type:string;details:string;response?:{code:number}};
type HlsLevel={details:{fragments:{start:number;end:number;gap?:boolean}[]}};
const fakeHls=vi.hoisted(()=>({supported:false,live:false,fragments:[] as {start:number;end:number;gap?:boolean}[],errors:[] as ((event:string,data:HlsFailure)=>void)[],levels:[] as ((event:string,data:HlsLevel)=>void)[],configs:[] as unknown[],destroy:vi.fn(),recover:vi.fn(),startLoad:vi.fn()}));
vi.mock("hls.js",()=>({default:class {
 constructor(config:unknown){fakeHls.configs.push(config);}
 static Events={ERROR:"error",LEVEL_LOADED:"levelLoaded"};static ErrorTypes={MEDIA_ERROR:"mediaError"};static isSupported(){return fakeHls.supported;}
 get latestLevelDetails(){return {fragments:fakeHls.fragments,live:fakeHls.live,fragmentEnd:Math.max(0,...fakeHls.fragments.map(fragment=>fragment.end))};}
 on(event:string,listener:((event:string,data:HlsFailure)=>void)|((event:string,data:HlsLevel)=>void)){if(event==="error")fakeHls.errors.push(listener as (event:string,data:HlsFailure)=>void);else fakeHls.levels.push(listener as (event:string,data:HlsLevel)=>void);}
 off(_event:string,listener:unknown){fakeHls.levels=fakeHls.levels.filter(value=>value!==listener);}
 startLoad(position:number,skip:boolean){fakeHls.startLoad(position,skip);}
 attachMedia(){}loadSource(){}destroy(){fakeHls.destroy();}recoverMediaError(){fakeHls.recover();}
}}));
const info:PlaybackInfo={conversion_allowed:true,title:"Maomao",series_title:"The Apothecary Diaries",season:1,episode:1,duration_seconds:1200,chapters:[{title:"Opening",start_seconds:90}],tracks:[{index:1,kind:"video",codec:"h264",width:1920,height:1080},{index:2,kind:"audio",codec:"aac",language:"ja",default:true},{index:3,kind:"audio",codec:"aac",language:"en"}],next:{library_id:"anime",item_id:"two",title:"Episode two"}};
const session:PlaybackSession={id:"playback-one",method:"direct",reason:"Browser supports the source",url:"/api/playback/sessions/one/file",mime:"video/mp4",offset_seconds:0,duration_seconds:1200};
const state={session_id:null,version:0,position_seconds:300,duration_seconds:1200,watched:false,play_count:0,last_played_at:null,audio_index:null,subtitle_index:null};
let navigateInTest:NavigateFunction|undefined;
let browserAudio:NativeAudioList|undefined;
const originalAudioProperty=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,"audioTracks");
const audioList=(tracks:NativeAudioList[number][])=>Object.assign({length:tracks.length},tracks) as NativeAudioList;
function CaptureNavigation(){navigateInTest=useNavigate();return null;}
function player(strict=false){const content=<MemoryRouter initialEntries={["/play/native/anime/one?return=%2Fmedia%2FAnime"]}><CaptureNavigation/><Routes><Route path="/play/native/:libraryId/:itemId" element={<PlayerPage/>}/><Route path="/media/Anime" element={<p>Media page</p>}/></Routes></MemoryRouter>;return render(strict?<StrictMode>{content}</StrictMode>:content);}
async function ready(){await waitFor(()=>expect(playbackApi.create).toHaveBeenCalled());const video=document.querySelector("video")!;fireEvent.loadedMetadata(video);fireEvent.seeked(video);await waitFor(()=>expect(screen.getByRole("heading",{name:"S1:E1 – Maomao"})).toBeTruthy());return video;}
function mediaRanges(...values:[number,number][]){return {length:values.length,start:(index:number)=>values[index][0],end:(index:number)=>values[index][1]};}
function scrubTo(value:number){const slider=screen.getByRole("slider",{name:"Seek"});fireEvent.change(slider,{target:{value:String(value)}});fireEvent.pointerUp(slider);return slider as HTMLInputElement;}
beforeEach(()=>{
 browserAudio=undefined;Object.defineProperty(HTMLMediaElement.prototype,"audioTracks",{get:()=>browserAudio,configurable:true});
 fakeHls.supported=false;fakeHls.live=false;fakeHls.fragments=[];fakeHls.errors.length=0;fakeHls.levels=[];fakeHls.configs=[];
 vi.clearAllMocks();vi.spyOn(HTMLMediaElement.prototype,"load").mockImplementation(()=>{});vi.spyOn(HTMLMediaElement.prototype,"pause").mockImplementation(()=>{});vi.spyOn(HTMLMediaElement.prototype,"play").mockResolvedValue();vi.spyOn(HTMLMediaElement.prototype,"canPlayType").mockReturnValue("probably");
 vi.mocked(playbackApi.info).mockResolvedValue(info);vi.mocked(watchApi.preferences).mockResolvedValue(defaultPlaybackPreferences);vi.mocked(watchApi.state).mockResolvedValue(state);vi.mocked(watchApi.begin).mockResolvedValue({session_id:"watch-one",state});vi.mocked(playbackApi.create).mockResolvedValue(session);vi.mocked(playbackApi.stop).mockResolvedValue();vi.mocked(watchApi.progress).mockResolvedValue({...state,audio_index:2,subtitle_index:-1});vi.mocked(playbackApi.heartbeat).mockResolvedValue();
});
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();if(originalAudioProperty)Object.defineProperty(HTMLMediaElement.prototype,"audioTracks",originalAudioProperty);else Reflect.deleteProperty(HTMLMediaElement.prototype,"audioTracks");});
describe("native player",()=>{
 it("plays original MKV with dual Opus audio, honestly falls back to default audio, and seeks without reloading",async()=>{
  const original={...info,conversion_allowed:false,container:"mkv",tracks:[{index:1,kind:"video",codec:"hevc",bit_depth:10},{index:2,kind:"audio",codec:"opus",language:"ja"},{index:3,kind:"audio",codec:"opus",language:"en",default:true}]};
  vi.mocked(playbackApi.info).mockResolvedValue(original);vi.mocked(watchApi.state).mockResolvedValue({...state,audio_index:2});vi.mocked(playbackApi.create).mockResolvedValue({...session,mime:"video/x-matroska",audio_index:3});
  player();const video=await ready();expect(playbackApi.create).toHaveBeenCalledWith("anime","one",expect.objectContaining({audio_index:3,native_audio_tracks:false,containers:expect.arrayContaining(["mkv"]),audio_codecs:expect.arrayContaining(["opus"]),max_height:0,max_bitrate:0,force_transcode:false,subtitle_burn_index:null}));
  expect(screen.getByText(/instead of your saved audio preference/)).toBeTruthy();fireEvent.click(screen.getByRole("button",{name:"Audio"}));
  expect((screen.getByRole("button",{name:/Japanese/}) as HTMLButtonElement).disabled).toBe(true);expect(screen.getByRole("button",{name:/English/}).getAttribute("aria-pressed")).toBe("true");
  vi.mocked(video.load).mockClear();const slider=scrubTo(900);expect(video.currentTime).toBe(900);expect(slider.value).toBe("900");expect(playbackApi.create).toHaveBeenCalledTimes(1);expect(playbackApi.stop).not.toHaveBeenCalled();expect(video.load).not.toHaveBeenCalled();
  expect(watchApi.progress).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({position_seconds:900,audio_index:3,seeking:true}),false);
 });
 it("treats a missing conversion policy as original-only and stops decoding failures without automatic conversion",async()=>{
  vi.mocked(playbackApi.info).mockResolvedValue({...info,conversion_allowed:undefined,tracks:info.tracks.map(track=>track.kind==="video"?{...track,profile:"High 10",bit_depth:10}:track)});vi.mocked(HTMLMediaElement.prototype.canPlayType).mockImplementation(type=>type.includes("6E0028")?"":"probably");player();const video=await ready();fireEvent.error(video);
  await screen.findByText("This browser cannot play the original file. Media conversion is disabled.");expect(playbackApi.create).toHaveBeenCalledTimes(1);expect(playbackApi.stop).toHaveBeenCalledWith("playback-one");expect(video.getAttribute("src")).toBeNull();expect(fakeHls.recover).not.toHaveBeenCalled();
  expect(playbackApi.create).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({force_transcode:false,max_height:0,max_bitrate:0}));
  fireEvent.click(screen.getByRole("button",{name:"Retry original playback"}));await waitFor(()=>expect(playbackApi.create).toHaveBeenCalledTimes(2));expect(playbackApi.create).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({force_transcode:false}));expect(watchApi.begin).toHaveBeenCalledTimes(1);
 });
 it("stops an original-source play rejection without waiting for another error event or encoding retry",async()=>{
  vi.mocked(playbackApi.info).mockResolvedValue({...info,conversion_allowed:false});vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new DOMException("Unsupported original","NotSupportedError"));
  player();await waitFor(()=>expect(playbackApi.create).toHaveBeenCalled());fireEvent.loadedMetadata(document.querySelector("video")!);
  await screen.findByText("This browser cannot play the original file. Media conversion is disabled.");expect(playbackApi.create).toHaveBeenCalledTimes(1);expect(playbackApi.stop).toHaveBeenCalledWith("playback-one");
 });
 it("rejects an unexpected converted response instead of attaching or retrying it in original mode",async()=>{
  fakeHls.supported=true;vi.mocked(playbackApi.info).mockResolvedValue({...info,conversion_allowed:false});vi.mocked(playbackApi.create).mockResolvedValue({...session,method:"audio_transcode",mime:"application/vnd.apple.mpegurl"});
  player();await screen.findByText(/server returned converted playback while media conversion is disabled/);expect(playbackApi.create).toHaveBeenCalledTimes(1);expect(playbackApi.stop).toHaveBeenCalledWith("playback-one");expect(fakeHls.configs).toHaveLength(0);expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
 });
 it("disables encoded qualities, subtitle burn-in, and image subtitles in original mode with usable explanations",async()=>{
  vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response("",{status:404}));
  vi.mocked(playbackApi.info).mockResolvedValue({...info,conversion_allowed:false,tracks:[...info.tracks,{index:4,kind:"subtitle",codec:"subrip",subtitle_format:"vtt",default:true,url:"/subtitle.vtt"},{index:5,kind:"subtitle",codec:"PGS",subtitle_format:"image"}]});
  player();await ready();await screen.findByText(/Choose another text subtitle track; media conversion is disabled/);fireEvent.click(screen.getByRole("button",{name:"Playback quality"}));
  expect((screen.getByRole("button",{name:"Original"}) as HTMLButtonElement).disabled).toBe(false);expect((screen.getByRole("button",{name:"1080p · 8 Mbps"}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button",{name:"1080p · 8 Mbps"}));expect(playbackApi.create).toHaveBeenCalledTimes(1);fireEvent.click(screen.getByRole("button",{name:"Close menu"}));fireEvent.click(screen.getByRole("button",{name:"Subtitles"}));
  expect((screen.getByRole("button",{name:/PGS/}) as HTMLButtonElement).disabled).toBe(true);expect((screen.getByRole("checkbox",{name:"Burn subtitles into video"}) as HTMLInputElement).disabled).toBe(true);expect(screen.getByText(/image subtitles and burn-in are unavailable/)).toBeTruthy();
  expect(playbackApi.create).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({subtitle_index:4,subtitle_burn_index:null,force_transcode:false}));
 });
 it("does not select an image subtitle preference when original playback cannot render it",async()=>{
  vi.mocked(playbackApi.info).mockResolvedValue({...info,conversion_allowed:false,tracks:[...info.tracks,{index:5,kind:"subtitle",codec:"PGS",subtitle_format:"image",default:true}]});
  player();await ready();expect(screen.getByText(/Image subtitles need media conversion/)).toBeTruthy();expect(playbackApi.create).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({subtitle_index:null,subtitle_burn_index:null,force_transcode:false}));
 });
 it("validates remembered native audio after metadata and switches its enabled flags without another source or session",async()=>{
  browserAudio=audioList([]);const original={...info,conversion_allowed:false,tracks:info.tracks.map(track=>track.kind==="audio"?{...track,default:track.index===3}:track)};
  vi.mocked(playbackApi.info).mockResolvedValue(original);vi.mocked(watchApi.state).mockResolvedValue({...state,audio_index:2});vi.mocked(playbackApi.create).mockResolvedValue({...session,audio_index:2});
  player();await waitFor(()=>expect(playbackApi.create).toHaveBeenCalled());expect(playbackApi.create).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({native_audio_tracks:true,audio_index:2,force_transcode:false}));
  const english={id:"container-900",language:"eng",enabled:true},japanese={id:"container-42",language:"jpn",enabled:false};browserAudio=audioList([english,japanese]);const video=document.querySelector("video")!;fireEvent.loadedMetadata(video);fireEvent.seeked(video);
  expect(japanese.enabled).toBe(true);expect(english.enabled).toBe(false);vi.mocked(video.load).mockClear();const source=video.getAttribute("src");
  fireEvent.click(screen.getByRole("button",{name:"Audio"}));expect((screen.getByRole("button",{name:/English/}) as HTMLButtonElement).disabled).toBe(false);fireEvent.click(screen.getByRole("button",{name:/English/}));
  expect(english.enabled).toBe(true);expect(japanese.enabled).toBe(false);expect(video.getAttribute("src")).toBe(source);expect(video.load).not.toHaveBeenCalled();expect(playbackApi.create).toHaveBeenCalledTimes(1);expect(playbackApi.stop).not.toHaveBeenCalled();
  expect(watchApi.progress).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({audio_index:3}),false);expect(watchApi.begin).toHaveBeenCalledTimes(1);
 });
 it("stops when a requested nondefault audio track cannot be mapped rather than playing the wrong language",async()=>{
  browserAudio=audioList([]);vi.mocked(playbackApi.info).mockResolvedValue({...info,conversion_allowed:false,tracks:info.tracks.map(track=>track.kind==="audio"?{...track,default:track.index===3}:track)});vi.mocked(watchApi.state).mockResolvedValue({...state,audio_index:2});vi.mocked(playbackApi.create).mockResolvedValue({...session,audio_index:2});
  player();await waitFor(()=>expect(playbackApi.create).toHaveBeenCalled());browserAudio=audioList([{id:"2",enabled:true},{id:"3",enabled:false}]);fireEvent.loadedMetadata(document.querySelector("video")!);
  await screen.findByText(/could not identify the requested audio track/);expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();expect(playbackApi.create).toHaveBeenCalledTimes(1);expect(playbackApi.stop).toHaveBeenCalledWith("playback-one");
  fireEvent.click(screen.getByRole("button",{name:"Audio"}));expect((screen.getByRole("button",{name:/Japanese/}) as HTMLButtonElement).disabled).toBe(true);expect((screen.getByRole("button",{name:/English/}) as HTMLButtonElement).disabled).toBe(false);
 });
 it("allows original default audio when the native mapping is inconclusive",async()=>{
  browserAudio=audioList([]);vi.mocked(playbackApi.info).mockResolvedValue({...info,conversion_allowed:false,tracks:info.tracks.map(track=>track.kind==="audio"?{...track,default:track.index===3}:track)});vi.mocked(playbackApi.create).mockResolvedValue({...session,audio_index:3});
  player();await waitFor(()=>expect(playbackApi.create).toHaveBeenCalled());browserAudio=audioList([{enabled:false},{enabled:true}]);fireEvent.loadedMetadata(document.querySelector("video")!);fireEvent.seeked(document.querySelector("video")!);
  expect(screen.queryByRole("alert")).toBeNull();expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();fireEvent.click(screen.getByRole("button",{name:"Audio"}));expect(screen.getByText(/default audio is playing. Other tracks cannot be mapped/)).toBeTruthy();
 });
 it.each([
  ["a Japanese-only partial list",[{language:"jpn",enabled:true}]],
  ["a mixed identified and unknown list",[{language:"jpn",enabled:true},{enabled:false},{enabled:false}]],
 ])("rejects a requested English default contradicted by %s",async(_name,tracks)=>{
  browserAudio=audioList([]);vi.mocked(playbackApi.info).mockResolvedValue({...info,conversion_allowed:false,tracks:info.tracks.map(track=>track.kind==="audio"?{...track,default:track.index===3}:track)});vi.mocked(playbackApi.create).mockResolvedValue({...session,audio_index:3});
  player();await waitFor(()=>expect(playbackApi.create).toHaveBeenCalled());browserAudio=audioList(tracks as NativeAudioList[number][]);fireEvent.loadedMetadata(document.querySelector("video")!);
  await screen.findByText(/does not expose the requested default audio track/);expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();expect(playbackApi.create).toHaveBeenCalledTimes(1);expect(playbackApi.stop).toHaveBeenCalledWith("playback-one");
  expect(document.querySelector("video")!.getAttribute("src")).toBeNull();fireEvent.click(screen.getByRole("button",{name:"Audio"}));expect(screen.getByRole("button",{name:/English/}).getAttribute("aria-pressed")).toBe("false");
 });
 it("keeps styled ASS subtitles and embedded fonts available with conversion disabled",async()=>{
  vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response("[Script Info]\n[Events]\n"));vi.mocked(playbackApi.info).mockResolvedValue({...info,conversion_allowed:false,tracks:[...info.tracks,{index:4,kind:"subtitle",codec:"ass",subtitle_format:"ass",default:true,url:"/subtitle.ass"}],fonts:[{index:5,name:"Font.ttf",url:"/font.ttf"}]});
  player();const video=await ready();await waitFor(()=>expect(renderer.construct).toHaveBeenCalledWith({video,subContent:"[Script Info]\n[Events]\n",fonts:["/font.ttf"],timeOffset:0,queryFonts:false}));expect(playbackApi.create).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({force_transcode:false,subtitle_burn_index:null}));
 });
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
  player();await waitFor(()=>expect(playbackApi.create).toHaveBeenCalled());const video=document.querySelector("video")!;fireEvent.loadedMetadata(video);fireEvent.seeked(video);
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
  fireEvent.loadedMetadata(video);expect(watchApi.progress).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({session_id:"watch-two",position_seconds:0,seeking:true}),false);
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
  player();await screen.findByText("Video information unavailable");fireEvent.click(screen.getByRole("button",{name:"Retry playback"}));await ready();
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
 it("seeks immediately inside buffered HLS ranges without replacing the source or watch token",async()=>{
  fakeHls.supported=true;vi.mocked(playbackApi.create).mockResolvedValue({...session,method:"remux",mime:"application/vnd.apple.mpegurl",offset_seconds:290});
  player();const video=await ready();Object.defineProperty(video,"buffered",{value:mediaRanges([0,15],[25,45]),configurable:true});vi.mocked(video.load).mockClear();
  const slider=scrubTo(320);expect(video.currentTime).toBe(30);expect(slider.value).toBe("320");
  expect(playbackApi.create).toHaveBeenCalledTimes(1);expect(playbackApi.stop).not.toHaveBeenCalled();expect(video.load).not.toHaveBeenCalled();expect(fakeHls.destroy).not.toHaveBeenCalled();expect(watchApi.begin).toHaveBeenCalledTimes(1);
  expect(watchApi.progress).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({position_seconds:320,seeking:true,playback_session_id:"playback-one"}),false);
  fireEvent.seeked(video);video.currentTime=31;fireEvent.timeUpdate(video);expect(slider.value).toBe("321");
 });
 it("reuses retained HLS fragments and finite native HLS seekable ranges",async()=>{
  fakeHls.supported=true;fakeHls.fragments=[{start:20,end:30},{start:30,end:40,gap:true}];
  vi.mocked(playbackApi.create).mockResolvedValue({...session,method:"audio_transcode",mime:"application/vnd.apple.mpegurl",offset_seconds:290});
  player();const video=await ready();scrubTo(315);expect(video.currentTime).toBe(25);expect(playbackApi.create).toHaveBeenCalledTimes(1);
  fireEvent.seeked(video);scrubTo(325);await waitFor(()=>expect(playbackApi.create).toHaveBeenCalledTimes(2));
  expect(playbackApi.create).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({position_seconds:325}));
 });
 it("uses native HLS seekable intervals without restarting the server",async()=>{
  vi.mocked(playbackApi.create).mockResolvedValue({...session,method:"remux",mime:"application/vnd.apple.mpegurl",offset_seconds:290});
  player();const video=await ready();Object.defineProperty(video,"seekable",{value:mediaRanges([0,60]),configurable:true});
  scrubTo(330);expect(video.currentTime).toBe(40);expect(playbackApi.create).toHaveBeenCalledTimes(1);expect(playbackApi.stop).not.toHaveBeenCalled();
 });
 it("notifies the producer immediately on Play, Pause, and a valid local seek",async()=>{
  player();const video=await ready();await act(async()=>{});vi.mocked(playbackApi.heartbeat).mockClear();
  Object.defineProperty(video,"paused",{value:true,writable:true,configurable:true});fireEvent.pause(video);
  await waitFor(()=>expect(playbackApi.heartbeat).toHaveBeenLastCalledWith("playback-one",295,true));
  fireEvent.click(screen.getByRole("button",{name:"Play"}));await waitFor(()=>expect(playbackApi.heartbeat).toHaveBeenLastCalledWith("playback-one",295,false));
  Object.defineProperty(video,"paused",{value:false,writable:true});fireEvent.play(video);scrubTo(325);
  await waitFor(()=>expect(playbackApi.heartbeat).toHaveBeenLastCalledWith("playback-one",325,false));
  expect(playbackApi.create).toHaveBeenCalledTimes(1);expect(watchApi.begin).toHaveBeenCalledTimes(1);
  expect(watchApi.progress).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({position_seconds:325,seeking:true}),false);
 });
 it("sends one production demand per waiting period rather than waiting for the ten-second timer",async()=>{
  player();const video=await ready();Object.defineProperty(video,"paused",{value:false,writable:true,configurable:true});Object.defineProperty(video,"readyState",{value:2,writable:true,configurable:true});fireEvent.play(video);await act(async()=>{});vi.mocked(playbackApi.heartbeat).mockClear();
  fireEvent.waiting(video);await waitFor(()=>expect(playbackApi.heartbeat).toHaveBeenCalledWith("playback-one",295,false));await act(async()=>{});fireEvent.waiting(video);expect(playbackApi.heartbeat).toHaveBeenCalledTimes(1);
  Object.defineProperty(video,"readyState",{value:4,writable:true});fireEvent.canPlay(video);expect(screen.queryByText("Buffering…")).toBeNull();
  Object.defineProperty(video,"readyState",{value:2,writable:true});fireEvent.waiting(video);await waitFor(()=>expect(playbackApi.heartbeat).toHaveBeenCalledTimes(2));
 });
 it("clears a paused seek's buffering indicator as soon as its preview frame is ready without autoplay",async()=>{
  fakeHls.supported=true;vi.mocked(playbackApi.create).mockResolvedValue({...session,method:"audio_transcode",mime:"application/vnd.apple.mpegurl",offset_seconds:290});
  player();const video=await ready();Object.defineProperty(video,"buffered",{value:mediaRanges([0,80]),configurable:true});Object.defineProperty(video,"readyState",{value:1,writable:true,configurable:true});vi.mocked(video.play).mockClear();
  scrubTo(330);fireEvent.waiting(video);expect(screen.getByText("Buffering…")).toBeTruthy();Object.defineProperty(video,"readyState",{value:2,writable:true});fireEvent.seeked(video);
  expect(screen.queryByText("Buffering…")).toBeNull();expect(video.play).not.toHaveBeenCalled();expect(playbackApi.create).toHaveBeenCalledTimes(1);
  await waitFor(()=>expect(playbackApi.heartbeat).toHaveBeenLastCalledWith("playback-one",330,true));
 });
 it("applies a larger bounded buffer target for known low-bitrate copied video",async()=>{
  fakeHls.supported=true;vi.mocked(playbackApi.info).mockResolvedValue({...info,tracks:info.tracks.map(track=>track.kind==="video"?{...track,bitrate:3_000_000}:track)});vi.mocked(playbackApi.create).mockResolvedValue({...session,method:"audio_transcode",mime:"application/vnd.apple.mpegurl"});
  player();await ready();expect(fakeHls.configs[0]).toEqual(expect.objectContaining({maxBufferLength:60,maxMaxBufferLength:60,maxBufferSize:60_000_000}));
 });
 it("refreshes a stale live playlist for a nearby forward target without replacing the source",async()=>{
  fakeHls.supported=true;fakeHls.live=true;fakeHls.fragments=[{start:0,end:60}];vi.mocked(playbackApi.create).mockResolvedValue({...session,method:"audio_transcode",mime:"application/vnd.apple.mpegurl",offset_seconds:290});
  player();const video=await ready();Object.defineProperty(video,"paused",{value:false,writable:true,configurable:true});await act(async()=>{});vi.mocked(playbackApi.heartbeat).mockClear();vi.mocked(video.load).mockClear();
  let clock=video.currentTime,clamp=true;Object.defineProperty(video,"currentTime",{get:()=>clock,set:(value:number)=>{clock=clamp?Math.min(value,59):value;},configurable:true});
  const slider=scrubTo(360);expect(fakeHls.startLoad).toHaveBeenCalledWith(70,true);expect(clock).toBe(59);expect(slider.value).toBe("360");expect(playbackApi.create).toHaveBeenCalledTimes(1);
  fireEvent.timeUpdate(video);await waitFor(()=>expect(playbackApi.heartbeat).toHaveBeenLastCalledWith("playback-one",295,false));expect(slider.value).toBe("360");
  fakeHls.fragments=[{start:0,end:80}];clamp=false;await act(async()=>fakeHls.levels[0]("levelLoaded",{details:{fragments:fakeHls.fragments}}));
  expect(clock).toBe(70);expect(fakeHls.levels).toHaveLength(0);expect(fakeHls.destroy).not.toHaveBeenCalled();expect(playbackApi.stop).not.toHaveBeenCalled();expect(video.load).not.toHaveBeenCalled();expect(playbackApi.create).toHaveBeenCalledTimes(1);
  await waitFor(()=>expect(playbackApi.heartbeat).toHaveBeenLastCalledWith("playback-one",360,false));Object.defineProperty(video,"readyState",{value:4,configurable:true});fireEvent.seeked(video);expect(screen.queryByText("Buffering…")).toBeNull();
 });
 it("restarts immediately if the first refreshed playlist still lacks the forward target",async()=>{
  fakeHls.supported=true;fakeHls.live=true;fakeHls.fragments=[{start:0,end:60}];vi.mocked(playbackApi.create).mockResolvedValue({...session,method:"remux",mime:"application/vnd.apple.mpegurl",offset_seconds:290});
  player();await ready();scrubTo(360);await act(async()=>fakeHls.levels[0]("levelLoaded",{details:{fragments:[{start:0,end:65}]}}));
  await waitFor(()=>expect(playbackApi.create).toHaveBeenCalledTimes(2));expect(playbackApi.create).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({position_seconds:360,force_transcode:false}));expect(fakeHls.levels).toHaveLength(0);
 });
 it("bounds a live-playlist refresh wait and preserves its target when no response arrives",async()=>{
  vi.useFakeTimers({shouldAdvanceTime:true});fakeHls.supported=true;fakeHls.live=true;fakeHls.fragments=[{start:0,end:60}];vi.mocked(playbackApi.create).mockResolvedValue({...session,method:"remux",mime:"application/vnd.apple.mpegurl",offset_seconds:290});
  player();await ready();const slider=scrubTo(360);await act(async()=>{await vi.advanceTimersByTimeAsync(1900);});expect(playbackApi.create).toHaveBeenCalledTimes(1);expect(slider.value).toBe("360");
  await act(async()=>{await vi.advanceTimersByTimeAsync(150);});await waitFor(()=>expect(playbackApi.create).toHaveBeenCalledTimes(2));expect(slider.value).toBe("360");expect(fakeHls.levels).toHaveLength(0);
 });
 it("cancels a speculative refresh on a newer seek without adopting an obsolete target or allocating extra jobs",async()=>{
  vi.useFakeTimers({shouldAdvanceTime:true});fakeHls.supported=true;fakeHls.live=true;fakeHls.fragments=[{start:0,end:60}];vi.mocked(playbackApi.create).mockResolvedValue({...session,method:"remux",mime:"application/vnd.apple.mpegurl",offset_seconds:290});
  player();const video=await ready();Object.defineProperty(video,"paused",{value:false,writable:true,configurable:true});scrubTo(360);const obsolete=fakeHls.levels[0];scrubTo(380);expect(fakeHls.levels).toHaveLength(1);
  await act(async()=>obsolete("levelLoaded",{details:{fragments:[{start:0,end:100}]}}));expect((screen.getByRole("slider",{name:"Seek"}) as HTMLInputElement).value).toBe("380");expect(playbackApi.create).toHaveBeenCalledTimes(1);
  fakeHls.fragments=[{start:0,end:100}];await act(async()=>fakeHls.levels[0]("levelLoaded",{details:{fragments:fakeHls.fragments}}));expect(video.currentTime).toBe(90);
  await act(async()=>{await vi.advanceTimersByTimeAsync(2100);});expect(playbackApi.create).toHaveBeenCalledTimes(1);expect(watchApi.begin).toHaveBeenCalledTimes(1);
  expect(playbackApi.heartbeat).not.toHaveBeenCalledWith("playback-one",360,false);
 });
 it("cancels a speculative refresh when media recovery needs a fresh source at its target",async()=>{
  vi.useFakeTimers({shouldAdvanceTime:true});fakeHls.supported=true;fakeHls.live=true;fakeHls.fragments=[{start:0,end:60}];vi.mocked(playbackApi.create).mockResolvedValue({...session,method:"remux",mime:"application/vnd.apple.mpegurl",offset_seconds:290});
  player();await ready();scrubTo(360);await act(async()=>fakeHls.errors[0]("error",{fatal:true,type:"mediaError",details:"bufferAppendError"}));
  await waitFor(()=>expect(playbackApi.create).toHaveBeenCalledTimes(2));expect(playbackApi.create).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({position_seconds:360,force_transcode:false}));expect(fakeHls.levels).toHaveLength(0);
  await act(async()=>{await vi.advanceTimersByTimeAsync(2100);});expect(playbackApi.create).toHaveBeenCalledTimes(2);
 });
 it("keeps an unbuffered seek target through delayed stop, creation, and reset-clock events",async()=>{
  let stop!:(value?:void)=>void,create!:(value:PlaybackSession)=>void;
  fakeHls.supported=true;vi.mocked(playbackApi.create).mockResolvedValueOnce({...session,method:"remux",mime:"application/vnd.apple.mpegurl",offset_seconds:290}).mockImplementationOnce(()=>new Promise(resolve=>{create=resolve;}));
  player();const video=await ready();vi.mocked(playbackApi.stop).mockImplementationOnce(()=>new Promise(resolve=>{stop=resolve;}));
  const slider=scrubTo(700);expect(slider.value).toBe("700");expect(slider.getAttribute("aria-valuetext")).toBe("11:40 of 20:00");expect(playbackApi.create).toHaveBeenCalledTimes(1);
  video.currentTime=0;fireEvent.timeUpdate(video);fireEvent.progress(video);fireEvent.playing(video);fireEvent.ended(video);expect(slider.value).toBe("700");
  expect(watchApi.progress).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({position_seconds:700,seeking:true}),false);
  await act(async()=>stop());await waitFor(()=>expect(playbackApi.create).toHaveBeenCalledTimes(2));expect(slider.value).toBe("700");
  await act(async()=>create({...session,id:"seek-job",method:"remux",mime:"application/vnd.apple.mpegurl",offset_seconds:696}));fireEvent.loadedMetadata(video);expect(video.currentTime).toBe(4);
  video.currentTime=0;fireEvent.timeUpdate(video);fireEvent.progress(video);fireEvent.playing(video);fireEvent.seeked(video);fireEvent.pause(video);expect(slider.value).toBe("700");
  expect(watchApi.progress).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({position_seconds:700,seeking:true,playback_session_id:"seek-job"}),false);
  video.currentTime=4;fireEvent.seeked(video);video.currentTime=5;fireEvent.timeUpdate(video);fireEvent.pause(video);expect(slider.value).toBe("701");
  expect(watchApi.progress).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({position_seconds:701,seeking:false}),false);
 });
 it("keeps the latest rapid seek and pause intent while superseded allocation is cleaned up",async()=>{
  let createOld!:(value:PlaybackSession)=>void,stopOld!:(value?:void)=>void;
  fakeHls.supported=true;vi.mocked(playbackApi.create).mockResolvedValueOnce({...session,method:"remux",mime:"application/vnd.apple.mpegurl",offset_seconds:290}).mockImplementationOnce(()=>new Promise(resolve=>{createOld=resolve;})).mockResolvedValueOnce({...session,id:"latest-job",method:"remux",mime:"application/vnd.apple.mpegurl",offset_seconds:756});
  player();const video=await ready();Object.defineProperty(video,"paused",{value:true,configurable:true});vi.mocked(video.play).mockClear();scrubTo(700);
  await waitFor(()=>expect(playbackApi.create).toHaveBeenCalledTimes(2));expect((screen.getByRole("slider",{name:"Seek"}) as HTMLInputElement).disabled).toBe(false);scrubTo(730);scrubTo(760);
  const slider=screen.getByRole("slider",{name:"Seek"}) as HTMLInputElement;expect(slider.value).toBe("760");expect(playbackApi.create).toHaveBeenCalledTimes(2);
  vi.mocked(playbackApi.stop).mockImplementationOnce(()=>new Promise(resolve=>{stopOld=resolve;}));await act(async()=>createOld({...session,id:"superseded-job",method:"remux",offset_seconds:700}));
  expect(playbackApi.stop).toHaveBeenCalledWith("superseded-job");expect(playbackApi.create).toHaveBeenCalledTimes(2);expect(slider.value).toBe("760");
  await act(async()=>stopOld());await waitFor(()=>expect(playbackApi.create).toHaveBeenCalledTimes(3));expect(playbackApi.create).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({position_seconds:760}));
  // The real server aligns copy output at or before the target; retain that offset.
  vi.mocked(video.play).mockClear();fireEvent.loadedMetadata(video);expect(video.play).not.toHaveBeenCalled();expect(watchApi.begin).toHaveBeenCalledTimes(1);expect(slider.value).toBe("760");
 });
 it("waits for a pending seek to settle, clears buffering then, and preserves playing intent across reset pause events",async()=>{
  fakeHls.supported=true;vi.mocked(playbackApi.create).mockResolvedValue({...session,method:"remux",mime:"application/vnd.apple.mpegurl",offset_seconds:290});
  player();const video=await ready();Object.defineProperty(video,"paused",{value:false,writable:true,configurable:true});Object.defineProperty(video,"seeking",{value:false,writable:true,configurable:true});Object.defineProperty(video,"readyState",{value:4,configurable:true});Object.defineProperty(video,"buffered",{value:mediaRanges([0,60]),configurable:true});fireEvent.play(video);
  const slider=scrubTo(330);Object.defineProperty(video,"seeking",{value:true,writable:true});fireEvent.waiting(video);fireEvent.playing(video);
  expect(screen.getByText("Buffering…")).toBeTruthy();expect(slider.value).toBe("330");
  // A queued reset pause during a seek cannot switch the next source to paused.
  Object.defineProperty(video,"paused",{value:true,writable:true});fireEvent.pause(video);vi.mocked(video.play).mockClear();fireEvent.click(screen.getByRole("button",{name:"Forward 30 seconds"}));
  await waitFor(()=>expect(playbackApi.create).toHaveBeenCalledTimes(2));fireEvent.loadedMetadata(video);expect(video.play).toHaveBeenCalled();
  Object.defineProperty(video,"paused",{value:false,writable:true});Object.defineProperty(video,"seeking",{value:true,writable:true});fireEvent.waiting(video);fireEvent.playing(video);expect(screen.getByText("Buffering…")).toBeTruthy();
  Object.defineProperty(video,"seeking",{value:false,writable:true});fireEvent.seeked(video);expect(screen.queryByText("Buffering…")).toBeNull();expect(slider.value).toBe("360");
 });
 it("rejects an unrequested clock reset after a confirmed seek without rewinding watch position",async()=>{
  player();const video=await ready();const slider=scrubTo(600);fireEvent.seeked(video);video.currentTime=601;fireEvent.timeUpdate(video);expect(slider.value).toBe("601");
  video.currentTime=0;fireEvent.timeUpdate(video);expect(slider.value).toBe("601");expect(video.currentTime).toBe(601);fireEvent.pause(video);
  expect(watchApi.progress).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({position_seconds:601,seeking:true}),false);expect(playbackApi.create).toHaveBeenCalledTimes(1);
 });
 it("restarts an unbuffered backward seek advertised by a stale completed manifest after its prefix was pruned",async()=>{
  vi.useFakeTimers({shouldAdvanceTime:true});fakeHls.supported=true;fakeHls.fragments=[{start:0,end:910}];
  vi.mocked(playbackApi.create).mockResolvedValue({...session,method:"remux",mime:"application/vnd.apple.mpegurl",offset_seconds:290});
  player();const video=await ready();video.currentTime=600;fireEvent.timeUpdate(video);await act(async()=>{await vi.advanceTimersByTimeAsync(10_000);});
  expect(playbackApi.heartbeat).toHaveBeenCalledWith("playback-one",890,true);
  Object.defineProperty(video,"buffered",{value:mediaRanges([500,610]),configurable:true});scrubTo(810);fireEvent.seeked(video);expect(playbackApi.create).toHaveBeenCalledTimes(1);
  // The browser can retain cached data behind the server's pruning floor. A
  // second backward target without cached data still needs a fresh source.
  Object.defineProperty(video,"buffered",{value:mediaRanges(),configurable:true});scrubTo(780);await waitFor(()=>expect(playbackApi.create).toHaveBeenCalledTimes(2));
  expect(playbackApi.create).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({position_seconds:780}));expect((screen.getByRole("slider",{name:"Seek"}) as HTMLInputElement).value).toBe("780");
 });
 it("retries a pruned pending fragment once at the same quality before the bounded decode fallback",async()=>{
  fakeHls.supported=true;fakeHls.fragments=[{start:0,end:200}];const converted={...session,method:"remux" as const,mime:"application/vnd.apple.mpegurl",offset_seconds:290};
  vi.mocked(playbackApi.create).mockResolvedValueOnce(converted).mockResolvedValueOnce({...converted,id:"range-retry"}).mockResolvedValueOnce({...converted,id:"compatible",method:"transcode",offset_seconds:360});
  player();const video=await ready();scrubTo(360);
  const missing={fatal:true,type:"networkError",details:"fragLoadError",response:{code:404}};
  await act(async()=>fakeHls.errors[0]("error",missing));await waitFor(()=>expect(playbackApi.create).toHaveBeenCalledTimes(2));
  expect(playbackApi.create).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({position_seconds:360,max_height:0,max_bitrate:0,force_transcode:false}));fireEvent.loadedMetadata(video);
  await act(async()=>fakeHls.errors[1]("error",missing));await waitFor(()=>expect(playbackApi.create).toHaveBeenCalledTimes(3));expect(playbackApi.create).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({position_seconds:360,force_transcode:true}));
  fireEvent.loadedMetadata(video);await act(async()=>fakeHls.errors[2]("error",missing));expect(screen.getByRole("alert")).toBeTruthy();expect(playbackApi.create).toHaveBeenCalledTimes(3);expect(watchApi.begin).toHaveBeenCalledTimes(1);
 });
 it("stops a terminal native decode failure, flushes once, and resumes heartbeats only after Retry",async()=>{
  vi.useFakeTimers({shouldAdvanceTime:true});
  vi.mocked(playbackApi.create).mockResolvedValueOnce({...session,method:"transcode"}).mockResolvedValueOnce({...session,id:"retried-job",method:"transcode"});
  player();const video=await ready();await act(async()=>{await Promise.resolve();});vi.mocked(playbackApi.heartbeat).mockClear();video.currentTime=310;fireEvent.timeUpdate(video);vi.mocked(video.pause).mockClear();const before=vi.mocked(watchApi.progress).mock.calls.length;
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
