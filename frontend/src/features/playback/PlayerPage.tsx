import {watchApi} from "./api/watch";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import Hls from "hls.js";
import { ArrowLeft, Check, ChevronRight, CircleHelp, Gauge, ListVideo, Maximize, Minimize, Pause, PictureInPicture2, Play, RotateCcw, RotateCw, Settings2, SkipForward, Subtitles, Volume2, VolumeX, X } from "lucide-react";
import { defaultPlaybackPreferences, playbackApi, type PlaybackInfo, type PlaybackPreferences, type PlaybackSession } from "./api/playback";
import { playbackCapabilities, playbackTime, safePlayerReturn, selectTracks, trackLabel } from "./lib/playback";
import DetailSynopsis from "../../components/DetailSynopsis";
import {applyPlainSubtitlePosition,subtitleAppearance,subtitleAppearanceVariables} from "./lib/subtitleAppearance";
import "./PlayerPage.css";

type Menu = "audio"|"subtitles"|"speed"|"quality"|"chapters"|"info"|"next"|null;
type Capability = Awaited<ReturnType<typeof playbackCapabilities>>;
const qualities = [{label:"Original / automatic",height:0,bitrate:0},{label:"2160p · 20 Mbps",height:2160,bitrate:20_000_000},{label:"1080p · 8 Mbps",height:1080,bitrate:8_000_000},{label:"720p · 3 Mbps",height:720,bitrate:3_000_000},{label:"480p · 1.5 Mbps",height:480,bitrate:1_500_000}];
const errorMessage=(error:unknown)=>error instanceof Error?error.message:"Unable to play this video.";

