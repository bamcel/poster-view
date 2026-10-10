import {render, screen, cleanup, fireEvent} from "@testing-library/react";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {MemoryRouter, Routes, Route} from "react-router-dom";
import {afterEach, it, expect, vi} from "vitest";
import HomePage from "./HomePage";
import {nativeLibraries} from "../api/nativeLibraries";
vi.mock("../api/nativeLibraries",()=>({nativeLibraries:{list:vi.fn()}}));
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
