import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {afterEach,expect,it,vi} from "vitest";
import ImportServerLibrary from "./ImportServerLibrary";
import {api} from "../api/client";
import type {NativeLibraryInput} from "../api/nativeLibraries";
vi.mock("../api/client",()=>({api:{listServers:vi.fn(),getIntegrationLibraries:vi.fn()}}));
vi.mock("./NativeLibrariesSection",()=>({LibraryDialog:({seed}:{seed:NativeLibraryInput})=><output>{JSON.stringify(seed)}</output>}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
it("seeds a PosterView library mapping without reusing server filesystem paths",async()=>{
 vi.mocked(api.listServers).mockResolvedValue([{id:1,name:"Emby",type:"emby"}] as never);
 vi.mocked(api.getIntegrationLibraries).mockResolvedValue([{id:"80197",title:"Anime",type:"show",visible:false}]);
 render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><ImportServerLibrary onClose={vi.fn()} onSaved={vi.fn()}/></QueryClientProvider>);
 await screen.findByRole("option",{name:"Emby"});fireEvent.change(screen.getByLabelText("Import library server"),{target:{value:"1"}});
 await screen.findByRole("option",{name:"Anime"});fireEvent.change(screen.getByLabelText("Library to import"),{target:{value:"80197"}});fireEvent.click(screen.getByRole("button",{name:"Continue to folder mapping"}));
 await waitFor(()=>expect(JSON.parse(screen.getByRole("status").textContent??"{}")).toMatchObject({name:"Anime",library_type:"anime",anime_content:"both",paths:[],options:{fetch_missing:false,server_sync:{server_id:1,library_id:"80197",mode:"import_only",enabled:true}}}));
});
