import {afterEach,expect,it,vi} from "vitest";
import {createHeldVideoFrame} from "./heldVideoFrame";
afterEach(()=>vi.restoreAllMocks());
function setup(){
  const surface=document.createElement("canvas"),video=document.createElement("video"),visible=vi.fn(),draw=vi.fn();
  vi.spyOn(surface,"getContext").mockReturnValue({drawImage:draw} as unknown as CanvasRenderingContext2D);
  Object.defineProperties(video,{readyState:{value:4,configurable:true},videoWidth:{value:3840,configurable:true},videoHeight:{value:2160,configurable:true}});
  const held=createHeldVideoFrame(()=>surface,visible);return {surface,video,visible,draw,held};
}
it("captures one bounded previous frame and does not redraw while a source waits",()=>{
  const {surface,video,visible,draw,held}=setup();held.capture(video);held.capture(video);
  expect(surface.width).toBe(1920);expect(surface.height).toBe(1080);expect(draw).toHaveBeenCalledTimes(1);expect(visible).toHaveBeenLastCalledWith(true);
  held.clear();expect(surface.width).toBe(0);expect(visible).toHaveBeenLastCalledWith(false);
});
it("keeps the frame until the current target is presented and ignores stale source callbacks",()=>{
  const {video,visible,held}=setup();const callbacks:VideoFrameRequestCallback[]=[];
  video.requestVideoFrameCallback=vi.fn(callback=>{callbacks.push(callback);return callbacks.length;});video.cancelVideoFrameCallback=vi.fn();
  held.capture(video);held.awaitFrame(video,600,()=>true);const old=callbacks[0];held.awaitFrame(video,900,()=>true);
  video.currentTime=900;old(0,{mediaTime:900} as VideoFrameCallbackMetadata);expect(visible).toHaveBeenLastCalledWith(true);
  callbacks.at(-1)!(0,{mediaTime:600} as VideoFrameCallbackMetadata);expect(visible).toHaveBeenLastCalledWith(true);
  callbacks.at(-1)!(0,{mediaTime:900} as VideoFrameCallbackMetadata);expect(visible).toHaveBeenLastCalledWith(false);
  expect(video.cancelVideoFrameCallback).toHaveBeenCalled();
});
it("falls back to a decoded settled frame when presentation callbacks are unavailable",()=>{
  const {video,visible,held}=setup();held.capture(video);
  Object.defineProperty(video,"readyState",{value:1});held.decoded(video);expect(visible).toHaveBeenLastCalledWith(true);
  Object.defineProperty(video,"readyState",{value:2});held.decoded(video);expect(visible).toHaveBeenLastCalledWith(false);
});
it("does not hold metadata-only media and tolerates unavailable canvas capture",()=>{
  const {video,draw,visible,held}=setup();Object.defineProperty(video,"readyState",{value:1});held.capture(video);expect(draw).not.toHaveBeenCalled();
  Object.defineProperty(video,"readyState",{value:4});draw.mockImplementation(()=>{throw new Error("Unavailable decoded surface");});held.capture(video);expect(visible).toHaveBeenLastCalledWith(false);
});
