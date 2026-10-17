import {Mic,MicOff} from "lucide-react";
import {useEffect,useRef,useState} from "react";
import {apiRequest} from "../../api/client";
import {playbackApi,defaultPlaybackPreferences} from "../playback/api/playback";
import {automaticStreamCopyAllowed,playbackCapabilities,selectTracks} from "../playback/lib/playback";
import {attachSegmentedPlayback} from "../playback/lib/hlsDelivery";
import type {PlaybackSession,WatchState} from "../playback/types";
import {watchApi} from "../playback/api/watch";
import {applyPlainSubtitlePosition,subtitleAppearance} from "../playback/lib/subtitleAppearance";
import {trackLabel} from "../playback/lib/playback";
import subtitleFallbackFont from "jassub/dist/default.woff2?url";

// A replacement waits for even a late session allocation to be deleted.
let previousPreview:Promise<void>=Promise.resolve();
let stopCurrentPreview:(()=>void)|undefined;
export const waitForLivePreviewTeardown=()=>previousPreview;
export function stopLivePreviews():Promise<void>{stopCurrentPreview?.();return previousPreview;}
const soundPreference="posterview-virtual-tv-preview-muted";
function initialMuted(){try{return localStorage.getItem(soundPreference)!=="false";}catch{return true;}}
interface Props {channelId:string;programId:string;endsAt:string;onReady:(ready:boolean)=>void}
interface Tune {library_id:string;item_id:string;program_id:string;position_seconds:number;ends_at:string}
export default function LiveChannelPreview({channelId,programId,endsAt,onReady}:Props){
 const video=useRef<HTMLVideoElement>(null),ready=useRef(onReady);ready.current=onReady;
 const [muted,setMuted]=useState(initialMuted);
 const mutedRef=useRef(muted);mutedRef.current=muted;
 useEffect(()=>{if(video.current)video.current.muted=muted;},[muted]);
 const toggleSound=()=>{
  const next=!muted;setMuted(next);mutedRef.current=next;
  try{localStorage.setItem(soundPreference,String(next));}catch{/* Sound remains usable when storage is unavailable. */}
  if(video.current){video.current.muted=next;if(!next)void video.current.play().catch(()=>{setMuted(true);});}
 };
 const [visibilityEpoch,setVisibilityEpoch]=useState(0);
 useEffect(()=>{const resume=()=>{if(!document.hidden)setVisibilityEpoch(value=>value+1);};document.addEventListener("visibilitychange",resume);return()=>document.removeEventListener("visibilitychange",resume);},[]);
 useEffect(()=>{
  const element=video.current!;let active=true,session:PlaybackSession|undefined,engine:ReturnType<typeof attachSegmentedPlayback>|undefined;
  let initialSeekApplied=false;
  let frame:number|undefined,heartbeat:ReturnType<typeof setInterval>|undefined,startup:ReturnType<typeof setTimeout>|undefined;
  let release!:()=>void;const predecessor=previousPreview;previousPreview=new Promise<void>(resolve=>{release=resolve;});
  const controller=new AbortController();let starting:Promise<void>=Promise.resolve(),stopping=false;
  let subtitleRenderer:{destroy:()=>Promise<void>}|undefined,subtitleTrack:HTMLTrackElement|undefined,subtitleUrl:string|undefined;
  const disableNativeSubtitles=()=>{for(const track of Array.from(element.textTracks))if(track!==subtitleTrack?.track)track.mode="disabled";};
  disableNativeSubtitles();element.textTracks.addEventListener?.("addtrack",disableNativeSubtitles);
  const alive=()=>active&&Date.now()<Date.parse(endsAt)&&!document.hidden;
  const stop=()=>{
   if(stopping)return;stopping=true;active=false;controller.abort();ready.current(false);if(stopCurrentPreview===stop)stopCurrentPreview=undefined;
   clearTimeout(debounce);clearTimeout(boundary);clearTimeout(startup);clearInterval(heartbeat);
   if(frame!==undefined)element.cancelVideoFrameCallback?.(frame);
   engine?.destroy();element.pause();element.removeAttribute("src");element.load();
   void subtitleRenderer?.destroy();subtitleTrack?.remove();if(subtitleUrl)URL.revokeObjectURL(subtitleUrl);
   element.textTracks.removeEventListener?.("addtrack",disableNativeSubtitles);
   void Promise.all([predecessor,starting]).then(async()=>{if(session)await playbackApi.stop(session.id,true);}).catch(()=>{}).finally(release);
  };
  const decoded=()=>{
   frame=undefined;
   if(!alive())return;
   if(element.readyState>=2&&element.videoWidth>0&&!element.seeking){clearTimeout(startup);ready.current(true);}
   else {ready.current(false);if(element.requestVideoFrameCallback)frame=element.requestVideoFrameCallback(decoded);}
  };
  const playing=()=>{
   if(!alive())return;
   if(element.requestVideoFrameCallback){if(frame!==undefined)element.cancelVideoFrameCallback?.(frame);frame=element.requestVideoFrameCallback(decoded);}
   else decoded();
  };
  const waiting=()=>{ready.current(false);if(frame!==undefined)element.cancelVideoFrameCallback?.(frame);frame=undefined;clearTimeout(startup);startup=setTimeout(stop,15_000);};
  const metadata=()=>{
   if(!alive()||!session)return;
   if(!initialSeekApplied){initialSeekApplied=true;element.currentTime=Math.max(0,(session.position_seconds??0)-session.offset_seconds);}
   void element.play().catch(error=>{
    // Browsers may block remembered audible autoplay on a fresh visit. Keep
    // the preference, but play silently until the viewer clicks the control.
    if(alive()&&!element.muted&&error?.name==="NotAllowedError"){
     element.muted=true;setMuted(true);void element.play().catch(stop);
    }else stop();
   });
  };
  const visibility=()=>{if(document.hidden)stop();};
  element.addEventListener("loadedmetadata",metadata);element.addEventListener("playing",playing);element.addEventListener("loadeddata",playing);element.addEventListener("canplay",playing);element.addEventListener("seeked",playing);element.addEventListener("seeking",waiting);element.addEventListener("waiting",waiting);element.addEventListener("error",stop);element.addEventListener("ended",stop);document.addEventListener("visibilitychange",visibility);
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
    const preferences=await watchApi.preferences(controller.signal).catch(()=>defaultPlaybackPreferences);if(!alive())return;
    const tracks=selectTracks(info,preferences,state);
    const copy=automaticStreamCopyAllowed(info,caps,tracks.audio)&&(!caps.containers.includes(info.container?.toLowerCase()??"")||caps.source_video_supported===false||["mkv","matroska"].includes(info.container?.toLowerCase()??""));
    session=await playbackApi.create(tune.library_id,tune.item_id,{...caps,version_id:info.version_id,virtual_channel_id:channelId,position_seconds:tune.position_seconds,audio_index:tracks.audio,subtitle_index:null,direct_only:!copy,force_remux:copy});
    if(!alive()||!["direct","remux"].includes(session.method)){stop();return;}
    session.position_seconds??=tune.position_seconds;element.muted=mutedRef.current;
    if(session.method==="remux")engine=attachSegmentedPlayback(element,session,{fatal:stop,isCurrent:alive},Math.max(0,session.position_seconds-session.offset_seconds));else element.src=session.url;
    // Render locally so subtitles never turn a lightweight preview into an encode.
    const selected=info.tracks.find(track=>track.kind==="subtitle"&&track.index===tracks.subtitle);
    if(selected)void(async()=>{
     try{
      const url=selected.url||playbackApi.subtitle(tune.library_id,tune.item_id,selected.index),offset=session!.offset_seconds;
      if(selected.subtitle_format==="pgs"||selected.subtitle_format==="vobsub"){
       const {PgsRenderer,VobSubRenderer}=await import("libbitsub");if(!alive())return;
       const options={video:element,subUrl:url,fileName:selected.subtitle_format==="vobsub"?"track.mks":"track.sup",timeOffset:offset,maxSubtitleBytes:128*1024*1024,cacheLimit:8,prefetchWindow:{before:1,after:1},devicePixelRatioCap:2,displaySettings:{aspectMode:"contain" as const},onError:()=>{}};
       const renderer=selected.subtitle_format==="vobsub"?new VobSubRenderer(options):new PgsRenderer(options);subtitleRenderer={destroy:async()=>renderer.dispose()};
      }else if(selected.subtitle_format==="ass"||["ass","ssa"].includes(selected.codec)){
       const [{default:JASSUB},response]=await Promise.all([import("jassub"),fetch(url,{signal:controller.signal})]);if(!response.ok)return;
       const content=await response.text();if(!alive())return;
       const renderer=new JASSUB({video:element,subContent:content,fonts:[...(info.fonts?.map(font=>font.url)??[]),subtitleFallbackFont],timeOffset:offset,queryFonts:false});subtitleRenderer=renderer;await renderer.ready;
      }else if(selected.subtitle_format!=="image"&&!["hdmv_pgs_subtitle","dvd_subtitle","pgs","vobsub"].includes(selected.codec.toLowerCase())){
       const response=await fetch(url,{signal:controller.signal});if(!response.ok)return;const content=await response.text();if(!alive())return;
       subtitleUrl=URL.createObjectURL(new Blob([content],{type:"text/vtt"}));const track=document.createElement("track");subtitleTrack=track;track.kind="subtitles";track.label=trackLabel(selected);track.default=true;track.src=subtitleUrl;
       track.onload=()=>{if(!alive())return;track.track.mode="showing";for(const cue of Array.from(track.track.cues??[])){if(cue.endTime<=offset){track.track.removeCue(cue);continue;}cue.startTime=Math.max(0,cue.startTime-offset);cue.endTime-=offset;applyPlainSubtitlePosition(cue,subtitleAppearance(preferences).subtitle_position);}};
       element.append(track);track.track.mode="showing";
      }
     }catch{/* Subtitle failures leave the silent video preview available. */}
    })();
    heartbeat=setInterval(()=>{if(session&&alive())void playbackApi.heartbeat(session.id,element.currentTime+session.offset_seconds,false,session.generation).catch(stop);},10_000);
   })().catch(stop);
  },2000);
  stopCurrentPreview=stop;
  return()=>{stop();element.removeEventListener("loadedmetadata",metadata);element.removeEventListener("playing",playing);element.removeEventListener("loadeddata",playing);element.removeEventListener("canplay",playing);element.removeEventListener("seeked",playing);element.removeEventListener("seeking",waiting);element.removeEventListener("waiting",waiting);element.removeEventListener("error",stop);element.removeEventListener("ended",stop);document.removeEventListener("visibilitychange",visibility);};
 },[channelId,programId,endsAt,visibilityEpoch]);
 return <div className="vtv-live-layer"><video ref={video} className="vtv-live-video" muted={muted} playsInline autoPlay aria-label="Live channel preview"/><button type="button" className="vtv-preview-sound" aria-label={muted?"Unmute live preview":"Mute live preview"} aria-pressed={!muted} title={muted?"Turn preview sound on":"Mute preview sound"} onClick={event=>{event.stopPropagation();toggleSound();}}>{muted?<MicOff size={18} aria-hidden="true"/>:<Mic size={18} aria-hidden="true"/>}</button></div>;
}
