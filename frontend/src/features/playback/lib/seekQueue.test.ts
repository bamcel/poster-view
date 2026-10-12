import {describe,it,expect,vi} from "vitest";
import {createPlaybackSeekQueue} from "./seekQueue";
import type {PlaybackSession} from "../types";
const session:PlaybackSession={id:"one",generation:1,method:"remux",url:"/hls/1/index.m3u8",offset_seconds:300,duration_seconds:1200,mime:"application/vnd.apple.mpegurl",reason:"Copy"};
describe("same-session seek ordering",()=>{
 it("coalesces rapid targets while advancing the backend generation before the next request",async()=>{
  let finish!:(value:PlaybackSession)=>void;const send=vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValue({...session,generation:3,url:"/hls/3/index.m3u8"});const queue=createPlaybackSeekQueue(send);queue.reset(session);
  const first=queue.request(600),superseded=queue.request(700),latest=queue.request(900,4);expect(await superseded).toBeNull();expect(send).toHaveBeenCalledTimes(1);finish({...session,generation:2});expect(await first).toBeNull();expect((await latest)?.generation).toBe(3);expect(send).toHaveBeenLastCalledWith("one",{position_seconds:900,generation:2,audio_index:4});
 });
 it("accepts a retained generation without forcing a source replacement",async()=>{
  const send=vi.fn().mockResolvedValue(session),queue=createPlaybackSeekQueue(send);queue.reset(session);expect(await queue.request(310)).toBe(session);
 });
 it("drops responses from a disposed session and does not advance the next item's generation",async()=>{
  let finish!:(value:PlaybackSession)=>void;const send=vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValue({...session,id:"two",generation:1});const queue=createPlaybackSeekQueue(send);queue.reset(session);const old=queue.request(700);queue.reset({...session,id:"two",generation:0});const fresh=queue.request(400);finish({...session,generation:5});expect(await old).toBeNull();expect((await fresh)?.id).toBe("two");expect(send).toHaveBeenLastCalledWith("two",{position_seconds:400,generation:0});
 });
});
