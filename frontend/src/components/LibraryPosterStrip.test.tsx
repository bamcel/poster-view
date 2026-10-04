import {act,cleanup,render,screen} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {afterEach,expect,it,vi} from "vitest";
import LibraryPosterStrip from "./LibraryPosterStrip";
import {nativeLibraries} from "../api/nativeLibraries";
vi.mock("../api/nativeLibraries",async original=>({...await original<typeof import("../api/nativeLibraries")>(),nativeLibraries:{...((await original<typeof import("../api/nativeLibraries")>()).nativeLibraries),previews:vi.fn()}}));
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();vi.clearAllMocks();});
function mount(paused=false){const client=new QueryClient({defaultOptions:{queries:{retry:false}}});client.setQueryData(["native-previews","anime"],Array.from({length:6},(_,i)=>({id:String(i),title:`Title ${i}`,revision:1})));return render(<QueryClientProvider client={client}><LibraryPosterStrip library="anime" paused={paused}/></QueryClientProvider>);}
it("cycles to the previous poster so the strip moves right",async()=>{
 vi.mocked(nativeLibraries.previews).mockResolvedValue(Array.from({length:6},(_,i)=>({id:String(i),title:`Title ${i}`,revision:1})));
 vi.useFakeTimers();mount();
 await act(async()=>{vi.advanceTimersByTime(5000);});
 expect(screen.getByLabelText("Library poster preview").firstElementChild?.getAttribute("style")).toContain("translateX(0%)");
 await act(async()=>{vi.advanceTimersByTime(700);});
 expect(screen.getByAltText("Title 5")).toBeTruthy();expect(screen.queryByAltText("Title 3")).toBeNull();
});
it("keeps the strip stationary while its action menu is open",async()=>{
 vi.mocked(nativeLibraries.previews).mockResolvedValue(Array.from({length:6},(_,i)=>({id:String(i),title:`Title ${i}`,revision:1})));
 vi.useFakeTimers();mount(true);
 await act(async()=>{vi.advanceTimersByTime(10_000);});
 expect(screen.getByLabelText("Library poster preview").firstElementChild?.getAttribute("style")).toContain("translateX(-25%)");
});
