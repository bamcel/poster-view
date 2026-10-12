import {describe,expect,it} from "vitest";
import {canSeekInCurrentSource,containsMediaTime} from "./seek";

const ranges=(...values:[number,number][])=>({length:values.length,start:(index:number)=>values[index][0],end:(index:number)=>values[index][1]});
describe("seeking in the current source",()=>{
  it("checks individual buffered ranges rather than treating gaps as buffered",()=>{
    const video={buffered:ranges([0,20],[40,60]),seekable:ranges()};
    expect(canSeekInCurrentSource(video,345,290,false,[])).toBe(true);
    expect(canSeekInCurrentSource(video,320,290,false,[])).toBe(false);
    expect(canSeekInCurrentSource(video,350,290,false,[])).toBe(false);
  });
  it("uses retained non-gap HLS fragments with source offsets",()=>{
    const video={buffered:ranges(),seekable:ranges([0,200])},fragments=[{start:20,end:30},{start:30,end:40,gap:true},{start:40,end:50}];
    expect(canSeekInCurrentSource(video,315,290,false,fragments)).toBe(true);
    expect(canSeekInCurrentSource(video,325,290,false,fragments)).toBe(false);
    expect(canSeekInCurrentSource(video,295,290,false,fragments)).toBe(false);
  });
  it("uses finite native HLS seekable ranges and allows HTTP range seeking for direct files",()=>{
    const video={buffered:ranges(),seekable:ranges([15,40],[100,Infinity])};
    expect(canSeekInCurrentSource(video,320,290,false,null)).toBe(true);
    expect(canSeekInCurrentSource(video,420,290,false,null)).toBe(false);
    expect(canSeekInCurrentSource(video,900,0,true,null)).toBe(true);
    expect(canSeekInCurrentSource(video,280,290,false,null)).toBe(false);
  });
  it("rejects invalid times and handles a disappearing live range",()=>{
    expect(containsMediaTime(ranges([0,10]),NaN)).toBe(false);
    expect(containsMediaTime({length:1,start:()=>{throw new Error("retired");},end:()=>10},5)).toBe(false);
  });
  it("rejects stale unbuffered playlist prefixes while retaining browser-buffered backward seeks",()=>{
    const video={buffered:ranges([10,20]),seekable:ranges([0,200])},fragments=[{start:0,end:200}];
    expect(canSeekInCurrentSource(video,315,290,false,fragments,350)).toBe(false);
    expect(canSeekInCurrentSource(video,305,290,false,fragments,350)).toBe(true);
    expect(canSeekInCurrentSource(video,355,290,false,fragments,350)).toBe(true);
  });
});
