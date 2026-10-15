import {act,cleanup,render,screen} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import PlaybackStatistics from "./PlaybackStatistics";
import type {PlaybackSession} from "../types";

afterEach(()=>{cleanup();vi.useRealTimers();});
const session:PlaybackSession={id:"one",method:"remux",reason:"Container compatibility",url:"/stream",mime:"application/vnd.apple.mpegurl",offset_seconds:120,duration_seconds:600};
function video(){
  const element=document.createElement("video");
  Object.defineProperties(element,{
    buffered:{value:{length:2,start:(index:number)=>[0,40][index],end:(index:number)=>[20,80][index]}},
    readyState:{value:4},networkState:{value:2},videoWidth:{value:1920},videoHeight:{value:1080},
    getVideoPlaybackQuality:{configurable:true,value:vi.fn(()=>({droppedVideoFrames:3,totalVideoFrames:500}))},
  });
  element.currentTime=5;return element;
}
it("reports contiguous buffer ahead, absolute source ranges and browser diagnostics",()=>{
  render(<PlaybackStatistics video={video()} active session={session}/>);
  for(const value of ["15.0 seconds","2:00–2:20, 2:40–3:20","Enough data","Loading","1920×1080","3 dropped / 500 total","1×"])
    expect(screen.getByText(value)).toBeTruthy();
});
it("does not count a disconnected future range as playable buffer",()=>{
  const element=video();element.currentTime=30;
  render(<PlaybackStatistics video={element} active session={session}/>);
  expect(screen.getByText("0.0 seconds")).toBeTruthy();
});
it("polls only while visible and stops on close and unmount",()=>{
  vi.useFakeTimers();const element=video();const quality=element.getVideoPlaybackQuality;
  const view=render(<PlaybackStatistics video={element} active={false} session={session}/>);
  expect(quality).not.toHaveBeenCalled();
  view.rerender(<PlaybackStatistics video={element} active session={session}/>);
  expect(quality).toHaveBeenCalledTimes(1);
  element.currentTime=10;act(()=>vi.advanceTimersByTime(1000));
  expect(screen.getByText("10.0 seconds")).toBeTruthy();
  view.rerender(<PlaybackStatistics video={element} active={false} session={session}/>);
  act(()=>vi.advanceTimersByTime(3000));expect(quality).toHaveBeenCalledTimes(2);
  view.rerender(<PlaybackStatistics video={element} active session={session}/>);
  view.unmount();act(()=>vi.advanceTimersByTime(3000));expect(quality).toHaveBeenCalledTimes(3);
});
it("handles browsers without frame quality support and missing metadata",()=>{
  const element=document.createElement("video");
  Object.defineProperty(element,"getVideoPlaybackQuality",{value:undefined});
  render(<PlaybackStatistics video={element} active session={undefined}/>);
  expect(screen.getByText("None")).toBeTruthy();
  expect(screen.getByText("No media data")).toBeTruthy();
  expect(screen.getAllByText("Unavailable")).toHaveLength(2);
});
