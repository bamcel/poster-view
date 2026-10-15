import {act,cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {MemoryRouter,Route,Routes,useNavigate,type NavigateFunction} from "react-router-dom";
import {StrictMode} from "react";
import PlayerPage from "./PlayerPage";
import {playbackApi,defaultPlaybackPreferences,type PlaybackInfo,type PlaybackSession} from "./api/playback";
import {watchApi} from "./api/watch";
import type {NativeAudioList} from "./lib/nativeAudio";
vi.mock("./api/playback",async importOriginal=>({...await importOriginal<typeof import("./api/playback")>(),playbackApi:{info:vi.fn(),create:vi.fn(),seek:vi.fn(),stop:vi.fn(),heartbeat:vi.fn(),subtitle:vi.fn()}}));
vi.mock("./api/watch",()=>({watchApi:{preferences:vi.fn(),state:vi.fn(),begin:vi.fn(),progress:vi.fn()}}));
const renderer=vi.hoisted(()=>({construct:vi.fn(),destroy:vi.fn(),manual:vi.fn()}));
const bitmap=vi.hoisted(()=>({construct:vi.fn(),dispose:vi.fn()}));
vi.mock("libbitsub",()=>({PgsRenderer:class{constructor(options:unknown){bitmap.construct("pgs",options);}dispose(){bitmap.dispose();}},VobSubRenderer:class{constructor(options:unknown){bitmap.construct("vobsub",options);}dispose(){bitmap.dispose();}}}));
const hlsState=vi.hoisted(()=>({supported:false,instances:[] as {media:HTMLVideoElement|null;url:string;options:unknown;latestLevelDetails:{fragments:{start:number;duration:number}[]};destroy:ReturnType<typeof vi.fn>;startLoad:ReturnType<typeof vi.fn>;emit:(event:string,data:unknown)=>void}[]}));
vi.mock("hls.js",()=>({default:class{
 static isSupported(){return hlsState.supported;}static Events={ERROR:"error",LEVEL_LOADING:"levelLoading",LEVEL_LOADED:"levelLoaded",FRAG_LOADING:"fragLoading",FRAG_LOADED:"fragLoaded"};static ErrorTypes={MEDIA_ERROR:"mediaError",NETWORK_ERROR:"networkError"};
 media:HTMLVideoElement|null=null;url="";latestLevelDetails={fragments:[] as {start:number;duration:number}[]};handlers=new Map<string,((event:string,data:unknown)=>void)[]>();destroy=vi.fn(()=>{this.media=null;});recoverMediaError=vi.fn();startLoad=vi.fn();options:unknown;
 constructor(options:unknown){this.options=options;hlsState.instances.push(this);}on(event:string,handler:(event:string,data:unknown)=>void){this.handlers.set(event,[...(this.handlers.get(event)??[]),handler]);}off(event:string,handler:(event:string,data:unknown)=>void){this.handlers.set(event,(this.handlers.get(event)??[]).filter(callback=>callback!==handler));}loadSource(url:string){this.url=url;}attachMedia(video:HTMLVideoElement){this.media=video;video.src=`blob:test-hls-${hlsState.instances.length}`;}emit(event:string,data:unknown){for(const handler of this.handlers.get(event)??[])handler(event,data);}
}}));
vi.mock("jassub",()=>({default:class {ready=Promise.resolve();constructor(options:unknown){renderer.construct(options);}destroy(){renderer.destroy();return Promise.resolve();}manualRender(frame:unknown,force:boolean){renderer.manual(frame,force);return Promise.resolve();}}}));
const info:PlaybackInfo={title:"Maomao",series_title:"The Apothecary Diaries",season:1,episode:1,duration_seconds:1200,chapters:[{title:"Opening",start_seconds:90}],tracks:[{index:1,kind:"video",codec:"h264",width:1920,height:1080},{index:2,kind:"audio",codec:"aac",language:"ja",default:true},{index:3,kind:"audio",codec:"aac",language:"en"}],next:{library_id:"anime",item_id:"two",title:"Episode two"}};
const session:PlaybackSession={id:"playback-one",method:"direct",reason:"Original file",url:"/api/playback/sessions/one/file",mime:"video/mp4",offset_seconds:0,duration_seconds:1200,audio_index:2};
const state={session_id:null,version:0,position_seconds:300,duration_seconds:1200,watched:false,play_count:0,last_played_at:null,audio_index:null,subtitle_index:null};
let navigateInTest:NavigateFunction|undefined,browserAudio:NativeAudioList|undefined;
const originalAudioProperty=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,"audioTracks");
const audioList=(tracks:NativeAudioList[number][])=>Object.assign({length:tracks.length},tracks) as NativeAudioList;
function CaptureNavigation(){navigateInTest=useNavigate();return null;}
function player(strict=false){const content=<MemoryRouter initialEntries={["/play/native/anime/one?return=%2Fmedia%2FAnime"]}><CaptureNavigation/><Routes><Route path="/play/native/:libraryId/:itemId" element={<PlayerPage/>}/><Route path="/media/Anime" element={<p>Media page</p>}/></Routes></MemoryRouter>;return render(strict?<StrictMode>{content}</StrictMode>:content);}
function loadMetadata(video:HTMLVideoElement){fireEvent.loadedMetadata(video);Object.defineProperty(video,"readyState",{value:2,configurable:true});fireEvent.loadedData(video);}
async function ready(){await waitFor(()=>expect(playbackApi.create).toHaveBeenCalled());const video=document.querySelector("video")!;loadMetadata(video);fireEvent.seeked(video);await waitFor(()=>expect(screen.getByRole("heading",{name:"S1:E1 – Maomao"})).toBeTruthy());return video;}
function scrubTo(value:number){const slider=screen.getByRole("slider",{name:"Seek"});fireEvent.change(slider,{target:{value:String(value)}});fireEvent.pointerUp(slider);return slider as HTMLInputElement;}
function mediaError(video:HTMLVideoElement,code:number|null){Object.defineProperty(video,"error",{value:code===null?null:{code,message:"Media playback failed"},configurable:true});}
it("seeks from a chapter timeline tick without replacing Original playback",async()=>{
  player();const video=await ready();const original=video.src;
  fireEvent.click(screen.getByRole("button",{name:"Seek to chapter Opening at 1:30"}));
  expect(video.currentTime).toBe(90);expect(video.src).toBe(original);
  expect(playbackApi.create).toHaveBeenCalledTimes(1);
});
beforeEach(()=>{
 browserAudio=undefined;hlsState.supported=false;hlsState.instances=[];Object.defineProperty(HTMLMediaElement.prototype,"audioTracks",{get:()=>browserAudio,configurable:true});
 vi.clearAllMocks();vi.spyOn(HTMLMediaElement.prototype,"load").mockImplementation(()=>{});vi.spyOn(HTMLMediaElement.prototype,"pause").mockImplementation(()=>{});vi.spyOn(HTMLMediaElement.prototype,"play").mockResolvedValue();vi.spyOn(HTMLMediaElement.prototype,"canPlayType").mockReturnValue("probably");
 vi.mocked(playbackApi.info).mockResolvedValue(info);vi.mocked(watchApi.preferences).mockResolvedValue(defaultPlaybackPreferences);vi.mocked(watchApi.state).mockResolvedValue(state);vi.mocked(watchApi.begin).mockResolvedValue({session_id:"watch-one",state});vi.mocked(playbackApi.create).mockResolvedValue(session);vi.mocked(playbackApi.stop).mockResolvedValue();vi.mocked(playbackApi.heartbeat).mockResolvedValue();vi.mocked(watchApi.progress).mockResolvedValue({...state,audio_index:2,subtitle_index:-1});
});
afterEach(()=>{cleanup();window.dispatchEvent(new Event("posterview:account-changed"));vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();if(originalAudioProperty)Object.defineProperty(HTMLMediaElement.prototype,"audioTracks",originalAudioProperty);else Reflect.deleteProperty(HTMLMediaElement.prototype,"audioTracks");});
describe("original-file player",()=>{
 it("prompts after paused inactivity and exits after no response, saving and stopping delivery",async()=>{
  vi.useFakeTimers({shouldAdvanceTime:true});vi.mocked(watchApi.preferences).mockResolvedValue({...defaultPlaybackPreferences,still_watching_minutes:1,still_watching_timeout_minutes:1});
  player();const video=await ready();fireEvent.pause(video);
  await act(async()=>{await vi.advanceTimersByTimeAsync(60_500);});
  expect(screen.getByRole("dialog",{name:"Still watching"})).toBeTruthy();
  await act(async()=>{await vi.advanceTimersByTimeAsync(60_500);});
  expect(screen.getByText("Media page")).toBeTruthy();await act(async()=>{});
  expect(playbackApi.stop).toHaveBeenCalledWith("playback-one");expect(watchApi.progress).toHaveBeenCalled();
 });
 it("settles rapid paused chapter seeks without seeked events and still expires inactivity",async()=>{
  vi.useFakeTimers({shouldAdvanceTime:true});vi.mocked(watchApi.preferences).mockResolvedValue({...defaultPlaybackPreferences,still_watching_minutes:1,still_watching_timeout_minutes:1});
  player();const video=await ready();fireEvent.pause(video);
  scrubTo(600);fireEvent.click(screen.getByRole("button",{name:"Seek to chapter Opening at 1:30"}));
  await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
  fireEvent.pause(video);expect(watchApi.progress).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({position_seconds:90,seeking:false}),false);
  await act(async()=>{await vi.advanceTimersByTimeAsync(60_500);});expect(screen.getByRole("dialog",{name:"Still watching"})).toBeTruthy();
  await act(async()=>{await vi.advanceTimersByTimeAsync(60_500);});expect(screen.getByText("Media page")).toBeTruthy();expect(playbackApi.stop).toHaveBeenCalledWith("playback-one");
 });
 it("expires an explicitly paused seek even when decoded data never arrives",async()=>{
  vi.useFakeTimers({shouldAdvanceTime:true});vi.mocked(watchApi.preferences).mockResolvedValue({...defaultPlaybackPreferences,still_watching_minutes:1,still_watching_timeout_minutes:1});
  player();const video=await ready();fireEvent.pause(video);Object.defineProperty(video,"readyState",{value:1,configurable:true});
  scrubTo(900);Object.defineProperty(video,"seeking",{value:true,configurable:true});
  await act(async()=>{await vi.advanceTimersByTimeAsync(61_000);});expect(screen.getByRole("dialog",{name:"Still watching"})).toBeTruthy();
  await act(async()=>{await vi.advanceTimersByTimeAsync(61_000);});expect(screen.getByText("Media page")).toBeTruthy();expect(playbackApi.stop).toHaveBeenCalledWith("playback-one");
 });
 it("never interrupts normal playing and restarts paused inactivity after pointer interaction",async()=>{
  vi.useFakeTimers({shouldAdvanceTime:true});vi.mocked(watchApi.preferences).mockResolvedValue({...defaultPlaybackPreferences,still_watching_minutes:1,still_watching_timeout_minutes:1});
  player();const video=await ready();Object.defineProperty(video,"paused",{value:false,configurable:true});fireEvent.play(video);
  await act(async()=>{await vi.advanceTimersByTimeAsync(125_000);});expect(screen.queryByRole("dialog",{name:"Still watching"})).toBeNull();
  Object.defineProperty(video,"paused",{value:true,configurable:true});fireEvent.pause(video);
  await act(async()=>{await vi.advanceTimersByTimeAsync(40_000);});fireEvent.pointerMove(video);
  await act(async()=>{await vi.advanceTimersByTimeAsync(40_000);});expect(screen.queryByRole("dialog",{name:"Still watching"})).toBeNull();
  await act(async()=>{await vi.advanceTimersByTimeAsync(21_000);});expect(screen.getByRole("dialog",{name:"Still watching"})).toBeTruthy();
  fireEvent.click(screen.getByRole("button",{name:"Continue watching"}));expect(screen.queryByRole("dialog",{name:"Still watching"})).toBeNull();
 });
 it("retires a session allocated after pagehide instead of attaching it",async()=>{
  let allocate!:(value:PlaybackSession)=>void;
  vi.mocked(playbackApi.create).mockImplementation(()=>new Promise(resolve=>{allocate=resolve;}));
  player();await waitFor(()=>expect(playbackApi.create).toHaveBeenCalledOnce());
  fireEvent(window,new Event("pagehide"));allocate(session);
  await waitFor(()=>expect(playbackApi.stop).toHaveBeenCalledWith("playback-one"));
  expect(document.querySelector("video")!.getAttribute("src")).toBeNull();
 });
 it("keeps delivery on tab switches, stops it on pagehide, and recreates it after bfcache restore",async()=>{
  player();const video=await ready();video.currentTime=420;
  fireEvent(document,new Event("visibilitychange"));expect(playbackApi.stop).not.toHaveBeenCalled();
  fireEvent(window,new Event("pagehide"));expect(playbackApi.stop).toHaveBeenCalledWith("playback-one",true);
  expect(video.getAttribute("src")).toBeNull();
  const restore=new Event("pageshow");Object.defineProperty(restore,"persisted",{value:true});fireEvent(window,restore);
  await waitFor(()=>expect(playbackApi.create).toHaveBeenCalledTimes(2));
  expect(playbackApi.create).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({position_seconds:420}));
 });
 it("holds the previous decoded picture across source replacement without restoring the poster",async()=>{
  vi.mocked(playbackApi.info).mockResolvedValue({...info,poster_url:"/poster.jpg",remux_allowed:true});hlsState.supported=true;vi.stubGlobal("MediaSource",{isTypeSupported:()=>true});
  const draw=vi.fn();vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockReturnValue({drawImage:draw} as unknown as CanvasRenderingContext2D);
  player();const video=await ready();Object.defineProperties(video,{videoWidth:{value:1920,configurable:true},videoHeight:{value:1080,configurable:true}});
  fireEvent.timeUpdate(video);expect(video.getAttribute("poster")).toBeNull();
  vi.mocked(playbackApi.create).mockResolvedValue({...session,id:"copied",method:"remux",generation:1,offset_seconds:290,url:"/hls/1/index.m3u8",mime:"application/vnd.apple.mpegurl"});
  fireEvent.click(screen.getByRole("button",{name:"Playback quality"}));fireEvent.click(screen.getByRole("button",{name:"Direct Stream · lossless"}));
  await waitFor(()=>expect(playbackApi.create).toHaveBeenCalledTimes(2));const held=document.querySelector(".pv-held-frame") as HTMLCanvasElement;
  expect(held.hidden).toBe(false);expect(draw).toHaveBeenCalledTimes(1);expect(video.getAttribute("poster")).toBeNull();
  loadMetadata(video);fireEvent.seeked(video);expect(held.hidden).toBe(true);
 });
 it("keeps brief and sustained native seek waits free of center buffering overlays",async()=>{
  player();const video=await ready();const source=video.getAttribute("src");
  Object.defineProperty(video,"paused",{value:false,configurable:true});
  vi.useFakeTimers();
  Object.defineProperty(video,"readyState",{value:1,configurable:true});fireEvent.waiting(video);
  act(()=>vi.advanceTimersByTime(499));expect(screen.queryByText("Buffering…")).toBeNull();
  Object.defineProperty(video,"readyState",{value:4,configurable:true});fireEvent.playing(video);
  act(()=>vi.advanceTimersByTime(1000));expect(screen.queryByText("Buffering…")).toBeNull();
  Object.defineProperty(video,"readyState",{value:1,configurable:true});fireEvent.waiting(video);
  act(()=>vi.advanceTimersByTime(499));expect(screen.queryByText("Buffering…")).toBeNull();
  act(()=>vi.advanceTimersByTime(1));expect(screen.queryByText("Buffering…")).toBeNull();expect(document.querySelector(".pv-spinner")).toBeNull();
  Object.defineProperty(video,"readyState",{value:4,configurable:true});fireEvent.playing(video);
  expect(screen.queryByText("Buffering…")).toBeNull();expect(video.getAttribute("src")).toBe(source);
  expect(playbackApi.create).toHaveBeenCalledTimes(1);expect(playbackApi.stop).not.toHaveBeenCalled();
 });
 it("prefers direct playback when conversion is permitted and sends accurate policy capabilities",async()=>{
  vi.mocked(playbackApi.info).mockResolvedValue({...info,conversion_allowed:true,audio_conversion_allowed:true,bandwidth_adaptation_allowed:true,remux_allowed:true,source_bitrate:10_000_000});const fetcher=vi.spyOn(globalThis,"fetch");
  player();const video=await ready();expect(video.getAttribute("src")).toBe(session.url);expect(video.currentTime).toBe(295);
  expect(playbackApi.create).toHaveBeenCalledWith("anime","one",expect.objectContaining({direct_only:false,force_remux:false,max_height:0,max_bitrate:0,bandwidth_limit_bps:0,source_video_supported:true,hls_audio_track_indexes:[2,3]}));
  expect(screen.getByRole("button",{name:"Playback quality"})).toBeTruthy();expect(screen.queryByRole("checkbox",{name:/Burn/})).toBeNull();expect(fetcher).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:"Info"}));expect(screen.getByText("Playback",{selector:"dt"}).nextElementSibling?.textContent).toBe("Original file");expect(screen.queryByText("Encoder")).toBeNull();
 });
 it.each([true,false])("seeks locally across unbuffered and buffered positions without reload while paused=%s",async paused=>{
  player();const video=await ready();Object.defineProperty(video,"paused",{value:paused,configurable:true});Object.defineProperty(video,"buffered",{value:{length:1,start:()=>0,end:()=>30},configurable:true});const source=video.getAttribute("src");vi.mocked(video.load).mockClear();vi.mocked(video.play).mockClear();vi.mocked(video.pause).mockClear();
  const slider=scrubTo(900);expect(video.currentTime).toBe(900);expect(slider.value).toBe("900");fireEvent.seeked(video);scrubTo(10);expect(video.currentTime).toBe(10);fireEvent.seeked(video);
  expect(video.getAttribute("src")).toBe(source);expect(video.load).not.toHaveBeenCalled();expect(video.play).not.toHaveBeenCalled();expect(video.pause).not.toHaveBeenCalled();expect(playbackApi.create).toHaveBeenCalledTimes(1);expect(playbackApi.stop).not.toHaveBeenCalled();expect(watchApi.begin).toHaveBeenCalledTimes(1);
  expect(watchApi.progress).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({position_seconds:10,seeking:true,session_id:"watch-one",playback_session_id:"playback-one"}),false);
 });
 it("preserves the latest requested seek clock through stale zero-time events and rapid seeks",async()=>{
  player();const video=await ready();scrubTo(600);const slider=scrubTo(900);video.currentTime=0;Object.defineProperty(video,"seeking",{value:true,configurable:true});fireEvent.timeUpdate(video);fireEvent.pause(video);expect(slider.value).toBe("900");expect(watchApi.progress).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({position_seconds:900,seeking:true}),false);
  video.currentTime=900;Object.defineProperty(video,"seeking",{value:false,configurable:true});fireEvent.seeked(video);video.currentTime=901;fireEvent.timeUpdate(video);expect(slider.value).toBe("901");expect(playbackApi.create).toHaveBeenCalledTimes(1);
 });
 it("keeps the actual ready-media clock when the browser rejects a native seek",async()=>{
  player();const video=await ready();let actual=310;Object.defineProperty(video,"currentTime",{configurable:true,get:()=>actual,set:value=>{if(value===900)throw new DOMException("Unsupported seek","InvalidStateError");actual=value;}});fireEvent.timeUpdate(video);vi.mocked(watchApi.progress).mockClear();
  const slider=scrubTo(900);expect(slider.value).toBe("310");expect(video.currentTime).toBe(310);expect(screen.getByText(/cannot seek to that position/)).toBeTruthy();expect(watchApi.progress).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({position_seconds:310,seeking:true}),false);expect(vi.mocked(watchApi.progress).mock.calls.some(call=>call[2].position_seconds===900)).toBe(false);
  video.currentTime=311;fireEvent.timeUpdate(video);fireEvent.pause(video);expect(slider.value).toBe("311");expect(watchApi.progress).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({position_seconds:311}),false);expect(playbackApi.create).toHaveBeenCalledTimes(1);expect(playbackApi.stop).not.toHaveBeenCalled();
 });
 it("retains a queued pre-metadata seek when the browser cannot assign its time yet",async()=>{
  player();await waitFor(()=>expect(playbackApi.create).toHaveBeenCalled());const video=document.querySelector("video")!;let metadata=false,actual=0;Object.defineProperty(video,"currentTime",{configurable:true,get:()=>actual,set:value=>{if(!metadata)throw new DOMException("No metadata","InvalidStateError");actual=value;}});
  const slider=scrubTo(900);expect(slider.value).toBe("900");metadata=true;loadMetadata(video);fireEvent.seeked(video);expect(video.currentTime).toBe(900);expect(slider.value).toBe("900");expect(playbackApi.create).toHaveBeenCalledTimes(1);expect(watchApi.progress).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({position_seconds:900,seeking:true}),false);
 });
 it("stops original playback explicitly when the metadata-time seek is rejected",async()=>{
  player();await waitFor(()=>expect(playbackApi.create).toHaveBeenCalled());const video=document.querySelector("video")!;Object.defineProperty(video,"currentTime",{configurable:true,get:()=>0,set:()=>{throw new DOMException("Cannot seek yet","InvalidStateError");}});loadMetadata(video);await screen.findByText(/could not apply the requested playback position/);expect(screen.queryByText("Preparing playback…")).toBeNull();expect(video.getAttribute("src")).toBeNull();expect(video.play).not.toHaveBeenCalled();expect(playbackApi.stop).toHaveBeenCalledWith("playback-one");expect(playbackApi.create).toHaveBeenCalledTimes(1);
 });
 it("honestly falls back to file default audio when saved alternate selection is unavailable",async()=>{
  vi.mocked(playbackApi.info).mockResolvedValue({...info,tracks:info.tracks.map(track=>track.kind==="audio"?{...track,default:track.index===3}:track)});vi.mocked(watchApi.state).mockResolvedValue({...state,audio_index:2});vi.mocked(playbackApi.create).mockResolvedValue({...session,audio_index:3});
  player();await ready();expect(playbackApi.create).toHaveBeenCalledWith("anime","one",expect.objectContaining({audio_index:3,native_audio_tracks:false}));expect(screen.getByText(/file's default audio will play instead/)).toBeTruthy();fireEvent.click(screen.getByRole("button",{name:"Audio"}));expect((screen.getByRole("button",{name:/Japanese/}) as HTMLButtonElement).disabled).toBe(true);expect(screen.getByRole("button",{name:/English/}).getAttribute("aria-pressed")).toBe("true");
 });
 it("validates native language mapping and switches audio flags on the same source/session",async()=>{
  browserAudio=audioList([]);vi.mocked(playbackApi.info).mockResolvedValue({...info,tracks:info.tracks.map(track=>track.kind==="audio"?{...track,default:track.index===3}:track)});vi.mocked(watchApi.state).mockResolvedValue({...state,audio_index:2});
  player();await waitFor(()=>expect(playbackApi.create).toHaveBeenCalled());const english={id:"opaque-900",language:"eng",enabled:true},japanese={id:"opaque-42",language:"jpn",enabled:false};browserAudio=audioList([english,japanese]);const video=document.querySelector("video")!;loadMetadata(video);fireEvent.seeked(video);expect(japanese.enabled).toBe(true);expect(english.enabled).toBe(false);video.currentTime=410;fireEvent.timeUpdate(video);
  const source=video.getAttribute("src");vi.mocked(video.load).mockClear();fireEvent.click(screen.getByRole("button",{name:"Audio"}));fireEvent.click(screen.getByRole("button",{name:/English/}));expect(english.enabled).toBe(true);expect(japanese.enabled).toBe(false);expect(video.currentTime).toBe(410);expect(video.getAttribute("src")).toBe(source);expect(video.load).not.toHaveBeenCalled();expect(playbackApi.create).toHaveBeenCalledTimes(1);expect(playbackApi.stop).not.toHaveBeenCalled();expect(watchApi.begin).toHaveBeenCalledTimes(1);expect(watchApi.progress).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({audio_index:3,position_seconds:410}),false);
 });
 it.each(["truehd","dts","pcm_s24le"])("disables unsupported %s audio when audio conversion is disabled",async codec=>{
  browserAudio=audioList([{language:"jpn",enabled:true},{language:"eng",enabled:false}]);vi.mocked(playbackApi.info).mockResolvedValue({...info,audio_conversion_allowed:false,conversion_allowed:false,tracks:info.tracks.map(track=>track.index===3?{...track,codec}:track)});
  player();await ready();fireEvent.click(screen.getByRole("button",{name:"Audio"}));const choice=screen.getByRole("button",{name:/English/}) as HTMLButtonElement;expect(choice.disabled).toBe(true);fireEvent.click(choice);expect(playbackApi.create).toHaveBeenCalledTimes(1);expect(browserAudio[0].enabled).toBe(true);
 });
 it("rejects known native default-track contradictions without fallback",async()=>{
  browserAudio=audioList([]);vi.mocked(playbackApi.info).mockResolvedValue({...info,tracks:info.tracks.map(track=>track.kind==="audio"?{...track,default:track.index===3}:track)});vi.mocked(playbackApi.create).mockResolvedValue({...session,audio_index:3});
  player();await waitFor(()=>expect(playbackApi.create).toHaveBeenCalled());browserAudio=audioList([{language:"jpn",enabled:true}]);loadMetadata(document.querySelector("video")!);await screen.findByText(/selected a different audio track/);expect(playbackApi.create).toHaveBeenCalledTimes(1);expect(playbackApi.stop).toHaveBeenCalledWith("playback-one");expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
 });
 it("keeps the current track when native selection mutation fails",async()=>{
  browserAudio=audioList([{language:"jpn",enabled:true},{language:"eng",get enabled(){return false;},set enabled(_value:boolean){/* Browser refuses this selection. */}}]);player();await ready();fireEvent.click(screen.getByRole("button",{name:"Audio"}));fireEvent.click(screen.getByRole("button",{name:/English/}));expect(screen.getByText(/current track is still selected/)).toBeTruthy();expect(screen.getByRole("button",{name:/Japanese/}).getAttribute("aria-pressed")).toBe("true");expect(playbackApi.create).toHaveBeenCalledTimes(1);expect(playbackApi.stop).not.toHaveBeenCalled();
 });
 it("stops decoder failures with no automatic source, encoding or remux retry",async()=>{
  vi.useFakeTimers({shouldAdvanceTime:true});player();const video=await ready();video.currentTime=310;fireEvent.timeUpdate(video);await act(async()=>{});vi.mocked(playbackApi.heartbeat).mockClear();mediaError(video,4);fireEvent.error(video);await screen.findByText(/cannot play the original file/);expect(playbackApi.create).toHaveBeenCalledTimes(1);expect(playbackApi.stop).toHaveBeenCalledWith("playback-one");expect(video.getAttribute("src")).toBeNull();await act(async()=>{await vi.advanceTimersByTimeAsync(20_000);});expect(playbackApi.heartbeat).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:"Retry original playback"}));await waitFor(()=>expect(playbackApi.create).toHaveBeenCalledTimes(2));expect(watchApi.begin).toHaveBeenCalledTimes(1);expect(playbackApi.create).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({position_seconds:310}));
 });
 it("handles native play rejection without another error event or fallback request",async()=>{
  vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new DOMException("Unsupported","NotSupportedError"));player();await waitFor(()=>expect(playbackApi.create).toHaveBeenCalled());loadMetadata(document.querySelector("video")!);await screen.findByText(/cannot play the original file/);expect(playbackApi.create).toHaveBeenCalledTimes(1);expect(playbackApi.stop).toHaveBeenCalledWith("playback-one");
 });
 it("rejects a legacy segmented response rather than attaching or recovering it",async()=>{
  vi.mocked(playbackApi.create).mockResolvedValue({...session,mime:"application/vnd.apple.mpegurl"});player();await screen.findByText("The server did not return original-file playback.");expect(document.querySelector("video")!.getAttribute("src")).toBeNull();expect(playbackApi.stop).toHaveBeenCalledWith("playback-one");expect(playbackApi.create).toHaveBeenCalledTimes(1);
 });
 it("retries a failed info or watch begin stage before creating a playable source",async()=>{
  vi.mocked(playbackApi.info).mockRejectedValueOnce(new Error("Info temporarily unavailable")).mockResolvedValue(info);vi.mocked(watchApi.begin).mockRejectedValueOnce(new Error("Watch temporarily unavailable")).mockResolvedValue({session_id:"watch-retried",state});player();await screen.findByText("Info temporarily unavailable");expect(playbackApi.create).not.toHaveBeenCalled();fireEvent.click(screen.getByRole("button",{name:"Retry original playback"}));await screen.findByText("Watch temporarily unavailable");expect(playbackApi.create).not.toHaveBeenCalled();fireEvent.click(screen.getByRole("button",{name:"Retry original playback"}));const video=await ready();video.currentTime=310;fireEvent.timeUpdate(video);fireEvent.pause(video);expect(watchApi.begin).toHaveBeenCalledTimes(2);expect(watchApi.progress).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({session_id:"watch-retried",position_seconds:310}),false);
 });
 it("owns exactly one session and watch begin under StrictMode",async()=>{player(true);await ready();expect(playbackApi.create).toHaveBeenCalledTimes(1);expect(watchApi.begin).toHaveBeenCalledTimes(1);});
 it("cleans up a source session returned after unmount",async()=>{
  let resolve!:(value:PlaybackSession)=>void;vi.mocked(playbackApi.create).mockImplementation(()=>new Promise(value=>{resolve=value;}));const rendered=player();await waitFor(()=>expect(playbackApi.create).toHaveBeenCalled());rendered.unmount();resolve(session);await waitFor(()=>expect(playbackApi.stop).toHaveBeenCalledWith("playback-one"));
 });
 it("immediately removes old media while the next route info is deferred and ignores stale clock events",async()=>{
  player();const video=await ready();let resolve!:(value:PlaybackInfo)=>void;vi.mocked(playbackApi.info).mockImplementation(()=>new Promise(value=>{resolve=value;}));await act(async()=>navigateInTest!("/play/native/anime/two?return=%2Fmedia%2FAnime"));expect(video.getAttribute("src")).toBeNull();expect(video.pause).toHaveBeenCalled();video.currentTime=900;fireEvent.timeUpdate(video);fireEvent.pause(video);expect((screen.getByRole("slider",{name:"Seek"}) as HTMLInputElement).disabled).toBe(true);
  vi.mocked(playbackApi.create).mockResolvedValue({...session,id:"playback-two",url:"/api/playback/sessions/two/file"});await act(async()=>resolve({...info,title:"Episode two",episode:2}));await waitFor(()=>expect(playbackApi.create).toHaveBeenCalledTimes(2));loadMetadata(video);fireEvent.seeked(video);expect(video.currentTime).toBe(295);expect(watchApi.progress).toHaveBeenLastCalledWith("anime","two",expect.objectContaining({position_seconds:295,playback_session_id:"playback-two"}),false);
 });
 it("waits for metadata of the owned original URL instead of consuming a queued old-source event",async()=>{
  player();await waitFor(()=>expect(playbackApi.create).toHaveBeenCalled());const video=document.querySelector("video")!;Object.defineProperty(video,"currentSrc",{value:new URL("/old-file",window.location.href).href,configurable:true});loadMetadata(video);mediaError(video,4);fireEvent.error(video);expect(video.play).not.toHaveBeenCalled();expect(screen.queryByRole("alert")).toBeNull();
  Object.defineProperty(video,"currentSrc",{value:new URL(session.url,window.location.href).href,configurable:true});loadMetadata(video);fireEvent.seeked(video);expect(video.play).toHaveBeenCalledTimes(1);expect(video.currentTime).toBe(295);
 });
 it.each([2,4])("ignores an old null-error event after a route switch but stops the current error code %s once",async code=>{
  player();const video=await ready();vi.mocked(playbackApi.info).mockResolvedValue({...info,title:"Episode two",episode:2});vi.mocked(playbackApi.create).mockResolvedValue({...session,id:"playback-two",url:"/api/playback/sessions/two/file"});await act(async()=>navigateInTest!("/play/native/anime/two"));await waitFor(()=>expect(playbackApi.create).toHaveBeenCalledTimes(2));expect(playbackApi.stop).toHaveBeenCalledWith("playback-one");vi.mocked(playbackApi.stop).mockClear();
  Object.defineProperty(video,"currentSrc",{value:"",configurable:true});mediaError(video,null);fireEvent.error(video);expect(screen.queryByRole("alert")).toBeNull();expect(video.getAttribute("src")).toBe("/api/playback/sessions/two/file");expect(playbackApi.stop).not.toHaveBeenCalled();loadMetadata(video);fireEvent.seeked(video);await screen.findByRole("heading",{name:"S1:E2 – Episode two"});video.currentTime=360;fireEvent.timeUpdate(video);
  mediaError(video,code);fireEvent.error(video);await screen.findByText(code===2?/original file could not be loaded/:/cannot play the original file/);fireEvent.error(video);expect(playbackApi.stop).toHaveBeenCalledTimes(1);expect(playbackApi.stop).toHaveBeenCalledWith("playback-two");expect(video.getAttribute("src")).toBeNull();expect(playbackApi.create).toHaveBeenCalledTimes(2);expect(watchApi.progress).toHaveBeenLastCalledWith("anime","two",expect.objectContaining({position_seconds:360,playback_session_id:"playback-two"}),false);
 });
 it("ignores obsolete watch failures after a newer report succeeds",async()=>{
  let rejectOld!:(error:Error)=>void,resolveNew!:(value:typeof state)=>void;vi.mocked(watchApi.progress).mockImplementationOnce(()=>new Promise((_resolve,reject)=>{rejectOld=reject;})).mockImplementationOnce(()=>new Promise(resolve=>{resolveNew=resolve;}));player();await ready();await act(async()=>{resolveNew(state);rejectOld(new Error("Stale"));});expect(screen.queryByText(/Watch progress could not be saved/)).toBeNull();
 });
 it("starts a fresh watch viewing for replay and completed seeks while retaining the original file/session",async()=>{
  vi.mocked(playbackApi.info).mockResolvedValue({...info,next:null});player();const video=await ready();video.currentTime=1200;fireEvent.ended(video);vi.mocked(watchApi.begin).mockResolvedValue({session_id:"watch-two",state:{...state,position_seconds:0}});vi.mocked(video.load).mockClear();scrubTo(90);await waitFor(()=>expect(watchApi.begin).toHaveBeenCalledTimes(2));expect(video.currentTime).toBe(90);fireEvent.seeked(video);expect(playbackApi.create).toHaveBeenCalledTimes(1);expect(video.load).not.toHaveBeenCalled();expect(watchApi.progress).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({session_id:"watch-two",position_seconds:90}),false);
 });
 it.each(["replay","completed seek"])("saves final EOF progress before beginning %s on the same original source",async action=>{
  let finish!:(value:typeof state)=>void;const final=new Promise<typeof state>(resolve=>{finish=resolve;});vi.mocked(watchApi.progress).mockImplementation(async(_library,_item,payload)=>payload.ended&&payload.session_id==="watch-one"?final:state);vi.mocked(playbackApi.info).mockResolvedValue({...info,next:null});player();const video=await ready();const source=video.getAttribute("src");video.currentTime=1200;fireEvent.ended(video);fireEvent.pause(video);
  vi.mocked(watchApi.begin).mockResolvedValue({session_id:"watch-two",state:{...state,position_seconds:0}});if(action==="replay")fireEvent.click(screen.getByRole("button",{name:"Play again"}));else scrubTo(90);await act(async()=>{});expect(watchApi.begin).toHaveBeenCalledTimes(1);expect(watchApi.progress).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({session_id:"watch-one",position_seconds:1200,ended:true}),false);
  await act(async()=>finish(state));await waitFor(()=>expect(watchApi.begin).toHaveBeenCalledTimes(2));expect(video.currentTime).toBe(action==="replay"?0:90);fireEvent.seeked(video);expect(video.getAttribute("src")).toBe(source);expect(playbackApi.create).toHaveBeenCalledTimes(1);expect(watchApi.progress).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({session_id:"watch-two",position_seconds:action==="replay"?0:90,ended:false}),false);
 });
 it("restores the confirmed EOF clock if a completed-viewing seek is rejected",async()=>{
  vi.mocked(playbackApi.info).mockResolvedValue({...info,next:null});player();const video=await ready();video.currentTime=1200;fireEvent.ended(video);Object.defineProperty(video,"currentTime",{configurable:true,get:()=>1200,set:()=>{throw new DOMException("Rejected replay seek","InvalidStateError");}});vi.mocked(watchApi.begin).mockResolvedValue({session_id:"watch-two",state});vi.mocked(watchApi.progress).mockClear();scrubTo(90);await screen.findByText(/could not seek to the requested replay position/);expect((screen.getByRole("slider",{name:"Seek"}) as HTMLInputElement).value).toBe("1200");expect(vi.mocked(watchApi.progress).mock.calls.some(call=>call[2].position_seconds===90)).toBe(false);expect(watchApi.progress).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({session_id:"watch-two",position_seconds:1200,seeking:true}),false);expect(video.getAttribute("src")).toBe(session.url);expect(playbackApi.create).toHaveBeenCalledTimes(1);
 });
 it("lets the next item's completed seek proceed while an old replay begin is unresolved",async()=>{
  vi.mocked(playbackApi.info).mockResolvedValue({...info,next:null});player();const video=await ready();video.currentTime=1200;fireEvent.ended(video);
  let finishOld!:(value:{session_id:string;state:typeof state})=>void,finishNew!:(value:{session_id:string;state:typeof state})=>void;vi.mocked(watchApi.begin).mockImplementationOnce(()=>new Promise(resolve=>{finishOld=resolve;})).mockResolvedValueOnce({session_id:"watch-next",state}).mockImplementationOnce(()=>new Promise(resolve=>{finishNew=resolve;}));fireEvent.click(screen.getByRole("button",{name:"Play again"}));await waitFor(()=>expect(watchApi.begin).toHaveBeenCalledTimes(2));
  vi.mocked(playbackApi.info).mockResolvedValue({...info,title:"Episode two",episode:2,next:null});vi.mocked(playbackApi.create).mockResolvedValue({...session,id:"playback-two",url:"/api/playback/sessions/two/file"});await act(async()=>navigateInTest!("/play/native/anime/two"));await waitFor(()=>expect(playbackApi.create).toHaveBeenCalledTimes(2));loadMetadata(video);fireEvent.seeked(video);video.currentTime=1200;fireEvent.ended(video);scrubTo(90);await waitFor(()=>expect(watchApi.begin).toHaveBeenCalledTimes(4));
  await act(async()=>finishOld({session_id:"stale-watch",state}));expect(video.currentTime).toBe(1200);expect((screen.getByRole("slider",{name:"Seek"}) as HTMLInputElement).disabled).toBe(true);await act(async()=>finishNew({session_id:"watch-next-replay",state}));expect(video.currentTime).toBe(90);fireEvent.seeked(video);expect(screen.getByRole("heading",{name:"S1:E2 – Episode two"})).toBeTruthy();expect(watchApi.progress).toHaveBeenLastCalledWith("anime","two",expect.objectContaining({session_id:"watch-next-replay",position_seconds:90,playback_session_id:"playback-two"}),false);expect(playbackApi.create).toHaveBeenCalledTimes(2);
 });
 it("preserves actual EOF position when duration is unknown",async()=>{
  vi.mocked(playbackApi.info).mockResolvedValue({...info,duration_seconds:0,next:null});vi.mocked(playbackApi.create).mockResolvedValue({...session,duration_seconds:0});player();const video=await ready();video.currentTime=77;fireEvent.ended(video);expect(watchApi.progress).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({position_seconds:77,ended:true}),false);
 });
 it("offers chapter, keyboard seek and volume controls without new sessions",async()=>{
  player();const video=await ready();fireEvent.click(screen.getByRole("button",{name:"Chapters"}));fireEvent.click(screen.getByRole("button",{name:/^Opening/}));expect(video.currentTime).toBe(90);fireEvent.seeked(video);fireEvent.keyDown(document,{key:"ArrowRight"});expect(video.currentTime).toBe(120);fireEvent.seeked(video);fireEvent.keyDown(document,{key:"m"});expect(video.muted).toBe(true);expect(playbackApi.create).toHaveBeenCalledTimes(1);
 });
 it("disables image subtitles and keeps styled ASS/fonts/Off client-side with original timestamps",async()=>{
  vi.spyOn(globalThis,"fetch").mockImplementation(async()=>new Response("[Script Info]\n[Events]\n"));vi.mocked(playbackApi.info).mockResolvedValue({...info,tracks:[...info.tracks,{index:4,kind:"subtitle",codec:"ass",subtitle_format:"ass",language:"ja",url:"/captions.ass"},{index:5,kind:"subtitle",codec:"pgs",subtitle_format:"image"}],fonts:[{index:6,name:"Font.ttf",url:"/font.ttf"}]});player();const video=await ready();video.currentTime=340;fireEvent.timeUpdate(video);Object.defineProperty(video,"readyState",{value:2,configurable:true});Object.defineProperty(video,"videoWidth",{value:1920});Object.defineProperty(video,"videoHeight",{value:1080});
  fireEvent.click(screen.getByRole("button",{name:"Subtitles"}));expect((screen.getByRole("button",{name:/PGS/}) as HTMLButtonElement).disabled).toBe(true);fireEvent.click(screen.getByRole("button",{name:/Japanese/}));await waitFor(()=>expect(renderer.construct).toHaveBeenCalledWith(expect.objectContaining({video,fonts:expect.arrayContaining(["/font.ttf"]),timeOffset:0,queryFonts:false})));await waitFor(()=>expect(renderer.manual).toHaveBeenCalledWith(expect.objectContaining({mediaTime:340,width:1920,height:1080}),true));
  fireEvent.click(screen.getByRole("button",{name:"Subtitles"}));expect(screen.queryByRole("checkbox",{name:/Burn/})).toBeNull();fireEvent.click(screen.getByRole("button",{name:"Off"}));expect(renderer.destroy).toHaveBeenCalledTimes(1);expect(playbackApi.create).toHaveBeenCalledTimes(1);expect(video.currentTime).toBe(340);expect(watchApi.progress).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({subtitle_index:-1}),false);
 });
 it("renders native VTT cue appearance without shifting original timing, then switches Off without reload",async()=>{
  const cue={startTime:300,endTime:310,line:35,snapToLines:false,position:25,align:"end"} as VTTCue,textTrack={mode:"disabled",cues:[cue],removeCue:vi.fn()},create=document.createElement.bind(document);
  vi.spyOn(document,"createElement").mockImplementation((tag,options)=>{const element=create(tag,options);if(tag==="track")Object.defineProperty(element,"track",{value:textTrack});return element;});const OriginalURL=URL;vi.stubGlobal("URL",class extends OriginalURL {static createObjectURL(){return "blob:subtitles";}static revokeObjectURL(){}});
  vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response("WEBVTT\n\n00:05:00.000 --> 00:05:10.000\nHello"));vi.mocked(watchApi.preferences).mockResolvedValue({...defaultPlaybackPreferences,subtitle_position:"top",subtitle_color:"#ffee00"});vi.mocked(playbackApi.info).mockResolvedValue({...info,tracks:[...info.tracks,{index:4,kind:"subtitle",codec:"subrip",subtitle_format:"vtt",default:true,url:"/subtitles.vtt"}]});
  player();const video=await ready();await waitFor(()=>expect(document.querySelector("track")).toBeTruthy());fireEvent.load(document.querySelector("track")!);expect(cue.startTime).toBe(300);expect(cue.endTime).toBe(310);expect(cue.line).toBe(0);expect(cue.snapToLines).toBe(true);expect(cue.position).toBe(25);expect((document.querySelector(".pv-player") as HTMLElement).style.getPropertyValue("--subtitle-color")).toBe("#ffee00");
  const source=video.getAttribute("src");fireEvent.click(screen.getByRole("button",{name:"Subtitles"}));fireEvent.click(screen.getByRole("button",{name:"Off"}));expect(document.querySelector("track")).toBeNull();expect(video.getAttribute("src")).toBe(source);expect(video.currentTime).toBe(295);expect(playbackApi.create).toHaveBeenCalledTimes(1);
 });
 it("does not automatically select image subtitles",async()=>{
  vi.mocked(playbackApi.info).mockResolvedValue({...info,tracks:[...info.tracks,{index:4,kind:"subtitle",codec:"dvd_subtitle",subtitle_format:"image",default:true}]});player();await ready();expect(screen.getByText(/image subtitle format is unavailable/)).toBeTruthy();expect(playbackApi.create).toHaveBeenCalledWith("anime","one",expect.objectContaining({subtitle_index:null}));
 });
 it("shows autoplay denial as a user Play action, and preserves next-episode navigation",async()=>{
  vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new DOMException("Gesture required","NotAllowedError"));player();await ready();expect(screen.getByText("Press Play to begin playback.")).toBeTruthy();fireEvent.click(screen.getByRole("button",{name:"Play"}));await waitFor(()=>expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2));expect(screen.queryByRole("alert")).toBeNull();fireEvent.click(screen.getByRole("button",{name:"Next episode"}));await waitFor(()=>expect(playbackApi.info).toHaveBeenCalledWith("anime","two",expect.any(AbortSignal)));
 });
});

