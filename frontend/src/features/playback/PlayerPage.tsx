import {waitForPreviousPlayback} from "./lib/previousPlayback";
import {trackWatchReport, finishWatchReports, waitForWatchReports} from "./lib/watchReports";
import {watchApi} from "./api/watch";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import subtitleFallbackFont from "jassub/dist/default.woff2?url";
import { ArrowLeft, Check, ChevronRight, CircleHelp, Gauge, ListVideo, Maximize, Minimize, Pause, PictureInPicture2, Play, RotateCcw, RotateCw, Settings2, SkipForward, Subtitles, Volume2, VolumeX, X } from "lucide-react";
import { defaultPlaybackPreferences, playbackApi, type PlaybackInfo, type PlaybackPreferences, type PlaybackSession } from "./api/playback";
import { audioDeliveryAllowed,losslessAudioAllowed,originalAudioSupported, playbackCapabilities, playbackTime, safePlayerReturn, selectTracks, trackLabel } from "./lib/playback";
import {attachSegmentedPlayback} from "./lib/hlsDelivery";
import {createPlaybackSeekQueue} from "./lib/seekQueue";
import {createBandwidthDetector,createFragmentTransferSampler} from "./lib/bandwidth";
import {createSessionHeartbeatQueue} from "./lib/sessionHeartbeat";
import {createVideoFrameMonitor} from "./lib/videoFrames";
import {createHeldVideoFrame} from "./lib/heldVideoFrame";
import {defaultAudioIndex,enableNativeAudio,mapNativeAudio,nativeAudioTracks,type NativeAudioTrack} from "./lib/nativeAudio";
import DetailSynopsis from "../../components/DetailSynopsis";
import {applyPlainSubtitlePosition,subtitleAppearance,subtitleAppearanceVariables} from "./lib/subtitleAppearance";
import "./PlayerPage.css";

type Menu = "audio"|"subtitles"|"speed"|"quality"|"chapters"|"info"|"next"|null;
type Delivery = "auto"|"original"|"stream";
const qualityChoices=[{label:"Automatic",height:0,bitrate:0},{label:"1080p · 8 Mbps",height:1080,bitrate:8_000_000},{label:"1080p · 4 Mbps",height:1080,bitrate:4_000_000},{label:"720p · 2 Mbps",height:720,bitrate:2_000_000},{label:"480p · 1 Mbps",height:480,bitrate:1_000_000}];
type Capability = Awaited<ReturnType<typeof playbackCapabilities>>;
const imageSubtitle=(track?:{subtitle_format?:string;codec:string})=>track?.subtitle_format==="image"||["hdmv_pgs_subtitle","dvd_subtitle","pgs","vobsub"].includes(track?.codec.toLowerCase()??"");
const bitmapSubtitle=(track?:{subtitle_format?:string})=>track?.subtitle_format==="pgs"||track?.subtitle_format==="vobsub";
const unsupportedImage=(track?:{subtitle_format?:string;codec:string})=>imageSubtitle(track)&&!bitmapSubtitle(track);
const errorMessage=(error:unknown)=>error instanceof Error?error.message:"Unable to play this video.";

