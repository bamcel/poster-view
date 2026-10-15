import {act,renderHook,waitFor} from "@testing-library/react";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {usePreviewStoryboard} from "./usePreviewStoryboard";

const prefix="/api/playback/native/library/item";
const manifest=(count=1)=>({interval:10,width:240,height:136,columns:6,frames_per_sheet:30,complete:true,sheets:Array.from({length:count},(_,index)=>({index,url:`${prefix}/preview-sheet/${index}`}))});
describe("prepared playback storyboards",()=>{
  let fetchMock:ReturnType<typeof vi.fn>,decode:ReturnType<typeof vi.fn>;
  beforeEach(()=>{
    decode=vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("Image",class {src="";naturalWidth=1440;naturalHeight=680;decode=decode;});
    vi.stubGlobal("URL",class extends URL {static createObjectURL=vi.fn().mockReturnValue("blob:sheet");static revokeObjectURL=vi.fn();});
    fetchMock=vi.fn().mockImplementation(async(url:string)=>url.endsWith("preview-storyboard")?{ok:true,json:async()=>manifest()}:{ok:true,headers:new Headers(),blob:async()=>new Blob(["sheet"],{type:"image/jpeg"})});
    vi.stubGlobal("fetch",fetchMock);
  });
  afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
  it("preloads and decodes before hover, and reuses one sheet for many frames",async()=>{
    const {result,unmount}=renderHook(()=>usePreviewStoryboard("library","item",1400,0));
    expect(result.current.frame(70)).toBeNull();
    await waitFor(()=>expect(result.current.frame(70)).not.toBeNull());
    expect(result.current.frame(70)).toMatchObject({x:240,y:136,width:240,height:136,columns:6,rows:5});
    result.current.frame(130);result.current.frame(290);
    expect(fetchMock).toHaveBeenCalledTimes(2);expect(decode).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({priority:"low"});
    unmount();expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:sheet");
  });
  it("clears account-owned images and aborts the old request on account change",async()=>{
    const {result,rerender}=renderHook(({revision})=>usePreviewStoryboard("library","item",1400,revision),{initialProps:{revision:0}});
    await waitFor(()=>expect(result.current.frame(0)).not.toBeNull());
    const signal=fetchMock.mock.calls[0][1].signal;
    fetchMock.mockImplementation(()=>new Promise(()=>{}));
    rerender({revision:1});
    expect(result.current.frame(0)).toBeNull();expect(signal.aborted).toBe(true);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:sheet");
  });
  it("rejects untrusted sheet URLs without fetching them",async()=>{
    fetchMock.mockResolvedValue({ok:true,json:async()=>({...manifest(),sheets:[{index:0,url:"https://other.example/image.jpg"}]})});
    const {result}=renderHook(()=>usePreviewStoryboard("library","item",1400,0));
    await act(async()=>{});
    expect(fetchMock).toHaveBeenCalledTimes(1);expect(result.current.frame(0)).toBeNull();
  });
  it("caps decoded sheet count and ignores out-of-range frame requests",async()=>{
    fetchMock.mockImplementation(async(url:string)=>url.endsWith("preview-storyboard")?{ok:true,json:async()=>manifest(10)}:{ok:true,headers:new Headers(),blob:async()=>new Blob(["sheet"],{type:"image/jpeg"})});
    const {result}=renderHook(()=>usePreviewStoryboard("library","item",3000,0));
    await waitFor(()=>expect(decode).toHaveBeenCalledTimes(8));
    expect(fetchMock).toHaveBeenCalledTimes(9);expect(result.current.frame(2500)).toBeNull();
    expect(result.current.frame(NaN)).toBeNull();expect(result.current.frame(-1)).toBeNull();
  });
  it("stops polling when the endpoint is unavailable",async()=>{
    vi.useFakeTimers();fetchMock.mockResolvedValue({ok:false,status:404,statusText:"Not Found",json:async()=>({})});
    renderHook(()=>usePreviewStoryboard("library","item",1400,0));
    await act(async()=>{await vi.advanceTimersByTimeAsync(30000);});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("loads a distant target with bounded eviction and does not refetch for cached hover",async()=>{
    fetchMock.mockImplementation(async(url:string)=>url.endsWith("preview-storyboard")?{ok:true,json:async()=>manifest(10)}:{ok:true,headers:new Headers(),blob:async()=>new Blob(["sheet"],{type:"image/jpeg"})});
    const {result,rerender}=renderHook(({target})=>usePreviewStoryboard("library","item",3000,0,target),{initialProps:{target:null as number|null}});
    await waitFor(()=>expect(decode).toHaveBeenCalledTimes(8));
    rerender({target:2750});
    await waitFor(()=>expect(result.current.frame(2750)).not.toBeNull());
    expect(decode).toHaveBeenCalledTimes(9);expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(result.current.frame(0)).toBeNull();
    const count=fetchMock.mock.calls.length;rerender({target:2760});await act(async()=>{});
    expect(fetchMock).toHaveBeenCalledTimes(count);
  });
  it("preloads the current distant resume position before the beginning of a movie",async()=>{
    fetchMock.mockImplementation(async(url:string)=>url.endsWith("preview-storyboard")?{ok:true,json:async()=>manifest(10)}:{ok:true,headers:new Headers(),blob:async()=>new Blob(["sheet"],{type:"image/jpeg"})});
    const {result}=renderHook(()=>usePreviewStoryboard("library","item",3000,0,2750));
    await waitFor(()=>expect(result.current.frame(2750)).not.toBeNull());
    expect(fetchMock.mock.calls[1][0]).toBe(`${prefix}/preview-sheet/9`);
  });
  it("rejects oversized images before decode",async()=>{
    fetchMock.mockImplementation(async(url:string)=>url.endsWith("preview-storyboard")?{ok:true,json:async()=>manifest()}:{ok:true,headers:new Headers({"Content-Length":"3000000"}),blob:vi.fn()});
    const {result}=renderHook(()=>usePreviewStoryboard("library","item",1400,0));
    await act(async()=>{});expect(decode).not.toHaveBeenCalled();expect(result.current.frame(0)).toBeNull();
  });
  it("does not request a manifest on every pointer movement within an unprepared sheet",async()=>{
    fetchMock.mockImplementation(async()=>({ok:true,json:async()=>({...manifest(),complete:false,sheets:[]})}));
    const {rerender}=renderHook(({target})=>usePreviewStoryboard("library","item",3000,0,target),{initialProps:{target:null as number|null}});
    await act(async()=>{});
    rerender({target:2750});await act(async()=>{});
    const count=fetchMock.mock.calls.length;
    for(const target of [2751,2752,2753,2760])rerender({target});
    await act(async()=>{});expect(fetchMock).toHaveBeenCalledTimes(count);
  });
});
