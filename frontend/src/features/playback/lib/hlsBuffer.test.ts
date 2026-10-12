import {describe,expect,it} from "vitest";
import type {PlaybackInfo} from "../types";
import {hlsBufferOptions} from "./hlsBuffer";

const info=(bitrate?:number):PlaybackInfo=>({title:"Episode",duration_seconds:1200,chapters:[],tracks:[{index:0,kind:"video",codec:"hevc",bitrate},{index:1,kind:"audio",codec:"opus",channels:2,bitrate:128_000}]});
describe("HLS buffer targets",()=>{
  it("keeps sixty seconds ahead for stream-copy sources that fit the estimated byte budget",()=>{
    expect(hlsBufferOptions(info(3_000_000),"audio_transcode",1)).toEqual({maxBufferLength:60,maxMaxBufferLength:60,backBufferLength:20,maxBufferSize:60_000_000});
  });
  it("reduces both time targets for high bitrate video instead of buffering a large sixty-second 4K window",()=>{
    const result=hlsBufferOptions(info(80_000_000),"remux",1);
    expect(result.maxBufferLength).toBeLessThan(5);expect(result.maxMaxBufferLength).toBe(result.maxBufferLength);expect(result.backBufferLength).toBeLessThan(2);
    expect((result.maxBufferLength+result.backBufferLength)*80_128_000/8).toBeLessThan(48_000_000);
  });
  it("keeps a conservative thirty seconds for unknown or converted output bitrate",()=>{
    expect(hlsBufferOptions(info(),"remux",1).maxBufferLength).toBe(30);
    expect(hlsBufferOptions(info(NaN),"audio_transcode",1).maxMaxBufferLength).toBe(30);
    expect(hlsBufferOptions(info(3_000_000),"transcode",1).maxMaxBufferLength).toBe(30);
  });
});