describe("segmented playback and browser bitmap subtitles",()=>{
 const remux:PlaybackSession={...session,method:"remux",generation:1,offset_seconds:290,url:"/api/playback/sessions/playback-one/hls/1/index.m3u8",mime:"application/vnd.apple.mpegurl",video_codec:"h264",audio_codec:"aac",bitrate:4_000_000};
 function streaming(data:Partial<PlaybackInfo>={}){hlsState.supported=true;vi.stubGlobal("MediaSource",{isTypeSupported:()=>true});vi.mocked(playbackApi.info).mockResolvedValue({...info,remux_allowed:true,...data});}
 it("loads copied resume and distant seek fragments at their relative source targets",async()=>{
  streaming();vi.mocked(playbackApi.create).mockResolvedValue(remux);player();await ready();
  expect(hlsState.instances[0].options).toEqual(expect.objectContaining({startPosition:5}));
  vi.mocked(playbackApi.seek).mockResolvedValue({...remux,generation:2,offset_seconds:796,url:"/hls/2/index.m3u8"});
  scrubTo(800);await waitFor(()=>expect(hlsState.instances).toHaveLength(2));
  expect(hlsState.instances[1].options).toEqual(expect.objectContaining({startPosition:4}));
 });
 it.each([true,false])("keeps source time and watch ownership through local then server HLS seek, paused=%s",async paused=>{
  streaming();vi.mocked(playbackApi.create).mockResolvedValue(remux);player();const video=await ready();expect(video.currentTime).toBe(5);expect((screen.getByRole("slider",{name:"Seek"}) as HTMLInputElement).value).toBe("295");Object.defineProperty(video,"paused",{value:paused,configurable:true});Object.defineProperty(video,"buffered",{value:{length:1,start:()=>0,end:()=>60},configurable:true});const source=video.getAttribute("src");scrubTo(320);expect(video.currentTime).toBe(30);fireEvent.seeked(video);expect(playbackApi.seek).not.toHaveBeenCalled();expect(video.getAttribute("src")).toBe(source);
  vi.mocked(video.play).mockClear();vi.mocked(playbackApi.seek).mockResolvedValue({...remux,generation:2,offset_seconds:796,url:"/api/playback/sessions/playback-one/hls/2/index.m3u8"});const slider=scrubTo(800);expect(slider.value).toBe("800");await waitFor(()=>expect(hlsState.instances).toHaveLength(2));expect(playbackApi.seek).toHaveBeenCalledWith("playback-one",{position_seconds:800,generation:1});expect(hlsState.instances[0].destroy).toHaveBeenCalledTimes(1);video.currentTime=0;fireEvent.timeUpdate(video);expect(slider.value).toBe("800");loadMetadata(video);expect(video.currentTime).toBe(4);fireEvent.seeked(video);expect(watchApi.progress).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({position_seconds:800,session_id:"watch-one",playback_session_id:"playback-one"}),false);expect(video.play).toHaveBeenCalledTimes(paused?0:1);expect(playbackApi.create).toHaveBeenCalledTimes(1);expect(playbackApi.stop).not.toHaveBeenCalled();expect(watchApi.begin).toHaveBeenCalledTimes(1);
 });
 it("keeps a buffered thirty-second Direct Stream skip on the same session and source",async()=>{
  streaming();vi.mocked(playbackApi.create).mockResolvedValue(remux);player();const video=await ready();
  Object.defineProperty(video,"buffered",{value:{length:1,start:()=>0,end:()=>65},configurable:true});
  const source=video.getAttribute("src");fireEvent.keyDown(document,{key:"ArrowRight"});fireEvent.seeked(video);
  expect(video.currentTime).toBe(35);expect((screen.getByRole("slider",{name:"Seek"}) as HTMLInputElement).value).toBe("325");
  expect(video.getAttribute("src")).toBe(source);expect(playbackApi.seek).not.toHaveBeenCalled();expect(playbackApi.create).toHaveBeenCalledTimes(1);expect(playbackApi.stop).not.toHaveBeenCalled();
 });
 it("keeps buffered ninety-second Direct Stream seeks local in both directions",async()=>{
  streaming();vi.mocked(playbackApi.create).mockResolvedValue(remux);player();const video=await ready();
  Object.defineProperty(video,"buffered",{value:{length:1,start:()=>0,end:()=>120},configurable:true});
  const source=video.getAttribute("src");scrubTo(385);fireEvent.seeked(video);
  expect(video.currentTime).toBe(95);
  // A retained older range remains usable even when separated from the playhead.
  video.currentTime=105;fireEvent.timeUpdate(video);
  Object.defineProperty(video,"buffered",{value:{length:1,start:()=>0,end:()=>30},configurable:true});
  scrubTo(305);fireEvent.seeked(video);expect(video.currentTime).toBe(15);
  expect((screen.getByRole("slider",{name:"Seek"}) as HTMLInputElement).value).toBe("305");
  expect(video.getAttribute("src")).toBe(source);expect(hlsState.instances).toHaveLength(1);
  expect(playbackApi.seek).not.toHaveBeenCalled();expect(playbackApi.create).toHaveBeenCalledTimes(1);expect(playbackApi.stop).not.toHaveBeenCalled();
 });
 it("serializes rapid HLS seeks, attaches only the latest generation and preserves requested position during response waits",async()=>{
  streaming();vi.mocked(playbackApi.create).mockResolvedValue(remux);let first!:(value:PlaybackSession)=>void,last!:(value:PlaybackSession)=>void;vi.mocked(playbackApi.seek).mockImplementationOnce(()=>new Promise(resolve=>{first=resolve;})).mockImplementationOnce(()=>new Promise(resolve=>{last=resolve;}));player();const video=await ready();scrubTo(800);scrubTo(900);const slider=scrubTo(1000);expect(slider.value).toBe("1000");expect(playbackApi.seek).toHaveBeenCalledTimes(1);await act(async()=>first({...remux,generation:2,offset_seconds:796,url:"/hls/2/index.m3u8"}));expect(hlsState.instances).toHaveLength(1);expect(playbackApi.seek).toHaveBeenLastCalledWith("playback-one",{position_seconds:1000,generation:2});await act(async()=>last({...remux,generation:3,offset_seconds:996,url:"/hls/3/index.m3u8"}));expect(hlsState.instances).toHaveLength(2);loadMetadata(video);fireEvent.seeked(video);expect(video.currentTime).toBe(4);expect(slider.value).toBe("1000");expect(watchApi.begin).toHaveBeenCalledTimes(1);
 });
 it("clears queued playback notices after rapid HLS seeks settle without a seeked event",async()=>{
  vi.useFakeTimers({shouldAdvanceTime:true});streaming();vi.mocked(playbackApi.create).mockResolvedValue(remux);
  let finish!:(value:PlaybackSession)=>void;vi.mocked(playbackApi.seek).mockResolvedValueOnce(remux).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  player();const video=await ready();scrubTo(800);await act(async()=>{});scrubTo(900);
  fireEvent.click(screen.getByRole("button",{name:"Play"}));expect(screen.getByText(/Playback will (begin when the video is ready|start paused)/)).toBeTruthy();
  await act(async()=>finish(remux));Object.defineProperty(video,"readyState",{value:4,configurable:true});
  await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
  expect(screen.queryByText(/Playback will (begin when the video is ready|start paused)/)).toBeNull();expect(document.querySelector(".pv-player-loading")).toBeNull();expect(hlsState.instances).toHaveLength(1);
 });
 it("repositions manifest-only HLS targets instead of assuming their frames are buffered",async()=>{
  streaming();vi.mocked(playbackApi.create).mockResolvedValue(remux);vi.mocked(playbackApi.seek).mockResolvedValue({...remux,generation:2,offset_seconds:346,url:"/hls/2/index.m3u8"});player();await ready();hlsState.instances[0].latestLevelDetails={fragments:[{start:50,duration:30}]};scrubTo(350);await waitFor(()=>expect(playbackApi.seek).toHaveBeenCalledWith("playback-one",{position_seconds:350,generation:1}));expect(playbackApi.create).toHaveBeenCalledTimes(1);
 });
 it("reuses a server-retained HLS generation and still handles actual fatal errors after reposition",async()=>{
  streaming();vi.mocked(playbackApi.create).mockResolvedValue(remux);vi.mocked(playbackApi.seek).mockResolvedValue(remux);player();const video=await ready();scrubTo(400);await waitFor(()=>expect(video.currentTime).toBe(110));fireEvent.seeked(video);expect(hlsState.instances).toHaveLength(1);expect(hlsState.instances[0].startLoad).toHaveBeenCalledWith(110);act(()=>{for(let attempt=0;attempt<3;attempt++)hlsState.instances[0].emit("error",{fatal:true,type:"networkError"});});await screen.findByText(/playback stream could not be loaded/);expect(playbackApi.stop).toHaveBeenCalledTimes(1);expect(playbackApi.stop).toHaveBeenCalledWith("playback-one");expect(hlsState.instances[0].destroy).toHaveBeenCalledTimes(1);
 });
 it("keeps a clamped same-generation HLS seek bounded and heartbeats its confirmed clock",async()=>{
  vi.useFakeTimers({shouldAdvanceTime:true});streaming();vi.mocked(playbackApi.create).mockResolvedValue(remux);vi.mocked(playbackApi.seek).mockResolvedValue(remux);
  player();const video=await ready();Object.defineProperty(video,"readyState",{value:4,configurable:true});Object.defineProperty(video,"paused",{value:false,configurable:true});
  video.currentTime=10;fireEvent.timeUpdate(video);
  Object.defineProperty(video,"currentTime",{get:()=>10,set:()=>{},configurable:true});
  scrubTo(900);await waitFor(()=>expect(playbackApi.seek).toHaveBeenCalledTimes(1));fireEvent.seeked(video);fireEvent.waiting(video);
  await act(async()=>{await Promise.resolve();});
  expect(playbackApi.heartbeat).toHaveBeenLastCalledWith("playback-one",300,false,1,1);
  expect((screen.getByRole("slider",{name:"Seek"}) as HTMLInputElement).value).toBe("900");
  await act(async()=>{await vi.advanceTimersByTimeAsync(17_000);});expect(playbackApi.seek).toHaveBeenCalledTimes(2);
  fireEvent.seeked(video);
  await act(async()=>{await vi.advanceTimersByTimeAsync(16_000);});
  expect(playbackApi.seek).toHaveBeenCalledTimes(2);expect(screen.getByText(/did not reach the requested position/)).toBeTruthy();
 });
 it("keeps an in-flight forward heartbeat on its old generation while a backward seek wakes the new generation",async()=>{
  streaming();vi.mocked(playbackApi.create).mockResolvedValue(remux);let rejectOld!:(error:Error)=>void;vi.mocked(playbackApi.heartbeat).mockImplementationOnce(()=>new Promise<void>((_resolve,reject)=>{rejectOld=reject;})).mockResolvedValue(undefined);vi.mocked(playbackApi.seek).mockResolvedValue({...remux,generation:2,offset_seconds:346,url:"/hls/2/index.m3u8"});player();const video=await ready();expect(playbackApi.heartbeat).toHaveBeenCalledWith("playback-one",290,false,1,1);video.currentTime=500;fireEvent.timeUpdate(video);fireEvent.pause(video);scrubTo(350);await waitFor(()=>expect(hlsState.instances).toHaveLength(2));loadMetadata(video);fireEvent.seeked(video);await waitFor(()=>expect(playbackApi.heartbeat).toHaveBeenLastCalledWith("playback-one",350,true,2,1));expect(playbackApi.heartbeat).toHaveBeenCalledWith("playback-one",346,true,2,1);expect(vi.mocked(playbackApi.heartbeat).mock.calls.some(call=>call[1]===790&&call[3]===2)).toBe(false);
  await act(async()=>rejectOld(new Error("409 stale generation")));expect(vi.mocked(playbackApi.heartbeat).mock.calls.some(call=>call[1]===790)).toBe(false);expect(screen.queryByRole("alert")).toBeNull();expect(playbackApi.stop).not.toHaveBeenCalled();expect((screen.getByRole("slider",{name:"Seek"}) as HTMLInputElement).value).toBe("350");expect(watchApi.begin).toHaveBeenCalledTimes(1);
 });
 it.each(["truehd","dts","pcm_s24le"])("promotes a direct source to permitted audio-only conversion for %s while retaining its watch/session",async codec=>{
  streaming({audio_conversion_allowed:true,conversion_allowed:false,tracks:info.tracks.map(track=>track.index===3?{...track,codec}:track)});vi.mocked(playbackApi.seek).mockResolvedValue({...remux,method:"audio_transcode",audio_index:3,offset_seconds:400,audio_codec:"aac"});player();const video=await ready();video.currentTime=410;fireEvent.timeUpdate(video);fireEvent.click(screen.getByRole("button",{name:"Audio"}));const choice=screen.getByRole("button",{name:/English/}) as HTMLButtonElement;expect(choice.disabled).toBe(false);fireEvent.click(choice);await waitFor(()=>expect(hlsState.instances).toHaveLength(1));expect(playbackApi.seek).toHaveBeenCalledWith("playback-one",{position_seconds:410,generation:0,audio_index:3});loadMetadata(video);fireEvent.seeked(video);expect(video.currentTime).toBe(10);expect(watchApi.progress).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({audio_index:3,position_seconds:410,session_id:"watch-one"}),false);expect(playbackApi.create).toHaveBeenCalledTimes(1);expect(watchApi.begin).toHaveBeenCalledTimes(1);fireEvent.click(screen.getByRole("button",{name:"Info"}));expect(screen.getByText("Audio transcode · video copied")).toBeTruthy();expect(screen.queryByText(/GPU.*fps/i)).toBeNull();
 });
 it("restricts video quality to saved policy and preserves source position/watch token when quality changes",async()=>{
  streaming({conversion_allowed:true});player();const video=await ready();video.currentTime=410;fireEvent.timeUpdate(video);vi.mocked(playbackApi.create).mockResolvedValue({...remux,method:"transcode",id:"playback-quality",encoder:"libx264",offset_seconds:410});fireEvent.click(screen.getByRole("button",{name:"Playback quality"}));fireEvent.click(screen.getByRole("button",{name:"720p · 2 Mbps"}));await waitFor(()=>expect(playbackApi.create).toHaveBeenCalledTimes(2));expect(playbackApi.create).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({position_seconds:410,max_height:720,max_bitrate:2_000_000,force_remux:false}));expect((screen.getByRole("slider",{name:"Seek"}) as HTMLInputElement).value).toBe("410");loadMetadata(video);fireEvent.seeked(video);expect(video.currentTime).toBe(0);expect(watchApi.begin).toHaveBeenCalledTimes(1);
 });
 it("leaves manual encoding choices disabled when only lossless playback is allowed",async()=>{
  streaming({conversion_allowed:false,audio_conversion_allowed:false});player();await ready();fireEvent.click(screen.getByRole("button",{name:"Playback quality"}));expect((screen.getByRole("button",{name:"720p · 2 Mbps"}) as HTMLButtonElement).disabled).toBe(true);expect((screen.getByRole("button",{name:"Direct Stream · lossless"}) as HTMLButtonElement).disabled).toBe(false);fireEvent.click(screen.getByRole("button",{name:"Original · direct only"}));await waitFor(()=>expect(playbackApi.create).toHaveBeenCalledTimes(2));expect(playbackApi.create).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({direct_only:true,force_remux:false,max_height:0,max_bitrate:0}));
 });
 it.each(["pgs","vobsub"] as const)("renders %s using a lazy browser overlay, positive source offset and bounded resources; Off disposes without changing media",async format=>{
  streaming({tracks:[...info.tracks,{index:4,kind:"subtitle",codec:format==="pgs"?"hdmv_pgs_subtitle":"dvd_subtitle",subtitle_format:format,url:"/private-bitmap",language:"en"}]});vi.mocked(playbackApi.create).mockResolvedValue(remux);player();const video=await ready();const source=video.getAttribute("src");fireEvent.click(screen.getByRole("button",{name:"Subtitles"}));fireEvent.click(screen.getByRole("button",{name:/English/}));await waitFor(()=>expect(bitmap.construct).toHaveBeenCalledWith(format,expect.objectContaining({video,subUrl:"/private-bitmap",fileName:format==="pgs"?"track.sup":"track.mks",timeOffset:290,cacheLimit:8,maxSubtitleBytes:128*1024*1024,displaySettings:{aspectMode:"contain"}})));fireEvent.click(screen.getByRole("button",{name:"Subtitles"}));fireEvent.click(screen.getByRole("button",{name:"Off"}));expect(bitmap.dispose).toHaveBeenCalledTimes(1);expect(video.getAttribute("src")).toBe(source);expect(playbackApi.create).toHaveBeenCalledTimes(1);expect(playbackApi.seek).not.toHaveBeenCalled();
 });
 it("disposes HLS and bitmap resources on a route change and rejects their late errors",async()=>{
  streaming({tracks:[...info.tracks,{index:4,kind:"subtitle",codec:"hdmv_pgs_subtitle",subtitle_format:"pgs",default:true,url:"/bitmap"}]});vi.mocked(playbackApi.create).mockResolvedValue(remux);player();const video=await ready();await waitFor(()=>expect(bitmap.construct).toHaveBeenCalled());const previous=hlsState.instances[0],options=bitmap.construct.mock.lastCall![1] as {onError:(error:Error)=>void};vi.mocked(playbackApi.info).mockImplementation(()=>new Promise(()=>{}));await act(async()=>navigateInTest!("/play/native/anime/two"));expect(previous.destroy).toHaveBeenCalledTimes(1);expect(bitmap.dispose).toHaveBeenCalledTimes(1);act(()=>{previous.emit("error",{fatal:true,type:"networkError"});options.onError(new Error("Late bitmap"));});expect(screen.queryByRole("alert")).toBeNull();expect(screen.queryByText(/Late bitmap/)).toBeNull();expect(video.getAttribute("src")).toBeNull();
 });
 it("reduces automatic bandwidth only after sustained partial HLS downloads and a real startup stall",async()=>{
  vi.useFakeTimers({shouldAdvanceTime:true});let now=0;vi.spyOn(performance,"now").mockImplementation(()=>now);streaming({bandwidth_adaptation_allowed:true,conversion_allowed:false,source_bitrate:8_000_000});vi.mocked(playbackApi.create).mockResolvedValueOnce(remux).mockResolvedValue({...remux,id:"limited",method:"transcode",offset_seconds:295,bitrate:1_600_000});player();await waitFor(()=>expect(hlsState.instances).toHaveLength(1));const stats={loaded:20_000,aborted:false,loading:{first:1,end:0}};act(()=>hlsState.instances[0].emit("fragLoading",{frag:{type:"main",stats}}));
  now=9000;await act(async()=>{await vi.advanceTimersByTimeAsync(9000);});expect(playbackApi.create).toHaveBeenCalledTimes(1);for(const at of [10_000,11_000,12_000]){now=at;stats.loaded+=250_000;await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});}
  await waitFor(()=>expect(playbackApi.create).toHaveBeenCalledTimes(2));expect(playbackApi.create).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({position_seconds:295,bandwidth_limit_bps:1_600_000,max_height:0,max_bitrate:0,force_remux:false}));expect(vi.mocked(playbackApi.create).mock.lastCall![2].force_transcode).toBeUndefined();expect(screen.getByText(/Automatic bandwidth: playback bitrate reduced/)).toBeTruthy();expect(watchApi.begin).toHaveBeenCalledTimes(1);
 });
 it.each(["disabled","unknown bitrate","paused","producer wait"])("does not adapt HLS bandwidth during %s",async condition=>{
  vi.useFakeTimers({shouldAdvanceTime:true});let now=0;vi.spyOn(performance,"now").mockImplementation(()=>now);streaming({bandwidth_adaptation_allowed:condition!=="disabled",source_bitrate:condition==="unknown bitrate"?null:8_000_000});vi.mocked(playbackApi.create).mockResolvedValue(remux);player();const video=await ready();if(condition==="paused"){Object.defineProperty(video,"paused",{value:false,configurable:true});fireEvent.play(video);fireEvent.click(screen.getByRole("button",{name:"Pause"}));Object.defineProperty(video,"paused",{value:true,configurable:true});fireEvent.pause(video);}const stats={loaded:condition==="producer wait"?0:20_000,aborted:false,loading:{first:condition==="producer wait"?0:1,end:0}};act(()=>hlsState.instances[0].emit("fragLoading",{frag:{type:"main",stats}}));now=9000;await act(async()=>{await vi.advanceTimersByTimeAsync(9000);});for(const at of [10_000,11_000,12_000,20_000]){now=at;if(condition!=="producer wait")stats.loaded+=250_000;await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});}expect(playbackApi.create).toHaveBeenCalledTimes(1);expect(screen.queryByText(/Automatic bandwidth: playback bitrate reduced/)).toBeNull();
 });
});


