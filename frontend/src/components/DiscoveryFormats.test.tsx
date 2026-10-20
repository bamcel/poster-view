import {defaultPlaybackPreferences} from "../features/playback/types";
import {cleanup,render,screen} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import DiscoveryFormats from "./DiscoveryFormats";
import {nativeLibraries,type NativeCatalogEntry,type NativeLibrary} from "../api/nativeLibraries";
import {watchApi} from "../features/playback/api/watch";

vi.mock("../api/nativeLibraries",()=>({nativeLibraries:{item:vi.fn(),summaries:vi.fn()}}));
vi.mock("../features/playback/api/watch",()=>({watchApi:{states:vi.fn(),continue:vi.fn(),preferences:vi.fn()}}));
const movie:NativeCatalogEntry={id:"movie",path:"/movie",parent_path:null,title:"Movie",kind:"movie",available:true,revision:1,metadata:{},artwork:[],nfo_path:null,files:[]};
const library={id:"library"} as NativeLibrary;
const measured=(entry:NativeCatalogEntry):NativeCatalogEntry=>({...entry,metadata:{...entry.metadata},files:[{path:"video.mkv",size:1,extension:"mkv",media_info:{streams:[{codec_type:"video",width:1920,height:1080},{codec_type:"audio",codec_name:"ac3",channels:6,channel_layout:"5.1"}]}}]});
function mount(entry=movie,client=new QueryClient({defaultOptions:{queries:{retry:false}}})) {return render(<QueryClientProvider client={client}><DiscoveryFormats title={{entry,library}}/></QueryClientProvider>);}
beforeEach(()=>{vi.clearAllMocks();vi.mocked(watchApi.preferences).mockResolvedValue({...defaultPlaybackPreferences,prefer_default_audio:false});vi.mocked(nativeLibraries.item).mockResolvedValue(measured(movie));vi.mocked(nativeLibraries.summaries).mockResolvedValue([]);vi.mocked(watchApi.states).mockResolvedValue({});vi.mocked(watchApi.continue).mockResolvedValue([]);});
afterEach(cleanup);
it("shows confirmed quality before audio after reading the selected movie",async()=>{
 mount();const row=await screen.findByRole("group",{name:"Media formats"});
 expect(row.textContent).toBe("Full HD5.1 Surround");
 expect(nativeLibraries.item).toHaveBeenCalledWith("library","movie");
 expect(screen.queryByText("Spatial Audio")).toBeNull();
});
it("leaves unknown formats hidden",async()=>{
 vi.mocked(nativeLibraries.item).mockResolvedValue(movie);mount();
 await vi.waitFor(()=>expect(nativeLibraries.item).toHaveBeenCalled());
 expect(screen.queryByRole("group",{name:"Media formats"})).toBeNull();
});
it("places the selected file's media source first",async()=>{
 const item=measured(movie);item.metadata.media_sources={"video.mkv":"bluray"};
 vi.mocked(nativeLibraries.item).mockResolvedValue(item);mount();
 const row=await screen.findByRole("group",{name:"Media formats"});
 expect(row.firstElementChild?.textContent).toBe("Blu-ray");
 expect(row.textContent).toBe("Blu-rayFull HD5.1 Surround");
});
it("adds Dual Audio after the audio format when distinct languages are recorded",async()=>{
 const item=measured(movie);item.files[0].media_info!.streams!.push({codec_type:"audio",channels:2,tags:{language:"jpn"}});
 item.files[0].media_info!.streams![1].tags={language:"eng"};
 vi.mocked(nativeLibraries.item).mockResolvedValue(item);mount();
 const row=await screen.findByRole("group",{name:"Media formats"});
 expect(row.textContent).toBe("Full HD5.1 SurroundDual Audio");
});
it("shows stereo for preferred English even when Japanese has surround",async()=>{
 const item=measured(movie);
 item.files[0].media_info!.streams![1].tags={language:"jpn"};
 item.files[0].media_info!.streams!.push({codec_type:"audio",channels:2,tags:{language:"eng"}});
 vi.mocked(nativeLibraries.item).mockResolvedValue(item);mount();
 expect(await screen.findByText("Stereo")).toBeTruthy();
 expect(screen.queryByText("5.1 Surround")).toBeNull();expect(screen.getByText("Dual Audio")).toBeTruthy();
});
it("uses the next playable episode instead of combining formats across a series",async()=>{
 const series={...movie,id:"series",kind:"series",path:"/series",title:"Show"};
 const first={...movie,id:"one",kind:"episode",path:"/series/one",metadata:{season:1,episode:1,_has_files:true},title:"First"};
 const next={...first,id:"two",path:"/series/two",metadata:{season:1,episode:2,_has_files:true},title:"Next"};
 vi.mocked(nativeLibraries.summaries).mockResolvedValue([series,first,next]);
 vi.mocked(watchApi.states).mockResolvedValue({one:{watched:true,position_seconds:0} as Awaited<ReturnType<typeof watchApi.state>>});
 vi.mocked(nativeLibraries.item).mockResolvedValue(measured(next));
 mount(series);const row=await screen.findByRole("group",{name:"Media formats"});
 expect(row.title).toBe("Next episode: Next");expect(nativeLibraries.item).toHaveBeenCalledWith("library","two");
});
