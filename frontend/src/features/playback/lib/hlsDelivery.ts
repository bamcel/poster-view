import type Hls from "hls.js";
import type {Fragment,FragLoadingData,FragLoadedData} from "hls.js";
import type {PlaybackSession} from "../types";

// Mirrors hls.js 1.7.3 is-supported.ts without loading the playback engine:
// prefer ManagedMediaSource, validate exposed SourceBuffer APIs, then probe
// the same video/audio MP4 types supported by its MSE pipeline.
export function msePlaybackSupported():boolean {
  if(typeof self==="undefined")return false;
  const scope=self as typeof self&{ManagedMediaSource?:typeof MediaSource;WebKitMediaSource?:typeof MediaSource;WebKitSourceBuffer?:typeof SourceBuffer};
  const media=scope.ManagedMediaSource||scope.MediaSource||scope.WebKitMediaSource;
  const buffer=scope.SourceBuffer||scope.WebKitSourceBuffer;
  if(!media||buffer&&(!buffer.prototype||typeof buffer.prototype.appendBuffer!=="function"||typeof buffer.prototype.remove!=="function")||typeof media.isTypeSupported!=="function")return false;
  try{return ["avc1.42E01E,mp4a.40.2","av01.0.01M.08","vp09.00.50.08"].some(codec=>media.isTypeSupported(`video/mp4;codecs=${codec}`))||["mp4a.40.2","fLaC"].some(codec=>media.isTypeSupported(`audio/mp4;codecs=${codec}`));}catch{return false;}
}
export const segmentedPlaybackSupported=(video:HTMLVideoElement)=>msePlaybackSupported()||!!video.canPlayType("application/vnd.apple.mpegurl");
type Callbacks={fatal:(message:string)=>void;isCurrent?:()=>boolean;fragmentLoading?:(data:FragLoadingData)=>void;fragmentLoaded?:(data:FragLoadedData)=>void};
let engine:Promise<typeof import("hls.js")>|undefined;
export function loadSegmentedEngine(load:()=>Promise<typeof import("hls.js")>=()=>import("hls.js")) {
  if(!engine){
    const attempt=load();engine=attempt;
    void attempt.catch(()=>{if(engine===attempt)engine=undefined;});
  }
  return engine;
}
export function attachSegmentedPlayback(video:HTMLVideoElement,session:PlaybackSession,callbacks:Callbacks) {
  if(!msePlaybackSupported()){
    if(!video.canPlayType("application/vnd.apple.mpegurl"))throw new Error("This browser cannot play a segmented stream.");
    video.src=session.url;
    let active=true;const attached=()=>active&&video.getAttribute("src")===session.url;
    return {attached,owns:()=>attached()&&callbacks.isCurrent?.()!==false,available:(time:number,confirmed=video.currentTime)=>inRange(video.buffered,time,confirmed-55),refresh:(_time:number)=>{},destroy:()=>{active=false;},hls:undefined};
  }
  let hls:Hls|undefined,active=true,recovery=0,networkRecovery=0,lastFailure=0;
  let recoveryTimer:ReturnType<typeof setTimeout>|undefined;
  const owns=()=>active&&callbacks.isCurrent?.()!==false;
  const byteBudget=48*1024*1024,rate=session.bitrate??0;
  const ahead=rate>0?Math.max(6,Math.min(60,byteBudget*8/rate)):20;
  void loadSegmentedEngine().then(({default:Engine})=>{
    if(!owns())return;
    if(!Engine.isSupported())throw new Error("This browser cannot play a segmented stream.");
    const instance=new Engine({startPosition:0,maxBufferLength:ahead,maxMaxBufferLength:ahead,maxBufferSize:byteBudget,backBufferLength:60});hls=instance;
    instance.on(Engine.Events.ERROR,(_event,data)=>{
      if(!owns()||!data.fatal)return;
      lastFailure=performance.now();
      clearTimeout(recoveryTimer);
      if(data.type===Engine.ErrorTypes.NETWORK_ERROR&&networkRecovery++<2){
        clearTimeout(recoveryTimer);
        recoveryTimer=setTimeout(()=>{recoveryTimer=undefined;if(owns())instance.startLoad(video.currentTime);},networkRecovery===1?250:750);
        return;
      }
      if(data.type===Engine.ErrorTypes.MEDIA_ERROR&&recovery++===0){instance.recoverMediaError();return;}
      clearTimeout(recoveryTimer);
      callbacks.fatal(data.type===Engine.ErrorTypes.NETWORK_ERROR?"The playback stream could not be loaded. Retry playback.":"This browser could not decode the playback stream. Retry playback.");
    });
    instance.on(Engine.Events.FRAG_LOADING,(_event,data)=>{if(owns()&&data.frag.type==="main")callbacks.fragmentLoading?.(data);});
    instance.on(Engine.Events.FRAG_LOADED,(_event,data)=>{if(owns()&&data.frag.type==="main"){
      if(performance.now()-lastFailure>=30_000){networkRecovery=0;recovery=0;}
      callbacks.fragmentLoaded?.(data);
    }});
    if(!owns()){instance.destroy();hls=undefined;return;}
    instance.loadSource(session.url);instance.attachMedia(video);
  }).catch(error=>{if(owns())callbacks.fatal(error instanceof Error?error.message:"The playback engine could not be loaded. Retry playback.");});
  return {get hls(){return hls;},attached:()=>active&&hls?.media===video,owns:()=>owns()&&hls?.media===video,available:(time:number,confirmed=video.currentTime)=>{
    if(!owns()||!hls)return false;
    if(inRange(video.buffered,time,confirmed-55))return true;
    // A stale ENDLIST can still list segments removed by the server. Outside
    // the conservative retention window, reposition instead of requesting them.
    if(time<confirmed-55)return false;
    const fragments=hls.latestLevelDetails?.fragments??[];
    return fragments.some((fragment:Fragment)=>time>=fragment.start&&time<fragment.start+fragment.duration);
  },refresh:(time:number)=>{if(owns())hls?.startLoad(time,true);},destroy:()=>{active=false;clearTimeout(recoveryTimer);hls?.destroy();hls=undefined;}};
}
function inRange(ranges:TimeRanges,time:number,minimumEnd=-Infinity){for(let index=0;index<ranges.length;index++)if(time>=ranges.start(index)&&time<ranges.end(index)&&ranges.end(index)>=minimumEnd)return true;return false;}