it("starts eligible cold HEVC Matroska resumes with lossless copying immediately",async()=>{
  hlsState.supported=true;vi.stubGlobal("MediaSource",{isTypeSupported:()=>true});
  vi.mocked(playbackApi.info).mockResolvedValue({...info,container:"mkv",remux_allowed:true,tracks:info.tracks.map(track=>track.kind==="video"?{...track,codec:"hevc"}:track)});
  vi.mocked(playbackApi.create).mockResolvedValue({...session,method:"remux",generation:1,offset_seconds:290,url:"/hls/1/index.m3u8",mime:"application/vnd.apple.mpegurl"});
  player();const video=await ready();
  expect(playbackApi.create).toHaveBeenCalledTimes(1);
  expect(playbackApi.create).toHaveBeenCalledWith("anime","one",expect.objectContaining({force_remux:true,max_bitrate:0,max_height:0,position_seconds:295}));
  expect(video.currentTime).toBe(5);
  expect(watchApi.progress).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({position_seconds:295}),false);
  vi.mocked(playbackApi.create).mockResolvedValue(session);
  fireEvent.click(screen.getByRole("button",{name:"Playback quality"}));
  fireEvent.click(screen.getByRole("button",{name:"Original · direct only"}));
  await waitFor(()=>expect(playbackApi.create).toHaveBeenCalledTimes(2));
  expect(playbackApi.create).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({direct_only:true,force_remux:false}));
});

