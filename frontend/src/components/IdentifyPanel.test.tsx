import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import type {ReactNode} from "react";
import {apiRequest} from "../api/client";
import {cleanup,fireEvent,render as renderUI,screen,waitFor} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import IdentifyPanel from "./IdentifyPanel";
import {nativeLibraries,defaultNativeOptions,type NativeLibrary,type NativeCatalogEntry} from "../api/nativeLibraries";
vi.mock("../api/nativeLibraries",async importOriginal=>({...await importOriginal<typeof import("../api/nativeLibraries")>(),nativeLibraries:{identifySearch:vi.fn(),identifyResolve:vi.fn(),editItem:vi.fn(),identify:vi.fn()}}));
vi.mock("../api/client",()=>({apiRequest:vi.fn().mockResolvedValue({poster:null})}));
function render(ui:ReactNode){return renderUI(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}>{ui}</QueryClientProvider>);}
afterEach(()=>{cleanup();vi.clearAllMocks();});
const library={id:"lib",library_type:"anime"} as NativeLibrary;
const entry={id:"item",title:"Haikyu! (2024)",path:"Anime/Haikyu",kind:"series",revision:3,parent_path:null,artwork:[],files:[],nfo_path:null,available:true,metadata:{identifiers:{tvdb:"wrong"}}} as NativeCatalogEntry;
it("searches together and saves reviewed AniDB and linked IDs",async()=>{
 const saved=vi.fn();
 vi.mocked(nativeLibraries.identifyResolve).mockImplementation(async(_library,_item,provider,id)=>({identifiers:{[provider]:id},candidates:[],warnings:[]}));
 vi.mocked(nativeLibraries.identifySearch).mockResolvedValue({groups:[{provider:"anilist",results:[{provider:"anilist",id:"1",title:"Haikyu!",year:2014,format:"TV",overview:"Volleyball",identifiers:{anilist:"1",mal:"2"}}]},{provider:"anidb",results:[{provider:"anidb",id:"3",title:"Japanese provider title",year:null,format:"Anime",overview:"",identifiers:{anidb:"3"}}]}]});
 vi.mocked(nativeLibraries.identify).mockResolvedValue({entry,warnings:[],message:"Saved"});
 render(<IdentifyPanel library={library} entry={entry} busy={false} onSaved={saved}/>);
 expect((screen.getByLabelText("Identification title") as HTMLInputElement).value).toBe("Haikyu!");
 fireEvent.click(screen.getByText("Search all providers"));
 fireEvent.click(await screen.findByText("Haikyu!"));
 await waitFor(()=>expect(screen.queryByText("Finding linked provider IDs…")).toBeNull());
 fireEvent.click(screen.getByText("Japanese provider title"));
 await waitFor(()=>expect(screen.queryByText("Finding linked provider IDs…")).toBeNull());
 expect((screen.getByLabelText("Identification title") as HTMLInputElement).value).toBe("Haikyu!");
 expect((screen.getByLabelText("MyAnimeList identification ID") as HTMLInputElement).value).toBe("2");
 expect((screen.getByLabelText("AniDB identification ID") as HTMLInputElement).value).toBe("3");
 fireEvent.click(screen.getByText("Save identification"));await waitFor(()=>expect(saved).toHaveBeenCalled());
 expect(nativeLibraries.identify).toHaveBeenCalledWith("lib","item",expect.objectContaining({revision:3,title:"Haikyu!",identifiers:{anilist:"1",mal:"2",anidb:"3"}}));
});
it("shows unavailable providers and blocks saving during scans",async()=>{
 vi.mocked(nativeLibraries.identifySearch).mockResolvedValue({groups:[{provider:"tvdb",results:[],error:"Configure credentials"}]});
 render(<IdentifyPanel library={library} entry={entry} busy onSaved={()=>{}}/>);
 fireEvent.click(screen.getByText("Search all providers"));expect(await screen.findByText("Configure credentials")).toBeTruthy();
 fireEvent.change(screen.getByLabelText("AniDB identification ID"),{target:{value:"3"}});expect((screen.getByText("Save identification") as HTMLButtonElement).disabled).toBe(true);
});

