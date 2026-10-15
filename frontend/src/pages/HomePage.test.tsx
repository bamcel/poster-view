import {render, screen, cleanup, fireEvent, within} from "@testing-library/react";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {MemoryRouter, Routes, Route} from "react-router-dom";
import {afterEach, beforeEach, it, expect, vi} from "vitest";
import HomePage from "./HomePage";
import {nativeLibraries} from "../api/nativeLibraries";
import {watchApi} from "../features/playback/api/watch";
vi.mock("../features/playback/api/watch",()=>({watchApi:{continue:vi.fn(),state:vi.fn()}}));
vi.mock("../api/nativeLibraries",()=>({nativeLibraries:{list:vi.fn(),catalog:vi.fn(),artworkUrl:vi.fn()}}));
vi.mock("../components/LibraryPosterStrip",()=>({default:({library}:{library:string})=><div data-testid={`collage-${library}`}>Shared collage</div>}));
vi.mock("./DashboardPage",()=>({default:()=> <div>Legacy library</div>}));
beforeEach(()=>{vi.resetAllMocks();HTMLDialogElement.prototype.showModal=vi.fn(function(this:HTMLDialogElement){this.setAttribute("open","");});HTMLDialogElement.prototype.close=vi.fn(function(this:HTMLDialogElement){this.removeAttribute("open");});vi.mocked(nativeLibraries.catalog).mockResolvedValue([]);vi.mocked(watchApi.continue).mockResolvedValue([]);vi.mocked(nativeLibraries.artworkUrl).mockImplementation((library,item,kind)=>`/art/${library}/${item}/${kind}`);});
afterEach(()=>{cleanup();vi.clearAllMocks();});
function mount(path="/"){
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><Routes><Route path="/" element={<HomePage/>}/><Route path="/media/:id" element={<div>Opened library page</div>}/></Routes></MemoryRouter></QueryClientProvider>);
}
it("uses settings collages and opens the selected library",async()=>{
 vi.mocked(nativeLibraries.list).mockResolvedValue([{id:"tv",name:"TV Series"},{id:"books",name:"Manga"}] as Awaited<ReturnType<typeof nativeLibraries.list>>);
 mount();
 expect(await screen.findByRole("link",{name:"Open TV Series"})).toBeTruthy();
 expect(screen.getByTestId("collage-tv")).toBeTruthy();
 expect(screen.getByTestId("collage-books")).toBeTruthy();
 fireEvent.click(screen.getByRole("link",{name:"Open Manga"}));
 expect(await screen.findByText("Opened library page")).toBeTruthy();
});
it("offers library setup when no libraries exist",async()=>{
 vi.mocked(nativeLibraries.list).mockResolvedValue([]);mount();
 expect(await screen.findByRole("link",{name:"Add a library"})).toBeTruthy();
});
it("preserves old native library links",async()=>{mount("/?native_library=tv");expect(await screen.findByText("Opened library page")).toBeTruthy();});
it("preserves connected library links",()=>{mount("/?lib=tv");expect(screen.getByText("Legacy library")).toBeTruthy();});

const entryDefaults={path:"test",parent_path:null,files:[],nfo_path:null,revision:1};
it("searches every library, includes original titles, and clears back to collages",async()=>{
 vi.mocked(nativeLibraries.list).mockResolvedValue([{id:"tv",name:"TV Series"},{id:"books",name:"Books"}] as Awaited<ReturnType<typeof nativeLibraries.list>>);
 vi.mocked(nativeLibraries.catalog).mockImplementation(async library=>[
  {...entryDefaults,id:library+"-item",title:library==="tv"?"Harry Show":"Different title",kind:"series",available:true,metadata:{originaltitle:"Harry original"},artwork:[],revision:1},
  {...entryDefaults,id:"missing",title:"Harry missing",kind:"series",available:false,metadata:{},artwork:[]},
 ] as Awaited<ReturnType<typeof nativeLibraries.catalog>>);
 mount();await screen.findByRole("link",{name:"Open TV Series"});
 expect(nativeLibraries.catalog).toHaveBeenCalledWith("tv");
 fireEvent.change(screen.getByRole("textbox",{name:"Search all libraries"}),{target:{value:"HARRY"}});
 const tv=await screen.findByRole("link",{name:"Open Harry Show in TV Series"});
 expect(tv.getAttribute("href")).toBe("/media/tv?native_library=tv&native_item=tv-item");
 expect(await screen.findByRole("link",{name:"Open Different title in Books"})).toBeTruthy();
 expect(screen.queryByText("Harry missing")).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"Clear search"}));
 expect(screen.getByTestId("collage-tv")).toBeTruthy();
});

