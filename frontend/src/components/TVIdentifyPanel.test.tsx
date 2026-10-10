import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import type {ReactNode} from "react";
import {cleanup,fireEvent,render as renderUI,screen,waitFor} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import TVIdentifyPanel from "./TVIdentifyPanel";
import {nativeLibraries,type NativeLibrary,type NativeCatalogEntry} from "../api/nativeLibraries";
vi.mock("../api/nativeLibraries",()=>({nativeLibraries:{identifySearch:vi.fn(),identifyResolve:vi.fn().mockResolvedValue({candidates:[]}),identify:vi.fn()}}));
function render(ui:ReactNode){return renderUI(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}>{ui}</QueryClientProvider>);}
afterEach(()=>{cleanup();vi.clearAllMocks();});
const library={id:"shows",library_type:"shows"} as NativeLibrary;const entry={id:"kingdom",kind:"series",path:"TV/Kingdom (2019)",title:"Wrong title",revision:5} as NativeCatalogEntry;
const candidate={id:"123",provider:"tvdb",title:"Kingdom",year:2019,identifiers:{tvdb:"123"},poster:null,format:"Series",overview:null};
it.each([false,true])("searches TVDB, confirms complete replacement and sends artwork preference %s",async replace=>{
 vi.mocked(nativeLibraries.identifySearch).mockResolvedValue({groups:[{provider:"tvdb",results:[candidate]}]} as Awaited<ReturnType<typeof nativeLibraries.identifySearch>>);
 vi.mocked(nativeLibraries.identify).mockResolvedValue({entry,warnings:[],message:"Saved"});const saved=vi.fn();render(<TVIdentifyPanel library={library} entry={entry} busy={false} onSaved={saved}/>);
 expect(screen.queryByLabelText(/AniList|AniDB|MyAnimeList/)).toBeNull();expect((screen.getByLabelText("Identification title") as HTMLInputElement).value).toBe("Kingdom");
 fireEvent.change(screen.getByLabelText("TheTVDB ID"),{target:{value:"123"}});fireEvent.click(screen.getByRole("button",{name:"Search"}));
 fireEvent.click(await screen.findByRole("button",{name:/Kingdom.*2019/}));
 const toggle=screen.getByRole("switch",{name:"Replace existing artwork"});expect(toggle.getAttribute("aria-checked")).toBe("false");if(replace)fireEvent.click(toggle);
 expect(nativeLibraries.identify).not.toHaveBeenCalled();fireEvent.click(screen.getByRole("button",{name:"Replace metadata"}));
 await waitFor(()=>expect(nativeLibraries.identify).toHaveBeenCalledWith("shows","kingdom",{revision:5,title:"Kingdom",year:2019,identifiers:{tvdb:"123"},rewrite_metadata:true,replace_artwork:replace}));await waitFor(()=>expect(saved).toHaveBeenCalledOnce());
});
it("retains the confirmation and reports a save error",async()=>{
 vi.mocked(nativeLibraries.identifySearch).mockResolvedValue({groups:[{provider:"tvdb",results:[candidate]}]} as Awaited<ReturnType<typeof nativeLibraries.identifySearch>>);vi.mocked(nativeLibraries.identify).mockRejectedValue(new Error("Provider unavailable"));
 render(<TVIdentifyPanel library={library} entry={entry} busy={false} onSaved={vi.fn()}/>);fireEvent.click(screen.getByRole("button",{name:"Search"}));fireEvent.click(await screen.findByRole("button",{name:/Kingdom.*2019/}));fireEvent.click(screen.getByRole("button",{name:"Replace metadata"}));expect(await screen.findByRole("alert")).toHaveProperty("textContent","Provider unavailable");expect(screen.getByRole("button",{name:"Replace metadata"})).toBeTruthy();
});
