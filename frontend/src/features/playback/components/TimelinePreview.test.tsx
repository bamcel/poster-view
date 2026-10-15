import {act,cleanup,render,screen} from "@testing-library/react";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import TimelinePreview from "./TimelinePreview";
const props={library:"a",item:"one",duration:1000};
const advance=async(ms=120)=>{await act(async()=>{await vi.advanceTimersByTimeAsync(ms);});};
const success=(size=4)=>({ok:true,status:200,blob:async()=>new Blob([new Uint8Array(size)])}) as Response;
beforeEach(()=>{
 vi.useFakeTimers();vi.stubGlobal("fetch",vi.fn().mockResolvedValue(success()));let serial=0;
 vi.spyOn(URL,"createObjectURL").mockImplementation(()=>`blob:${++serial}`);vi.spyOn(URL,"revokeObjectURL").mockImplementation(()=>{});
});
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
it("debounces deliberate inspection to the latest quantized target",async()=>{
 const view=render(<TimelinePreview {...props} seconds={null}/>);await advance(1000);expect(fetch).not.toHaveBeenCalled();
 view.rerender(<TimelinePreview {...props} seconds={19}/>);await advance(119);
 view.rerender(<TimelinePreview {...props} seconds={29}/>);await advance(119);expect(fetch).not.toHaveBeenCalled();await advance(1);
 expect(fetch).toHaveBeenCalledWith("/api/playback/native/a/one/preview?seconds=20",expect.objectContaining({signal:expect.any(AbortSignal)}));
 view.rerender(<TimelinePreview {...props} seconds={28}/>);await advance(1000);expect(fetch).toHaveBeenCalledTimes(1);
});
it("reuses cached frames immediately across bucket revisits and reentry",async()=>{
 const view=render(<TimelinePreview {...props} seconds={15}/>);await advance();
 view.rerender(<TimelinePreview {...props} seconds={85}/>);expect(screen.queryByRole("img")).toBeNull();await advance();
 view.rerender(<TimelinePreview {...props} seconds={15}/>);expect(screen.getByRole("img").getAttribute("src")).toBe("blob:1");
 view.rerender(<TimelinePreview {...props} seconds={null}/>);expect(URL.revokeObjectURL).not.toHaveBeenCalled();
 view.rerender(<TimelinePreview {...props} seconds={15}/>);expect(screen.getByRole("img")).toBeTruthy();expect(fetch).toHaveBeenCalledTimes(2);
 view.unmount();expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
});
it("aborts superseded work and ignores late responses",async()=>{
 let resolve!:(value:Response)=>void;vi.mocked(fetch).mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
 const view=render(<TimelinePreview {...props} seconds={15}/>);await advance();const signal=vi.mocked(fetch).mock.calls[0][1]!.signal!;
 view.rerender(<TimelinePreview {...props} seconds={85}/>);expect(signal.aborted).toBe(true);await advance();
 await act(async()=>{resolve(success());});expect(screen.getByRole("img",{name:"Preview near 1:20"})).toBeTruthy();expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
});
it("retries busy work without pointer movement within a bounded budget",async()=>{
 vi.mocked(fetch).mockResolvedValueOnce({ok:false,status:429} as Response);
 const view=render(<TimelinePreview {...props} seconds={15}/>);await advance();await advance(249);expect(fetch).toHaveBeenCalledTimes(1);
 await advance(1);expect(screen.getByRole("img")).toBeTruthy();
 vi.mocked(fetch).mockResolvedValue({ok:false,status:429} as Response);view.rerender(<TimelinePreview {...props} seconds={85}/>);await advance(10000);
 expect(fetch).toHaveBeenCalledTimes(7);expect(screen.queryByRole("img")).toBeNull();expect(screen.getByText("1:25")).toBeTruthy();await advance(10000);expect(fetch).toHaveBeenCalledTimes(7);
});
it("cancels retry timers on target change and exit without retrying other errors",async()=>{
 vi.mocked(fetch).mockResolvedValue({ok:false,status:429} as Response);const view=render(<TimelinePreview {...props} seconds={15}/>);await advance();
 view.rerender(<TimelinePreview {...props} seconds={85}/>);vi.mocked(fetch).mockResolvedValue({ok:false,status:500} as Response);await advance(10000);expect(fetch).toHaveBeenCalledTimes(2);
 vi.mocked(fetch).mockResolvedValue({ok:false,status:429} as Response);view.rerender(<TimelinePreview {...props} seconds={95}/>);await advance();view.rerender(<TimelinePreview {...props} seconds={null}/>);await advance(10000);expect(fetch).toHaveBeenCalledTimes(3);
});
it("evicts least recently inspected frames at the image count limit",async()=>{
 const view=render(<TimelinePreview {...props} seconds={0}/>);await advance();
 for(let index=1;index<12;index++){view.rerender(<TimelinePreview {...props} seconds={index*10}/>);await advance();}
 view.rerender(<TimelinePreview {...props} seconds={0}/>);view.rerender(<TimelinePreview {...props} seconds={120}/>);await advance();
 expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:2");expect(URL.revokeObjectURL).not.toHaveBeenCalledWith("blob:1");
 view.rerender(<TimelinePreview {...props} seconds={10}/>);expect(screen.queryByRole("img")).toBeNull();await advance();expect(fetch).toHaveBeenCalledTimes(14);
});
it("bounds cached bytes and rejects oversized images",async()=>{
 vi.mocked(fetch).mockResolvedValue(success(1024*1024));const view=render(<TimelinePreview {...props} seconds={0}/>);await advance();
 for(let index=1;index<5;index++){view.rerender(<TimelinePreview {...props} seconds={index*10}/>);await advance();}
 expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);vi.mocked(fetch).mockResolvedValue(success(1024*1024+1));view.rerender(<TimelinePreview {...props} seconds={50}/>);await advance();
 expect(screen.queryByRole("img")).toBeNull();expect(URL.createObjectURL).toHaveBeenCalledTimes(5);
});
it("clears images when media or account changes",async()=>{
 const view=render(<TimelinePreview {...props} seconds={15}/>);await advance();view.rerender(<TimelinePreview {...props} item="two" seconds={15}/>);
 expect(screen.queryByRole("img")).toBeNull();expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:1");await advance();
 act(()=>window.dispatchEvent(new Event("posterview:account-changed")));expect(screen.queryByRole("img")).toBeNull();expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:2");await advance();expect(fetch).toHaveBeenCalledTimes(3);
});
it("shows exact chapter names without additional frame requests",async()=>{
 const chapters=[{title:"Middle",start_seconds:25},{title:"Intro",start_seconds:0}];
 const view=render(<TimelinePreview {...props} seconds={24} chapters={chapters}/>);expect(screen.getByText("Intro")).toBeTruthy();await advance();
 view.rerender(<TimelinePreview {...props} seconds={25} chapters={chapters}/>);expect(screen.getByText("Middle")).toBeTruthy();expect(screen.queryByText("Intro")).toBeNull();await advance();expect(fetch).toHaveBeenCalledTimes(1);
});
it("immediately aborts account-owned work before a late response can populate the cache",async()=>{
 let resolve!:(value:Response)=>void;vi.mocked(fetch).mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
 render(<TimelinePreview {...props} seconds={15}/>);await advance();const signal=vi.mocked(fetch).mock.calls[0][1]!.signal!;
 act(()=>{window.dispatchEvent(new Event("posterview:account-changed"));expect(signal.aborted).toBe(true);});
 await act(async()=>resolve(success()));expect(URL.createObjectURL).not.toHaveBeenCalled();expect(screen.queryByRole("img")).toBeNull();
});
