import {afterEach,describe,it,expect,vi} from "vitest";
import {attachSegmentedPlayback,msePlaybackSupported,segmentedPlaybackSupported} from "./hlsDelivery";
import type {PlaybackSession} from "../types";
const moduleLoad=vi.hoisted(()=>{
 let complete!:()=>void;const ready=new Promise<void>(resolve=>{complete=resolve;});return {ready,complete,factory:vi.fn(),created:vi.fn(),destroy:vi.fn()};
});
vi.mock("hls.js",async()=>{moduleLoad.factory();await moduleLoad.ready;return {default:class{
 static isSupported(){return true;}static Events={ERROR:"error",FRAG_LOADING:"loading",FRAG_LOADED:"loaded"};static ErrorTypes={MEDIA_ERROR:"media",NETWORK_ERROR:"network"};media:HTMLVideoElement|null=null;latestLevelDetails={fragments:[]};constructor(options:unknown){moduleLoad.created(options);}on(){}loadSource(){}attachMedia(video:HTMLVideoElement){this.media=video;video.src="blob:owned-hls";}destroy(){moduleLoad.destroy();this.media=null;}startLoad(){}recoverMediaError(){}
}};});
const session:PlaybackSession={id:"one",generation:1,method:"remux",url:"/hls/1/index.m3u8",offset_seconds:0,mime:"application/vnd.apple.mpegurl",reason:"Copy",duration_seconds:1200};
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
describe("lightweight HLS capability and lazy delivery",()=>{
 it("rejects missing MSE, broken exposed SourceBuffer methods and unsupported baseline types",()=>{
  vi.stubGlobal("MediaSource",undefined);vi.stubGlobal("ManagedMediaSource",undefined);vi.stubGlobal("WebKitMediaSource",undefined);expect(msePlaybackSupported()).toBe(false);vi.stubGlobal("MediaSource",{isTypeSupported:()=>true});vi.stubGlobal("SourceBuffer",{prototype:{appendBuffer(){}}});expect(msePlaybackSupported()).toBe(false);vi.stubGlobal("SourceBuffer",{prototype:{appendBuffer(){},remove(){}}});vi.stubGlobal("MediaSource",{isTypeSupported:()=>false});expect(msePlaybackSupported()).toBe(false);
 });
 it("matches Managed/WebKit selection and the official video/audio baseline MIME probes",()=>{
  vi.stubGlobal("MediaSource",{isTypeSupported:()=>false});const probe=vi.fn((mime:string)=>mime==="audio/mp4;codecs=fLaC");vi.stubGlobal("ManagedMediaSource",{isTypeSupported:probe});expect(msePlaybackSupported()).toBe(true);expect(probe.mock.calls.map(call=>call[0])).toEqual(["video/mp4;codecs=avc1.42E01E,mp4a.40.2","video/mp4;codecs=av01.0.01M.08","video/mp4;codecs=vp09.00.50.08","audio/mp4;codecs=mp4a.40.2","audio/mp4;codecs=fLaC"]);vi.stubGlobal("ManagedMediaSource",undefined);vi.stubGlobal("MediaSource",undefined);vi.stubGlobal("WebKitMediaSource",{isTypeSupported:()=>true});expect(msePlaybackSupported()).toBe(true);
 });
 it("uses native HLS without loading the engine when MSE is unavailable",()=>{
  vi.stubGlobal("MediaSource",undefined);const video=document.createElement("video");vi.spyOn(video,"canPlayType").mockReturnValue("probably");expect(segmentedPlaybackSupported(video)).toBe(true);const adapter=attachSegmentedPlayback(video,session,{fatal:vi.fn()});expect(adapter.owns()).toBe(true);expect(video.getAttribute("src")).toBe(session.url);expect(moduleLoad.factory).not.toHaveBeenCalled();adapter.destroy();expect(adapter.owns()).toBe(false);
 });
 it("discards a late engine import for a canceled source and only attaches the current generation",async()=>{
  vi.stubGlobal("MediaSource",{isTypeSupported:()=>true});const stale=document.createElement("video"),fresh=document.createElement("video"),fatal=vi.fn();let current=true;const old=attachSegmentedPlayback(stale,session,{fatal,isCurrent:()=>current});expect(old.attached()).toBe(false);await vi.waitFor(()=>expect(moduleLoad.factory).toHaveBeenCalledTimes(1));current=false;old.destroy();moduleLoad.complete();await moduleLoad.ready;await Promise.resolve();await Promise.resolve();expect(moduleLoad.created).not.toHaveBeenCalled();expect(stale.getAttribute("src")).toBeNull();expect(fatal).not.toHaveBeenCalled();const next=attachSegmentedPlayback(fresh,{...session,generation:2,url:"/hls/2/index.m3u8"},{fatal});await vi.waitFor(()=>expect(next.attached()).toBe(true));expect(moduleLoad.created).toHaveBeenCalledTimes(1);expect(fresh.getAttribute("src")).toBe("blob:owned-hls");next.destroy();expect(moduleLoad.destroy).toHaveBeenCalledTimes(1);
 });
});