export default function PlayerPage() {
  const {libraryId="",itemId=""}=useParams();
  const routeKey=`${libraryId}\u0000${itemId}`;
  const activeRoute=useRef(routeKey);activeRoute.current=routeKey;
  const navigate=useNavigate(), [params]=useSearchParams();
  const returnPath=safePlayerReturn(params.get("return"));
  const root=useRef<HTMLDivElement>(null), video=useRef<HTMLVideoElement>(null);
  const heldCanvas=useRef<HTMLCanvasElement>(null);
  const [heldFrame,setHeldFrame]=useState(false),[hasVideoFrame,setHasVideoFrame]=useState(false);
  const heldVideo=useRef(createHeldVideoFrame(()=>heldCanvas.current,setHeldFrame));
  useEffect(()=>{setHasVideoFrame(false);return()=>heldVideo.current.clear();},[routeKey]);
  const [info,setInfo]=useState<PlaybackInfo>(), [session,setSession]=useState<PlaybackSession>();
  const [preferences,setPreferences]=useState(defaultPlaybackPreferences);
  const [error,setError]=useState(""), [notice,setNotice]=useState(""), [loading,setLoading]=useState(true);
  const [playing,setPlaying]=useState(false), [buffering,setBuffering]=useState(false), [visible,setVisible]=useState(true);
  const [bufferingVisible,setBufferingVisible]=useState(false);
  const [recoveryNeeded,setRecoveryNeeded]=useState(false);
  const nativeFallbackAttempted=useRef(false);
  const nativeActivity=useRef({position:0,at:Date.now(),seekTarget:null as number|null});
  const videoFrames=useRef(createVideoFrameMonitor());
  const resetVideoFrames=(element:HTMLVideoElement,target:number)=>{
    const generation=requestGeneration.current,owner=current.current;
    videoFrames.current.reset(element,Math.max(0,target-(owner?.offset_seconds??0)),()=>mounted.current&&activeRoute.current===routeKey&&requestGeneration.current===generation&&current.current===owner&&mediaOwner.current?.generation===generation);
    heldVideo.current.awaitFrame(element,Math.max(0,target-(owner?.offset_seconds??0)),()=>mounted.current&&activeRoute.current===routeKey&&requestGeneration.current===generation&&current.current===owner&&mediaOwner.current?.generation===generation);
  };
  useEffect(()=>()=>videoFrames.current.destroy(),[routeKey]);
  useEffect(()=>{
    setBufferingVisible(false);
    if(!buffering||loading)return;
    // Native unbuffered seeks often settle quickly. Keep the current frame
    // visible and avoid flashing a spinner for these brief fetch/decode waits.
    const timer=window.setTimeout(()=>setBufferingVisible(true),500);
    return()=>window.clearTimeout(timer);
  },[buffering,loading,routeKey,session?.id]);
  const [position,setPosition]=useState(0), [scrubbing,setScrubbing]=useState<number|null>(null), [buffered,setBuffered]=useState(0);
  const [audio,setAudio]=useState<number|null>(null), [subtitle,setSubtitle]=useState(-1);
  const [nativeAudioChoices,setNativeAudioChoices]=useState<number[]>([]),[audioHelp,setAudioHelp]=useState("");
  const audioMapping=useRef(new Map<number,NativeAudioTrack>());
  const segmented=useRef<ReturnType<typeof attachSegmentedPlayback>|undefined>(undefined);
  const seekQueue=useRef(createPlaybackSeekQueue((id,body)=>playbackApi.seek(id,body)));
  const repositionRef=useRef<(position:number,audio?:number,autoplay?:boolean)=>Promise<void>>(async()=>{});
  const [delivery,setDelivery]=useState<Delivery>("auto"),[quality,setQuality]=useState(0);
  const selectedDelivery=useRef<{delivery:Delivery;quality:number;budget:number}>({delivery:"auto",quality:0,budget:0});
  const bandwidthDetector=useRef(createBandwidthDetector()),fragmentSampler=useRef(createFragmentTransferSampler());
  const bandwidthStarted=useRef(0),bandwidthStall=useRef<number|null>(null),bandwidthChanging=useRef(false);
  const [volume,setVolume]=useState(1), [muted,setMuted]=useState(false), [speed,setSpeed]=useState(1);
  const [menu,setMenu]=useState<Menu>(null), [fullscreen,setFullscreen]=useState(false), [pip,setPip]=useState(false);
  const [watchPrompt,setWatchPrompt]=useState(false), [ended,setEnded]=useState(false), [countdown,setCountdown]=useState<number|null>(null);
  const [watchError,setWatchError]=useState("");
  const [initializing,setInitializing]=useState(true);
  const initializedRoute=useRef<string|null>(null), initializationGeneration=useRef(0), initializationController=useRef<AbortController|null>(null);
  const pendingStop=useRef<Promise<void>|undefined>(undefined);
  const pendingAllocation=useRef<Promise<void>|undefined>(undefined);
  const metadataCleanup=useRef<(()=>void)|undefined>(undefined);
  const mediaOwner=useRef<{generation:number;sessionId:string}|null>(null);
  const pendingSeek=useRef<{generation:number;target:number}|null>(null);
  const playIntent=useRef(true);
  const waitingDemand=useRef(false);
  const heartbeatQueue=useRef<ReturnType<typeof createSessionHeartbeatQueue>|null>(null);
  if(!heartbeatQueue.current)heartbeatQueue.current=createSessionHeartbeatQueue((session,position,paused,generation,speed)=>playbackApi.heartbeat(session,position,paused,generation,speed));
  const infoRef=useRef<PlaybackInfo|undefined>(undefined), prefsRef=useRef<PlaybackPreferences>(defaultPlaybackPreferences);
  const current=useRef<PlaybackSession|undefined>(undefined), capability=useRef<Capability|undefined>(undefined);
  const watchSession=useRef(""), sequence=useRef(0), requestGeneration=useRef(0), mounted=useRef(false);
  const sourcePosition=useRef(0),confirmedPosition=useRef(0),ready=useRef(false);
  const streamSeekRecovery=useRef<{generation:number;target:number;at:number;retried:boolean}|null>(null);
  const replaying=useRef<{routeKey:string;generation:number}|null>(null);
  const completedReport=useRef<{routeKey:string;generation:number;promise:Promise<void>}|null>(null);
  const selected=useRef({audio:null as number|null,subtitle:-1});
  const controls=useRef({visible:true,playing:false,menu:null as Menu,dragging:false,lastActive:Date.now(),focus:false,prompt:false,ended:false});
  const replayRef=useRef<(position?:number,autoplay?:boolean)=>Promise<void>>(async()=>{});
  const failureRef=useRef<(message:string)=>void>(()=>{});
  const report=useCallback((isEnded=false,keepalive=false,seeking=false,previousRoute=false)=>{
    if(!watchSession.current||(!ready.current&&!pendingSeek.current)||(!previousRoute&&activeRoute.current!==routeKey))return Promise.resolve();
    const completion=completedReport.current?.routeKey===routeKey&&completedReport.current.generation===requestGeneration.current?completedReport.current:null;
    const payload={session_id:watchSession.current,sequence:++sequence.current,position_seconds:sourcePosition.current,paused:video.current?.paused??true,ended:isEnded||!!completion,seeking:seeking||!!pendingSeek.current,...(!keepalive&&current.current?{playback_session_id:current.current.id}:{}),audio_index:selected.current.audio,subtitle_index:selected.current.subtitle};
    const saving=watchApi.progress(libraryId,itemId,payload,keepalive).then(()=>{
      if(mounted.current&&activeRoute.current===routeKey&&payload.session_id===watchSession.current&&payload.sequence===sequence.current)setWatchError("");
      window.dispatchEvent(new Event("posterview-watch-updated"));
    }).catch(error=>{if(mounted.current&&activeRoute.current===routeKey&&payload.session_id===watchSession.current&&payload.sequence===sequence.current)setWatchError(`Watch progress could not be saved: ${errorMessage(error)}`);});
    if(completion)completion.promise=Promise.all([completion.promise,saving]).then(()=>{});
    return trackWatchReport(routeKey,saving);
  },[libraryId,itemId,routeKey]);
  const interact=useCallback(()=>{
    controls.current.lastActive=Date.now();controls.current.visible=true;setVisible(true);
  },[]);
  const heartbeat=useCallback((paused=video.current?.paused??true,position=sourcePosition.current)=>{
    const owned=current.current;
    if(!owned||!ready.current||activeRoute.current!==routeKey||initializedRoute.current!==routeKey)return;
    // A requested seek is watch intent, not evidence that the media consumed
    // that time. Avoid pruning copied-stream fragments ahead of the decoder.
    const consumed=owned.method!=="direct"&&pendingSeek.current?Math.max(owned.offset_seconds,confirmedPosition.current):position;
    heartbeatQueue.current?.request(owned.id,consumed,paused,owned.generation??0,video.current?.playbackRate??1);
  },[routeKey]);
  const play=useCallback(async(userInteraction=true)=>{
    const element=video.current;if(!element||activeRoute.current!==routeKey||initializedRoute.current!==routeKey||!watchSession.current||!ready.current||!current.current)return;
    playIntent.current=true;
    if(userInteraction)interact();
    heartbeat(false);
    const owned=current.current.id,generation=requestGeneration.current;
    try{await element.play();if(activeRoute.current===routeKey&&current.current?.id===owned&&requestGeneration.current===generation)setNotice(value=>value==="Press Play to begin playback."||value.startsWith("The browser cannot decode this source.")?"":value);}catch(error){
      if(activeRoute.current!==routeKey||current.current?.id!==owned||requestGeneration.current!==generation)return;
      if(error instanceof DOMException&&error.name==="NotAllowedError")setNotice("Press Play to begin playback.");
      else failureRef.current("This browser cannot play the original file. Try a browser that supports its video and audio formats.");
    }
  },[interact,routeKey,heartbeat]);
  const terminalError=useCallback((message:string)=>{
    if(!mounted.current||activeRoute.current!==routeKey)return;
    const element=video.current;
    if(ready.current&&!pendingSeek.current&&element&&Number.isFinite(element.currentTime)){
      sourcePosition.current=Math.max(0,element.currentTime+(current.current?.offset_seconds??0));setPosition(sourcePosition.current);
    }
    const finalReport=report();ready.current=false;pendingSeek.current=null;requestGeneration.current++;
    mediaOwner.current=null;metadataCleanup.current?.();metadataCleanup.current=undefined;segmented.current?.destroy();segmented.current=undefined;seekQueue.current.reset();fragmentSampler.current.reset();
    element?.pause();
    const stopped=current.current;current.current=undefined;setSession(undefined);
    if(stopped)heartbeatQueue.current?.forget(stopped.id);
    if(element){element.removeAttribute("src");element.load();}
    if(stopped){
      const stopping=Promise.all([finalReport,finishWatchReports(routeKey)]).then(()=>playbackApi.stop(stopped.id)).catch(()=>{});pendingStop.current=stopping;
      void stopping.finally(()=>{if(pendingStop.current===stopping)pendingStop.current=undefined;});
    }
    setLoading(false);setBuffering(false);setPlaying(false);setVisible(true);setError(message);
  },[report,routeKey]);
  failureRef.current=terminalError;
  function bandwidthObservationAllowed(){
    const data=infoRef.current,policy=selectedDelivery.current;
    return mounted.current&&activeRoute.current===routeKey&&mediaOwner.current?.generation===requestGeneration.current&&current.current?.method!=="direct"&&!!current.current&&data?.bandwidth_adaptation_allowed===true&&Number.isFinite(data.source_bitrate)&&data.source_bitrate!>0&&capability.current?.source_video_supported===true&&policy.delivery==="auto"&&policy.quality===0&&playIntent.current&&speedRef.current===1&&!controls.current.ended&&!controls.current.prompt&&!(ready.current&&pendingSeek.current);
  }
  const attachSource=useCallback((created:PlaybackSession,target:number,generation:number)=>{
    const element=video.current,data=infoRef.current;if(!element||!data)return;
    heldVideo.current.capture(element);
    metadataCleanup.current?.();metadataCleanup.current=undefined;segmented.current?.destroy();segmented.current=undefined;
    current.current=created;mediaOwner.current={generation,sessionId:created.id};setSession(created);
    if(created.method!=="direct")confirmedPosition.current=created.offset_seconds;
    const policy=selectedDelivery.current;
    if(created.method!=="direct"&&(policy.delivery==="original"||!capability.current?.hls_supported||created.method==="remux"&&data.remux_allowed!==true||created.method==="audio_transcode"&&data.audio_conversion_allowed!==true&&data.conversion_allowed!==true||created.method==="transcode"&&data.conversion_allowed!==true&&!(data.bandwidth_adaptation_allowed===true&&policy.budget>0)||policy.delivery==="stream"&&created.method!=="remux")){
      terminalError("The server returned a playback method that is not permitted.");return;
    }
    if(created.method==="direct"&&(created.offset_seconds!==0||/mpegurl/i.test(created.mime))){terminalError("The server did not return original-file playback.");return;}
    if(created.method==="direct")nativeActivity.current={position:target,at:Date.now(),seekTarget:target};
    const initialize=()=>{
      if(activeRoute.current!==routeKey||generation!==requestGeneration.current||current.current?.id!==created.id)return;
      if(created.method==="direct"){
        if(element.getAttribute("src")!==created.url||element.currentSrc&&element.currentSrc!==new URL(created.url,window.location.href).href)return;
        const nativeTarget=pendingSeek.current?.target??target;
        // A seekable duration at metadata time does not prove that the native
        // demuxer has primed its file index or decoded any media yet.
        if(nativeTarget>0&&element.readyState<HTMLMediaElement.HAVE_CURRENT_DATA){element.preload="auto";return;}
        const list=nativeAudioTracks(element),mapping=mapNativeAudio(data,list),requested=created.audio_index??selected.current.audio??defaultAudioIndex(data);
        audioMapping.current=mapping;setNativeAudioChoices(Array.from(mapping.keys()).filter(index=>{const track=data.tracks.find(track=>track.index===index);return !!track&&originalAudioSupported(track,element);}));
        const actual=data.tracks.find(track=>track.kind==="audio"&&track.index===requested);
        const canPromote=requested!=null&&policy.delivery!=="original"&&(policy.delivery==="stream"?losslessAudioAllowed(data,capability.current,requested):audioDeliveryAllowed(data,capability.current,requested));
        const contradictsDefault=requested===defaultAudioIndex(data)&&Array.from(mapping.entries()).some(([index,track])=>index!==requested&&track.enabled);
        if(actual&&!originalAudioSupported(actual,element)||list&&requested!=null&&mapping.has(requested)&&!enableNativeAudio(list,mapping,requested)||requested!=null&&!mapping.has(requested)&&(requested!==defaultAudioIndex(data)||contradictsDefault)){
          if(canPromote){metadataCleanup.current?.();metadataCleanup.current=undefined;void repositionRef.current(pendingSeek.current?.target??target,requested);return;}
          setAudio(null);selected.current.audio=null;terminalError(actual&&!originalAudioSupported(actual,element)?"This browser cannot decode the original audio track.":contradictsDefault?"The browser selected a different audio track and does not expose the requested default track.":"The browser could not select the requested audio track reliably.");return;
        }
        selected.current.audio=requested;setAudio(requested);
        setAudioHelp(list?"Only identified native tracks or policy-permitted playback streams can be selected.":"Native audio selection is unavailable. Other tracks require permitted playback streaming.");
      }else{
        if(!segmented.current?.owns()||element.currentSrc&&element.currentSrc!==element.src)return;
        selected.current.audio=created.audio_index??selected.current.audio;setAudio(selected.current.audio);setAudioHelp(created.method==="audio_transcode"?"The selected audio is converted for this playback stream. Video is copied.":"The playback stream contains the selected audio track.");
      }
      metadataCleanup.current?.();metadataCleanup.current=undefined;
      try{element.currentTime=Math.max(0,(pendingSeek.current?.target??target)-created.offset_seconds);}catch{terminalError("The browser could not apply the requested playback position. Retry playback.");return;}
      element.playbackRate=speedRef.current;ready.current=true;nativeActivity.current={position:target,at:Date.now(),seekTarget:target};resetVideoFrames(element,target);setRecoveryNeeded(false);setLoading(false);report(false,false,true);
      if(playIntent.current)void play(false);else heartbeat(true);
    };
    const events=["loadedmetadata","loadeddata","canplay"];
    for(const event of events)element.addEventListener(event,initialize);
    metadataCleanup.current=()=>{for(const event of events)element.removeEventListener(event,initialize);};
    if(created.method==="direct")element.src=created.url;
    else try{const owns=()=>mounted.current&&activeRoute.current===routeKey&&current.current?.id===created.id&&current.current.url===created.url&&mediaOwner.current?.generation===requestGeneration.current;segmented.current=attachSegmentedPlayback(element,created,{
      isCurrent:owns,
      fatal:message=>{if(owns())terminalError(message);},
      fragmentLoading:data=>{if(owns())fragmentSampler.current.start(data.frag.stats);},
      fragmentLoaded:data=>{if(!owns())return;const sample=fragmentSampler.current.finish(data.frag.stats);if(sample&&bandwidthObservationAllowed())bandwidthDetector.current.observe(sample.bytes,sample.bodyMilliseconds,performance.now());},
    },Math.max(0,target-created.offset_seconds));}catch(error){terminalError(errorMessage(error));}
  },[routeKey,play,report,terminalError,heartbeat]);
  const start=useCallback(async(sourceTime:number,playOverride?:boolean,losslessFallback=false)=>{
    const element=video.current,data=infoRef.current,caps=capability.current;
    if(!element||!data||!caps||activeRoute.current!==routeKey||initializedRoute.current!==routeKey||!watchSession.current)return;
    heldVideo.current.capture(element);
    const generation=++requestGeneration.current;
    playIntent.current=playOverride??(current.current&&ready.current&&!pendingSeek.current?!element.paused:playIntent.current);
    const target=Math.max(0,Math.min(sourceTime,data.duration_seconds||sourceTime));
    streamSeekRecovery.current=null;
    report();sourcePosition.current=target;pendingSeek.current={generation,target};setPosition(target);setScrubbing(null);report(false,false,true);
    ready.current=false;mediaOwner.current=null;metadataCleanup.current?.();metadataCleanup.current=undefined;
    segmented.current?.destroy();segmented.current=undefined;seekQueue.current.reset();fragmentSampler.current.reset();
    const previous=current.current;current.current=undefined;
    audioMapping.current.clear();setNativeAudioChoices([]);setAudioHelp("Audio choices will be available when playback is ready.");
    waitingDemand.current=false;if(previous)heartbeatQueue.current?.forget(previous.id);
    element.pause();setPlaying(false);setLoading(true);setBuffering(false);setError("");setEnded(false);setCountdown(null);
    element.removeAttribute("src");element.load();
    if(previous){const stopping=finishWatchReports(routeKey).then(()=>playbackApi.stop(previous.id)).catch(()=>{});pendingStop.current=stopping;void stopping.finally(()=>{if(pendingStop.current===stopping)pendingStop.current=undefined;});}
    try{
      if(pendingStop.current)await waitForPreviousPlayback(pendingStop.current,"The previous playback session");
      if(pendingAllocation.current)await waitForPreviousPlayback(pendingAllocation.current,"The previous playback request");
    }catch(error){
      if(mounted.current&&activeRoute.current===routeKey&&generation===requestGeneration.current){setLoading(false);setError(errorMessage(error));}
      return;
    }
    if(!mounted.current||activeRoute.current!==routeKey||generation!==requestGeneration.current)return;
    try{
      const choice=selected.current,policy=selectedDelivery.current,chosenAudio=data.tracks.find(track=>track.kind==="audio"&&track.index===choice.audio);
      const audioCodecs=caps.audio_codecs.filter(codec=>!chosenAudio||codec!==chosenAudio.codec||originalAudioSupported(chosenAudio,element));
      const q=qualityChoices[policy.quality]??qualityChoices[0];
      // Cold HEVC-in-Matroska resumes can stall while native demuxers rebuild
      // their seek state. Start a permitted copied stream without that wait;
      // warm native seeks and explicit original playback keep their source.
      const copiedResume=!previous&&target>0&&policy.delivery==="auto"&&policy.quality===0&&["mkv","matroska"].includes(data.container?.toLowerCase()??"")&&data.tracks.some(track=>track.kind==="video"&&track.codec.toLowerCase()==="hevc")&&losslessAudioAllowed(data,caps,choice.audio);
      const requireCopy=losslessFallback||copiedResume;
      const creating=playbackApi.create(libraryId,itemId,{position_seconds:target,audio_index:choice.audio,subtitle_index:choice.subtitle<0?null:choice.subtitle,...caps,audio_codecs:audioCodecs,direct_only:policy.delivery==="original",force_remux:policy.delivery==="stream"||requireCopy,max_height:q.height,max_bitrate:q.bitrate,bandwidth_limit_bps:policy.budget});
      const allocation=creating.then(async created=>{if(!mounted.current||activeRoute.current!==routeKey||generation!==requestGeneration.current)await playbackApi.stop(created.id).catch(()=>{});}).catch(()=>{});
      pendingAllocation.current=allocation;void allocation.finally(()=>{if(pendingAllocation.current===allocation)pendingAllocation.current=undefined;});
      const created=await creating;
      if(!mounted.current||activeRoute.current!==routeKey||generation!==requestGeneration.current)return;
      if(requireCopy&&created.method!=="remux"){void playbackApi.stop(created.id).catch(()=>{});throw new Error("The server could not resume this video with lossless stream copying.");}
      seekQueue.current.reset(created);attachSource(created,target,generation);
    }catch(error){if(mounted.current&&activeRoute.current===routeKey&&generation===requestGeneration.current){setLoading(false);setError(errorMessage(error));}}
  },[libraryId,itemId,routeKey,report,attachSource,terminalError]);
  const reposition=useCallback(async(target:number,audioIndex?:number,playOverride?:boolean)=>{
    const element=video.current,owned=current.current;if(!element||!owned||activeRoute.current!==routeKey||initializedRoute.current!==routeKey)return;
    heldVideo.current.capture(element);
    const generation=++requestGeneration.current;
    heartbeatQueue.current?.forget(owned.id);
    playIntent.current=playOverride??(ready.current&&!pendingSeek.current?!element.paused:playIntent.current);
    sourcePosition.current=target;pendingSeek.current={generation,target};setPosition(target);setScrubbing(null);report(false,false,true);
    ready.current=false;mediaOwner.current=null;metadataCleanup.current?.();metadataCleanup.current=undefined;
    element.pause();setPlaying(false);setLoading(false);setBuffering(true);fragmentSampler.current.reset();bandwidthDetector.current.suppressUntil(performance.now()+8_000);
    try{
      const updated=await seekQueue.current.request(target,audioIndex);
      if(!updated||!mounted.current||activeRoute.current!==routeKey||generation!==requestGeneration.current)return;
      if(updated.url===owned.url&&updated.generation===(owned.generation??0)&&segmented.current?.attached()){
        current.current=updated;mediaOwner.current={generation,sessionId:updated.id};setSession(updated);ready.current=true;
        segmented.current?.refresh(Math.max(0,target-updated.offset_seconds));
        element.currentTime=Math.max(0,target-updated.offset_seconds);
        resetVideoFrames(element,target);
        if(audioIndex!==undefined){selected.current.audio=updated.audio_index??audioIndex;setAudio(selected.current.audio);}
        report(false,false,true);if(playIntent.current)void play(false);else heartbeat(true);
      }else attachSource(updated,target,generation);
    }catch(error){if(mounted.current&&activeRoute.current===routeKey&&generation===requestGeneration.current)terminalError(errorMessage(error));}
  },[routeKey,report,attachSource,play,heartbeat,terminalError]);
  repositionRef.current=reposition;
  const speedRef=useRef(speed);speedRef.current=speed;
  useEffect(()=>{
    const timer=window.setInterval(()=>{
      if(!bandwidthObservationAllowed()||bandwidthChanging.current){bandwidthStall.current=null;fragmentSampler.current.clearWindow();return;}
      const now=performance.now(),element=video.current,owned=current.current;if(!element||!owned||now-bandwidthStarted.current<8_000)return;
      const sample=fragmentSampler.current.poll(now);if(sample)bandwidthDetector.current.observe(sample.bytes,sample.bodyMilliseconds,now);
      let ahead=0;for(let index=0;index<element.buffered.length;index++)if(element.currentTime>=element.buffered.start(index)&&element.currentTime<=element.buffered.end(index))ahead=element.buffered.end(index)-element.currentTime;
      if(ahead<=3&&element.readyState<HTMLMediaElement.HAVE_FUTURE_DATA){if(bandwidthStall.current===null){bandwidthStall.current=now;bandwidthDetector.current.underflow(now);}}else bandwidthStall.current=null;
      const required=selectedDelivery.current.budget||owned.bitrate||infoRef.current?.source_bitrate||0;
      const budget=bandwidthDetector.current.recommend({now,requiredBitrate:required,bufferSeconds:ahead,stallMilliseconds:bandwidthStall.current===null?0:now-bandwidthStall.current});
      if(!budget)return;
      selectedDelivery.current.budget=budget;bandwidthDetector.current.accepted(now);bandwidthChanging.current=true;
      setNotice(`Automatic bandwidth: playback bitrate reduced to ${(budget/1_000_000).toFixed(1)} Mbps after sustained slow stream downloads.`);
      void start(sourcePosition.current,playIntent.current).finally(()=>{if(activeRoute.current===routeKey)bandwidthChanging.current=false;});
    },1_000);
    return()=>window.clearInterval(timer);
  // The detector reads session ownership, intent and policy from current refs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[routeKey,start]);
  const startFromBeginning=params.get("start")==="0";
  const initializeItem=useCallback(async()=>{
    initializationController.current?.abort();
    const controller=new AbortController();initializationController.current=controller;
    const attempt=++initializationGeneration.current;requestGeneration.current++;
    const isCurrent=()=>mounted.current&&activeRoute.current===routeKey&&attempt===initializationGeneration.current&&!controller.signal.aborted;
    initializedRoute.current=null;watchSession.current="";ready.current=false;replaying.current=null;completedReport.current=null;
    selectedDelivery.current={delivery:"auto",quality:0,budget:0};setDelivery("auto");setQuality(0);bandwidthDetector.current.reset(performance.now());bandwidthStarted.current=performance.now();bandwidthStall.current=null;bandwidthChanging.current=false;fragmentSampler.current.reset();
    pendingSeek.current=null;mediaOwner.current=null;playIntent.current=true;waitingDemand.current=false;
    infoRef.current=undefined;capability.current=undefined;
    setInitializing(true);setLoading(true);setRecoveryNeeded(false);setError("");setNotice("");setWatchError("");
    setInfo(undefined);setSession(undefined);setPosition(0);setBuffered(0);setScrubbing(null);setPlaying(false);setBuffering(false);
    audioMapping.current.clear();setNativeAudioChoices([]);setAudioHelp("");setAudio(null);setSubtitle(-1);setMenu(null);setEnded(false);setCountdown(null);setWatchPrompt(false);setVisible(true);
    sourcePosition.current=0;confirmedPosition.current=0;streamSeekRecovery.current=null;nativeFallbackAttempted.current=false;
    controls.current.playing=false;controls.current.menu=null;controls.current.dragging=false;controls.current.prompt=false;controls.current.ended=false;
      try{
        await waitForWatchReports(routeKey,controller.signal);
        if(!isCurrent())return;
        const [data,prefs,state]=await Promise.all([playbackApi.info(libraryId,itemId,controller.signal),watchApi.preferences(controller.signal),watchApi.state(libraryId,itemId,controller.signal)]);
        if(!isCurrent()||!video.current)return;
        const caps=await playbackCapabilities(data,video.current);if(!isCurrent())return;
        const tracks=selectTracks(data,prefs,state);let chosenSub=data.tracks.find(track=>track.index===tracks.subtitle);
        const messages:string[]=[];
        if(tracks.audio!==defaultAudioIndex(data)&&!audioDeliveryAllowed(data,caps,tracks.audio!)&&(!caps.native_audio_tracks||!originalAudioSupported(data.tracks.find(track=>track.index===tracks.audio)!,video.current))){
          tracks.audio=defaultAudioIndex(data);messages.push("This browser cannot select your saved audio track. The file's default audio will play instead.");
        }
        if(unsupportedImage(chosenSub)){tracks.subtitle=-1;chosenSub=undefined;messages.push("This image subtitle format is unavailable. Choose a supported bitmap, text or ASS track.");}
        infoRef.current=data;prefsRef.current=prefs;capability.current=caps;
        selected.current={audio:tracks.audio,subtitle:tracks.subtitle};
        setInfo(data);setPreferences(prefs);setAudio(tracks.audio);setSubtitle(tracks.subtitle);
        if(messages.length)setNotice(messages.join(" "));
        const watch=await watchApi.begin(libraryId,itemId);if(!isCurrent())return;
        if(!watch.session_id)throw new Error("Watch tracking could not be initialized. Try again.");
        watchSession.current=watch.session_id;sequence.current=0;initializedRoute.current=routeKey;setInitializing(false);
        const initial=startFromBeginning?0:Math.max(0,watch.state.position_seconds-prefs.resume_rewind_seconds);
        await start(initial);
      }catch(error){if(isCurrent()){controller.abort();setLoading(false);setError(errorMessage(error));}}
  },[libraryId,itemId,routeKey,startFromBeginning,start]);
  const retryPlayback=()=>{
    if(initializedRoute.current===routeKey&&watchSession.current&&infoRef.current&&capability.current)void start(sourcePosition.current);
    else void initializeItem();
  };
  useEffect(()=>{
    mounted.current=true;void initializeItem();
    return()=>{
      report(false,true,false,true);const finalReports=finishWatchReports(routeKey);mounted.current=false;requestGeneration.current++;initializationGeneration.current++;
      initializationController.current?.abort();initializedRoute.current=null;
      ready.current=false;watchSession.current="";pendingSeek.current=null;mediaOwner.current=null;metadataCleanup.current?.();metadataCleanup.current=undefined;
      heartbeatQueue.current?.clear();infoRef.current=undefined;capability.current=undefined;
      segmented.current?.destroy();segmented.current=undefined;seekQueue.current.reset();fragmentSampler.current.reset();
      const element=video.current;if(element){element.pause();element.removeAttribute("src");element.load();}
      const stopped=current.current;current.current=undefined;if(stopped){
        const stopping=finalReports.then(()=>playbackApi.stop(stopped.id)).catch(()=>{});pendingStop.current=stopping;
        void stopping.finally(()=>{if(pendingStop.current===stopping)pendingStop.current=undefined;});
      }
    };
  // A new item owns an independent watch/session lifecycle, including StrictMode cleanup.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[initializeItem,report]);
  useEffect(()=>{
    const timer=window.setInterval(()=>{
      if(ready.current){report();heartbeat();}
    },10_000);
    const flush=()=>report(false,true);
    window.addEventListener("pagehide",flush);document.addEventListener("visibilitychange",flush);
    return()=>{clearInterval(timer);window.removeEventListener("pagehide",flush);document.removeEventListener("visibilitychange",flush);};
  },[report,heartbeat]);
  useEffect(()=>{
    controls.current.playing=playing;controls.current.menu=menu;controls.current.dragging=scrubbing!==null;controls.current.prompt=watchPrompt;controls.current.ended=ended;
  },[playing,menu,scrubbing,watchPrompt,ended]);
  useEffect(()=>{
    const timer=window.setInterval(()=>{
      const value=controls.current;
      if(value.playing&&!value.menu&&!value.dragging&&!value.focus&&!value.prompt&&Date.now()-value.lastActive>4000){value.visible=false;setVisible(false);}
      const minutes=prefsRef.current.still_watching_minutes;
      if(minutes>0&&value.playing&&!value.prompt&&Date.now()-value.lastActive>minutes*60_000){video.current?.pause();setWatchPrompt(true);setVisible(true);}
    },500);
    return()=>clearInterval(timer);
  },[]);
  const seek=useCallback((target:number)=>{
    if(activeRoute.current!==routeKey||initializedRoute.current!==routeKey||!current.current||!video.current)return;
    interact();const bound=Math.max(0,Math.min(target,infoRef.current?.duration_seconds||target));if(!Number.isFinite(bound))return;
    streamSeekRecovery.current=null;
    const element=video.current;
    if(controls.current.ended){void replayRef.current(bound,false);return;}
    if(ready.current&&!pendingSeek.current)playIntent.current=!element.paused;
    if(current.current.method!=="direct"&&(!ready.current||!segmented.current?.available(bound-current.current.offset_seconds))){void reposition(bound);return;}
    const offset=current.current.offset_seconds;
    const wasReady=ready.current,actual=Number.isFinite(element.currentTime)?Math.max(0,element.currentTime+offset):sourcePosition.current;
    nativeActivity.current={position:bound,at:Date.now(),seekTarget:bound};resetVideoFrames(element,bound);setRecoveryNeeded(false);
    sourcePosition.current=bound;setPosition(bound);setScrubbing(null);pendingSeek.current={generation:requestGeneration.current,target:bound};
    fragmentSampler.current.clearWindow();bandwidthDetector.current.suppressUntil(performance.now()+8_000);bandwidthStall.current=null;
    try{element.currentTime=Math.max(0,bound-offset);waitingDemand.current=false;report(false,false,true);heartbeat(!playIntent.current);}catch{
      if(wasReady){sourcePosition.current=actual;setPosition(actual);pendingSeek.current=null;}
      report(false,false,true);setNotice("The browser cannot seek to that position in the original file yet.");
    }
  },[interact,report,routeKey,heartbeat,reposition]);
  const toggle=useCallback(()=>{if(controls.current.prompt||activeRoute.current!==routeKey||initializedRoute.current!==routeKey)return;interact();if(controls.current.ended){void replayRef.current();return;}if(!ready.current&&current.current){playIntent.current=!playIntent.current;setNotice(playIntent.current?"Playback will begin when the video is ready.":"Playback will start paused.");return;}if(video.current?.paused)void play();else{playIntent.current=false;video.current?.pause();}},[play,interact,routeKey]);
  const exit=()=>{
    const element=video.current;if(ready.current&&!pendingSeek.current&&element&&Number.isFinite(element.currentTime))sourcePosition.current=Math.max(0,element.currentTime+(current.current?.offset_seconds??0));
    report(false,true);navigate(returnPath);
  };
  const next=useCallback((automatic=false)=>{
    if(activeRoute.current!==routeKey||initializedRoute.current!==routeKey)return;
    const value=infoRef.current?.next;if(!value)return;
    if(!automatic)interact();
    report();navigate(`/play/native/${encodeURIComponent(value.library_id)}/${encodeURIComponent(value.item_id)}?return=${encodeURIComponent(returnPath)}`);
  },[navigate,returnPath,report,interact,routeKey]);
  const toggleFullscreen=useCallback(async()=>{
    interact();try{if(document.fullscreenElement)await document.exitFullscreen();else await root.current?.requestFullscreen();}catch(error){setNotice(errorMessage(error));}
  },[interact]);
  useEffect(()=>{
    const element=video.current;if(!element)return;
    const entered=()=>setPip(true),left=()=>setPip(false);
    element.addEventListener("enterpictureinpicture",entered);element.addEventListener("leavepictureinpicture",left);
    return()=>{element.removeEventListener("enterpictureinpicture",entered);element.removeEventListener("leavepictureinpicture",left);};
  },[]);
  useEffect(()=>{
    const listener=()=>setFullscreen(!!document.fullscreenElement);document.addEventListener("fullscreenchange",listener);return()=>document.removeEventListener("fullscreenchange",listener);
  },[]);
  useEffect(()=>{
    const listener=(event:KeyboardEvent)=>{
      if(event.key==="Escape"){setMenu(null);interact();return;}
      if(controls.current.prompt)return;
      if(event.altKey||event.ctrlKey||event.metaKey||(event.target instanceof HTMLElement&&(event.target.matches("input,select,textarea,button")||event.target.isContentEditable)))return;
      switch(event.key.toLowerCase()){
        case " ":case "k":event.preventDefault();toggle();break;
        case "arrowleft":event.preventDefault();seek(sourcePosition.current-prefsRef.current.skip_back_seconds);break;
        case "arrowright":event.preventDefault();seek(sourcePosition.current+prefsRef.current.skip_forward_seconds);break;
        case "f":event.preventDefault();void toggleFullscreen();break;
        case "m":event.preventDefault();setMuted(value=>!value);interact();break;
      }
    };
    document.addEventListener("keydown",listener);return()=>document.removeEventListener("keydown",listener);
  },[toggle,seek,toggleFullscreen,interact]);
  useEffect(()=>{
    if(countdown===null||countdown<=0)return;
    const timer=window.setTimeout(()=>setCountdown(value=>value===null?null:value-1),1000);return()=>clearTimeout(timer);
  },[countdown]);
  useEffect(()=>{if(countdown===0){setCountdown(null);next(true);}},[countdown,next]);
  useEffect(()=>{
    const element=video.current;if(element){element.volume=volume;element.muted=muted;element.playbackRate=speed;}
  },[volume,muted,speed]);
  useEffect(()=>{
    const element=video.current, data=info, selectedTrack=data?.tracks.find(track=>track.index===subtitle);
    if(!element)return;
    let canceled=false, renderer:{destroy:()=>Promise<void>}|undefined, track:HTMLTrackElement|undefined, objectUrl:string|undefined;
    const disableNative=()=>{for(const native of Array.from(element.textTracks))if(native!==track?.track)native.mode="disabled";};
    disableNative();element.textTracks.addEventListener?.("addtrack",disableNative);
    if(!session||!selectedTrack||subtitle<0||unsupportedImage(selectedTrack))return()=>element.textTracks.removeEventListener?.("addtrack",disableNative);
    const controller=new AbortController();
    void(async()=>{
      try{
        const url=selectedTrack.url||playbackApi.subtitle(libraryId,itemId,subtitle);
        if(bitmapSubtitle(selectedTrack)){
          const {PgsRenderer,VobSubRenderer}=await import("libbitsub");if(canceled)return;
          const options={video:element,subUrl:url,fileName:selectedTrack.subtitle_format==="vobsub"?"track.mks":"track.sup",timeOffset:session.offset_seconds,maxSubtitleBytes:128*1024*1024,cacheLimit:8,prefetchWindow:{before:1,after:1},devicePixelRatioCap:2,displaySettings:{aspectMode:"contain" as const},onError:(error:Error)=>{if(!canceled)setNotice(`Subtitles: ${errorMessage(error)}`);}};
          const bitmap=selectedTrack.subtitle_format==="vobsub"?new VobSubRenderer(options):new PgsRenderer(options);renderer={destroy:async()=>{bitmap.dispose();}};
        }else if(selectedTrack.subtitle_format==="ass"||["ass","ssa"].includes(selectedTrack.codec)){
          const [{default:JASSUB},response]=await Promise.all([import("jassub"),fetch(url,{signal:controller.signal})]);
          if(!response.ok)throw new Error("Subtitle extraction failed.");
          const content=await response.text();if(canceled)return;
          const instance=new JASSUB({video:element,subContent:content,fonts:[...(data?.fonts?.map(font=>font.url)??[]),subtitleFallbackFont],timeOffset:session.offset_seconds,queryFonts:false});renderer=instance;
          await instance.ready;
          if(canceled)void instance.destroy();
          else if(element.paused&&element.readyState>=2&&element.videoWidth>0&&element.videoHeight>0){
            await instance.manualRender({mediaTime:element.currentTime,width:element.videoWidth,height:element.videoHeight,expectedDisplayTime:performance.now()},true);
          }
        }else if(selectedTrack.subtitle_format!=="image"){
          const response=await fetch(url,{signal:controller.signal});if(!response.ok)throw new Error("Subtitle extraction failed.");
          const content=await response.text();if(canceled)return;
          objectUrl=URL.createObjectURL(new Blob([content],{type:"text/vtt"}));track=document.createElement("track");track.kind="subtitles";track.label=trackLabel(selectedTrack);track.default=true;track.src=objectUrl;
          track.onload=()=>{
            if(!track||canceled)return;
            const text=track.track;text.mode="showing";
            for(const cue of Array.from(text.cues??[])){
              if(cue.endTime<=session.offset_seconds){text.removeCue(cue);continue;}
              cue.startTime=Math.max(0,cue.startTime-session.offset_seconds);cue.endTime-=session.offset_seconds;
              applyPlainSubtitlePosition(cue,subtitleAppearance(prefsRef.current).subtitle_position);
            }
          };
          element.append(track);track.track.mode="showing";
        }
      }catch(error){if(!canceled&&!controller.signal.aborted)setNotice(`Subtitles: ${errorMessage(error)} Choose another text or ASS subtitle track.`);}
    })();
    return()=>{canceled=true;controller.abort();element.textTracks.removeEventListener?.("addtrack",disableNative);void renderer?.destroy();track?.remove();if(objectUrl)URL.revokeObjectURL(objectUrl);};
  // Retained HLS seeks replace the session object without changing subtitle time.
  },[info,session?.offset_seconds,!!session,subtitle,libraryId,itemId,preferences.subtitle_position]);
  const changeTrack=(kind:"audio"|"subtitle",value:number)=>{
    if(activeRoute.current!==routeKey||initializedRoute.current!==routeKey)return;
    interact();setNotice("");
    const chosen=infoRef.current?.tracks.find(track=>track.index===value);
    if(kind==="audio"){
      if(value===selected.current.audio){setMenu(null);return;}
      if(!ready.current||!current.current||!chosen||!video.current)return;
      if(current.current.method==="direct"&&originalAudioSupported(chosen,video.current)&&audioMapping.current.has(value)&&enableNativeAudio(nativeAudioTracks(video.current),audioMapping.current,value)){
        selected.current.audio=value;setAudio(value);report();
      }else if(selectedDelivery.current.delivery!=="original"&&(selectedDelivery.current.delivery==="stream"?losslessAudioAllowed(infoRef.current!,capability.current,value):audioDeliveryAllowed(infoRef.current!,capability.current,value,{videoEncoding:current.current.method==="transcode",bandwidthBudget:selectedDelivery.current.budget}))){
        void reposition(sourcePosition.current,value);
      }else{setNotice("This browser cannot select that audio track under the current playback policy. Your current track is still selected.");return;}
    }else{
      if(unsupportedImage(chosen)){setNotice("This image subtitle format is unavailable in this player.");return;}
      selected.current.subtitle=value;setSubtitle(value);report();
    }
    setMenu(null);
  };
  const toggleMenu=(value:Menu)=>{if(activeRoute.current!==routeKey||initializedRoute.current!==routeKey)return;interact();setMenu(current=>current===value?null:value);};
  const pipAvailable=!!document.pictureInPictureEnabled;
  const togglePip=async()=>{
    interact();try{if(document.pictureInPictureElement)await document.exitPictureInPicture();else await video.current?.requestPictureInPicture();}catch(error){setNotice(errorMessage(error));}
  };
  const ownsMedia=()=>mounted.current&&activeRoute.current===routeKey&&initializedRoute.current===routeKey&&!!current.current&&mediaOwner.current?.generation===requestGeneration.current&&mediaOwner.current.sessionId===current.current.id&&(current.current.method==="direct"?video.current?.getAttribute("src")===current.current.url&&(!video.current.currentSrc||video.current.currentSrc===new URL(current.current.url,window.location.href).href):!!segmented.current?.owns());
  const updatePosition=()=>{
    const element=video.current;if(!element||!ready.current||!ownsMedia())return false;
    // Assigning currentTime can update the clock and emit seeked before a frame
    // at that position exists. Keep seek ownership and the stall deadline then.
    if(element.readyState<HTMLMediaElement.HAVE_CURRENT_DATA)return false;
    const source=element.currentTime+(current.current?.offset_seconds??0);if(!Number.isFinite(source))return false;
    const pending=pendingSeek.current;
    if(pending){
      // Browser reset events may still carry time zero while a requested
      // seek is being applied. Keep the source clock until this seek settles.
      if(pending.generation!==requestGeneration.current||element.seeking||Math.abs(source-pending.target)>1)return false;
      pendingSeek.current=null;
    }else if(source<sourcePosition.current-1){
      // All player-initiated backward seeks install a pending target. An
      // unrequested reset of the reused media element must not rewind history.
      pendingSeek.current={generation:requestGeneration.current,target:sourcePosition.current};
      try{element.currentTime=Math.max(0,sourcePosition.current-(current.current?.offset_seconds??0));}catch { /* Keep the last source time while the media recovers. */ }
      report(false,false,true);return false;
    }
    if(Math.abs(source-nativeActivity.current.position)>0.1){nativeActivity.current={position:source,at:Date.now(),seekTarget:null};setRecoveryNeeded(false);}
    sourcePosition.current=Math.max(0,source);confirmedPosition.current=sourcePosition.current;setPosition(sourcePosition.current);
    if(element.videoWidth>0&&element.videoHeight>0){setHasVideoFrame(true);heldVideo.current.decoded(element);}
    if(pending)heartbeat(element.paused);
    const usable=element.paused?element.readyState>=HTMLMediaElement.HAVE_CURRENT_DATA:element.readyState>=HTMLMediaElement.HAVE_FUTURE_DATA;
    if(usable){waitingDemand.current=false;setBuffering(false);setLoading(false);}
    return true;
  };
  const progressEvent=()=>{
    const element=video.current;if(!element||!ready.current||!ownsMedia())return;
    // Download progress does not advance the source clock.
    if(element.buffered.length)setBuffered(element.buffered.end(element.buffered.length-1)+(current.current?.offset_seconds??0));
  };
  const mediaPlay=()=>{
    if(!ownsMedia()||!ready.current||video.current?.paused)return;
    playIntent.current=true;setPlaying(true);setEnded(false);heartbeat(false);
  };
  const mediaPause=()=>{
    if(!ownsMedia()||!ready.current||!video.current?.paused)return;
    if(!pendingSeek.current)playIntent.current=false;
    fragmentSampler.current.clearWindow();bandwidthStall.current=null;
    setPlaying(false);setVisible(true);report();
    if(!playIntent.current)heartbeat(true);
  };
  const mediaWaiting=()=>{
    if(!ownsMedia()||!ready.current)return;
    setBuffering(true);
    if(!waitingDemand.current){waitingDemand.current=true;heartbeat(!playIntent.current);}
  };
  const mediaPlaying=()=>{
    if(updatePosition()&&!video.current?.paused){setPlaying(true);setBuffering(false);setLoading(false);}
  };
  const end=()=>{
    if(!ready.current||!ownsMedia()||pendingSeek.current)return;
    const duration=infoRef.current?.duration_seconds??0;
    const actualPosition=(video.current?.currentTime??0)+(current.current?.offset_seconds??0);
    if(duration>0&&actualPosition<duration-3){terminalError("Playback ended before the original file finished. Retry playback.");return;}
    sourcePosition.current=duration>0?duration:Number.isFinite(actualPosition)?Math.max(0,actualPosition):sourcePosition.current;
    if(completedReport.current?.routeKey===routeKey&&completedReport.current.generation===requestGeneration.current)return;
    completedReport.current={routeKey,generation:requestGeneration.current,promise:report(true)};setEnded(true);setVisible(true);setPlaying(false);
    if(infoRef.current?.next&&prefsRef.current.autoplay_next)setCountdown(10);
  };
  const replay=async(position=0,autoplay=true)=>{
    if(activeRoute.current!==routeKey||initializedRoute.current!==routeKey)return;
    if(replaying.current)return;
    const operation={routeKey,generation:requestGeneration.current};replaying.current=operation;
    const isCurrent=()=>mounted.current&&activeRoute.current===routeKey&&operation.generation===requestGeneration.current&&replaying.current===operation;
    const completion=completedReport.current?.routeKey===routeKey&&completedReport.current.generation===operation.generation?completedReport.current:null;
    ready.current=false;initializedRoute.current=null;setInitializing(true);setLoading(true);setEnded(false);setCountdown(null);
    try{
      // Finish the prior viewing before replacing its watch token. A route
      // change can abandon this operation without blocking the next item.
      if(completion)await completion.promise;
      if(!isCurrent())return;
      watchSession.current="";
      const watch=await watchApi.begin(libraryId,itemId);
      if(!isCurrent())return;
      if(!watch.session_id)throw new Error("Watch tracking could not be initialized. Try again.");
      watchSession.current=watch.session_id;sequence.current=0;completedReport.current=null;initializedRoute.current=routeKey;setInitializing(false);
      if(current.current&&video.current){
        const target=Math.max(0,Math.min(position,infoRef.current?.duration_seconds||position));
        if(current.current.method!=="direct"&&!segmented.current?.available(target-current.current.offset_seconds)){await reposition(target,undefined,autoplay);return;}
        const element=video.current,offset=current.current.offset_seconds,actual=Number.isFinite(element.currentTime)?Math.max(0,element.currentTime+offset):sourcePosition.current;
        ready.current=true;playIntent.current=autoplay;
        try{element.currentTime=Math.max(0,target-offset);}catch{
          sourcePosition.current=actual;pendingSeek.current=null;setPosition(actual);report(false,false,true);throw new Error("The browser could not seek to the requested replay position. Retry original playback.");
        }
        sourcePosition.current=target;pendingSeek.current={generation:operation.generation,target};resetVideoFrames(element,target);setPosition(target);setLoading(false);report(false,false,true);if(autoplay)void play(false);else heartbeat(true);
      }else await start(position,autoplay);
    }catch(error){if(isCurrent()){setLoading(false);setError(errorMessage(error));}}finally{if(replaying.current===operation)replaying.current=null;}
  };
  replayRef.current=replay;
  const mediaError=()=>{
    const mediaError=video.current?.error;
    if(!ownsMedia()||!mediaError)return;
    terminalError(mediaError.code===2?"The original file could not be loaded. Retry playback.":"This browser cannot play the original file. Try a browser that supports its video and audio formats.");
  };
  useEffect(()=>{
    const timer=window.setInterval(()=>{
      const element=video.current,owned=current.current;
      if(!mounted.current||activeRoute.current!==routeKey||initializedRoute.current!==routeKey||!owned||!element||mediaOwner.current?.generation!==requestGeneration.current||controls.current.ended||controls.current.prompt)return;
      if(owned.method!=="direct"){
        const pending=pendingSeek.current;
        if(!pending){streamSeekRecovery.current=null;return;}
        let recovery=streamSeekRecovery.current;
        if(!recovery||recovery.generation!==pending.generation||recovery.target!==pending.target){recovery={generation:pending.generation,target:pending.target,at:Date.now(),retried:false};streamSeekRecovery.current=recovery;}
        if(document.hidden){recovery.at=Date.now();return;}
        if(Date.now()-recovery.at<15_000)return;
        if(!recovery.retried){
          streamSeekRecovery.current={generation:requestGeneration.current+1,target:pending.target,at:Date.now(),retried:true};
          setNotice("The playback stream seek stalled. Retrying the requested position.");
          void repositionRef.current(pending.target,undefined,playIntent.current);
        }else terminalError("The playback stream did not reach the requested position. Retry playback.");
        return;
      }
      if(!ready.current&&(!playIntent.current||document.hidden)){nativeActivity.current.at=Date.now();return;}
      const activity=nativeActivity.current,target=pendingSeek.current?.target;
      const frameStalled=ready.current&&videoFrames.current.stalled(element,!playIntent.current||element.paused,8);
      if(target!==undefined&&activity.seekTarget!==target){nativeActivity.current={position:target,at:Date.now(),seekTarget:target};return;}
      if(target===undefined&&(!playIntent.current||element.paused)){nativeActivity.current.at=Date.now();return;}
      const seconds=target===undefined?30:8;
      if(frameStalled||Date.now()-nativeActivity.current.at>=seconds*1000){
        const policy=selectedDelivery.current,data=infoRef.current;
        if(!nativeFallbackAttempted.current&&policy.delivery==="auto"&&policy.quality===0&&data&&losslessAudioAllowed(data,capability.current,selected.current.audio)){
          nativeFallbackAttempted.current=true;
          setNotice("The original-file playback stalled. Recovering with a lossless stream; video and audio remain unchanged.");
          void start(target??sourcePosition.current,playIntent.current,true);
        }else{setLoading(false);setRecoveryNeeded(true);setVisible(true);}
      }
    },1000);
    return()=>window.clearInterval(timer);
  },[routeKey,start,terminalError]);
  const changeQuality=(mode:Delivery,value=0)=>{
    interact();
    if(selectedDelivery.current.delivery===mode&&selectedDelivery.current.quality===value){setMenu(null);return;}
    selectedDelivery.current={delivery:mode,quality:value,budget:0};setDelivery(mode);setQuality(value);setMenu(null);bandwidthDetector.current.suppressUntil(performance.now()+8_000);void start(sourcePosition.current);
  };
  const audioSelectable=(index:number)=>{
    const track=info?.tracks.find(value=>value.index===index);
    return audio===index||current.current?.method==="direct"&&!!track&&!!video.current&&originalAudioSupported(track,video.current)&&nativeAudioChoices.includes(index)||delivery!=="original"&&!!info&&(delivery==="stream"?losslessAudioAllowed(info,capability.current,index):audioDeliveryAllowed(info,capability.current,index,{videoEncoding:current.current?.method==="transcode",bandwidthBudget:selectedDelivery.current.budget}));
  };
  const methodLabel=session?({direct:"Original file",remux:"Direct Stream · video and audio copied",audio_transcode:"Audio transcode · video copied",transcode:"Video transcode"}[session.method]):"Preparing playback";
  const duration=info?.duration_seconds||session?.duration_seconds||0;
  const retryLabel="Retry original playback";
  const pendingInitialization=initializing||initializedRoute.current!==routeKey;
  const showNext=!pendingInitialization&&!!info?.next&&preferences.up_next&&duration>0&&position>=duration-20;
  const title=pendingInitialization?"Media player":info?.season!=null&&info?.episode!=null?`S${info.season}:E${info.episode} – ${info.title}`:info?.title??"Media player";
  const selectedSubtitle=info?.tracks.find(track=>track.index===subtitle);
  return <div className={`pv-player ${visible||menu||watchPrompt||!playing?"controls-visible":"controls-hidden"}`} ref={root} style={{"--subtitle-scale":preferences.subtitle_size/100,...subtitleAppearanceVariables(preferences)} as React.CSSProperties} onPointerMove={interact} onKeyDownCapture={interact} onPointerDown={()=>{controls.current.focus=false;interact();}} onFocusCapture={event=>{controls.current.focus=event.target instanceof HTMLElement&&event.target.matches(":focus-visible");setVisible(true);}} onBlurCapture={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))controls.current.focus=false;}}>
    <div className="pv-video-stage" inert={watchPrompt||pendingInitialization}><video ref={video} playsInline preload="metadata" poster={hasVideoFrame?undefined:info?.poster_url??undefined} onClick={toggle} onDoubleClick={()=>void toggleFullscreen()} onPlay={mediaPlay} onPause={mediaPause} onWaiting={mediaWaiting} onPlaying={mediaPlaying} onLoadedData={()=>updatePosition()} onCanPlay={()=>updatePosition()} onTimeUpdate={()=>{updatePosition();progressEvent();}} onProgress={progressEvent} onEnded={end} onError={mediaError} onSeeked={()=>{if(updatePosition())report(false,false,true);}} aria-label={title}/><canvas ref={heldCanvas} className="pv-held-frame" hidden={!heldFrame} aria-hidden="true"/></div>
    <div className="pv-player-header pv-controls" inert={watchPrompt} aria-hidden={!visible&&playing&&!menu}>
      <button className="pv-icon" aria-label="Back to media" onClick={exit} title="Back"><ArrowLeft/></button>
      <div className="pv-header-tools" inert={pendingInitialization}><button className="pv-icon" aria-label={muted?"Unmute":"Mute"} onClick={()=>setMuted(value=>!value)}>{muted||volume===0?<VolumeX/>:<Volume2/>}</button><input className="pv-volume" aria-label="Volume" type="range" min="0" max="1" step="0.01" value={muted?0:volume} onChange={event=>{setVolume(Number(event.target.value));setMuted(false);}}/>
        {pipAvailable&&<button className="pv-icon" aria-label={pip?"Exit picture in picture":"Picture in picture"} onClick={()=>void togglePip()}><PictureInPicture2/></button>}
        <button className="pv-icon" aria-label={fullscreen?"Exit fullscreen":"Fullscreen"} onClick={()=>void toggleFullscreen()}>{fullscreen?<Minimize/>:<Maximize/>}</button>
      </div>
    </div>
    {(loading||buffering&&bufferingVisible)&&!error&&!recoveryNeeded&&<div className="pv-player-loading" role="status"><span className="pv-spinner"/><span>{loading?"Preparing playback…":"Buffering…"}</span></div>}
    {recoveryNeeded&&!error&&<div className="pv-player-message" role="alert"><h2>Playback is not advancing</h2><p>Your position is saved. Recover the current source or return to media.</p><div><button className="pv-primary" onClick={()=>{const owned=current.current;if(!owned)return;const target=pendingSeek.current?.target??sourcePosition.current;const generation=++requestGeneration.current;pendingSeek.current={generation,target};ready.current=false;setLoading(true);setRecoveryNeeded(false);nativeActivity.current={position:target,at:Date.now(),seekTarget:target};attachSource(owned,target,generation);}}>Recover current playback</button><button className="pv-button" onClick={exit}>Back to media</button></div></div>}
    {error&&<div className="pv-player-message" role="alert"><h1>Unable to play</h1><p>{error}</p><div><button className="pv-primary" onClick={retryPlayback}>{retryLabel}</button><button className="pv-button" onClick={exit}>Back to media</button></div></div>}
    {watchPrompt&&<div className="pv-player-message" role="dialog" aria-modal="true" aria-label="Still watching" onKeyDown={event=>{if(event.key!=="Tab")return;const buttons=event.currentTarget.querySelectorAll<HTMLButtonElement>("button"),first=buttons[0],last=buttons[buttons.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}}><h2>Are you still watching?</h2><p>Playback paused after inactivity.</p><button className="pv-primary" autoFocus onClick={()=>{setWatchPrompt(false);interact();void play();}}>Continue watching</button><button className="pv-button" onClick={exit}>Stop playback</button></div>}
    {notice&&<div className="pv-player-notice" role="status">{notice}<button aria-label="Dismiss message" onClick={()=>setNotice("")}><X size={16}/></button></div>}
    {watchError&&<div className="pv-watch-error" role="status">{watchError}</div>}
    {(showNext||ended)&&info?.next&&!menu&&!watchPrompt&&<div className="pv-up-next"><p>Up next{countdown!==null?` in ${countdown} seconds`:""}</p><h3>{info.next.title}</h3><div><button className="pv-primary" onClick={()=>next()}><Play size={16}/> Play next</button>{countdown!==null&&<button className="pv-button" onClick={()=>setCountdown(null)}>Cancel autoplay</button>}</div></div>}
    {ended&&!pendingInitialization&&!info?.next&&!error&&<div className="pv-player-message"><h2>Playback completed</h2><button className="pv-primary" onClick={()=>void replay()}>Play again</button><button className="pv-button" onClick={exit}>Back to media</button></div>}
    {menu&&!pendingInitialization&&<div className="pv-player-menu" inert={watchPrompt} role="dialog" aria-label={menu==="next"?"Up next":`${menu[0].toUpperCase()}${menu.slice(1)}`}>
      <header><h2>{menu==="next"?"Up Next":menu[0].toUpperCase()+menu.slice(1)}</h2><button className="pv-icon" aria-label="Close menu" onClick={()=>setMenu(null)}><X/></button></header>
      {menu==="audio"&&<div className="pv-option-list">{info?.tracks.filter(track=>track.kind==="audio").map(track=><button key={track.index} aria-pressed={audio===track.index} disabled={!ready.current||!current.current||!audioSelectable(track.index)} onClick={()=>changeTrack("audio",track.index)}><span>{trackLabel(track)}</span>{audio===track.index&&<Check size={18}/>}</button>)}{audioHelp&&<p className="pv-menu-help">{audioHelp}</p>}<p className="pv-menu-help">Native audio is preferred. Other tracks require a permitted lossless stream or audio conversion.</p></div>}
      {menu==="subtitles"&&<div className="pv-option-list"><button aria-pressed={subtitle===-1} onClick={()=>changeTrack("subtitle",-1)}>Off{subtitle===-1&&<Check size={18}/>}</button>{info?.tracks.filter(track=>track.kind==="subtitle").map(track=><button key={track.index} aria-pressed={subtitle===track.index} disabled={unsupportedImage(track)} onClick={()=>changeTrack("subtitle",track.index)}><span>{trackLabel(track)}</span>{subtitle===track.index&&<Check size={18}/>}</button>)}<p className="pv-menu-help">Text, ASS, PGS and VobSub subtitles render in your browser. Other bitmap formats are unavailable. Browser overlays may be omitted from picture in picture.</p>{selectedSubtitle?.subtitle_format==="ass"&&<p className="pv-menu-help">ASS styling uses embedded fonts. Picture in picture may omit styled subtitles.</p>}</div>}
      {menu==="quality"&&<div className="pv-option-list"><button aria-pressed={delivery==="auto"&&quality===0} onClick={()=>changeQuality("auto")}>Auto · direct playback first</button><button aria-pressed={delivery==="original"} onClick={()=>changeQuality("original")}>Original · direct only</button><button disabled={!info||!losslessAudioAllowed(info,capability.current,audio)} aria-pressed={delivery==="stream"} onClick={()=>changeQuality("stream")}>Direct Stream · lossless</button>{qualityChoices.slice(1).map((choice,index)=><button key={choice.label} disabled={info?.conversion_allowed!==true||!capability.current?.hls_supported} aria-pressed={delivery==="auto"&&quality===index+1} onClick={()=>changeQuality("auto",index+1)}>{choice.label}</button>)}<p className="pv-menu-help">Quality changes affect this temporary playback stream. Video conversion must be enabled in the server playback settings. Direct Stream copies video and audio.</p>{info?.bandwidth_adaptation_allowed&&<p className="pv-menu-help">Auto can reduce bitrate after sustained slow HLS downloads. Original-file downloads are not measured automatically.</p>}</div>}
      {menu==="speed"&&<div className="pv-option-list">{[0.5,0.75,1,1.25,1.5,1.75,2].map(value=><button key={value} aria-pressed={speed===value} onClick={()=>{setSpeed(value);setMenu(null);}}>{value===1?"Normal":`${value}×`}{speed===value&&<Check size={18}/>}</button>)}</div>}
      {menu==="chapters"&&<div className="pv-option-list">{info?.chapters.map((chapter,index)=><button key={index} onClick={()=>{seek(chapter.start_seconds);setMenu(null);}}><span>{chapter.title||`Chapter ${index+1}`}</span><time>{playbackTime(chapter.start_seconds)}</time></button>)}</div>}
      {menu==="info"&&<div className="pv-player-info"><DetailSynopsis text={info?.overview} lines={8}/><dl><dt>Playback</dt><dd>{methodLabel}</dd>{session?.video_codec&&<><dt>Video codec</dt><dd>{session.video_codec.toUpperCase()}{session.width&&session.height?` · ${session.width}×${session.height}`:""}</dd></>}{session?.audio_codec&&<><dt>Audio codec</dt><dd>{session.audio_codec.toUpperCase()}</dd></>}{session?.encoder&&<><dt>Encoder</dt><dd>{session.encoder}</dd></>}{!!session?.bitrate&&<><dt>{session.method==="transcode"?"Target bitrate":"Source bitrate"}</dt><dd>{(session.bitrate/1_000_000).toFixed(1)} Mbps</dd></>}<dt>Reason</dt><dd>{session?.reason}</dd><dt>Position</dt><dd>{playbackTime(position)} / {playbackTime(duration)}</dd><dt>Buffered until</dt><dd>{playbackTime(buffered)}</dd><dt>Audio</dt><dd>{info?.tracks.find(track=>track.index===audio)?trackLabel(info.tracks.find(track=>track.index===audio)!):"None"}</dd><dt>Subtitles</dt><dd>{selectedSubtitle?trackLabel(selectedSubtitle):"Off"}</dd></dl><p className="pv-menu-help">Shortcuts: Space/K play or pause · ←/→ skip · F fullscreen · M mute · Esc close menu.</p></div>}
      {menu==="next"&&info?.next&&<div className="pv-option-list"><button onClick={()=>next()}>{info.next.title}<ChevronRight/></button></div>}
    </div>}
    <div className="pv-player-bottom pv-controls" inert={watchPrompt||pendingInitialization} aria-hidden={!visible&&playing&&!menu}>
      <div className="pv-title-row"><div><p className="pv-series-title">{info?.series_title}</p><h1>{title}</h1></div><div className="pv-menu-buttons">
        {info?.tracks.some(track=>track.kind==="audio")&&<button className="pv-button" aria-label="Audio" aria-expanded={menu==="audio"} onClick={()=>toggleMenu("audio")}><Volume2/> <span>Audio</span></button>}
        {info?.tracks.some(track=>track.kind==="subtitle")&&<button className="pv-button" aria-label="Subtitles" aria-expanded={menu==="subtitles"} onClick={()=>toggleMenu("subtitles")}><Subtitles/> <span>Subtitles</span></button>}
        <button className="pv-button" aria-label="Playback quality" aria-expanded={menu==="quality"} onClick={()=>toggleMenu("quality")}><Settings2/><span>{delivery==="original"?"Original":delivery==="stream"?"Direct Stream":quality===0?"Auto":qualityChoices[quality].label}</span></button>
        <button className="pv-button" aria-label="Playback speed" aria-expanded={menu==="speed"} onClick={()=>toggleMenu("speed")}><Gauge/><span>{speed}×</span></button>
      </div></div>
      <div className="pv-timeline-row"><time>{playbackTime(scrubbing??position)}</time><div className="pv-timeline" style={{"--buffered":`${duration?Math.min(100,buffered/duration*100):0}%`,"--position":`${duration?Math.min(100,(scrubbing??position)/duration*100):0}%`} as React.CSSProperties}><input aria-label="Seek" disabled={pendingInitialization||!!error||duration<=0} aria-valuetext={`${playbackTime(scrubbing??position)} of ${playbackTime(duration)}`} type="range" min="0" max={duration||1} step="0.1" value={scrubbing??Math.min(position,duration||position)} onPointerDown={()=>{controls.current.dragging=true;}} onChange={event=>setScrubbing(Number(event.target.value))} onPointerUp={event=>{const value=Number(event.currentTarget.value);setScrubbing(null);controls.current.dragging=false;seek(value);}} onKeyUp={event=>{if(["ArrowLeft","ArrowRight","Home","End","PageUp","PageDown"].includes(event.key)){const value=Number(event.currentTarget.value);setScrubbing(null);seek(value);}}} onPointerCancel={()=>{setScrubbing(null);controls.current.dragging=false;}}/></div><time>{duration>0?`-${playbackTime(duration-(scrubbing??position))}`:"--:--"}</time></div>
      <div className="pv-transport-row"><div className="pv-transport"><button className="pv-icon" aria-label={`Rewind ${preferences.skip_back_seconds} seconds`} onClick={()=>seek(position-preferences.skip_back_seconds)}><RotateCcw/><small>{preferences.skip_back_seconds}</small></button><button className="pv-icon pv-play" aria-label={playing?"Pause":"Play"} onClick={toggle} disabled={loading||pendingInitialization||!!error}>{playing?<Pause/>:<Play/>}</button><button className="pv-icon" aria-label={`Forward ${preferences.skip_forward_seconds} seconds`} onClick={()=>seek(position+preferences.skip_forward_seconds)}><RotateCw/><small>{preferences.skip_forward_seconds}</small></button>{info?.next&&<button className="pv-icon" aria-label="Next episode" onClick={()=>next()}><SkipForward/></button>}</div><div className="pv-sections"><button className="pv-button" aria-label="Info" aria-expanded={menu==="info"} onClick={()=>toggleMenu("info")}><CircleHelp/><span>Info</span></button>{!!info?.chapters.length&&<button className="pv-button" aria-label="Chapters" aria-expanded={menu==="chapters"} onClick={()=>toggleMenu("chapters")}><ListVideo/><span>Chapters</span></button>}{info?.next&&<button className="pv-button" aria-label="Up Next" aria-expanded={menu==="next"} onClick={()=>toggleMenu("next")}><SkipForward/><span>Up Next</span></button>}</div></div>
    </div>
  </div>;
}
