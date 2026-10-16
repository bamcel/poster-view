import {useEffect,useRef} from "react";
import {apiRequest} from "../../api/client";
import {playbackApi,defaultPlaybackPreferences} from "../playback/api/playback";
import {automaticStreamCopyAllowed,playbackCapabilities,selectTracks} from "../playback/lib/playback";
import {attachSegmentedPlayback} from "../playback/lib/hlsDelivery";
import type {PlaybackSession,WatchState} from "../playback/types";

// A replacement waits for even a late session allocation to be deleted.
let previousPreview:Promise<void>=Promise.resolve();
let stopCurrentPreview:(()=>void)|undefined;
export const waitForLivePreviewTeardown=()=>previousPreview;
export function stopLivePreviews():Promise<void>{stopCurrentPreview?.();return previousPreview;}
interface Props {channelId:string;programId:string;endsAt:string;onReady:(ready:boolean)=>void}
interface Tune {library_id:string;item_id:string;program_id:string;position_seconds:number;ends_at:string}
export default function LiveChannelPreview({channelId,programId,endsAt,onReady}:Props){
 const video=useRef<HTMLVideoElement>(null),ready=useRef(onReady);ready.current=onReady;
 useEffect(()=>{
  const element=video.current!;let active=true,session:PlaybackSession|undefined,engine:ReturnType<typeof attachSegmentedPlayback>|undefined;
  let frame:number|undefined,heartbeat:ReturnType<typeof setInterval>|undefined,startup:ReturnType<typeof setTimeout>|undefined;
  let release!:()=>void;const predecessor=previousPreview;previousPreview=new Promise<void>(resolve=>{release=resolve;});
  const controller=new AbortController();let starting:Promise<void>=Promise.resolve(),stopping=false;
  const alive=()=>active&&Date.now()<Date.parse(endsAt)&&!document.hidden;
  const stop=()=>{
   if(stopping)return;stopping=true;active=false;controller.abort();ready.current(false);if(stopCurrentPreview===stop)stopCurrentPreview=undefined;
   clearTimeout(debounce);clearTimeout(boundary);clearTimeout(startup);clearInterval(heartbeat);
   if(frame!==undefined)element.cancelVideoFrameCallback?.(frame);
   engine?.destroy();element.pause();element.removeAttribute("src");element.load();
   void Promise.all([predecessor,starting]).then(async()=>{if(session)await playbackApi.stop(session.id,true);}).catch(()=>{}).finally(release);
  };
  const decoded=()=>{
   if(!alive()||element.readyState<2||element.videoWidth<=0)return;
   clearTimeout(startup);ready.current(true);
  };
  const playing=()=>{
   if(!alive())return;
   if(element.requestVideoFrameCallback){if(frame!==undefined)element.cancelVideoFrameCallback?.(frame);frame=element.requestVideoFrameCallback(decoded);}
   else decoded();
  };
  const waiting=()=>{ready.current(false);if(frame!==undefined)element.cancelVideoFrameCallback?.(frame);clearTimeout(startup);startup=setTimeout(stop,15_000);};
  const metadata=()=>{
   if(!alive()||!session)return;
   element.currentTime=Math.max(0,(session.position_seconds??0)-session.offset_seconds);
   void element.play().catch(stop);
  };
  const visibility=()=>{if(document.hidden)stop();};
  element.addEventListener("loadedmetadata",metadata);element.addEventListener("playing",playing);element.addEventListener("waiting",waiting);element.addEventListener("error",stop);element.addEventListener("ended",stop);document.addEventListener("visibilitychange",visibility);
  ready.current(false);
  const boundary=setTimeout(stop,Math.min(2_147_483_647,Math.max(0,Date.parse(endsAt)-Date.now())));
  const debounce=setTimeout(()=>{
   starting=(async()=>{
    await predecessor;if(!alive())return;startup=setTimeout(stop,15_000);
    const tune=await apiRequest<Tune>(`/virtual-tv/channels/${encodeURIComponent(channelId)}/tune`,{method:"POST",signal:controller.signal});
    if(!alive()||tune.program_id!==programId||Date.now()>=Date.parse(tune.ends_at)){stop();return;}
    const info=await playbackApi.info(tune.library_id,tune.item_id,controller.signal);if(!alive())return;
    const caps=await playbackCapabilities(info,element);if(!alive())return;
    const state:WatchState={position_seconds:0,duration_seconds:0,watched:false,play_count:0,last_played_at:null,audio_index:null,subtitle_index:null,session_id:null,version:0};
    const tracks=selectTracks(info,defaultPlaybackPreferences,state);
    const copy=automaticStreamCopyAllowed(info,caps,tracks.audio)&&(!caps.containers.includes(info.container?.toLowerCase()??"")||caps.source_video_supported===false||["mkv","matroska"].includes(info.container?.toLowerCase()??""));
    session=await playbackApi.create(tune.library_id,tune.item_id,{...caps,version_id:info.version_id,virtual_channel_id:channelId,position_seconds:tune.position_seconds,audio_index:tracks.audio,subtitle_index:null,direct_only:!copy,force_remux:copy});
    if(!alive()||!["direct","remux"].includes(session.method)){stop();return;}
    session.position_seconds??=tune.position_seconds;element.muted=true;
    if(session.method==="remux")engine=attachSegmentedPlayback(element,session,{fatal:stop,isCurrent:alive},Math.max(0,session.position_seconds-session.offset_seconds));else element.src=session.url;
    heartbeat=setInterval(()=>{if(session&&alive())void playbackApi.heartbeat(session.id,element.currentTime+session.offset_seconds,false,session.generation).catch(stop);},10_000);
   })().catch(stop);
  },2000);
  stopCurrentPreview=stop;
  return()=>{stop();element.removeEventListener("loadedmetadata",metadata);element.removeEventListener("playing",playing);element.removeEventListener("waiting",waiting);element.removeEventListener("error",stop);element.removeEventListener("ended",stop);document.removeEventListener("visibilitychange",visibility);};
 },[channelId,programId,endsAt]);
 return <video ref={video} className="vtv-live-video" muted playsInline autoPlay aria-label="Live channel preview"/>;
}