export default function PlayerPage() {
  const {libraryId="",itemId=""}=useParams();
  const routeKey=`${libraryId}\u0000${itemId}`;
  const activeRoute=useRef(routeKey);activeRoute.current=routeKey;
  const navigate=useNavigate(), [params]=useSearchParams();
  const returnPath=safePlayerReturn(params.get("return"));
  const root=useRef<HTMLDivElement>(null), video=useRef<HTMLVideoElement>(null);
  const [info,setInfo]=useState<PlaybackInfo>(), [session,setSession]=useState<PlaybackSession>();
  const [preferences,setPreferences]=useState(defaultPlaybackPreferences);
  const [error,setError]=useState(""), [notice,setNotice]=useState(""), [loading,setLoading]=useState(true);
  const [playing,setPlaying]=useState(false), [buffering,setBuffering]=useState(false), [visible,setVisible]=useState(true);
  const [position,setPosition]=useState(0), [scrubbing,setScrubbing]=useState<number|null>(null), [buffered,setBuffered]=useState(0);
  const [audio,setAudio]=useState<number|null>(null), [subtitle,setSubtitle]=useState(-1), [burnSubtitles,setBurnSubtitles]=useState(false);
  const [volume,setVolume]=useState(1), [muted,setMuted]=useState(false), [speed,setSpeed]=useState(1), [quality,setQuality]=useState(0);
  const [menu,setMenu]=useState<Menu>(null), [fullscreen,setFullscreen]=useState(false), [pip,setPip]=useState(false);
  const [watchPrompt,setWatchPrompt]=useState(false), [ended,setEnded]=useState(false), [countdown,setCountdown]=useState<number|null>(null);
  const [watchError,setWatchError]=useState("");
  const [initializing,setInitializing]=useState(true);
  const initializedRoute=useRef<string|null>(null), initializationGeneration=useRef(0), initializationController=useRef<AbortController|null>(null);
  const pendingStop=useRef<Promise<void>|undefined>(undefined);
  const infoRef=useRef<PlaybackInfo|undefined>(undefined), prefsRef=useRef<PlaybackPreferences>(defaultPlaybackPreferences);
  const current=useRef<PlaybackSession|undefined>(undefined), capability=useRef<Capability|undefined>(undefined), hls=useRef<Hls|undefined>(undefined);
  const watchSession=useRef(""), sequence=useRef(0), requestGeneration=useRef(0), mounted=useRef(false);
  const offset=useRef(0), sourcePosition=useRef(0), ready=useRef(false), retries=useRef(0);
  const replaying=useRef(false);
  const selected=useRef({audio:null as number|null,subtitle:-1,burn:false,quality:0});
  const controls=useRef({visible:true,playing:false,menu:null as Menu,dragging:false,lastActive:Date.now(),focus:false,prompt:false,ended:false});
  const restartRef=useRef<(position:number,force?:boolean)=>Promise<void>>(async()=>{});
  const replayRef=useRef<(position?:number,autoplay?:boolean)=>Promise<void>>(async()=>{});
  const report=useCallback((isEnded=false,keepalive=false,seeking=false,previousRoute=false)=>{
    if(!watchSession.current||!ready.current||(!previousRoute&&activeRoute.current!==routeKey))return;
    const payload={session_id:watchSession.current,sequence:++sequence.current,position_seconds:sourcePosition.current,paused:video.current?.paused??true,ended:isEnded,seeking,...(!keepalive&&current.current?{playback_session_id:current.current.id}:{}),audio_index:selected.current.audio,subtitle_index:selected.current.subtitle};
    void watchApi.progress(libraryId,itemId,payload,keepalive).then(()=>{
      if(mounted.current&&activeRoute.current===routeKey&&payload.session_id===watchSession.current&&payload.sequence===sequence.current)setWatchError("");
      window.dispatchEvent(new Event("posterview-watch-updated"));
    }).catch(error=>{if(mounted.current&&activeRoute.current===routeKey&&payload.session_id===watchSession.current&&payload.sequence===sequence.current)setWatchError(`Watch progress could not be saved: ${errorMessage(error)}`);});
  },[libraryId,itemId,routeKey]);
  const interact=useCallback(()=>{
    controls.current.lastActive=Date.now();controls.current.visible=true;setVisible(true);
  },[]);
  const play=useCallback(async(userInteraction=true)=>{
    const element=video.current;if(!element||activeRoute.current!==routeKey||initializedRoute.current!==routeKey||!watchSession.current||!ready.current||!current.current)return;
    if(userInteraction)interact();
    try{await element.play();setNotice(value=>value==="Press Play to begin playback."||value.startsWith("The browser cannot decode this source.")?"":value);}catch(error){setNotice(error instanceof DOMException&&error.name==="NotAllowedError"?"Press Play to begin playback.":errorMessage(error));}
  },[interact,routeKey]);
  const terminalError=useCallback((message:string)=>{
    if(!mounted.current||activeRoute.current!==routeKey)return;
    const element=video.current;
    if(ready.current&&element&&Number.isFinite(element.currentTime)){
      sourcePosition.current=Math.max(0,offset.current+element.currentTime);setPosition(sourcePosition.current);
    }
    report();ready.current=false;requestGeneration.current++;
    element?.pause();hls.current?.destroy();hls.current=undefined;
    const stopped=current.current;current.current=undefined;
    if(element){element.removeAttribute("src");element.load();}
    if(stopped){
      const stopping=playbackApi.stop(stopped.id).catch(()=>{});pendingStop.current=stopping;
      void stopping.finally(()=>{if(pendingStop.current===stopping)pendingStop.current=undefined;});
    }
    setLoading(false);setBuffering(false);setPlaying(false);setVisible(true);setError(message);
  },[report,routeKey]);
  const start=useCallback(async(sourceTime:number,force=false,playOverride?:boolean)=>{
    const element=video.current, data=infoRef.current, caps=capability.current;
    if(!element||!data||!caps||activeRoute.current!==routeKey||initializedRoute.current!==routeKey||!watchSession.current)return;
    const generation=++requestGeneration.current;
    const shouldPlay=playOverride??(force||!current.current||!element.paused);
    const target=Math.max(0,Math.min(sourceTime,data.duration_seconds||sourceTime));
    report();ready.current=false;element.pause();setLoading(true);setError("");setEnded(false);setCountdown(null);
    hls.current?.destroy();hls.current=undefined;
    element.removeAttribute("src");element.load();
    const previous=current.current;current.current=undefined;
    if(previous)await playbackApi.stop(previous.id).catch(()=>{});
    if(pendingStop.current)await pendingStop.current;
    if(!mounted.current||activeRoute.current!==routeKey||generation!==requestGeneration.current)return;
    try{
      const choice=selected.current, q=qualities[choice.quality];
      const {source_video_supported,...outputCapabilities}=caps;
      const created=await playbackApi.create(libraryId,itemId,{position_seconds:target,audio_index:choice.audio,subtitle_index:choice.subtitle<0?null:choice.subtitle,max_height:q.height,max_bitrate:q.bitrate,...outputCapabilities,force_transcode:force||!source_video_supported,subtitle_burn_index:choice.burn&&choice.subtitle>=0?choice.subtitle:null});
      if(!mounted.current||activeRoute.current!==routeKey||generation!==requestGeneration.current){void playbackApi.stop(created.id).catch(()=>{});return;}
      current.current=created;offset.current=created.offset_seconds;sourcePosition.current=target;setSession(created);setPosition(target);
      const initialize=()=>{
        if(activeRoute.current!==routeKey||generation!==requestGeneration.current)return;
        const relativePosition=Math.max(0,target-created.offset_seconds);
        element.currentTime=relativePosition;
        element.playbackRate=speedRef.current;ready.current=true;setLoading(false);report(false,false,true);if(shouldPlay)void play(false);
      };
      element.addEventListener("loadedmetadata",initialize,{once:true});
      if(created.mime.includes("mpegurl")&&Hls.isSupported()){
        const instance=new Hls({startPosition:Math.max(0,target-created.offset_seconds),maxBufferLength:30,maxMaxBufferLength:60,backBufferLength:20,enableWorker:true,lowLatencyMode:false});
        hls.current=instance;let mediaRecovery=false;
        instance.on(Hls.Events.ERROR,(_event,data)=>{
          if(!data.fatal||generation!==requestGeneration.current)return;
          if(data.type===Hls.ErrorTypes.MEDIA_ERROR&&!mediaRecovery){mediaRecovery=true;instance.recoverMediaError();return;}
          if(retries.current++===0&&created.method!=="transcode")void restartRef.current(sourcePosition.current,true);
          else terminalError(`Playback failed: ${data.details}. Try a different quality or inspect transcoding settings.`);
        });
        instance.attachMedia(element);instance.loadSource(created.url);
      }else element.src=created.url;
    }catch(error){if(mounted.current&&generation===requestGeneration.current){setLoading(false);setError(errorMessage(error));}}
  },[libraryId,itemId,routeKey,play,report,terminalError]);
  restartRef.current=start;
  const speedRef=useRef(speed);speedRef.current=speed;
  const startFromBeginning=params.get("start")==="0";
  const initializeItem=useCallback(async()=>{
    initializationController.current?.abort();
    const controller=new AbortController();initializationController.current=controller;
    const attempt=++initializationGeneration.current;requestGeneration.current++;
    const isCurrent=()=>mounted.current&&activeRoute.current===routeKey&&attempt===initializationGeneration.current&&!controller.signal.aborted;
    initializedRoute.current=null;watchSession.current="";ready.current=false;
    infoRef.current=undefined;capability.current=undefined;
    setInitializing(true);setLoading(true);setError("");setNotice("");setWatchError("");
    setInfo(undefined);setSession(undefined);setPosition(0);setBuffered(0);setScrubbing(null);setPlaying(false);setBuffering(false);
    setAudio(null);setSubtitle(-1);setBurnSubtitles(false);setQuality(0);setMenu(null);setEnded(false);setCountdown(null);setWatchPrompt(false);setVisible(true);
    sourcePosition.current=0;offset.current=0;retries.current=0;
    controls.current.playing=false;controls.current.menu=null;controls.current.dragging=false;controls.current.prompt=false;controls.current.ended=false;
      try{
        const [data,prefs,state]=await Promise.all([playbackApi.info(libraryId,itemId,controller.signal),watchApi.preferences(controller.signal),watchApi.state(libraryId,itemId,controller.signal)]);
        if(!isCurrent()||!video.current)return;
        const caps=await playbackCapabilities(data,video.current);if(!isCurrent())return;
        const tracks=selectTracks(data,prefs,state), chosenSub=data.tracks.find(track=>track.index===tracks.subtitle);
        infoRef.current=data;prefsRef.current=prefs;capability.current=caps;
        selected.current={audio:tracks.audio,subtitle:tracks.subtitle,burn:chosenSub?.subtitle_format==="image",quality:0};
        setInfo(data);setPreferences(prefs);setAudio(tracks.audio);setSubtitle(tracks.subtitle);setBurnSubtitles(selected.current.burn);
        const watch=await watchApi.begin(libraryId,itemId);if(!isCurrent())return;
        if(!watch.session_id)throw new Error("Watch tracking could not be initialized. Try again.");
        watchSession.current=watch.session_id;sequence.current=0;initializedRoute.current=routeKey;setInitializing(false);
        const initial=startFromBeginning?0:Math.max(0,watch.state.position_seconds-prefs.resume_rewind_seconds);
        await start(initial);
      }catch(error){if(isCurrent()){controller.abort();setLoading(false);setError(errorMessage(error));}}
  },[libraryId,itemId,routeKey,startFromBeginning,start]);
  const retryPlayback=()=>{
    retries.current=0;
    if(initializedRoute.current===routeKey&&watchSession.current&&infoRef.current&&capability.current)void start(sourcePosition.current,true);
    else void initializeItem();
  };
  useEffect(()=>{
    mounted.current=true;void initializeItem();
    return()=>{
      report(false,true,false,true);mounted.current=false;requestGeneration.current++;initializationGeneration.current++;
      initializationController.current?.abort();initializedRoute.current=null;
      ready.current=false;watchSession.current="";infoRef.current=undefined;capability.current=undefined;hls.current?.destroy();hls.current=undefined;
      const element=video.current;if(element){element.pause();element.removeAttribute("src");element.load();}
      const stopped=current.current;current.current=undefined;if(stopped)void playbackApi.stop(stopped.id).catch(()=>{});
    };
  // A new item owns an independent watch/session lifecycle, including StrictMode cleanup.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[initializeItem,report]);
  useEffect(()=>{
    const timer=window.setInterval(()=>{
      if(ready.current){report();if(current.current)void playbackApi.heartbeat(current.current.id,sourcePosition.current,video.current?.paused??true).catch(()=>{});}
    },10_000);
    const flush=()=>report(false,true);
    window.addEventListener("pagehide",flush);document.addEventListener("visibilitychange",flush);
    return()=>{clearInterval(timer);window.removeEventListener("pagehide",flush);document.removeEventListener("visibilitychange",flush);};
  },[report]);
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
    if(activeRoute.current!==routeKey||initializedRoute.current!==routeKey)return;
    interact();const bound=Math.max(0,Math.min(target,infoRef.current?.duration_seconds||target));
    if(controls.current.ended){void replayRef.current(bound,false);return;}
    if(current.current?.method==="direct"&&video.current){video.current.currentTime=bound;sourcePosition.current=bound;setPosition(bound);report(false,false,true);}
    else void start(bound);
  },[interact,start,report,routeKey]);
  const toggle=useCallback(()=>{if(controls.current.prompt||activeRoute.current!==routeKey||initializedRoute.current!==routeKey)return;interact();if(controls.current.ended){void replayRef.current();return;}if(video.current?.paused)void play();else video.current?.pause();},[play,interact,routeKey]);
  const exit=()=>{report(false,true);navigate(returnPath);};
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
    if(!session||!selectedTrack||subtitle<0||burnSubtitles)return()=>element.textTracks.removeEventListener?.("addtrack",disableNative);
    const controller=new AbortController();
    void(async()=>{
      try{
        const url=selectedTrack.url||playbackApi.subtitle(libraryId,itemId,subtitle);
        if(selectedTrack.subtitle_format==="ass"||["ass","ssa"].includes(selectedTrack.codec)){
          const [{default:JASSUB},response]=await Promise.all([import("jassub"),fetch(url,{signal:controller.signal})]);
          if(!response.ok)throw new Error("Subtitle extraction failed.");
          const content=await response.text();if(canceled)return;
          const instance=new JASSUB({video:element,subContent:content,fonts:data?.fonts?.map(font=>font.url)??[],timeOffset:session.offset_seconds,queryFonts:false});renderer=instance;
          await instance.ready;if(canceled)void instance.destroy();
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
      }catch(error){if(!canceled&&!controller.signal.aborted)setNotice(`Subtitles: ${errorMessage(error)} Select “Burn subtitles into video” to use the server renderer.`);}
    })();
    return()=>{canceled=true;controller.abort();element.textTracks.removeEventListener?.("addtrack",disableNative);void renderer?.destroy();track?.remove();if(objectUrl)URL.revokeObjectURL(objectUrl);};
  },[info,session,subtitle,burnSubtitles,libraryId,itemId,preferences.subtitle_position]);
  const changeTrack=(kind:"audio"|"subtitle",value:number)=>{
    if(activeRoute.current!==routeKey||initializedRoute.current!==routeKey)return;
    interact();setNotice("");if(kind==="audio"){selected.current.audio=value;setAudio(value);report();void start(sourcePosition.current);}
    else{
      const previousBurn=selected.current.burn, chosen=info?.tracks.find(track=>track.index===value);
      selected.current.subtitle=value;selected.current.burn=chosen?.subtitle_format==="image";setSubtitle(value);setBurnSubtitles(selected.current.burn);report();
      if(previousBurn||selected.current.burn)void start(sourcePosition.current);
    }
    setMenu(null);
  };
  const toggleMenu=(value:Menu)=>{if(activeRoute.current!==routeKey||initializedRoute.current!==routeKey)return;interact();setMenu(current=>current===value?null:value);};
  const pipAvailable=!!document.pictureInPictureEnabled;
  const togglePip=async()=>{
    interact();try{if(document.pictureInPictureElement)await document.exitPictureInPicture();else await video.current?.requestPictureInPicture();}catch(error){setNotice(errorMessage(error));}
  };
  const progressEvent=()=>{
    const element=video.current;if(!element||!ready.current)return;
    const source=offset.current+element.currentTime;sourcePosition.current=source;setPosition(source);
    if(element.buffered.length)setBuffered(offset.current+element.buffered.end(element.buffered.length-1));
  };
  const end=()=>{
    if(!ready.current||activeRoute.current!==routeKey)return;
    const duration=infoRef.current?.duration_seconds??0;
    if(duration>0&&sourcePosition.current<duration-3){setError("Playback ended before the file finished. Retry playback or choose another quality.");return;}
    const actualPosition=offset.current+(video.current?.currentTime??0);
    sourcePosition.current=duration>0?duration:Number.isFinite(actualPosition)?Math.max(0,actualPosition):sourcePosition.current;
    report(true);setEnded(true);setVisible(true);setPlaying(false);
    if(infoRef.current?.next&&prefsRef.current.autoplay_next)setCountdown(10);
  };
  const replay=async(position=0,autoplay=true)=>{
    if(activeRoute.current!==routeKey||initializedRoute.current!==routeKey)return;
    if(replaying.current)return;replaying.current=true;
    const generation=requestGeneration.current;ready.current=false;initializedRoute.current=null;watchSession.current="";setInitializing(true);setLoading(true);setEnded(false);setCountdown(null);
    try{
      const watch=await watchApi.begin(libraryId,itemId);
      if(!mounted.current||activeRoute.current!==routeKey||generation!==requestGeneration.current)return;
      if(!watch.session_id)throw new Error("Watch tracking could not be initialized. Try again.");
      watchSession.current=watch.session_id;sequence.current=0;initializedRoute.current=routeKey;setInitializing(false);await start(position,false,autoplay);
    }catch(error){if(mounted.current&&activeRoute.current===routeKey&&generation===requestGeneration.current){setLoading(false);setError(errorMessage(error));}}finally{replaying.current=false;}
  };
  replayRef.current=replay;
  const mediaError=()=>{
    if(!current.current)return;
    if(retries.current++===0&&current.current?.method!=="transcode"){setNotice("The browser cannot decode this source. Switching to compatible playback…");void start(sourcePosition.current,true);}
    else terminalError("The browser could not decode the video. Check transcoding settings or select a lower quality.");
  };
  const duration=info?.duration_seconds||session?.duration_seconds||0;
  const pendingInitialization=initializing||initializedRoute.current!==routeKey;
  const showNext=!pendingInitialization&&!!info?.next&&preferences.up_next&&duration>0&&position>=duration-20;
  const title=pendingInitialization?"Media player":info?.season!=null&&info?.episode!=null?`S${info.season}:E${info.episode} – ${info.title}`:info?.title??"Media player";
  const selectedSubtitle=info?.tracks.find(track=>track.index===subtitle);
  return <div className={`pv-player ${visible||menu||watchPrompt||!playing?"controls-visible":"controls-hidden"}`} ref={root} style={{"--subtitle-scale":preferences.subtitle_size/100,...subtitleAppearanceVariables(preferences)} as React.CSSProperties} onPointerMove={interact} onKeyDownCapture={interact} onPointerDown={()=>{controls.current.focus=false;interact();}} onFocusCapture={event=>{controls.current.focus=event.target instanceof HTMLElement&&event.target.matches(":focus-visible");setVisible(true);}} onBlurCapture={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))controls.current.focus=false;}}>
    <div className="pv-video-stage" inert={watchPrompt||pendingInitialization}><video ref={video} playsInline preload="metadata" poster={info?.poster_url??undefined} onClick={toggle} onDoubleClick={()=>void toggleFullscreen()} onPlay={()=>{setPlaying(true);setEnded(false);}} onPause={()=>{setPlaying(false);setVisible(true);report();}} onWaiting={()=>setBuffering(true)} onPlaying={()=>{setBuffering(false);setLoading(false);}} onTimeUpdate={progressEvent} onProgress={progressEvent} onEnded={end} onError={mediaError} onSeeked={()=>report()} aria-label={title}/></div>
    <div className="pv-player-header pv-controls" inert={watchPrompt} aria-hidden={!visible&&playing&&!menu}>
      <button className="pv-icon" aria-label="Back to media" onClick={exit} title="Back"><ArrowLeft/></button>
      <div className="pv-header-tools" inert={pendingInitialization}><button className="pv-icon" aria-label={muted?"Unmute":"Mute"} onClick={()=>setMuted(value=>!value)}>{muted||volume===0?<VolumeX/>:<Volume2/>}</button><input className="pv-volume" aria-label="Volume" type="range" min="0" max="1" step="0.01" value={muted?0:volume} onChange={event=>{setVolume(Number(event.target.value));setMuted(false);}}/>
        {pipAvailable&&<button className="pv-icon" aria-label={pip?"Exit picture in picture":"Picture in picture"} onClick={()=>void togglePip()}><PictureInPicture2/></button>}
        <button className="pv-icon" aria-label={fullscreen?"Exit fullscreen":"Fullscreen"} onClick={()=>void toggleFullscreen()}>{fullscreen?<Minimize/>:<Maximize/>}</button>
      </div>
    </div>
    {(loading||buffering)&&!error&&<div className="pv-player-loading" role="status"><span className="pv-spinner"/><span>{loading?"Preparing playback…":"Buffering…"}</span></div>}
    {error&&<div className="pv-player-message" role="alert"><h1>Unable to play</h1><p>{error}</p><div><button className="pv-primary" onClick={retryPlayback}>Retry compatible playback</button><button className="pv-button" onClick={exit}>Back to media</button></div></div>}
    {watchPrompt&&<div className="pv-player-message" role="dialog" aria-modal="true" aria-label="Still watching" onKeyDown={event=>{if(event.key!=="Tab")return;const buttons=event.currentTarget.querySelectorAll<HTMLButtonElement>("button"),first=buttons[0],last=buttons[buttons.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}}><h2>Are you still watching?</h2><p>Playback paused after inactivity.</p><button className="pv-primary" autoFocus onClick={()=>{setWatchPrompt(false);interact();void play();}}>Continue watching</button><button className="pv-button" onClick={exit}>Stop playback</button></div>}
    {notice&&<div className="pv-player-notice" role="status">{notice}<button aria-label="Dismiss message" onClick={()=>setNotice("")}><X size={16}/></button></div>}
    {watchError&&<div className="pv-watch-error" role="status">{watchError}</div>}
    {(showNext||ended)&&info?.next&&!menu&&!watchPrompt&&<div className="pv-up-next"><p>Up next{countdown!==null?` in ${countdown} seconds`:""}</p><h3>{info.next.title}</h3><div><button className="pv-primary" onClick={()=>next()}><Play size={16}/> Play next</button>{countdown!==null&&<button className="pv-button" onClick={()=>setCountdown(null)}>Cancel autoplay</button>}</div></div>}
    {ended&&!pendingInitialization&&!info?.next&&!error&&<div className="pv-player-message"><h2>Playback completed</h2><button className="pv-primary" onClick={()=>void replay()}>Play again</button><button className="pv-button" onClick={exit}>Back to media</button></div>}
    {menu&&!pendingInitialization&&<div className="pv-player-menu" inert={watchPrompt} role="dialog" aria-label={menu==="next"?"Up next":`${menu[0].toUpperCase()}${menu.slice(1)}`}>
      <header><h2>{menu==="next"?"Up Next":menu[0].toUpperCase()+menu.slice(1)}</h2><button className="pv-icon" aria-label="Close menu" onClick={()=>setMenu(null)}><X/></button></header>
      {menu==="audio"&&<div className="pv-option-list">{info?.tracks.filter(track=>track.kind==="audio").map(track=><button key={track.index} aria-pressed={audio===track.index} onClick={()=>changeTrack("audio",track.index)}><span>{trackLabel(track)}</span>{audio===track.index&&<Check size={18}/>}</button>)}</div>}
      {menu==="subtitles"&&<div className="pv-option-list"><button aria-pressed={subtitle===-1} onClick={()=>changeTrack("subtitle",-1)}>Off{subtitle===-1&&<Check size={18}/>}</button>{info?.tracks.filter(track=>track.kind==="subtitle").map(track=><button key={track.index} aria-pressed={subtitle===track.index} onClick={()=>changeTrack("subtitle",track.index)}><span>{trackLabel(track)}</span>{subtitle===track.index&&<Check size={18}/>}</button>)}{subtitle>=0&&<label className="pv-toggle"><input type="checkbox" checked={burnSubtitles} disabled={selectedSubtitle?.subtitle_format==="image"} onChange={event=>{selected.current.burn=event.target.checked;setBurnSubtitles(event.target.checked);void start(sourcePosition.current);}}/> Burn subtitles into video</label>}{selectedSubtitle?.subtitle_format==="ass"&&<p className="pv-menu-help">ASS styling uses the embedded fonts. Picture in picture may omit styled subtitles; burn in to include them.</p>}</div>}
      {menu==="speed"&&<div className="pv-option-list">{[0.5,0.75,1,1.25,1.5,1.75,2].map(value=><button key={value} aria-pressed={speed===value} onClick={()=>{setSpeed(value);setMenu(null);}}>{value===1?"Normal":`${value}×`}{speed===value&&<Check size={18}/>}</button>)}</div>}
      {menu==="quality"&&<div className="pv-option-list">{qualities.map((choice,index)=><button key={choice.label} aria-pressed={quality===index} onClick={()=>{selected.current.quality=index;setQuality(index);setMenu(null);void start(sourcePosition.current);}}>{choice.label}{quality===index&&<Check size={18}/>}</button>)}<p className="pv-menu-help">Automatic preserves the source whenever the browser supports it. Server transcoding limits also apply.</p></div>}
      {menu==="chapters"&&<div className="pv-option-list">{info?.chapters.map((chapter,index)=><button key={index} onClick={()=>{seek(chapter.start_seconds);setMenu(null);}}><span>{chapter.title||`Chapter ${index+1}`}</span><time>{playbackTime(chapter.start_seconds)}</time></button>)}</div>}
      {menu==="info"&&<div className="pv-player-info"><DetailSynopsis text={info?.overview} lines={8}/><dl><dt>Playback</dt><dd>{session?.method.replaceAll("_"," ")}</dd><dt>Reason</dt><dd>{session?.reason}</dd>{session?.encoder&&<><dt>Encoder</dt><dd>{session.encoder}</dd></>}<dt>Position</dt><dd>{playbackTime(position)} / {playbackTime(duration)}</dd><dt>Buffered until</dt><dd>{playbackTime(buffered)}</dd><dt>Audio</dt><dd>{info?.tracks.find(track=>track.index===audio)?trackLabel(info.tracks.find(track=>track.index===audio)!):"None"}</dd><dt>Subtitles</dt><dd>{selectedSubtitle?trackLabel(selectedSubtitle):"Off"}{burnSubtitles?" (burned in)":""}</dd></dl><p className="pv-menu-help">Shortcuts: Space/K play or pause · ←/→ skip · F fullscreen · M mute · Esc close menu.</p></div>}
      {menu==="next"&&info?.next&&<div className="pv-option-list"><button onClick={()=>next()}>{info.next.title}<ChevronRight/></button></div>}
    </div>}
    <div className="pv-player-bottom pv-controls" inert={watchPrompt||pendingInitialization} aria-hidden={!visible&&playing&&!menu}>
      <div className="pv-title-row"><div><p className="pv-series-title">{info?.series_title}</p><h1>{title}</h1></div><div className="pv-menu-buttons">
        {info?.tracks.some(track=>track.kind==="audio")&&<button className="pv-button" aria-label="Audio" aria-expanded={menu==="audio"} onClick={()=>toggleMenu("audio")}><Volume2/> <span>Audio</span></button>}
        {info?.tracks.some(track=>track.kind==="subtitle")&&<button className="pv-button" aria-label="Subtitles" aria-expanded={menu==="subtitles"} onClick={()=>toggleMenu("subtitles")}><Subtitles/> <span>Subtitles</span></button>}
        <button className="pv-button" aria-label="Playback speed" aria-expanded={menu==="speed"} onClick={()=>toggleMenu("speed")}><Gauge/><span>{speed}×</span></button><button className="pv-icon" aria-label="Playback quality" disabled={pendingInitialization} aria-expanded={menu==="quality"} onClick={()=>toggleMenu("quality")}><Settings2/></button>
      </div></div>
      <div className="pv-timeline-row"><time>{playbackTime(scrubbing??position)}</time><div className="pv-timeline" style={{"--buffered":`${duration?Math.min(100,buffered/duration*100):0}%`,"--position":`${duration?Math.min(100,(scrubbing??position)/duration*100):0}%`} as React.CSSProperties}><input aria-label="Seek" disabled={pendingInitialization||loading||duration<=0} aria-valuetext={`${playbackTime(scrubbing??position)} of ${playbackTime(duration)}`} type="range" min="0" max={duration||1} step="0.1" value={scrubbing??Math.min(position,duration||position)} onPointerDown={()=>{controls.current.dragging=true;}} onChange={event=>setScrubbing(Number(event.target.value))} onPointerUp={event=>{const value=Number(event.currentTarget.value);setScrubbing(null);controls.current.dragging=false;seek(value);}} onKeyUp={event=>{if(["ArrowLeft","ArrowRight","Home","End","PageUp","PageDown"].includes(event.key)){const value=Number(event.currentTarget.value);setScrubbing(null);seek(value);}}} onPointerCancel={()=>{setScrubbing(null);controls.current.dragging=false;}}/></div><time>{duration>0?`-${playbackTime(duration-(scrubbing??position))}`:"--:--"}</time></div>
      <div className="pv-transport-row"><div className="pv-transport"><button className="pv-icon" aria-label={`Rewind ${preferences.skip_back_seconds} seconds`} onClick={()=>seek(position-preferences.skip_back_seconds)}><RotateCcw/><small>{preferences.skip_back_seconds}</small></button><button className="pv-icon pv-play" aria-label={playing?"Pause":"Play"} onClick={toggle} disabled={loading||pendingInitialization||!!error}>{playing?<Pause/>:<Play/>}</button><button className="pv-icon" aria-label={`Forward ${preferences.skip_forward_seconds} seconds`} onClick={()=>seek(position+preferences.skip_forward_seconds)}><RotateCw/><small>{preferences.skip_forward_seconds}</small></button>{info?.next&&<button className="pv-icon" aria-label="Next episode" onClick={()=>next()}><SkipForward/></button>}</div><div className="pv-sections"><button className="pv-button" aria-label="Info" aria-expanded={menu==="info"} onClick={()=>toggleMenu("info")}><CircleHelp/><span>Info</span></button>{!!info?.chapters.length&&<button className="pv-button" aria-label="Chapters" aria-expanded={menu==="chapters"} onClick={()=>toggleMenu("chapters")}><ListVideo/><span>Chapters</span></button>}{info?.next&&<button className="pv-button" aria-label="Up Next" aria-expanded={menu==="next"} onClick={()=>toggleMenu("next")}><SkipForward/><span>Up Next</span></button>}</div></div>
    </div>
  </div>;
}
