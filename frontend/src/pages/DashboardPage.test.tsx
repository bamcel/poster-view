import {cleanup,render,screen,waitFor} from "@testing-library/react";
import {MemoryRouter,useLocation,Routes,Route} from "react-router-dom";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {afterEach,expect,it,vi} from "vitest";
import {useSearchParams} from "../lib/libraryNavigation";
import DashboardPage from "./DashboardPage";
import {nativeLibraries,defaultNativeOptions,defaultServerSync,type NativeLibrary} from "../api/nativeLibraries";
vi.mock("../api/nativeLibraries",async original=>({...await original<typeof import("../api/nativeLibraries")>(),nativeLibraries:{list:vi.fn(),status:vi.fn(),catalog:vi.fn(async()=>[])}}));
vi.mock("../components/NativeLibraryBrowser",()=>({default:({library}:{library:NativeLibrary})=>{const [params]=useSearchParams();return <><p>Catalog {library.name}</p><span data-testid="selected">{params.get("native_item")}</span></>;}}));
const library:NativeLibrary={id:"anime",name:"Anime",library_type:"anime",anime_content:"both",paths:["Anime"],revision:1,created_at:"",updated_at:"",options:{...defaultNativeOptions,server_sync:{...defaultServerSync,enabled:true,server_id:1,library_id:"80197"}}};
function Location(){const location=useLocation();return <output>{location.pathname}{location.search}</output>;}
function mount(url="/"){return render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MemoryRouter initialEntries={[url]}><Routes><Route path="/" element={<DashboardPage/>}/><Route path="/media/:libraryId" element={<DashboardPage/>}/><Route path="/media/:libraryId/:itemSlug" element={<DashboardPage/>}/></Routes><Location/></MemoryRouter></QueryClientProvider>);}
afterEach(()=>{cleanup();vi.clearAllMocks();localStorage.clear();});
it("uses only PosterView libraries and redirects an old server library URL to its mapping",async()=>{
 vi.mocked(nativeLibraries.list).mockResolvedValue([library]);vi.mocked(nativeLibraries.status).mockResolvedValue({status:"complete",count:1,warnings:[]});mount("/?lib=80197");
 await screen.findByText("Catalog Anime");await waitFor(()=>expect(screen.getByRole("status").textContent).toBe("/media/Anime"));
 expect(screen.queryByRole("group",{name:"Libraries"})).toBeNull();
});
it("changes catalog libraries and clears the previous item",async()=>{
 vi.mocked(nativeLibraries.list).mockResolvedValue([library,{...library,id:"movies",name:"Movies"}]);vi.mocked(nativeLibraries.status).mockResolvedValue({status:"complete",count:1,warnings:[]});mount("/media/movies?native_library=movies");
 await screen.findByText("Catalog Movies");await waitFor(()=>expect(screen.getByRole("status").textContent).toBe("/media/Movies"));
});
it("explains importing a library when no catalog exists",async()=>{vi.mocked(nativeLibraries.list).mockResolvedValue([]);mount();expect(await screen.findByText(/Add a library or import a connected server library/)).toBeTruthy();});

it("opens readable series links and canonicalizes legacy item links",async()=>{
 vi.mocked(nativeLibraries.list).mockResolvedValue([library]);
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([{id:"dragon",title:"Dragon Ball",kind:"series",path:"Anime/Dragon Ball",parent_path:null,available:true,files:[],metadata:{},artwork:[],nfo_path:null,revision:1}]);
 mount("/media/anime?native_library=anime&native_item=dragon");
 await waitFor(()=>expect(screen.getByRole("status").textContent).toBe("/media/Anime/Dragon-Ball"));
 expect(screen.getByTestId("selected").textContent).toBe("dragon");
 cleanup();
 mount("/media/Anime/Dragon-Ball");
 await waitFor(()=>expect(screen.getByTestId("selected").textContent).toBe("dragon"));
});