it("keeps warm native HEVC Matroska seeks on their original source",async()=>{
  hlsState.supported=true;vi.stubGlobal("MediaSource",{isTypeSupported:()=>true});
  vi.mocked(playbackApi.info).mockResolvedValue({...info,container:"mkv",remux_allowed:true,tracks:info.tracks.map(track=>track.kind==="video"?{...track,codec:"hevc"}:track)});
  vi.mocked(watchApi.begin).mockResolvedValue({session_id:"watch-one",state:{...state,position_seconds:0}});
  player();const video=await ready();const source=video.getAttribute("src");scrubTo(600);fireEvent.seeked(video);
  expect(video.currentTime).toBe(600);expect(video.getAttribute("src")).toBe(source);expect(playbackApi.create).toHaveBeenCalledTimes(1);
});

it.each(["zero","forbidden","unsupported","other codec"])("keeps the original cold source when copied resume is %s",async condition=>{
  hlsState.supported=true;vi.stubGlobal("MediaSource",{isTypeSupported:()=>condition!=="unsupported"});
  vi.mocked(playbackApi.info).mockResolvedValue({...info,container:"mkv",remux_allowed:condition!=="forbidden",tracks:info.tracks.map(track=>track.kind==="video"?{...track,codec:condition==="other codec"?"h264":"hevc"}:track)});
  if(condition==="zero")vi.mocked(watchApi.begin).mockResolvedValue({session_id:"watch-one",state:{...state,position_seconds:0}});
  player();await waitFor(()=>expect(playbackApi.create).toHaveBeenCalled());
  expect(playbackApi.create).toHaveBeenCalledTimes(1);
  expect(playbackApi.create).toHaveBeenCalledWith("anime","one",expect.objectContaining({force_remux:false,direct_only:false}));
});