it("shows posters and prefers automatically linked matches before other results",async()=>{
 const candidate={provider:"tmdb",id:"1",title:"Correct show",year:2014,format:"Series",overview:null,poster:"https://image.tmdb.org/t/p/w342/test.jpg",identifiers:{tmdb:"1"}};
 const linked={...candidate,provider:"tvdb",id:"2",identifiers:{tvdb:"2"}};
 vi.mocked(nativeLibraries.identifySearch).mockResolvedValue({groups:[{provider:"tmdb",results:[candidate]},{provider:"tvdb",results:[{...linked,id:"99",title:"Wrong show",identifiers:{tvdb:"99"}}]}]});
 vi.mocked(nativeLibraries.identifyResolve).mockResolvedValue({identifiers:{tmdb:"1",tvdb:"2"},candidates:[candidate,linked],warnings:[]});
 render(<IdentifyPanel library={library} entry={entry} busy={false} onSaved={()=>{}}/>);
 fireEvent.click(screen.getByText("Search all providers"));fireEvent.click((await screen.findAllByText("Correct show"))[0]);
 await waitFor(()=>expect((screen.getByLabelText("TheTVDB identification ID") as HTMLInputElement).value).toBe("2"));
 expect(screen.getAllByAltText("Correct show poster").length).toBeGreaterThan(0);
 
 expect(screen.getByRole("region",{name:"TheTVDB matches"}).querySelector("button")?.textContent).toContain("Linked match");
 expect((screen.getByLabelText("Identification title") as HTMLInputElement).value).toBe("Haikyu!");
});

it("identifies book series with ComicVine first and manga providers only",async()=>{
 const book={...entry,kind:"book_series",title:"Batman",metadata:{}};
 const match={provider:"comicvine",id:"123",title:"Batman",year:2016,format:"Book series",publisher:"DC Comics",volume_count:12,overview:null,identifiers:{comicvine:"123"}};
 vi.mocked(nativeLibraries.identifySearch).mockResolvedValue({groups:[{provider:"comicvine",results:[match]},{provider:"anilist",results:[]},{provider:"mal",results:[]}]});
 vi.mocked(nativeLibraries.identifyResolve).mockResolvedValue({identifiers:{comicvine:"123"},candidates:[match],warnings:[]});
 vi.mocked(nativeLibraries.identify).mockResolvedValue({entry:book,warnings:[],message:"Saved"});
 render(<IdentifyPanel library={{...library,library_type:"books"}} entry={book} busy={false} onSaved={()=>{}}/>);
 expect(screen.queryByLabelText("TheTVDB identification ID")).toBeNull();
 fireEvent.click(screen.getByText("Search all providers"));
 expect(await screen.findByRole("region",{name:"ComicVine matches"})).toBeTruthy();
 expect(screen.getByText("Publisher: DC Comics")).toBeTruthy();expect(screen.getByText("12 volumes")).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:/Batman.*2016/}));
 await waitFor(()=>expect(screen.queryByText("Finding linked provider IDs…")).toBeNull());
 fireEvent.click(screen.getByText("Save identification"));
 await waitFor(()=>expect(nativeLibraries.identify).toHaveBeenCalledWith("lib","item",expect.objectContaining({identifiers:{comicvine:"123"}})));
});

it("hides excluded book providers and supports a local-only library",()=>{
 const book={...entry,kind:"book_series"};
 const view=render(<IdentifyPanel library={{...library,options:{...defaultNativeOptions,metadata_providers:{book_series:["comicvine"]}}} as NativeLibrary} entry={book} busy={false} onSaved={()=>{}}/>);
 expect(screen.getByLabelText("ComicVine identification ID")).toBeTruthy();
 expect(screen.queryByLabelText("AniList identification ID")).toBeNull();
 expect(screen.queryByLabelText("MyAnimeList identification ID")).toBeNull();
 view.unmount();
 render(<IdentifyPanel library={{...library,options:{...defaultNativeOptions,metadata_providers:{book_series:[]}}} as NativeLibrary} entry={book} busy={false} onSaved={()=>{}}/>);
 expect((screen.getByText("Search all providers") as HTMLButtonElement).disabled).toBe(true);
 expect(screen.getByText(/No book metadata providers are enabled/)).toBeTruthy();
});

