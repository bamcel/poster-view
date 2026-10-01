import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import IdentifyPanel from "./IdentifyPanel";
import {nativeLibraries,type NativeLibrary,type NativeCatalogEntry} from "../api/nativeLibraries";
vi.mock("../api/nativeLibraries",()=>({nativeLibraries:{identifySearch:vi.fn(),identify:vi.fn()}}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
const library={id:"lib",library_type:"anime"} as NativeLibrary;
const entry={id:"item",title:"Haikyu! (2024)",path:"Anime/Haikyu",kind:"series",revision:3,parent_path:null,artwork:[],files:[],nfo_path:null,available:true,metadata:{identifiers:{tvdb:"wrong"}}} as NativeCatalogEntry;
it("searches together and saves reviewed AniDB and linked IDs",async()=>{
 const saved=vi.fn();
 vi.mocked(nativeLibraries.identifySearch).mockResolvedValue({groups:[{provider:"anilist",results:[{provider:"anilist",id:"1",title:"Haikyu!",year:2014,format:"TV",overview:"Volleyball",identifiers:{anilist:"1",mal:"2"}}]},{provider:"anidb",results:[{provider:"anidb",id:"3",title:"Haikyuu!!",year:null,format:"Anime",overview:"",identifiers:{anidb:"3"}}]}]});
 vi.mocked(nativeLibraries.identify).mockResolvedValue({entry,warnings:[],message:"Saved"});
 render(<IdentifyPanel library={library} entry={entry} busy={false} onSaved={saved}/>);
 expect((screen.getByLabelText("Identification title") as HTMLInputElement).value).toBe("Haikyu!");
 fireEvent.click(screen.getByText("Search all providers"));
 fireEvent.click(await screen.findByText("Haikyu!"));fireEvent.click(screen.getByText("Haikyuu!!"));
 expect((screen.getByLabelText("MyAnimeList identification ID") as HTMLInputElement).value).toBe("2");
 expect((screen.getByLabelText("AniDB identification ID") as HTMLInputElement).value).toBe("3");
 fireEvent.click(screen.getByText("Save identification"));await waitFor(()=>expect(saved).toHaveBeenCalled());
 expect(nativeLibraries.identify).toHaveBeenCalledWith("lib","item",expect.objectContaining({revision:3,identifiers:{anilist:"1",mal:"2",anidb:"3"}}));
});
it("shows unavailable providers and blocks saving during scans",async()=>{
 vi.mocked(nativeLibraries.identifySearch).mockResolvedValue({groups:[{provider:"tvdb",results:[],error:"Configure credentials"}]});
 render(<IdentifyPanel library={library} entry={entry} busy onSaved={()=>{}}/>);
 fireEvent.click(screen.getByText("Search all providers"));expect(await screen.findByText("Configure credentials")).toBeTruthy();
 fireEvent.change(screen.getByLabelText("AniDB identification ID"),{target:{value:"3"}});expect((screen.getByText("Save identification") as HTMLButtonElement).disabled).toBe(true);
});
