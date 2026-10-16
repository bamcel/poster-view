import {useEffect, useRef, useState} from "react";
import {Link, useParams} from "react-router-dom";
import {apiRequest} from "../../api/client";
import {defaultPlaybackPreferences, playbackApi, type PlaybackSession} from "../playback/api/playback";
import {playbackCapabilities, selectTracks} from "../playback/lib/playback";
import {attachSegmentedPlayback} from "../playback/lib/hlsDelivery";

interface Tune {library_id:string;item_id:string;position_seconds:number;ends_at:string;program_id:string;channel_name?:string;title?:string}

/** Live channel sessions deliberately do not create or update personal watch history. */
export default function VirtualTvPlayer() {
  const {channelId=""}=useParams();
  const video=useRef<HTMLVideoElement>(null);
  const [error,setError]=useState(""),[title,setTitle]=useState("Virtual TV"),[loading,setLoading]=useState(true);
  const actions=useRef({tune:()=>{}});
  useEffect(()=>{
    let active=true,busy=false,session:PlaybackSession|undefined,program="";
    let pendingStop=Promise.resolve();
    let attachment:ReturnType<typeof attachSegmentedPlayback>|undefined;
    let boundary:ReturnType<typeof setTimeout>|undefined,metadata:(()=>void)|undefined;
    const controller=new AbortController(),element=video.current!;
    const stop=()=>{
      attachment?.destroy();attachment=undefined;
      if(metadata)element.removeEventListener("loadedmetadata",metadata);
      metadata=undefined;element.pause();element.removeAttribute("src");element.load();
      const old=session;session=undefined;
      if(old)pendingStop=pendingStop.then(()=>playbackApi.stop(old.id,true)).catch(()=>{});
      return pendingStop;
    };
    const fail=(reason:unknown)=>{
      if(!active)return;
      stop();program="";clearTimeout(boundary);setLoading(false);
      setError(reason instanceof Error?reason.message:String(reason));
    };
    const schedule=(end:string)=>{
      clearTimeout(boundary);
      const remaining=Date.parse(end)-Date.now();
      const transition=()=>{
        if(!active)return;
        if(busy){boundary=setTimeout(transition,250);return;}
        void tune(false);
      };
      boundary=setTimeout(transition,Math.min(2_147_483_647,Math.max(1000,remaining+250)));
    };
    const tune=async(force=false)=>{
      if(!active||busy)return;
      busy=true;
      try{
        const current=await apiRequest<Tune>(`/virtual-tv/channels/${encodeURIComponent(channelId)}/tune`,{method:"POST",signal:controller.signal});
        if(!active)return;
        schedule(current.ends_at);
        if(!force&&session&&program===current.program_id)return;
        await stop();
        if(!active)return;
        setError("");setLoading(true);
        const info=await playbackApi.info(current.library_id,current.item_id,controller.signal);
        if(!active)return;
        const caps=await playbackCapabilities(info,element);
        if(!active)return;
        const choice=selectTracks(info,defaultPlaybackPreferences,{session_id:null,version:0,position_seconds:0,duration_seconds:0,watched:false,play_count:0,last_played_at:null,audio_index:null,subtitle_index:-1});
        const next=await playbackApi.create(current.library_id,current.item_id,{...caps,position_seconds:current.position_seconds,audio_index:choice.audio,subtitle_index:null,virtual_channel_id:channelId});
        if(!active){void playbackApi.stop(next.id,true).catch(()=>{});return;}
        session=next;program=current.program_id;
        setTitle([current.channel_name,current.title??info.title].filter(Boolean).join(" · "));
        const target=Math.max(0,(next.position_seconds??current.position_seconds)-next.offset_seconds);
        metadata=()=>{
          if(!active||session!==next)return;
          element.currentTime=target;setLoading(false);
          void element.play().catch(()=>{/* Native controls allow playback when autoplay is blocked. */});
        };
        element.addEventListener("loadedmetadata",metadata,{once:true});
        if(next.method==="direct"){element.src=next.url;element.load();}
        else attachment=attachSegmentedPlayback(element,next,{fatal:fail,isCurrent:()=>active&&session===next},target);
      }catch(reason){if(active)fail(reason);}
      finally{busy=false;}
    };
    actions.current={tune:()=>void tune(true)};
    const heartbeat=setInterval(()=>{
      const owner=session;if(!owner)return;
      void playbackApi.heartbeat(owner.id,element.currentTime+owner.offset_seconds,element.paused,owner.generation,element.playbackRate).catch(reason=>{if(session===owner)fail(reason);});
    },10_000);
    const permissions=setInterval(()=>void tune(false),15_000);
    const ended=()=>void tune(false);
    const mediaError=()=>{if(session)fail("This channel could not be played. Retry or return to the guide.");};
    element.addEventListener("ended",ended);element.addEventListener("error",mediaError);
    void tune();
    return()=>{active=false;controller.abort();clearInterval(heartbeat);clearInterval(permissions);clearTimeout(boundary);element.removeEventListener("ended",ended);element.removeEventListener("error",mediaError);stop();};
  },[channelId]);
  return <main className="virtual-tv-player">
    <header style={{display:"flex",alignItems:"center",gap:16,padding:16}}><Link to="/virtual-tv">Back to guide</Link><h1 style={{flex:1,fontSize:"1.1rem"}}>{title}</h1><button onClick={()=>actions.current.tune()}>Return to live</button></header>
    {error&&<div role="alert" style={{padding:16}}>{error} <button onClick={()=>actions.current.tune()}>Retry</button></div>}
    {loading&&<p role="status">Tuning channel…</p>}
    <video ref={video} controls playsInline aria-label="Virtual TV player" style={{width:"100%",maxHeight:"calc(100vh - 100px)",background:"black"}}/>
  </main>;
}