it("previews a pasted ComicVine series URL and saves its canonical ID",async()=>{
 const book={...entry,kind:"book_series"};const match={provider:"comicvine",id:"72430",title:"Food Wars!",year:2012,format:"Book series",overview:null,identifiers:{comicvine:"72430"}};
 vi.mocked(nativeLibraries.identifyResolve).mockResolvedValue({identifiers:{comicvine:"72430"},candidates:[match],warnings:[]});
 render(<IdentifyPanel library={library} entry={book} busy={false} onSaved={()=>{}}/>);
 fireEvent.change(screen.getByLabelText("ComicVine identification ID"),{target:{value:"https://comicvine.gamespot.com/food-wars/4050-72430/"}});
 fireEvent.click(screen.getByRole("button",{name:"Find ComicVine record"}));
 await screen.findByText("Selected match: Food Wars!");
 expect((screen.getByLabelText("ComicVine identification ID") as HTMLInputElement).value).toBe("72430");
});


it("loads AniDB posters when its results tab opens",async()=>{
 vi.mocked(apiRequest).mockResolvedValue({poster:"https://cdn-eu.anidb.net/images/main/123.jpg"});
 vi.mocked(nativeLibraries.identifySearch).mockResolvedValue({groups:[{provider:"anidb",results:[{provider:"anidb",id:"10901",title:"Food Wars",year:null,format:"Anime",overview:"",identifiers:{anidb:"10901"}}]}]});
 render(<IdentifyPanel library={library} entry={entry} busy={false} onSaved={vi.fn()}/>);
 fireEvent.click(screen.getByText("Search all providers"));
 expect((await screen.findByAltText("Food Wars poster")).getAttribute("src")).toBe("https://cdn-eu.anidb.net/images/main/123.jpg");
 expect(apiRequest).toHaveBeenCalledWith("/native/identify/anidb/10901/poster");
});

it("hides anime provider ID fields in a movie library",()=>{
 render(<IdentifyPanel library={{...library,library_type:"movies"}} entry={{...entry,kind:"movie"}} busy={false} onSaved={vi.fn()}/>);
 expect(screen.queryByLabelText("AniDB identification ID")).toBeNull();expect(screen.queryByLabelText("AniList identification ID")).toBeNull();expect(screen.queryByLabelText("MyAnimeList identification ID")).toBeNull();expect(screen.getByLabelText("TheTVDB identification ID")).toBeTruthy();
});

it("populates saved provider IDs and previews their own records without changing linked IDs",async()=>{
 vi.mocked(nativeLibraries.identifyResolve).mockImplementation(async(_lib,_item,provider,id)=>({identifiers:{tvdb:"unwanted"},warnings:[],candidates:[{provider,id,title:`${provider} record`,year:2000,format:"TV",overview:null,poster:`https://example.com/${provider}.jpg`,identifiers:{[provider]:id}}]}));
 render(<IdentifyPanel library={library} entry={{...entry,metadata:{identifiers:{anilist:"1281",tvdb:"82234"}}}} busy={false} onSaved={()=>{}}/>);
 expect(screen.getByLabelText("AniList identification ID")).toHaveProperty("value","1281");
 expect(screen.getByLabelText("TheTVDB identification ID")).toHaveProperty("value","82234");
 expect(await screen.findByAltText("AniList: anilist record poster")).toHaveProperty("src","https://example.com/anilist.jpg");
 expect(screen.getByLabelText("TheTVDB identification ID")).toHaveProperty("value","82234");
 fireEvent.change(screen.getByLabelText("AniList identification ID"),{target:{value:"999"}});
 await waitFor(()=>expect(nativeLibraries.identifyResolve).toHaveBeenCalledWith("lib","item","anilist","999"));
 fireEvent.change(screen.getByLabelText("AniList identification ID"),{target:{value:""}});
 expect(screen.queryByLabelText("AniList ID preview")).toBeNull();
});

it("resolves IMDb previews by exact ID without title search",async()=>{
 vi.mocked(nativeLibraries.identifyResolve).mockResolvedValue({identifiers:{imdb:"tt2560140"},warnings:[],candidates:[{provider:"tvdb",id:"267440",title:"Attack on Titan",year:2013,poster:"https://example.com/aot.jpg",format:"Series",overview:null,identifiers:{tvdb:"267440",imdb:"tt2560140"}}]});
 render(<IdentifyPanel library={library} entry={{...entry,metadata:{identifiers:{imdb:"tt2560140"}}}} busy={false} onSaved={()=>{}}/>);
 expect(await screen.findByAltText("IMDb: Attack on Titan poster")).toBeTruthy();
 expect(nativeLibraries.identifyResolve).toHaveBeenCalledWith("lib","item","imdb","tt2560140");
 expect(nativeLibraries.identifySearch).not.toHaveBeenCalled();
});

