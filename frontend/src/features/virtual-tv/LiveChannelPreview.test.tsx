import {act,cleanup,fireEvent,render} from "@testing-library/react";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {apiRequest} from "../../api/client";
import {playbackApi,defaultPlaybackPreferences} from "../playback/api/playback";
import {watchApi} from "../playback/api/watch";
import {automaticStreamCopyAllowed,playbackCapabilities} from "../playback/lib/playback";
import {attachSegmentedPlayback} from "../playback/lib/hlsDelivery";
import LiveChannelPreview,{stopLivePreviews} from "./LiveChannelPreview";
vi.mock("../../api/client",()=>({apiRequest:vi.fn()}));
vi.mock("../playback/api/watch",()=>({watchApi:{preferences:vi.fn()}}));
vi.mock("../playback/api/playback",async original=>({...await original<typeof import("../playback/api/playback")>(),playbackApi:{info:vi.fn(),create:vi.fn(),stop:vi.fn(),heartbeat:vi.fn()}}));
vi.mock("../playback/lib/playback",async original=>({...await original<typeof import("../playback/lib/playback")>(),playbackCapabilities:vi.fn(),automaticStreamCopyAllowed:vi.fn()}));
vi.mock("../playback/lib/hlsDelivery",()=>({attachSegmentedPlayback:vi.fn()}));
const tune={library_id:"lib",item_id:"episode",program_id:"program",position_seconds:120,ends_at:"2099-01-01T00:00:00Z"};
const session={id:"preview",method:"direct" as const,url:"/media",mime:"video/mp4",offset_seconds:0,duration_seconds:1200,reason:"original"};
const props={channelId:"channel",programId:"program",endsAt:tune.ends_at,onReady:vi.fn()};
beforeEach(()=>{
 vi.useFakeTimers();vi.clearAllMocks();vi.spyOn(HTMLMediaElement.prototype,"play").mockResolvedValue();vi.spyOn(HTMLMediaElement.prototype,"pause").mockImplementation(()=>{});vi.spyOn(HTMLMediaElement.prototype,"load").mockImplementation(()=>{});
 vi.mocked(watchApi.preferences).mockResolvedValue(defaultPlaybackPreferences);
 vi.mocked(apiRequest).mockResolvedValue(tune);vi.mocked(playbackApi.info).mockResolvedValue({title:"Episode",container:"mp4",duration_seconds:1200,tracks:[],chapters:[]});vi.mocked(playbackApi.create).mockResolvedValue({...session});vi.mocked(playbackApi.stop).mockResolvedValue();vi.mocked(playbackApi.heartbeat).mockResolvedValue();
 vi.mocked(playbackCapabilities).mockResolvedValue({containers:["mp4"],source_video_supported:true} as Awaited<ReturnType<typeof playbackCapabilities>>);vi.mocked(automaticStreamCopyAllowed).mockReturnValue(false);
});
it("resumes automatically when the guide becomes visible again",async()=>{
 render(<LiveChannelPreview {...props}/>);await start();
 Object.defineProperty(document,"hidden",{configurable:true,value:true});fireEvent(document,new Event("visibilitychange"));
 await act(async()=>{await Promise.resolve();});expect(playbackApi.stop).toHaveBeenCalledWith("preview",true);
 Object.defineProperty(document,"hidden",{configurable:true,value:false});fireEvent(document,new Event("visibilitychange"));await start();expect(playbackApi.create).toHaveBeenCalledTimes(2);
});
it("uses enabled default text subtitles locally without requesting an encode",async()=>{
 vi.mocked(playbackApi.info).mockResolvedValue({title:"Episode",container:"mp4",duration_seconds:1200,chapters:[],tracks:[{index:2,kind:"subtitle",codec:"webvtt",subtitle_format:"vtt",default:true,language:"en",url:"/subtitles.vtt"}]});
 vi.stubGlobal("fetch",vi.fn().mockResolvedValue({ok:true,text:async()=>"WEBVTT\n"}));
 vi.spyOn(URL,"createObjectURL").mockReturnValue("blob:preview-subtitles");vi.spyOn(URL,"revokeObjectURL").mockImplementation(()=>{});
 Object.defineProperty(HTMLTrackElement.prototype,"track",{configurable:true,get:()=>({mode:"disabled",cues:[]})});
 const view=render(<LiveChannelPreview {...props}/>);await start();expect(watchApi.preferences).toHaveBeenCalled();expect(view.container.querySelector("track")?.src).toContain("blob:preview-subtitles");
 expect(playbackApi.create).toHaveBeenCalledWith("lib","episode",expect.objectContaining({subtitle_index:null,direct_only:true}));
 view.unmount();expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview-subtitles");vi.unstubAllGlobals();
});
afterEach(async()=>{cleanup();await act(async()=>{await Promise.resolve();await Promise.resolve();});vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();delete (HTMLTrackElement.prototype as unknown as {track?:unknown}).track;});
const start=async()=>{await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});};
it("keeps subtitles off when the viewer disables them",async()=>{
 vi.mocked(watchApi.preferences).mockResolvedValue({...defaultPlaybackPreferences,subtitle_mode:"off"});
 vi.mocked(playbackApi.info).mockResolvedValue({title:"Episode",container:"mp4",duration_seconds:1200,chapters:[],tracks:[{index:2,kind:"subtitle",codec:"webvtt",subtitle_format:"vtt",default:true,language:"en",url:"/subtitles.vtt"}]});
 const view=render(<LiveChannelPreview {...props}/>);await start();expect(view.container.querySelector("track")).toBeNull();expect(playbackApi.create).toHaveBeenCalled();
});
it("debounces startup and never creates a session after immediate unmount",async()=>{const view=render(<LiveChannelPreview {...props}/>);await act(async()=>{await vi.advanceTimersByTimeAsync(1900);});expect(apiRequest).not.toHaveBeenCalled();view.unmount();await start();expect(playbackApi.create).not.toHaveBeenCalled();});
it("keeps the image until the first decoded frame and seeks to live before playing",async()=>{
 const view=render(<LiveChannelPreview {...props}/>);const video=view.container.querySelector("video")!;let frame!:VideoFrameRequestCallback;
 Object.defineProperty(video,"requestVideoFrameCallback",{value:vi.fn(callback=>{frame=callback;return 1;})});Object.defineProperty(video,"cancelVideoFrameCallback",{value:vi.fn()});Object.defineProperty(video,"readyState",{value:2});Object.defineProperty(video,"videoWidth",{value:1920});
 await start();fireEvent.loadedMetadata(video);expect(video.currentTime).toBe(120);expect(video.muted).toBe(true);fireEvent.playing(video);expect(props.onReady).not.toHaveBeenCalledWith(true);act(()=>frame(0,{} as VideoFrameCallbackMetadata));expect(props.onReady).toHaveBeenLastCalledWith(true);
 fireEvent.waiting(video);expect(props.onReady).toHaveBeenLastCalledWith(false);
});
it("rejects a stale program or an expired guide entry",async()=>{vi.mocked(apiRequest).mockResolvedValue({...tune,program_id:"other"});const view=render(<LiveChannelPreview {...props}/>);await start();expect(playbackApi.create).not.toHaveBeenCalled();view.unmount();render(<LiveChannelPreview {...props} endsAt="2000-01-01T00:00:00Z"/>);await start();expect(apiRequest).toHaveBeenCalledTimes(1);});
it("deletes late allocations before a replacement begins",async()=>{
 let resolve!:(value:typeof session)=>void;vi.mocked(playbackApi.create).mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));const view=render(<LiveChannelPreview {...props}/>);await start();view.rerender(<LiveChannelPreview {...props} channelId="other"/>);await start();expect(playbackApi.create).toHaveBeenCalledTimes(1);
 await act(async()=>{resolve({...session});await Promise.resolve();});expect(playbackApi.stop).toHaveBeenCalledWith("preview",true);expect(playbackApi.create).toHaveBeenCalledTimes(2);
});
it("preserves pending teardown across several rapid selections",async()=>{
 let finishStop!:()=>void;vi.mocked(playbackApi.stop).mockImplementationOnce(()=>new Promise(done=>{finishStop=done;}));
 const view=render(<LiveChannelPreview {...props}/>);await start();view.rerender(<LiveChannelPreview {...props} channelId="second"/>);view.rerender(<LiveChannelPreview {...props} channelId="third"/>);await start();expect(playbackApi.create).toHaveBeenCalledTimes(1);
 await act(async()=>{finishStop();await Promise.resolve();});expect(playbackApi.create).toHaveBeenCalledTimes(2);expect(apiRequest).toHaveBeenLastCalledWith("/virtual-tv/channels/third/tune",expect.anything());
});
it("stops at the schedule boundary and falls back on startup failure",async()=>{
 const view=render(<LiveChannelPreview {...props} endsAt={new Date(Date.now()+3000).toISOString()}/>);await start();await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});expect(playbackApi.stop).toHaveBeenCalledWith("preview",true);view.unmount();vi.mocked(playbackApi.create).mockRejectedValueOnce(new Error("Unsupported"));render(<LiveChannelPreview {...props}/>);await start();expect(props.onReady).toHaveBeenLastCalledWith(false);
});
it("permits lossless remux but rejects encoding sessions",async()=>{
 vi.mocked(automaticStreamCopyAllowed).mockReturnValue(true);vi.mocked(playbackApi.info).mockResolvedValue({title:"Episode",container:"mkv",duration_seconds:1200,tracks:[],chapters:[]});vi.mocked(playbackApi.create).mockResolvedValue({...session,method:"remux"});vi.mocked(attachSegmentedPlayback).mockReturnValue({destroy:vi.fn()} as unknown as ReturnType<typeof attachSegmentedPlayback>);
 const view=render(<LiveChannelPreview {...props}/>);await start();expect(playbackApi.create).toHaveBeenCalledWith("lib","episode",expect.objectContaining({force_remux:true,direct_only:false,subtitle_index:null,virtual_channel_id:"channel"}));expect(attachSegmentedPlayback).toHaveBeenCalled();view.unmount();await act(async()=>{await Promise.resolve();});vi.mocked(playbackApi.create).mockResolvedValue({...session,method:"transcode"});render(<LiveChannelPreview {...props}/>);await start();expect(playbackApi.stop).toHaveBeenCalledTimes(2);
});
it("stops when decoding never becomes ready",async()=>{render(<LiveChannelPreview {...props}/>);await start();await act(async()=>{await vi.advanceTimersByTimeAsync(15_000);});expect(playbackApi.stop).toHaveBeenCalledWith("preview",true);expect(props.onReady).toHaveBeenLastCalledWith(false);});
it("lets full playback await explicit preview teardown and treats a denied heartbeat as fatal",async()=>{
 const view=render(<LiveChannelPreview {...props}/>);await start();await act(async()=>{await stopLivePreviews();});expect(playbackApi.stop).toHaveBeenCalledTimes(1);view.unmount();
 vi.mocked(playbackApi.heartbeat).mockRejectedValueOnce(new Error("Access revoked"));render(<LiveChannelPreview {...props}/>);await start();await act(async()=>{await vi.advanceTimersByTimeAsync(10_000);});expect(playbackApi.stop).toHaveBeenCalledTimes(2);expect(props.onReady).toHaveBeenLastCalledWith(false);
});