it("bounds native initialization without decoded data and preserves its resume target",async()=>{
  vi.useFakeTimers({shouldAdvanceTime:true});hlsState.supported=true;vi.stubGlobal("MediaSource",{isTypeSupported:()=>true});
  vi.mocked(playbackApi.info).mockResolvedValue({...info,remux_allowed:true});
  vi.mocked(playbackApi.create).mockResolvedValueOnce(session).mockResolvedValue({...session,method:"remux",generation:1,offset_seconds:290,url:"/hls/1/index.m3u8",mime:"application/vnd.apple.mpegurl"});
  player();await waitFor(()=>expect(playbackApi.create).toHaveBeenCalled());
  const video=document.querySelector("video")!;Object.defineProperty(video,"readyState",{value:1,configurable:true});fireEvent.loadedMetadata(video);
  await act(async()=>{await vi.advanceTimersByTimeAsync(9000);});
  expect(playbackApi.create).toHaveBeenCalledTimes(2);
  expect(playbackApi.create).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({force_remux:true,position_seconds:295}));
  expect(watchApi.progress).not.toHaveBeenCalledWith("anime","one",expect.objectContaining({position_seconds:0}),expect.anything());
});

it("primes cold resumed original media before seeking and never starts at zero", async () => {
  player();
  await waitFor(() => expect(playbackApi.create).toHaveBeenCalled());
  const video = document.querySelector("video")!;
  Object.defineProperty(video, "readyState", { value: 1, configurable: true });
  Object.defineProperty(video, "seekable", { value: { length: 1, start: () => 0, end: () => 1200 }, configurable: true });
  fireEvent.loadedMetadata(video);
  expect(video.currentTime).toBe(0);
  expect(video.preload).toBe("auto");
  expect(video.play).not.toHaveBeenCalled();
  expect(watchApi.progress).not.toHaveBeenCalledWith("anime", "one", expect.objectContaining({ position_seconds: 0 }), expect.anything());
  Object.defineProperty(video, "readyState", { value: 2, configurable: true });
  fireEvent.loadedData(video);
  expect(video.currentTime).toBe(295);
  expect(video.play).toHaveBeenCalledTimes(1);
  fireEvent.seeked(video);
});