it("searches only missing IDs and saves additions without changing identity metadata",async()=>{
 const current={...entry,metadata:{identifiers:{anilist:"1281",tvdb:"82234"},plot:"Keep description"}};
 const match={provider:"mal",id:"1281",title:"Ghost Stories",year:2000,format:"TV",overview:null,identifiers:{mal:"1281",anilist:"wrong"}};
 vi.mocked(nativeLibraries.identifySearch).mockResolvedValue({groups:[{provider:"mal",results:[match]}]});
 vi.mocked(nativeLibraries.identifyResolve).mockImplementation(async(_l,_i,provider)=>provider==="anilist"?{identifiers:{anilist:"1281"},candidates:[],warnings:[]}:{identifiers:match.identifiers,candidates:[match],warnings:[]});
 vi.mocked(nativeLibraries.editItem).mockResolvedValue({entry:current,warnings:[]});
 render(<IdentifyPanel library={library} entry={current} busy={false} onSaved={()=>{}}/>);
 fireEvent.click(screen.getByRole("button",{name:"Search missing IDs"}));
 await waitFor(()=>expect(nativeLibraries.identifySearch).toHaveBeenCalledWith("lib","item","Haikyu!",null,{providers:["tmdb","mal","imdb","anidb"]}));
 fireEvent.click((await screen.findAllByText("Ghost Stories"))[0]);
 await waitFor(()=>expect(screen.queryByText("Finding linked provider IDs…")).toBeNull());
 expect(screen.getByLabelText("AniList identification ID")).toHaveProperty("value","1281");
 fireEvent.click(screen.getByRole("button",{name:"Save identification"}));
 await waitFor(()=>expect(nativeLibraries.editItem).toHaveBeenCalledWith("lib",current,{identifiers:{anilist:"1281",tvdb:"82234",mal:"1281"}}));
 expect(nativeLibraries.identify).not.toHaveBeenCalled();
});

it("fills a missing MAL ID from the saved AniList link without a MAL title search",async()=>{
 const current={...entry,metadata:{identifiers:{anilist:"1281",tvdb:"82234",tmdb:"35466",imdb:"tt0285368",anidb:"481"}}};
 vi.mocked(nativeLibraries.identifyResolve).mockResolvedValue({identifiers:{anilist:"1281",mal:"1281"},candidates:[],warnings:[]});
 render(<IdentifyPanel library={library} entry={current} busy={false} onSaved={()=>{}}/>);
 fireEvent.click(screen.getByRole("button",{name:"Search missing IDs"}));
 await waitFor(()=>expect(screen.getByLabelText("MyAnimeList identification ID")).toHaveProperty("value","1281"));
 expect(nativeLibraries.identifySearch).not.toHaveBeenCalled();
 expect(screen.getByLabelText("TheTVDB identification ID")).toHaveProperty("value","82234");
});

it("places four results under the provider ID and reveals additional matches on demand",async()=>{
 const results=Array.from({length:6},(_,i)=>({provider:"mal",id:String(i+1),title:`Match ${i+1}`,year:2000,format:"TV",overview:null,identifiers:{mal:String(i+1)}}));
 vi.mocked(nativeLibraries.identifySearch).mockResolvedValue({groups:[{provider:"mal",results}]});
 render(<IdentifyPanel library={library} entry={{...entry,metadata:{}}} busy={false} onSaved={()=>{}}/>);
 fireEvent.click(screen.getByRole("button",{name:"Search all providers"}));
 const region=await screen.findByRole("region",{name:"MyAnimeList matches"});
 expect(region.parentElement?.querySelector('input[aria-label="MyAnimeList identification ID"]')).toBeTruthy();
 expect(region.querySelectorAll('button[aria-pressed]').length).toBe(4);
 expect(screen.queryByText("Match 5")).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"Show more MyAnimeList matches"}));
 expect(region.querySelectorAll('button[aria-pressed]').length).toBe(6);
 expect(screen.queryByRole("tablist")).toBeNull();
});
