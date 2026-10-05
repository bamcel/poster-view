import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import IdentifyPanel from "./IdentifyPanel";
import {nativeLibraries,type NativeLibrary,type NativeCatalogEntry} from "../api/nativeLibraries";
vi.mock("../api/nativeLibraries",()=>({nativeLibraries:{identifySearch:vi.fn(),identifyResolve:vi.fn(),identify:vi.fn()}}));
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
 fireEvent.click(screen.getByRole("tab",{name:/AniDB/}));fireEvent.click(screen.getByText("Japanese provider title"));
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
 fireEvent.click(screen.getByText("Search all providers"));fireEvent.click(await screen.findByText("Correct show"));
 await waitFor(()=>expect((screen.getByLabelText("TheTVDB identification ID") as HTMLInputElement).value).toBe("2"));
 expect(screen.getAllByAltText("Correct show poster").length).toBeGreaterThan(0);
 fireEvent.click(screen.getByRole("tab",{name:/TheTVDB/}));
 expect(screen.getByRole("tabpanel").querySelector("button")?.textContent).toContain("Linked match");
 expect((screen.getByLabelText("Identification title") as HTMLInputElement).value).toBe("Haikyu!");
});

it("identifies book series with ComicVine first and manga providers only",async()=>{
 const book={...entry,kind:"book_series",title:"Batman",metadata:{}};
 const match={provider:"comicvine",id:"123",title:"Batman",year:2016,format:"Book series",overview:null,identifiers:{comicvine:"123"}};
 vi.mocked(nativeLibraries.identifySearch).mockResolvedValue({groups:[{provider:"comicvine",results:[match]},{provider:"anilist",results:[]},{provider:"mal",results:[]}]});
 vi.mocked(nativeLibraries.identifyResolve).mockResolvedValue({identifiers:{comicvine:"123"},candidates:[match],warnings:[]});
 vi.mocked(nativeLibraries.identify).mockResolvedValue({entry:book,warnings:[],message:"Saved"});
 render(<IdentifyPanel library={{...library,library_type:"books"}} entry={book} busy={false} onSaved={()=>{}}/>);
 expect(screen.queryByLabelText("TheTVDB identification ID")).toBeNull();
 fireEvent.click(screen.getByText("Search all providers"));
 expect((await screen.findAllByRole("tab"))[0].textContent).toContain("ComicVine");
 fireEvent.click(screen.getByRole("button",{name:/Batman.*2016/}));
 await waitFor(()=>expect(screen.queryByText("Finding linked provider IDs…")).toBeNull());
 fireEvent.click(screen.getByText("Save identification"));
 await waitFor(()=>expect(nativeLibraries.identify).toHaveBeenCalledWith("lib","item",expect.objectContaining({identifiers:{comicvine:"123"}})));
});
