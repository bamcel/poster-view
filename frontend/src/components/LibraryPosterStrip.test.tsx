import {act,cleanup,render,screen} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {afterEach,expect,it,vi} from "vitest";
import LibraryPosterStrip from "./LibraryPosterStrip";
vi.mock("../api/nativeLibraries",async original=>({...await original<typeof import("../api/nativeLibraries")>(),nativeLibraries:{...((await original<typeof import("../api/nativeLibraries")>()).nativeLibraries),previews:vi.fn()}}));
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();vi.clearAllMocks();});
function mount(){const client=new QueryClient({defaultOptions:{queries:{retry:false}}});client.setQueryData(["native-previews","anime"],Array.from({length:6},(_,i)=>({id:String(i),title:`Title ${i}`,revision:1})));return render(<QueryClientProvider client={client}><LibraryPosterStrip library="anime"/></QueryClientProvider>);}
it("slides continuously right and wraps without a waiting interval",()=>{
 let callback:FrameRequestCallback=()=>{};
 vi.stubGlobal("requestAnimationFrame",vi.fn((next:FrameRequestCallback)=>{callback=next;return 1;}));
 vi.stubGlobal("cancelAnimationFrame",vi.fn());
 mount();act(()=>callback(0));act(()=>callback(100));
 expect(screen.getByLabelText("Library poster preview").firstElementChild?.getAttribute("style")).toContain("-24.5%");
 for(let time=200;time<=5100;time+=100)act(()=>callback(time));
 expect(screen.getByAltText("Title 5")).toBeTruthy();
 expect(screen.queryByAltText("Title 3")).toBeNull();
});
it("honors reduced motion",()=>{
 vi.stubGlobal("matchMedia",()=>({matches:true,addEventListener:vi.fn(),removeEventListener:vi.fn()}));
 const frame=vi.fn();vi.stubGlobal("requestAnimationFrame",frame);
 mount();expect(frame).not.toHaveBeenCalled();
});
