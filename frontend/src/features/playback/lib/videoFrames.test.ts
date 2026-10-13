import {afterEach,expect,it,vi} from "vitest";
import {createVideoFrameMonitor} from "./videoFrames";
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
function setup(){
  vi.useFakeTimers();
  const video=document.createElement("video"),callbacks:VideoFrameRequestCallback[]=[];
  video.requestVideoFrameCallback=vi.fn(callback=>{callbacks.push(callback);return callbacks.length;});
  video.cancelVideoFrameCallback=vi.fn();
  const monitor=createVideoFrameMonitor();
  return {video,callbacks,monitor,frame(time:number){video.currentTime=time;callbacks.at(-1)!(0,{mediaTime:time} as VideoFrameCallbackMetadata);}};
}
it("detects absent presented frames despite an advancing audio clock",()=>{
  const {video,monitor}=setup();monitor.reset(video,900,()=>true);
  for(let seconds=0;seconds<8;seconds++){video.currentTime=900+seconds;vi.advanceTimersByTime(1000);}
  expect(monitor.stalled(video,false,8)).toBe(true);monitor.destroy();
});
it("keeps healthy presented frames alive and rearms every seek",()=>{
  const {video,monitor,frame}=setup();monitor.reset(video,900,()=>true);
  for(let seconds=0;seconds<40;seconds++){vi.advanceTimersByTime(1000);frame(900+seconds);expect(monitor.stalled(video,false,8)).toBe(false);}
  monitor.reset(video,100,()=>true);vi.advanceTimersByTime(8000);expect(monitor.stalled(video,false,8)).toBe(true);monitor.destroy();
});
it("ignores old target and replaced source callbacks",()=>{
  const {video,monitor,callbacks}=setup();let owned=true;monitor.reset(video,900,()=>owned);const old=callbacks[0];
  monitor.reset(video,600,()=>true);video.currentTime=600;vi.advanceTimersByTime(7000);
  old(0,{mediaTime:600} as VideoFrameCallbackMetadata);
  callbacks.at(-1)!(0,{mediaTime:300} as VideoFrameCallbackMetadata);
  vi.advanceTimersByTime(1000);expect(monitor.stalled(video,false,8)).toBe(true);
  owned=false;monitor.destroy();expect(video.cancelVideoFrameCallback).toHaveBeenCalled();
});
it("suspends paused, hidden and offscreen playback deadlines",()=>{
  const {video,monitor}=setup();monitor.reset(video,0,()=>true);
  vi.advanceTimersByTime(9000);expect(monitor.stalled(video,true,8)).toBe(false);
  vi.spyOn(document,"hidden","get").mockReturnValue(true);vi.advanceTimersByTime(9000);expect(monitor.stalled(video,false,8)).toBe(false);
  vi.spyOn(document,"hidden","get").mockReturnValue(false);
  vi.spyOn(video,"getBoundingClientRect").mockReturnValue({width:100,height:100,top:10000,left:0,bottom:10100,right:100} as DOMRect);
  vi.advanceTimersByTime(9000);expect(monitor.stalled(video,false,8)).toBe(false);monitor.destroy();
});
it("uses presented quality counts when callbacks are unavailable, and stays neutral without either API",()=>{
  vi.useFakeTimers();const video=document.createElement("video");let frames=0;
  video.getVideoPlaybackQuality=()=>({totalVideoFrames:frames,droppedVideoFrames:0} as VideoPlaybackQuality);
  const monitor=createVideoFrameMonitor();monitor.reset(video,0,()=>true);
  vi.advanceTimersByTime(7000);frames++;expect(monitor.stalled(video,false,8)).toBe(false);
  vi.advanceTimersByTime(8000);expect(monitor.stalled(video,false,8)).toBe(true);
  Object.defineProperty(video,"getVideoPlaybackQuality",{value:undefined});monitor.reset(video,0,()=>true);
  vi.advanceTimersByTime(40000);expect(monitor.stalled(video,false,8)).toBe(false);monitor.destroy();
});