it("loads unbuffered seek targets explicitly and keeps buffered seeks local", async () => {
 vi.stubGlobal("MediaSource",{isTypeSupported:()=>true});
 const video=document.createElement("video"),adapter=attachSegmentedPlayback(video,session,{fatal:vi.fn()});
 await vi.waitFor(()=>expect(adapter.attached()).toBe(true));
 const hls=adapter.hls!;
 Object.defineProperty(hls,"latestLevelDetails",{value:{fragments:[{start:30,duration:10}]},configurable:true});
 Object.defineProperty(video,"buffered",{value:{length:1,start:()=>0,end:()=>20},configurable:true});
 expect(adapter.available(10)).toBe(true);
 expect(adapter.available(35)).toBe(false);
 const load=vi.spyOn(hls,"startLoad");adapter.refresh(35);
 // Let the engine reapply the seek when the new fragment extends MSE duration.
 expect(load).toHaveBeenCalledWith(35);
 Object.defineProperty(video,"buffered",{value:{length:1,start:()=>30,end:()=>40},configurable:true});
 expect(adapter.available(35)).toBe(true);
 expect(adapter.available(35,100)).toBe(true);
 expect(adapter.available(35,160)).toBe(false);
 adapter.destroy();adapter.refresh(45);expect(load).toHaveBeenCalledTimes(1);
});

it("does not retain a failed HLS engine load across a later retry", async () => {
  vi.resetModules();
  const { loadSegmentedEngine } = await import("./hlsDelivery");
  const result = { default: {} } as unknown as typeof import("hls.js");
  const load = vi.fn<() => Promise<typeof import("hls.js")>>()
    .mockRejectedValueOnce(new Error("Temporary asset download failure"))
    .mockResolvedValue(result);
  await expect(loadSegmentedEngine(load)).rejects.toThrow("Temporary asset download failure");
  await expect(loadSegmentedEngine(load)).resolves.toBe(result);
  expect(load).toHaveBeenCalledTimes(2);
});

it.each([
 {method:"remux" as const,position:5.5,startPosition:5.5},
 {method:"remux" as const,position:-5,startPosition:0},
 {method:"remux" as const,position:NaN,startPosition:0},
 {method:"audio_transcode" as const,position:5,startPosition:0},
 {method:"transcode" as const,position:5,startPosition:0},
])("starts $method loading at the permitted resume position",async({method,position,startPosition})=>{
 vi.stubGlobal("MediaSource",{isTypeSupported:()=>true});
 const adapter=attachSegmentedPlayback(document.createElement("video"),{...session,method},{fatal:vi.fn()},position);
 await vi.waitFor(()=>expect(adapter.attached()).toBe(true));
 expect(moduleLoad.created).toHaveBeenLastCalledWith(expect.objectContaining({startPosition}));
 adapter.destroy();
});

it.each([
 {method:"remux" as const,bitrate:undefined,seconds:120},
 {method:"remux" as const,bitrate:0,seconds:120},
 {method:"audio_transcode" as const,bitrate:undefined,seconds:20},
 {method:"transcode" as const,bitrate:0,seconds:20},
 {method:"remux" as const,bitrate:4_000_000,seconds:120},
 {method:"remux" as const,bitrate:16_000_000,seconds:96*1024*1024*8/16_000_000},
 {method:"remux" as const,bitrate:200_000_000,seconds:6},
 {method:"audio_transcode" as const,bitrate:4_000_000,seconds:60},
 {method:"transcode" as const,bitrate:16_000_000,seconds:48*1024*1024*8/16_000_000},
 {method:"transcode" as const,bitrate:100_000_000,seconds:6},
])("buffers $method at $bitrate bitrate within its delivery bounds",async({method,bitrate,seconds})=>{
 vi.stubGlobal("MediaSource",{isTypeSupported:()=>true});
 const adapter=attachSegmentedPlayback(document.createElement("video"),{...session,method,bitrate},{fatal:vi.fn()});
 await vi.waitFor(()=>expect(adapter.attached()).toBe(true));
 expect(moduleLoad.created).toHaveBeenLastCalledWith(expect.objectContaining({maxBufferLength:seconds,maxMaxBufferLength:seconds,maxBufferSize:(method==="remux"?96:48)*1024*1024,backBufferLength:method==="remux"?120:60}));
 adapter.destroy();
});

it.each([true,false])("uses method-specific buffered seek retention with MSE=%s",async(mse)=>{
 vi.stubGlobal("MediaSource",mse?{isTypeSupported:()=>true}:undefined);
 for(const method of ["remux","audio_transcode","transcode"] as const){
  const video=document.createElement("video");vi.spyOn(video,"canPlayType").mockReturnValue("probably");
  Object.defineProperty(video,"buffered",{value:{length:1,start:()=>10,end:()=>30},configurable:true});
  const adapter=attachSegmentedPlayback(video,{...session,method},{fatal:vi.fn()});
  await vi.waitFor(()=>expect(adapter.attached()).toBe(true));
  expect(adapter.available(20,120)).toBe(method==="remux");
  expect(adapter.available(20,146)).toBe(false);
  expect(adapter.available(35,120)).toBe(false);
  expect(adapter.available(20,60)).toBe(true);
  adapter.destroy();
 }
});