it("does not recreate an original source when selecting its current quality", async () => {
  player();
  const video = await ready();
  const source = video.getAttribute("src");
  vi.mocked(video.load).mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Playback quality" }));
  fireEvent.click(screen.getByRole("button", { name: "Auto · direct playback first" }));
  expect(playbackApi.create).toHaveBeenCalledTimes(1);
  expect(playbackApi.stop).not.toHaveBeenCalled();
  expect(video.load).not.toHaveBeenCalled();
  expect(video.getAttribute("src")).toBe(source);
});

it("finishes exit progress before deleting playback or reopening the same item", async () => {
  player();
  const video = await ready();
  video.currentTime = 700;
  fireEvent.timeUpdate(video);
  let finish!: () => void;
  const saving = new Promise<void>(resolve => { finish = resolve; });
  vi.mocked(watchApi.progress).mockImplementation(() => saving.then(() => ({ ...state, position_seconds: 700 })));
  fireEvent.click(screen.getByRole("button", { name: "Back to media" }));
  await screen.findByText("Media page");
  expect(playbackApi.stop).not.toHaveBeenCalled();
  vi.mocked(watchApi.state).mockClear();
  vi.mocked(watchApi.begin).mockClear();
  await act(async () => navigateInTest!("/play/native/anime/one"));
  expect(watchApi.state).not.toHaveBeenCalled();
  expect(watchApi.begin).not.toHaveBeenCalled();
  await act(async () => { finish(); await saving; });
  await waitFor(() => expect(watchApi.begin).toHaveBeenCalledTimes(1));
  expect(playbackApi.stop).toHaveBeenCalledWith("playback-one");
});

