import type Hls from "hls.js";
import type {ErrorData} from "hls.js";

// Copied segments can span a long GOP. The normal live reload deadline can
// outlast the small initial browser buffer even when the server has more media.
// Refresh just the playlist: restarting the stream loader would cancel useful
// fragment requests and can make that starvation worse.
export function watchRemuxPlaylistRefresh(hls:Hls,Engine:typeof Hls,video:HTMLVideoElement,owns:()=>boolean):()=>void {
  let active=true,loading=false,networkBlocked=false,lastRequest=-Infinity;
  const loadingPlaylist=()=>{loading=true;lastRequest=performance.now();};
  const loadedPlaylist=()=>{loading=false;networkBlocked=false;};
  const onError=(_event:typeof Engine.Events.ERROR,data:ErrorData)=>{
    if(data.type===Engine.ErrorTypes.NETWORK_ERROR){loading=false;networkBlocked=true;}
    else if(data.fatal)stop();
  };
  const tick=()=>{
    if(!owns()||hls.media!==video){stop();return;}
    const level=hls.loadLevelObj,details=level?.details;
    if(details&&!details.live){stop();return;}
    if(!level||!details||video.paused||video.ended||video.seeking||loading||networkBlocked||performance.now()-lastRequest<1000)return;
    const time=video.currentTime;
    if(!Number.isFinite(time))return;
    let lead=0;
    for(let i=0;i<video.buffered.length;i++){
      if(time>=video.buffered.start(i)&&time<=video.buffered.end(i)){lead=video.buffered.end(i)-time;break;}
    }
    if(lead===0&&video.readyState<1)return;
    const threshold=Math.min(30,Math.max(10,details.targetduration+2));
    if(lead>=threshold)return;
    const index=hls.levels.indexOf(level);
    if(index<0)return;
    // LEVEL_LOADING uses the engine's existing playlist loader and parser while
    // preserving the current source, SourceBuffers and in-flight fragments.
    hls.trigger(Engine.Events.LEVEL_LOADING,{url:level.uri,level:index,levelInfo:level,pathwayId:level.attrs["PATHWAY-ID"],id:0,deliveryDirectives:null});
  };
  const timer=setInterval(tick,1000);
  function stop(){
    if(!active)return;
    active=false;clearInterval(timer);
    hls.off(Engine.Events.LEVEL_LOADING,loadingPlaylist);
    hls.off(Engine.Events.LEVEL_LOADED,loadedPlaylist);
    hls.off(Engine.Events.ERROR,onError);
  }
  hls.on(Engine.Events.LEVEL_LOADING,loadingPlaylist);
  hls.on(Engine.Events.LEVEL_LOADED,loadedPlaylist);
  hls.on(Engine.Events.ERROR,onError);
  return stop;
}
