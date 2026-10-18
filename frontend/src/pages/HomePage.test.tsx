import {AuthSessionContext} from "../lib/authContext";
import type {AuthSession} from "../api/client";
import {act,render, screen, cleanup, fireEvent, within} from "@testing-library/react";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {MemoryRouter, Routes, Route} from "react-router-dom";
import {afterEach, beforeEach, it, expect, vi} from "vitest";
import HomePage from "./HomePage";
import {nativeLibraries} from "../api/nativeLibraries";
import {watchApi} from "../features/playback/api/watch";
vi.mock("../features/playback/api/watch",()=>({watchApi:{continue:vi.fn(),state:vi.fn()}}));
vi.mock("../api/nativeLibraries",()=>({nativeLibraries:{list:vi.fn(),catalog:vi.fn(),summaries:vi.fn(),artworkUrl:vi.fn(),scan:vi.fn(),refresh:vi.fn()}}));
vi.mock("../components/SeriesBannerPlay",()=>({default:({title}:{title:{entry:{title:string}}})=><button aria-label={`Play ${title.entry.title}`}>Play</button>}));
vi.mock("../components/HomeBackground",()=>({default:({libraries}:{libraries:{id:string}[]})=><div data-testid="home-background-libraries" data-libraries={libraries.map(library=>library.id).join(",")}/>}));
vi.mock("../components/LibraryPosterStrip",()=>({default:({library}:{library:string})=><div data-testid={`collage-${library}`}>Shared collage</div>}));
vi.mock("./DashboardPage",()=>({default:()=> <div>Legacy library</div>}));
beforeEach(()=>{vi.resetAllMocks();vi.mocked(nativeLibraries.summaries).mockImplementation(id=>nativeLibraries.catalog(id));HTMLDialogElement.prototype.showModal=vi.fn(function(this:HTMLDialogElement){this.setAttribute("open","");});HTMLDialogElement.prototype.close=vi.fn(function(this:HTMLDialogElement){this.removeAttribute("open");});vi.mocked(nativeLibraries.catalog).mockResolvedValue([]);vi.mocked(watchApi.continue).mockResolvedValue([]);vi.mocked(nativeLibraries.artworkUrl).mockImplementation((library,item,kind)=>`/art/${library}/${item}/${kind}`);});
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
 expect(tv.getAttribute("href")).toBe("/media/tv?native_library=tv&native_item=tv-item&from=home");
 expect(await screen.findByRole("link",{name:"Open Different title in Books"})).toBeTruthy();
 expect(screen.queryByText("Harry missing")).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"Clear search"}));
 expect(screen.getByTestId("collage-tv")).toBeTruthy();
});

