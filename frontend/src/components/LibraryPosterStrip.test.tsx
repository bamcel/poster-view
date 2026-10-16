import {act,cleanup,render,screen} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {nativeLibraries} from "../api/nativeLibraries";
import LibraryPosterStrip from "./LibraryPosterStrip";
vi.mock("../api/nativeLibraries",async original=>({...await original<typeof import("../api/nativeLibraries")>(),nativeLibraries:{...((await original<typeof import("../api/nativeLibraries")>()).nativeLibraries),previews:vi.fn()}}));
beforeEach(()=>{vi.spyOn(HTMLElement.prototype,"getBoundingClientRect").mockReturnValue({width:400} as DOMRect);});
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();vi.clearAllMocks();vi.restoreAllMocks();});
function mount(){const client=new QueryClient({defaultOptions:{queries:{retry:false}}});client.setQueryData(["native-previews","anime"],Array.from({length:6},(_,i)=>({id:String(i),title:`Title ${i}`,revision:1})));return render(<QueryClientProvider client={client}><LibraryPosterStrip library="anime"/></QueryClientProvider>);}
it("slides continuously right and wraps without a waiting interval",async()=>{
 let callback:FrameRequestCallback=()=>{};
 vi.stubGlobal("requestAnimationFrame",vi.fn((next:FrameRequestCallback)=>{callback=next;return 1;}));
 vi.stubGlobal("cancelAnimationFrame",vi.fn());
 mount();
 await act(async()=>{});
 const images=Array.from(screen.getByLabelText("Library poster preview").querySelectorAll("img"));
 const sources=images.map(image=>image.src);
 expect(sources.every(source=>new URL(source).searchParams.get("width")==="192")).toBe(true);
 act(()=>callback(0));act(()=>callback(100));
 expect(screen.getByLabelText("Library poster preview").firstElementChild?.getAttribute("style")).toContain("-598px");
 for(let time=200;time<=5100;time+=100)act(()=>callback(time));
 expect(Array.from(screen.getByLabelText("Library poster preview").querySelectorAll("img"))).toEqual(images);
 expect(images.map(image=>image.src)).toEqual(sources);
 expect(screen.getByAltText("Title 5")).toBeTruthy();
 expect(screen.getByAltText("Title 3")).toBeTruthy();
});
it("honors reduced motion",()=>{
 vi.stubGlobal("matchMedia",()=>({matches:true,addEventListener:vi.fn(),removeEventListener:vi.fn()}));
 const frame=vi.fn();vi.stubGlobal("requestAnimationFrame",frame);
 mount();expect(frame).not.toHaveBeenCalled();
});

it("keeps poster URLs on metadata refresh and updates when media is added",async()=>{
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 const items=[{id:"one",title:"One",revision:1},{id:"two",title:"Two",revision:1}];
 client.setQueryData(["native-previews","anime"],items);
 const node=<QueryClientProvider client={client}><LibraryPosterStrip library="anime"/></QueryClientProvider>;
 const view=render(node);
 const src=screen.getAllByAltText("One")[0].getAttribute("src");
 act(()=>{client.setQueryData(["native-previews","anime"],items.map(item=>({...item,revision:2})));});
 view.rerender(node);
 expect(screen.getAllByAltText("One")[0].getAttribute("src")).toBe(src);
 vi.mocked(nativeLibraries.previews).mockResolvedValue([...items,{id:"three",title:"Three",revision:1}]);
 await act(async()=>{await client.refetchQueries({queryKey:["native-previews","anime"]});});
 expect((await screen.findAllByAltText("Three"))[0]).toBeTruthy();
});

it("randomizes a new track once and preserves its order across frames",async()=>{
 const random=vi.spyOn(Math,"random").mockReturnValue(0);
 let callback:FrameRequestCallback=()=>{};
 vi.stubGlobal("requestAnimationFrame",vi.fn((next:FrameRequestCallback)=>{callback=next;return 1;}));
 vi.stubGlobal("cancelAnimationFrame",vi.fn());
 mount();
 await act(async()=>{});
 const posters=()=>Array.from(screen.getByLabelText("Library poster preview").querySelectorAll("img")).map(image=>image.getAttribute("alt")).filter(Boolean);
 expect(posters()).toEqual(["Title 1","Title 2","Title 3","Title 4","Title 5","Title 0"]);
 act(()=>callback(0));
 for(let time=100;time<=31000;time+=100)act(()=>callback(time));
 expect(posters()).toEqual(["Title 1","Title 2","Title 3","Title 4","Title 5","Title 0"]);
 expect(random).toHaveBeenCalledTimes(5);
});

it("shares random poster order and revisions between Home and Settings mounts",()=>{
 const random=vi.spyOn(Math,"random").mockReturnValue(0);
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 const items=Array.from({length:6},(_,i)=>({id:String(i),title:`Title ${i}`,revision:1}));
 client.setQueryData(["native-previews","anime"],items);
 const node=<QueryClientProvider client={client}><LibraryPosterStrip library="anime"/></QueryClientProvider>;
 const first=render(node);
 const sources=()=>Array.from(screen.getByLabelText("Library poster preview").querySelectorAll("img")).map(image=>image.getAttribute("src"));
 const original=sources();
 first.unmount();
 client.setQueryData(["native-previews","anime"],items.map(item=>({...item,revision:2})));
 render(node);
 expect(sources()).toEqual(original);
 expect(random).toHaveBeenCalledTimes(5);
});

it("pauses offscreen without restarting the slide",async()=>{
 let observe:IntersectionObserverCallback=()=>{};
 vi.stubGlobal("IntersectionObserver",class {constructor(callback:IntersectionObserverCallback){observe=callback;}observe(){}disconnect(){}});
 let callback:FrameRequestCallback=()=>{};
 vi.stubGlobal("requestAnimationFrame",vi.fn((next:FrameRequestCallback)=>{callback=next;return 1;}));
 vi.stubGlobal("cancelAnimationFrame",vi.fn());
 mount();
 const visibility=async(isIntersecting:boolean)=>{await act(async()=>{observe([{isIntersecting} as IntersectionObserverEntry],{} as IntersectionObserver);});};
 await visibility(true);
 act(()=>callback(0));act(()=>callback(100));
 const track=screen.getByLabelText("Library poster preview").firstElementChild!;
 const position=track.getAttribute("style");
 await visibility(false);
 await visibility(true);
 expect(track.getAttribute("style")).toBe(position);
});

it("moves continuously between physical pixels at fractional display scaling",async()=>{
 vi.stubGlobal("devicePixelRatio",1.25);
 let callback:FrameRequestCallback=()=>{};
 vi.stubGlobal("requestAnimationFrame",vi.fn((next:FrameRequestCallback)=>{callback=next;return 1;}));
 vi.stubGlobal("cancelAnimationFrame",vi.fn());
 mount();await act(async()=>{});
 act(()=>callback(0));
 const offsets:number[]=[];
 for(let time=17;time<=510;time+=17){
  act(()=>callback(time));
  const style=screen.getByLabelText("Library poster preview").firstElementChild?.getAttribute("style")??"";
  const offset=Number(/translate3d\(([-\d.]+)px/.exec(style)?.[1]);
  offsets.push(offset);
 }
 expect(offsets.some(offset=>Math.abs(offset*1.25-Math.round(offset*1.25))>0.00001)).toBe(true);
 const steps=offsets.slice(1).map((offset,index)=>offset-offsets[index]);
 expect(steps.every(step=>step>0)).toBe(true);
 expect(Math.max(...steps)-Math.min(...steps)).toBeLessThan(0.00001);
});