it("preserves bitmap subtitles across a retained HLS generation seek", async () => {
  hlsState.supported = true;
  vi.stubGlobal("MediaSource", { isTypeSupported: () => true });
  vi.mocked(playbackApi.info).mockResolvedValue({ ...info, remux_allowed: true, tracks: [...info.tracks, { index: 4, kind: "subtitle", codec: "hdmv_pgs_subtitle", subtitle_format: "pgs", language: "en", default: true }] });
  vi.mocked(watchApi.preferences).mockResolvedValue({ ...defaultPlaybackPreferences, subtitle_mode: "always" });
  const remux: PlaybackSession = { ...session, method: "remux", generation: 1, offset_seconds: 290, url: "/hls/1/index.m3u8", mime: "application/vnd.apple.mpegurl" };
  vi.mocked(playbackApi.create).mockResolvedValue(remux);
  vi.mocked(playbackApi.seek).mockResolvedValue({ ...remux });
  player();
  const video = await ready();
  await waitFor(() => expect(bitmap.construct).toHaveBeenCalledTimes(1));
  scrubTo(400);
  await waitFor(() => expect(video.currentTime).toBe(110));
  await act(async () => {});
  expect(bitmap.construct).toHaveBeenCalledTimes(1);
  expect(bitmap.dispose).not.toHaveBeenCalled();
});

