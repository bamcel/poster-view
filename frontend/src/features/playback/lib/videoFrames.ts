// Audio can advance the media clock while video decoding has stopped. Observe
// presented frames independently, and abandon callbacks from replaced sources.
export function createVideoFrameMonitor() {
  let cleanup=()=>{};
  let lastFrameAt=0,lastMediaTime=-1,supported=false;
  let pollCounter:(()=>number)|undefined,lastCounter=0;
  return {
    reset(video:HTMLVideoElement,target:number,isCurrent:()=>boolean) {
      cleanup();lastFrameAt=Date.now();lastMediaTime=-1;pollCounter=undefined;
      let active=true,callback:number|undefined;
      supported=typeof video.requestVideoFrameCallback==="function";
      if(supported){
        const frame:VideoFrameRequestCallback=(_now,metadata)=>{
          if(!active||!isCurrent())return;
          if(metadata.mediaTime>=target-1&&Math.abs(metadata.mediaTime-video.currentTime)<2&&metadata.mediaTime>lastMediaTime){lastMediaTime=metadata.mediaTime;lastFrameAt=Date.now();}
          callback=video.requestVideoFrameCallback(frame);
        };
        callback=video.requestVideoFrameCallback(frame);
      }else if(typeof video.getVideoPlaybackQuality==="function"){
        pollCounter=()=>{const quality=video.getVideoPlaybackQuality();return Math.max(0,quality.totalVideoFrames-quality.droppedVideoFrames);};
        lastCounter=pollCounter();supported=true;
      }
      cleanup=()=>{active=false;if(callback!==undefined&&typeof video.cancelVideoFrameCallback==="function")video.cancelVideoFrameCallback(callback);};
    },
    stalled(video:HTMLVideoElement,suspended:boolean,seconds:number) {
      const now=Date.now();
      // Hidden/offscreen browsers may intentionally suspend frame presentation.
      const rect=video.getBoundingClientRect();
      const offscreen=rect.width>0&&rect.height>0&&(rect.bottom<=0||rect.right<=0||rect.top>=window.innerHeight||rect.left>=window.innerWidth);
      if(suspended||document.hidden||offscreen){lastFrameAt=now;if(pollCounter)lastCounter=pollCounter();return false;}
      if(pollCounter){const count=pollCounter();if(count!==lastCounter){lastCounter=count;lastFrameAt=now;}}
      return supported&&now-lastFrameAt>=seconds*1000;
    },
    destroy(){cleanup();supported=false;pollCounter=undefined;},
  };
}