it("places featured media and Continue Watching before animated libraries and discovery rows",async()=>{
 const library={id:"films",name:"Films",library_type:"movies"} as Awaited<ReturnType<typeof nativeLibraries.list>>[number];
 const movie={...entryDefaults,id:"film",title:"Featured Film",kind:"movie",available:true,metadata:{plot:"A journey home",year:2025,rating:8.5,genres:["Drama"]},artwork:[{kind:"backdrop",path:"backdrop.jpg",source:"local"}],files:[{path:"film.mkv",size:100,extension:"mkv"}]};
 vi.mocked(nativeLibraries.list).mockResolvedValue([library]);
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([movie,{...movie,id:"missing",title:"Missing Film",available:false},{...movie,id:"episode",title:"An Episode",kind:"episode"}]);
 vi.mocked(watchApi.continue).mockResolvedValue([{library_id:"films",item_id:"film",kind:"movie",title:"Featured Film",library_name:"Films",entry:movie,state:{position_seconds:60,duration_seconds:120,watched:false,play_count:1,last_played_at:null,audio_index:null,subtitle_index:null,session_id:null,version:1}}]);
 mount();
 const featured=await screen.findByRole("region",{name:"Featured title"});
 const continued=await screen.findByRole("region",{name:"Continue watching"});
 const libraries=screen.getByRole("region",{name:"My libraries"});
 expect(featured.compareDocumentPosition(continued)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 expect(continued.compareDocumentPosition(libraries)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 expect(screen.getByTestId("collage-films")).toBeTruthy();
 expect(within(featured).getByRole("link",{name:/Play/}).getAttribute("href")).toBe("/play/native/films/film?return=%2F");
 expect(screen.queryByText("Missing Film")).toBeNull();
 expect(screen.queryByText("An Episode")).toBeNull();
 expect(screen.queryByText("My List")).toBeNull();
});

it("keeps books out of initial discovery requests but includes them in global search",async()=>{
 vi.mocked(nativeLibraries.list).mockResolvedValue([{id:"books",name:"Books",library_type:"books"}] as Awaited<ReturnType<typeof nativeLibraries.list>>);
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([{...entryDefaults,id:"book",title:"A Book",kind:"book",available:true,metadata:{},artwork:[]}]);
 mount();await screen.findByRole("link",{name:"Open Books"});
 expect(nativeLibraries.catalog).not.toHaveBeenCalled();
 fireEvent.change(screen.getByRole("textbox",{name:"Search all libraries"}),{target:{value:"Book"}});
 expect(await screen.findByRole("link",{name:"Open A Book in Books"})).toBeTruthy();
});

it("keeps library navigation usable when discovery fails",async()=>{
 vi.mocked(nativeLibraries.list).mockResolvedValue([{id:"films",name:"Films",library_type:"movies"}] as Awaited<ReturnType<typeof nativeLibraries.list>>);
 vi.mocked(nativeLibraries.catalog).mockRejectedValue(new Error("Unavailable"));
 mount();
 expect(await screen.findByRole("link",{name:"Open Films"})).toBeTruthy();
 expect(await screen.findByText("Could not load discoveries from Films: Unavailable")).toBeTruthy();
});

it("opens quick view on the homepage and keeps the library cards after closing",async()=>{
 const movie={...entryDefaults,id:"film",title:"A Journey",kind:"movie",available:true,metadata:{plot:"A complete synopsis",year:2025},artwork:[],files:[{path:"film.mkv",size:100,extension:"mkv"}]};
 vi.mocked(nativeLibraries.list).mockResolvedValue([{id:"films",name:"Films",library_type:"movies"}] as Awaited<ReturnType<typeof nativeLibraries.list>>);
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([movie]);
 vi.mocked(watchApi.state).mockResolvedValue({position_seconds:120,duration_seconds:360,watched:false,play_count:1,last_played_at:null,audio_index:null,subtitle_index:null,session_id:null,version:1});
 mount();
 const featured=await screen.findByRole("region",{name:"Featured title"});
 expect(watchApi.state).not.toHaveBeenCalled();
 fireEvent.click(within(featured).getByRole("button",{name:"More info about A Journey"}));
 const dialog=await screen.findByRole("dialog");
 expect(within(dialog).getByText("A complete synopsis")).toBeTruthy();
 expect(await within(dialog).findByRole("link",{name:/Resume/})).toBeTruthy();
 expect(screen.queryByText("Opened library page")).toBeNull();
 expect(screen.queryByText("My List")).toBeNull();
 fireEvent.click(within(dialog).getByRole("button",{name:/Close/}));
 expect(screen.queryByRole("dialog")).toBeNull();
 expect(screen.getByTestId("collage-films")).toBeTruthy();
});
it("reports a failed library search while keeping successful matches",async()=>{
 vi.mocked(nativeLibraries.list).mockResolvedValue([{id:"tv",name:"TV Series"},{id:"books",name:"Books"}] as Awaited<ReturnType<typeof nativeLibraries.list>>);
 vi.mocked(nativeLibraries.catalog).mockImplementation(async library=>{if(library==="tv")throw new Error("Unavailable");return [{...entryDefaults,id:"1",title:"Harry",kind:"book",available:true,metadata:{},artwork:[]}] as Awaited<ReturnType<typeof nativeLibraries.catalog>>;});
 mount();await screen.findByRole("link",{name:"Open Books"});
 fireEvent.change(screen.getByRole("textbox",{name:"Search all libraries"}),{target:{value:"Harry"}});
 expect(await screen.findByRole("link",{name:"Open Harry in Books"})).toBeTruthy();
 expect(await screen.findByRole("alert")).toBeTruthy();
});

it("groups matching media into ordered rows and hides empty sections",async()=>{
 vi.mocked(nativeLibraries.list).mockResolvedValue([{id:"all",name:"Media"}] as Awaited<ReturnType<typeof nativeLibraries.list>>);
 vi.mocked(nativeLibraries.catalog).mockResolvedValue(["book_series","episode","series","movie","book"].map((kind,index)=>({...entryDefaults,id:String(index),title:`Match ${kind}`,kind,available:true,metadata:{},artwork:[]})));
 mount();await screen.findByRole("link",{name:"Open Media"});
 fireEvent.change(screen.getByRole("textbox",{name:"Search all libraries"}),{target:{value:"Match"}});
 await screen.findByRole("region",{name:"Movies"});
 expect(screen.getAllByRole("region").map(region=>region.getAttribute("aria-label"))).toEqual(["Movies","Series","Episodes","Books"]);
 expect(within(screen.getByRole("region",{name:"Books"})).getAllByRole("link")).toHaveLength(2);
 expect(within(screen.getByRole("region",{name:"Episodes"})).getByRole("link",{name:"Open Match episode in Media"})).toBeTruthy();
 fireEvent.change(screen.getByRole("textbox",{name:"Search all libraries"}),{target:{value:"Match episode"}});
 expect(screen.getAllByRole("region").map(region=>region.getAttribute("aria-label"))).toEqual(["Episodes"]);
});