it("offers explicit source recovery for a stalled original-only seek without creating a session", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  player();
  const video = await ready();
  scrubTo(900);
  Object.defineProperty(video, "seeking", { value: true, configurable: true });
  await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
  expect(screen.getByRole("button", { name: "Recover current playback" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Recover current playback" }));
  expect(playbackApi.create).toHaveBeenCalledTimes(1);
  expect(playbackApi.stop).not.toHaveBeenCalled();
  expect(video.getAttribute("src")).toBe(session.url);
  Object.defineProperty(video, "seeking", { value: false, configurable: true });
  loadMetadata(video);
  fireEvent.seeked(video);
  expect(video.currentTime).toBe(900);
});

it("recovers an auto-mode native seek using only policy-authorized stream copying", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  hlsState.supported = true;
  vi.stubGlobal("MediaSource", { isTypeSupported: () => true });
  vi.mocked(playbackApi.info).mockResolvedValue({ ...info, remux_allowed: true });
  vi.mocked(playbackApi.create).mockResolvedValueOnce(session).mockResolvedValue({ ...session, method: "remux", generation: 1, offset_seconds: 896, url: "/hls/1/index.m3u8", mime: "application/vnd.apple.mpegurl" });
  player();
  const video = await ready();
  scrubTo(900);
  Object.defineProperty(video, "seeking", { value: true, configurable: true });
  await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
  expect(playbackApi.create).toHaveBeenCalledTimes(2);
  expect(playbackApi.create).toHaveBeenLastCalledWith("anime", "one", expect.objectContaining({ force_remux: true, max_bitrate: 0, position_seconds: 900 }));
  expect(watchApi.begin).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/Recovering with a lossless stream/)).toBeTruthy();
  Object.defineProperty(video, "seeking", { value: false, configurable: true });
  loadMetadata(video);
  fireEvent.seeked(video);
  expect(video.currentTime).toBe(4);
});

it("recovers missing video frames even while audio advances the native clock",async()=>{
  vi.useFakeTimers({shouldAdvanceTime:true});hlsState.supported=true;
  vi.stubGlobal("MediaSource",{isTypeSupported:()=>true});
  vi.mocked(playbackApi.info).mockResolvedValue({...info,remux_allowed:true});
  vi.mocked(playbackApi.create).mockResolvedValueOnce(session).mockResolvedValue({...session,method:"remux",generation:1,offset_seconds:896,url:"/hls/1/index.m3u8",mime:"application/vnd.apple.mpegurl"});
  player();const video=await ready();video.requestVideoFrameCallback=vi.fn(()=>1);video.cancelVideoFrameCallback=vi.fn();
  Object.defineProperty(video,"paused",{value:false,configurable:true});scrubTo(900);fireEvent.seeked(video);
  for(let second=1;second<=9;second++){
    video.currentTime=900+second;fireEvent.timeUpdate(video);
    await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
  }
  expect(playbackApi.create).toHaveBeenCalledTimes(2);
  expect(playbackApi.create).toHaveBeenLastCalledWith("anime","one",expect.objectContaining({force_remux:true,max_bitrate:0,position_seconds:expect.any(Number)}));
});

it("retries transient HLS network errors within the same owned session and cancels retry after exit", async () => {
  hlsState.supported = true;
  vi.stubGlobal("MediaSource", { isTypeSupported: () => true });
  vi.mocked(playbackApi.info).mockResolvedValue({ ...info, remux_allowed: true });
  vi.mocked(playbackApi.create).mockResolvedValue({ ...session, method: "remux", generation: 1, offset_seconds: 290, url: "/hls/1/index.m3u8", mime: "application/vnd.apple.mpegurl" });
  player();
  const video = await ready();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const engine = hlsState.instances[0];
  act(() => engine.emit("error", { fatal: true, type: "networkError" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(engine.startLoad).toHaveBeenCalledWith(video.currentTime);
  expect(playbackApi.create).toHaveBeenCalledTimes(1);
  expect(playbackApi.stop).not.toHaveBeenCalled();
  act(() => engine.emit("error", { fatal: true, type: "networkError" }));
  fireEvent.click(screen.getByRole("button", { name: "Back to media" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(engine.startLoad).toHaveBeenCalledTimes(1);
});

it("reports a delayed obsolete stop instead of leaving a replacement source preparing forever", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  player();
  await ready();
  let finish!: () => void;
  vi.mocked(playbackApi.stop).mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole("button", { name: "Playback quality" }));
  fireEvent.click(screen.getByRole("button", { name: "Original · direct only" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(screen.getByText(/previous playback session is still finishing/)).toBeTruthy();
  expect(playbackApi.create).toHaveBeenCalledTimes(1);
  await act(async () => { finish(); });
  fireEvent.click(screen.getByRole("button", { name: "Retry original playback" }));
  await waitFor(() => expect(playbackApi.create).toHaveBeenCalledTimes(2));
});

it("does not diagnose autoplay denial as a native playback stall", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValue(new DOMException("Gesture required", "NotAllowedError"));
  player();
  const video = await ready();
  fireEvent.seeked(video);
  await act(async () => { await vi.advanceTimersByTimeAsync(40_000); });
  expect(screen.getByText("Press Play to begin playback.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Recover current playback" })).toBeNull();
  expect(playbackApi.create).toHaveBeenCalledTimes(1);
});


it("retains a cold native seek deadline when synthetic clocks settle before a decoded frame", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  hlsState.supported = true;
  vi.stubGlobal("MediaSource", { isTypeSupported: () => true });
  vi.mocked(playbackApi.info).mockResolvedValue({ ...info, remux_allowed: true });
  vi.mocked(playbackApi.create).mockResolvedValueOnce(session).mockResolvedValue({
    ...session, method: "remux", generation: 1, offset_seconds: 896,
    url: "/hls/1/index.m3u8", mime: "application/vnd.apple.mpegurl",
  });
  player();
  const video = await ready();
  scrubTo(900);
  Object.defineProperty(video, "paused", { value: false, configurable: true });
  Object.defineProperty(video, "readyState", { value: 1, configurable: true });
  Object.defineProperty(video, "seeking", { value: false, configurable: true });
  fireEvent.seeked(video);
  video.currentTime = 900.5;
  fireEvent.timeUpdate(video);
  expect((screen.getByRole("slider", { name: "Seek" }) as HTMLInputElement).value).toBe("900");
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  video.currentTime = 900.7;
  fireEvent.timeUpdate(video);
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  expect(playbackApi.create).toHaveBeenCalledTimes(2);
  expect(playbackApi.create).toHaveBeenLastCalledWith("anime", "one", expect.objectContaining({
    force_remux: true, max_bitrate: 0, position_seconds: 900,
  }));
  expect(watchApi.begin).toHaveBeenCalledTimes(1);
});

it("settles a paused native seek when its decoded frame arrives after an early seeked event", async () => {
  player();
  const video = await ready();
  scrubTo(600);
  Object.defineProperty(video, "readyState", { value: 1, configurable: true });
  fireEvent.seeked(video);
  video.currentTime = 600.5;
  fireEvent.timeUpdate(video);
  expect((screen.getByRole("slider", { name: "Seek" }) as HTMLInputElement).value).toBe("600");
  Object.defineProperty(video, "readyState", { value: 2, configurable: true });
  fireEvent.loadedData(video);
  expect((screen.getByRole("slider", { name: "Seek" }) as HTMLInputElement).value).toBe("600.5");
  expect(playbackApi.create).toHaveBeenCalledTimes(1);
});
