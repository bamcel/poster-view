import Hls from "hls.js";
import {afterEach,describe,expect,it,vi} from "vitest";
import {watchRemuxPlaylistRefresh} from "./remuxPlaylistRefresh";

function fixture(){
  vi.useFakeTimers();
  const video=document.createElement("video");
  let playing=true,ended=false,seeking=false,ready=4,time=20,end=25,current=true;
  Object.defineProperties(video,{
    paused:{get:()=>!playing},ended:{get:()=>ended},seeking:{get:()=>seeking},readyState:{get:()=>ready},
    currentTime:{get:()=>time},buffered:{get:()=>({length:1,start:()=>10,end:()=>end})},
  });
  const details={live:true,targetduration:60,requestScheduled:performance.now()+60_000};
  const level={uri:"/copy/index.m3u8",attrs:{},details};
  const listeners=new Map<string,Set<(...args:unknown[])=>void>>();
  const on=vi.fn((name:string,callback:(...args:unknown[])=>void)=>{
    if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name)!.add(callback);
  });
  const off=vi.fn((name:string,callback:(...args:unknown[])=>void)=>listeners.get(name)?.delete(callback));
  const trigger=vi.fn((name:string,data:unknown)=>{for(const callback of [...listeners.get(name)??[]])callback(name,data);return true;});
  const startLoad=vi.fn(),stopLoad=vi.fn(),loadSource=vi.fn();
  const fake={media:video,loadLevelObj:level,levels:[level],on,off,trigger,startLoad,stopLoad,loadSource};
  const stop=watchRemuxPlaylistRefresh(fake as unknown as Hls,Hls,video,()=>current);
  return {video,details,level,fake,listeners,stop,trigger,startLoad,stopLoad,loadSource,
    state:(changes:{playing?:boolean;ended?:boolean;seeking?:boolean;ready?:number;time?:number;end?:number;current?:boolean})=>{
      playing=changes.playing??playing;ended=changes.ended??ended;seeking=changes.seeking??seeking;ready=changes.ready??ready;
      time=changes.time??time;end=changes.end??end;current=changes.current??current;
    }};
}
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();});

describe("copied playlist refill watchdog",()=>{
  it("refreshes a low live buffer before the ordinary reload deadline without resetting media loading",()=>{
    const f=fixture();vi.advanceTimersByTime(1000);
    expect(f.trigger).toHaveBeenCalledExactlyOnceWith(Hls.Events.LEVEL_LOADING,{url:f.level.uri,level:0,levelInfo:f.level,pathwayId:undefined,id:0,deliveryDirectives:null});
    expect(f.details.requestScheduled).toBeGreaterThan(performance.now());
    expect(f.startLoad).not.toHaveBeenCalled();expect(f.stopLoad).not.toHaveBeenCalled();expect(f.loadSource).not.toHaveBeenCalled();
    expect(f.fake.media).toBe(f.video);f.stop();
  });
  it("does not overlap automatic or watchdog requests and throttles successful reloads",()=>{
    const f=fixture();f.trigger(Hls.Events.LEVEL_LOADING,{});vi.advanceTimersByTime(3000);expect(f.trigger).toHaveBeenCalledTimes(1);
    f.trigger(Hls.Events.LEVEL_LOADED,{});vi.advanceTimersByTime(1000);expect(f.trigger).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(4000);expect(f.trigger).toHaveBeenCalledTimes(3);
    f.trigger(Hls.Events.LEVEL_LOADED,{});vi.advanceTimersByTime(1000);expect(f.trigger).toHaveBeenCalledTimes(5);f.stop();
  });
  it.each([false,true])("lets the engine own network retry after fatal=%s errors",fatal=>{
    const f=fixture();vi.advanceTimersByTime(1000);f.trigger(Hls.Events.ERROR,{type:Hls.ErrorTypes.NETWORK_ERROR,fatal});
    const calls=f.trigger.mock.calls.length;vi.advanceTimersByTime(60_000);expect(f.trigger).toHaveBeenCalledTimes(calls);
    f.trigger(Hls.Events.LEVEL_LOADED,{});vi.advanceTimersByTime(1000);expect(f.trigger).toHaveBeenCalledTimes(calls+2);f.stop();
  });
  it("does not refresh adequate buffers, paused, ended or actively seeking media",()=>{
    const f=fixture();f.state({end:51});vi.advanceTimersByTime(1000);expect(f.trigger).not.toHaveBeenCalled();
    f.state({end:25,playing:false});vi.advanceTimersByTime(1000);
    f.state({playing:true,ended:true});vi.advanceTimersByTime(1000);
    f.state({ended:false,seeking:true});vi.advanceTimersByTime(1000);expect(f.trigger).not.toHaveBeenCalled();f.stop();
  });
  it("uses a ten-second floor and thirty-second ceiling for reload headroom",()=>{
    const f=fixture();f.details.targetduration=2;f.state({end:30});vi.advanceTimersByTime(1000);expect(f.trigger).not.toHaveBeenCalled();
    f.state({end:29});vi.advanceTimersByTime(1000);expect(f.trigger).toHaveBeenCalledTimes(1);f.stop();
  });
  it("refreshes an exhausted buffer once metadata exists but not before",()=>{
    const f=fixture();f.state({time:30,ready:0});vi.advanceTimersByTime(1000);expect(f.trigger).not.toHaveBeenCalled();
    f.state({ready:1});vi.advanceTimersByTime(1000);expect(f.trigger).toHaveBeenCalledTimes(1);f.stop();
  });
  it.each(["destroy","ownership","detached","complete","fatalMedia"])("cleans up interval and listeners after %s",reason=>{
    const f=fixture();
    if(reason==="destroy")f.stop();
    else if(reason==="ownership")f.state({current:false});
    else if(reason==="detached")f.fake.media=document.createElement("video");
    else if(reason==="complete")f.details.live=false;
    else f.trigger(Hls.Events.ERROR,{type:Hls.ErrorTypes.MEDIA_ERROR,fatal:true});
    vi.advanceTimersByTime(1000);const calls=f.trigger.mock.calls.length;
    expect(vi.getTimerCount()).toBe(0);expect([...f.listeners.values()].every(set=>set.size===0)).toBe(true);
    vi.advanceTimersByTime(5000);expect(f.trigger).toHaveBeenCalledTimes(calls);f.stop();
  });
});
