import {useEffect,useState} from "react";
import type {PlaybackSession} from "../types";

type Props={video:HTMLVideoElement|null;active:boolean;session:PlaybackSession|undefined};
type Snapshot={ahead:number;ranges:string;ready:string;network:string;resolution:string;rate:number;frames:string};
const time=(seconds:number)=>{
  const value=Math.max(0,Math.floor(seconds));
  return `${Math.floor(value/60)}:${String(value%60).padStart(2,"0")}`;
};
function snapshot(video:HTMLVideoElement,offset:number):Snapshot{
  let ahead=0;
  const ranges:string[]=[];
  for(let index=0;index<video.buffered.length;index++){
    const start=video.buffered.start(index),end=video.buffered.end(index);
    ranges.push(`${time(start+offset)}–${time(end+offset)}`);
    // A future disconnected range cannot keep the current frame playing.
    if(start<=video.currentTime&&video.currentTime<=end)ahead=end-video.currentTime;
  }
  let frames="Unavailable";
  try{
    const quality=video.getVideoPlaybackQuality?.();
    if(quality)frames=`${quality.droppedVideoFrames} dropped / ${quality.totalVideoFrames} total`;
  }catch{ /* Some engines expose the API before playback diagnostics are available. */ }
  return {ahead,ranges:ranges.join(", ")||"None",
    ready:["No media data","Metadata loaded","Current frame ready","Future frames ready","Enough data"][video.readyState]??"Unknown",
    network:["Empty","Idle","Loading","No source"][video.networkState]??"Unknown",
    resolution:video.videoWidth&&video.videoHeight?`${video.videoWidth}×${video.videoHeight}`:"Unavailable",
    rate:video.playbackRate,frames};
}

export default function PlaybackStatistics({video,active,session}:Props){
  const [stats,setStats]=useState<Snapshot>();
  useEffect(()=>{
    if(!active||!video){setStats(undefined);return;}
    const update=()=>setStats(snapshot(video,session?.offset_seconds??0));
    update();
    const timer=window.setInterval(update,1000);
    return ()=>window.clearInterval(timer);
  },[active,video,session?.id,session?.url,session?.offset_seconds]);
  if(!active||!stats)return null;
  return <dl aria-label="Live playback statistics">
    <dt>Buffer ahead</dt><dd>{stats.ahead.toFixed(1)} seconds</dd>
    <dt>Buffered ranges</dt><dd>{stats.ranges}</dd>
    <dt>Media readiness</dt><dd>{stats.ready}</dd>
    <dt>Network state</dt><dd>{stats.network}</dd>
    <dt>Decoded resolution</dt><dd>{stats.resolution}</dd>
    <dt>Video frames</dt><dd>{stats.frames}</dd>
    <dt>Playback rate</dt><dd>{stats.rate}×</dd>
  </dl>;
}
