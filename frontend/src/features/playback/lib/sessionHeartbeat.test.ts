import {describe,expect,it,vi} from "vitest";
import {createSessionHeartbeatQueue} from "./sessionHeartbeat";

const flush=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve();};
describe("session heartbeat queue",()=>{
  it("orders requests and coalesces pending updates to the latest playback state",async()=>{
    const complete:(()=>void)[]=[];
    const send=vi.fn(()=>new Promise<void>(resolve=>complete.push(resolve))),queue=createSessionHeartbeatQueue(send);
    queue.request("one",50,true);queue.request("one",80,true);queue.request("one",80,false);
    expect(send.mock.calls).toEqual([["one",50,true]]);
    complete[0]();await flush();expect(send.mock.calls).toEqual([["one",50,true],["one",80,false]]);
    complete[1]();await flush();queue.request("one",80,false);expect(send).toHaveBeenCalledTimes(3);
  });
  it("drops an unsent intermediate Pause when the latest state equals the in-flight Play",async()=>{
    let complete!:()=>void;const send=vi.fn(()=>new Promise<void>(resolve=>{complete=resolve;})),queue=createSessionHeartbeatQueue(send);
    queue.request("one",50,false);queue.request("one",50,true);queue.request("one",50,false);complete();await flush();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("forgets stopped jobs without delaying heartbeats for their replacement",async()=>{
    const complete:(()=>void)[]=[];const send=vi.fn(()=>new Promise<void>(resolve=>complete.push(resolve))),queue=createSessionHeartbeatQueue(send);
    queue.request("old",50,true);queue.request("old",80,false);queue.forget("old");queue.request("new",80,false);
    expect(send.mock.calls).toEqual([["old",50,true],["new",80,false]]);complete[0]();await flush();expect(send).toHaveBeenCalledTimes(2);
    queue.request("new",90,true);queue.clear();complete[1]();await flush();expect(send).toHaveBeenCalledTimes(2);
  });
  it("continues with the latest update after a request fails",async()=>{
    let reject!:(error:Error)=>void;
    const send=vi.fn().mockImplementationOnce(()=>new Promise<void>((_resolve,rejected)=>{reject=rejected;})).mockResolvedValue(undefined),queue=createSessionHeartbeatQueue(send);
    queue.request("one",50,true);queue.request("one",80,false);reject(new Error("temporary"));await flush();
    expect(send).toHaveBeenLastCalledWith("one",80,false);
  });
});
