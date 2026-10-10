import {render, screen, cleanup, fireEvent} from "@testing-library/react";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {MemoryRouter, Routes, Route} from "react-router-dom";
import {afterEach, it, expect, vi} from "vitest";
import HomePage from "./HomePage";
import {nativeLibraries} from "../api/nativeLibraries";
vi.mock("../api/nativeLibraries",()=>({nativeLibraries:{list:vi.fn(),catalog:vi.fn(),artworkUrl:vi.fn()}}));
vi.mock("../components/LibraryPosterStrip",()=>({default:({library}:{library:string})=><div data-testid={`collage-${library}`}>Shared collage</div>}));
vi.mock("./DashboardPage",()=>({default:()=> <div>Legacy library</div>}));
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
 expect(nativeLibraries.catalog).not.toHaveBeenCalled();
 fireEvent.change(screen.getByRole("textbox",{name:"Search all libraries"}),{target:{value:"HARRY"}});
 const tv=await screen.findByRole("link",{name:"Open Harry Show in TV Series"});
 expect(tv.getAttribute("href")).toBe("/media/tv?native_library=tv&native_item=tv-item");
 expect(await screen.findByRole("link",{name:"Open Different title in Books"})).toBeTruthy();
 expect(screen.queryByText("Harry missing")).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"Clear search"}));
 expect(screen.getByTestId("collage-tv")).toBeTruthy();
});
it("reports a failed library search while keeping successful matches",async()=>{
 vi.mocked(nativeLibraries.list).mockResolvedValue([{id:"tv",name:"TV Series"},{id:"books",name:"Books"}] as Awaited<ReturnType<typeof nativeLibraries.list>>);
 vi.mocked(nativeLibraries.catalog).mockImplementation(async library=>{if(library==="tv")throw new Error("Unavailable");return [{...entryDefaults,id:"1",title:"Harry",kind:"book",available:true,metadata:{},artwork:[]}] as Awaited<ReturnType<typeof nativeLibraries.catalog>>;});
 mount();await screen.findByRole("link",{name:"Open Books"});
 fireEvent.change(screen.getByRole("textbox",{name:"Search all libraries"}),{target:{value:"Harry"}});
 expect(await screen.findByRole("link",{name:"Open Harry in Books"})).toBeTruthy();
 expect(await screen.findByRole("alert")).toBeTruthy();
});
