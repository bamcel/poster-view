// Retain one bounded video-only frame across a source replacement. Capturing
// happens before resetting the media element, never on the progress hot path.
export function createHeldVideoFrame(canvas:()=>HTMLCanvasElement|null,visible:(held:boolean)=>void){
  let held=false,cancel=()=>{};
  const clear=()=>{cancel();cancel=()=>{};held=false;const surface=canvas();if(surface){surface.width=0;surface.height=0;}visible(false);};
  return {
    capture(video:HTMLVideoElement){
      if(held||video.readyState<2||video.videoWidth<=0||video.videoHeight<=0)return;
      const surface=canvas();if(!surface)return;
      const scale=Math.min(1,1920/video.videoWidth,1080/video.videoHeight);
      surface.width=Math.max(1,Math.round(video.videoWidth*scale));surface.height=Math.max(1,Math.round(video.videoHeight*scale));
      try{const context=surface.getContext("2d");if(!context)return;context.drawImage(video,0,0,surface.width,surface.height);held=true;visible(true);}catch{clear();}
    },
    awaitFrame(video:HTMLVideoElement,target:number,isCurrent:()=>boolean){
      cancel();if(!held||typeof video.requestVideoFrameCallback!=="function")return;
      let active=true,id:number;
      const frame:VideoFrameRequestCallback=(_now,metadata)=>{
        if(!active||!isCurrent())return;
        if(metadata.mediaTime>=target-1&&Math.abs(metadata.mediaTime-video.currentTime)<2){clear();return;}
        id=video.requestVideoFrameCallback(frame);
      };
      id=video.requestVideoFrameCallback(frame);
      cancel=()=>{active=false;if(typeof video.cancelVideoFrameCallback==="function")video.cancelVideoFrameCallback(id);};
    },
    decoded(video:HTMLVideoElement){if(held&&typeof video.requestVideoFrameCallback!=="function"&&video.readyState>=2&&video.videoWidth>0&&video.videoHeight>0)clear();},
    clear,
  };
}