it("places My Libraries between featured media and Continue Watching",async()=>{
 const library={id:"films",name:"Films",library_type:"movies"} as Awaited<ReturnType<typeof nativeLibraries.list>>[number];
 const movie={...entryDefaults,id:"film",title:"Featured Film",kind:"movie",available:true,metadata:{plot:"A journey home",year:2025,rating:8.5,genres:["Drama"]},artwork:[{kind:"backdrop",path:"backdrop.jpg",source:"local"}],files:[{path:"film.mkv",size:100,extension:"mkv"}]};
 vi.mocked(nativeLibraries.list).mockResolvedValue([library]);
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([movie,{...movie,id:"missing",title:"Missing Film",available:false},{...movie,id:"episode",title:"An Episode",kind:"episode"}]);
 vi.mocked(watchApi.continue).mockResolvedValue([{library_id:"films",item_id:"film",kind:"movie",title:"Featured Film",library_name:"Films",entry:movie,state:{position_seconds:60,duration_seconds:120,watched:false,play_count:1,last_played_at:null,audio_index:null,subtitle_index:null,session_id:null,version:1}}]);
 mount();
 const featured=await screen.findByRole("region",{name:"Featured title"});
 const continued=await screen.findByRole("region",{name:"Continue watching"});
 const libraries=screen.getByRole("region",{name:"My libraries"});
 expect(featured.compareDocumentPosition(libraries)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 expect(libraries.compareDocumentPosition(continued)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 expect(screen.getByTestId("collage-films")).toBeTruthy();
 expect(within(featured).getByRole("link",{name:/Play/}).getAttribute("href")).toBe("/play/native/films/film?return=%2F&start=0");
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

it("opens title details directly from the homepage without an overlay",async()=>{
 const movie={...entryDefaults,id:"film",title:"A Journey",kind:"movie",available:true,metadata:{plot:"A complete synopsis",year:2025},artwork:[],files:[{path:"film.mkv",size:100,extension:"mkv"}]};
 vi.mocked(nativeLibraries.list).mockResolvedValue([{id:"films",name:"Films",library_type:"movies"}] as Awaited<ReturnType<typeof nativeLibraries.list>>);
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([movie]);
 vi.mocked(watchApi.state).mockResolvedValue({position_seconds:120,duration_seconds:360,watched:false,play_count:1,last_played_at:null,audio_index:null,subtitle_index:null,session_id:null,version:1});
 mount();
 const featured=await screen.findByRole("region",{name:"Featured title"});
 expect(watchApi.state).not.toHaveBeenCalled();
 const info=within(featured).getByRole("link",{name:"More info about A Journey"});
 expect(info.getAttribute("href")).toBe("/media/films?native_library=films&native_item=film&from=home");
 fireEvent.click(info);
 expect(await screen.findByText("Opened library page")).toBeTruthy();
 expect(watchApi.state).not.toHaveBeenCalled();
 expect(screen.queryByText("My List")).toBeNull();
 expect(screen.queryByRole("dialog")).toBeNull();
});

it("shows matching titles once per discovery and search row across libraries",async()=>{
 const series={...entryDefaults,id:"show",title:"Bon Appétit, Your Majesty",kind:"series",available:true,metadata:{year:2025,rating:9,identifiers:{tvdb:123}},artwork:[]};
 vi.mocked(nativeLibraries.list).mockResolvedValue([{id:"korean",name:"Korean",library_type:"shows"},{id:"tv",name:"TV Series",library_type:"shows"}] as Awaited<ReturnType<typeof nativeLibraries.list>>);
 vi.mocked(nativeLibraries.catalog).mockImplementation(async library=>[{...series,id:library+"-show",metadata:{...series.metadata,identifiers:{tvdb:library==="korean"?123:"123"}}}]);
 mount();
 const row=await screen.findByRole("region",{name:"Highly Rated"});
 await screen.findByRole("link",{name:"Open TV Series"});
 expect(within(row).getAllByRole("link",{name:`Open ${series.title} in Korean`})).toHaveLength(1);
 expect(screen.getByTestId("collage-korean")).toBeTruthy();
 expect(screen.getByTestId("collage-tv")).toBeTruthy();
 fireEvent.change(screen.getByRole("textbox",{name:"Search all libraries"}),{target:{value:"Bon Appétit"}});
 const results=await screen.findByRole("region",{name:"Series"});
 expect(within(results).getAllByRole("link")).toHaveLength(1);
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

it("waits for all enabled catalogs before choosing the first banner",async()=>{
 vi.mocked(nativeLibraries.list).mockResolvedValue([{id:"anime",name:"Anime",library_type:"anime"},{id:"korean",name:"Korean",library_type:"shows"},{id:"books",name:"Books",library_type:"books"}] as Awaited<ReturnType<typeof nativeLibraries.list>>);
 let resolveAnime!:(entries:Awaited<ReturnType<typeof nativeLibraries.catalog>>)=>void;
 const anime=new Promise<Awaited<ReturnType<typeof nativeLibraries.catalog>>>(resolve=>{resolveAnime=resolve;});
 const entry=(id:string,title:string)=>({...entryDefaults,id,title,kind:"series",available:true,metadata:{},artwork:[{kind:"backdrop",path:"backdrop.jpg",source:"local"}]});
 vi.mocked(nativeLibraries.catalog).mockImplementation(id=>id==="anime"?anime:Promise.resolve([entry("bon","Bon Appetit")]));
 mount();
 await screen.findByRole("region",{name:"Explore Your Libraries"});
 expect(screen.getByRole("region",{name:"Loading featured title"}).getAttribute("aria-busy")).toBe("true");
 expect(within(screen.getByRole("region",{name:"Loading featured title"})).queryByRole("heading")).toBeNull();
 await act(async()=>resolveAnime([entry("anime-show","Anime First")]));
 const banner=await screen.findByRole("region",{name:"Featured title"});
 expect(within(banner).getByRole("heading",{name:"Anime First"})).toBeTruthy();
 expect(within(screen.getByRole("region",{name:"Featured title"})).queryByRole("heading",{name:"Bon Appetit"})).toBeNull();
});

it("excludes denied libraries and replaces a banner when library access changes",async()=>{
 vi.mocked(nativeLibraries.list).mockResolvedValue([{id:"anime",name:"Anime",library_type:"anime"},{id:"films",name:"Films",library_type:"movies"}] as Awaited<ReturnType<typeof nativeLibraries.list>>);
 vi.mocked(nativeLibraries.catalog).mockImplementation(async id=>[{...entryDefaults,id:id+"-show",title:id==="anime"?"Allowed Anime":"Allowed Movie",kind:"series",available:true,metadata:{},artwork:[{kind:"backdrop",path:"backdrop.jpg",source:"local"}]}]);
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 const view=(ids:string[])=>{
  const session:AuthSession={authenticated:true,user:{id:"viewer",username:"viewer",display_name:"Viewer",role:"user",enabled:true,revision:1,created_at:"",permissions:{all_libraries:false,library_ids:ids,max_movie_rating:null,max_tv_rating:null,allow_unrated:false}}};
  return <QueryClientProvider client={client}><AuthSessionContext.Provider value={session}><MemoryRouter><HomePage/></MemoryRouter></AuthSessionContext.Provider></QueryClientProvider>;
 };
 const rendered=render(view(["anime"]));
 let banner=await screen.findByRole("region",{name:"Featured title"});
 expect(within(banner).getByRole("heading",{name:"Allowed Anime"})).toBeTruthy();
 expect(screen.queryByRole("link",{name:"Open Films"})).toBeNull();
 expect(nativeLibraries.catalog).not.toHaveBeenCalledWith("films");
 expect(screen.getByTestId("home-background-libraries").getAttribute("data-libraries")).toBe("anime");
 rendered.rerender(view(["films"]));
 banner=await screen.findByRole("region",{name:"Featured title"});
 expect(await within(banner).findByRole("heading",{name:"Allowed Movie"})).toBeTruthy();
 expect(screen.queryByRole("link",{name:"Open Anime"})).toBeNull();
 expect(screen.getByTestId("home-background-libraries").getAttribute("data-libraries")).toBe("films");
 expect([...banner.querySelectorAll("img")].some(image=>image.src.includes("/anime/"))).toBe(false);
 rendered.rerender(view([]));
 expect(screen.queryByRole("region",{name:"Featured title"})).toBeNull();
});

it.each(["Scan Library Files","Refresh Metadata"])("offers admin library action %s without navigating",async action=>{
 vi.mocked(nativeLibraries.list).mockResolvedValue([{id:"films",name:"Films",library_type:"movies"}] as Awaited<ReturnType<typeof nativeLibraries.list>>);
 vi.mocked(nativeLibraries.scan).mockResolvedValue();vi.mocked(nativeLibraries.refresh).mockResolvedValue();
 mount();const tile=await screen.findByRole("link",{name:"Open Films"});
 fireEvent.contextMenu(tile);
 fireEvent.click(await screen.findByRole("menuitem",{name:action}));
 if(action==="Scan Library Files")await screen.findByText("Scan requested for Films.");
 else await screen.findByText("Metadata refresh requested for Films.");
 expect(screen.queryByText("Opened library page")).toBeNull();
 if(action==="Scan Library Files"){expect(nativeLibraries.scan).toHaveBeenCalledWith("films");expect(nativeLibraries.refresh).not.toHaveBeenCalled();}
 else {expect(nativeLibraries.refresh).toHaveBeenCalledWith("films",{replaceMetadata:false,replaceImages:false});expect(nativeLibraries.scan).not.toHaveBeenCalled();}
});
it("does not expose library management context menus to viewers",async()=>{
 vi.mocked(nativeLibraries.list).mockResolvedValue([{id:"films",name:"Films",library_type:"movies"}] as Awaited<ReturnType<typeof nativeLibraries.list>>);
 const session:AuthSession={authenticated:true,user:{id:"viewer",username:"viewer",display_name:"Viewer",role:"user",enabled:true,revision:1,created_at:"",permissions:{all_libraries:true,library_ids:[],max_movie_rating:null,max_tv_rating:null,allow_unrated:false}}};
 render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><AuthSessionContext.Provider value={session}><MemoryRouter><HomePage/></MemoryRouter></AuthSessionContext.Provider></QueryClientProvider>);
 fireEvent.contextMenu(await screen.findByRole("link",{name:"Open Films"}));
 expect(screen.queryByRole("menu")).toBeNull();expect(screen.queryByRole("menuitem",{name:"Scan Library Files"})).toBeNull();
 expect(nativeLibraries.scan).not.toHaveBeenCalled();expect(nativeLibraries.refresh).not.toHaveBeenCalled();
});

it("opens library actions with Shift+F10 and closes them with Escape",async()=>{
 vi.mocked(nativeLibraries.list).mockResolvedValue([{id:"films",name:"Films",library_type:"movies"}] as Awaited<ReturnType<typeof nativeLibraries.list>>);
 mount();const tile=await screen.findByRole("link",{name:"Open Films"});tile.focus();
 fireEvent.keyDown(tile,{key:"F10",shiftKey:true});
 const menu=await screen.findByRole("menu");
 expect(within(menu).getByRole("menuitem",{name:"Scan Library Files"})).toBeTruthy();
 fireEvent.keyDown(menu,{key:"Escape"});
 expect(screen.queryByRole("menu")).toBeNull();expect(nativeLibraries.scan).not.toHaveBeenCalled();
});
