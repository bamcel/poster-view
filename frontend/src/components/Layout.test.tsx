import HeaderSearchControl from "./HeaderSearchControl";
import {LibraryPageBack} from "../lib/libraryHeaderBack";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import type {ReactNode} from "react";
import { cleanup, fireEvent, render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, Link } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import AuthGate from "./AuthGate";
import Layout from "./Layout";
import { api } from "../api/client";
import {virtualTv} from "../features/virtual-tv/client";
vi.mock("../features/virtual-tv/client",()=>({virtualTv:{settings:vi.fn(async()=>({enabled:false}))}}));

vi.mock("../api/nativeLibraries",()=>({nativeLibraries:{list:vi.fn(async()=>[])}}));
vi.mock("../features/settings/ytdl/client",()=>({ytdl:{jobs:vi.fn(async()=>[])}}));
function render(node:ReactNode){return rtlRender(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}>{node}</QueryClientProvider>);}

vi.mock("../api/client", () => ({ api: { authStatus: vi.fn() } }));
vi.mock("../lib/serverContext", () => ({ useServers: () => ({ servers: [], selectedId: 7, setSelectedId: vi.fn() }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); sessionStorage.clear();localStorage.clear(); });

it.each([true,false])("shows the Virtual TV sidebar page only when enabled (%s)",async(enabled)=>{
 vi.mocked(virtualTv.settings).mockResolvedValue({enabled});
 vi.mocked(api.authStatus).mockResolvedValue({authenticated:true,password_required:false});
 render(<MemoryRouter initialEntries={["/media/example"]}><AuthGate><Layout/></AuthGate></MemoryRouter>);
 await screen.findByRole("link",{name:"Settings"});
 await waitFor(()=>expect(screen.queryAllByRole("link",{name:"Virtual TV"}).length).toBe(enabled?2:0));
 vi.mocked(virtualTv.settings).mockResolvedValue({enabled:false});
});

function CurrentLocation() {
  const location = useLocation();
  return <p>{location.pathname}{location.search}</p>;
}

it("keeps homepage navigation open without collapse controls or stored-state effects",async()=>{
 vi.mocked(api.authStatus).mockResolvedValue({authenticated:true,password_required:false});
 localStorage.setItem("posterview:homepage-navigation:local","collapsed");
 const mount=()=>render(<MemoryRouter><AuthGate><Layout><p>Homepage content</p></Layout></AuthGate></MemoryRouter>);
 const first=mount();
 const panel=await screen.findByRole("complementary",{name:"Navigation"});
 expect(within(panel).getByRole("link",{name:"Home"})).toBeTruthy();
 expect(screen.queryByRole("button",{name:/Open navigation|Collapse navigation|Close navigation/})).toBeNull();
 fireEvent.keyDown(window,{key:"Escape"});expect(screen.getByRole("complementary",{name:"Navigation"})).toBeTruthy();
 first.unmount();mount();expect(await screen.findByRole("complementary",{name:"Navigation"})).toBeTruthy();
});

it("offers separate Playback preferences and Transcoding policy in navigation",async()=>{
  vi.mocked(api.authStatus).mockResolvedValue({authenticated:true,password_required:false});
  render(<MemoryRouter initialEntries={["/settings/playback"]}><AuthGate><Layout/></AuthGate></MemoryRouter>);
  expect(await screen.findByRole("link",{name:"Playback"})).toBeTruthy();
  expect(screen.getByRole("link",{name:"Playback & transcoding"}).getAttribute("href")).toBe("/settings/transcoding");
  expect(screen.getByRole("option",{name:"Playback & transcoding"})).toBeTruthy();
});

it.each([true, false])("shows Sign out only when password_required is true (%s)", async (required) => {
  vi.mocked(api.authStatus).mockResolvedValue({ authenticated: true, password_required: required });
  render(<MemoryRouter><AuthGate><Layout /></AuthGate></MemoryRouter>);
  await screen.findByRole("link", {name:"Settings"});
  fireEvent.click(screen.getByLabelText("Profile"));
  expect(screen.queryAllByRole("button", { name: "Sign out" })).toHaveLength(required ? 1 : 0);
});

it("updates the profile sign-out control when the security policy changes", async () => {
  vi.mocked(api.authStatus).mockResolvedValue({ authenticated: true, password_required: true });
  render(<MemoryRouter><AuthGate><Layout /></AuthGate></MemoryRouter>);
  await screen.findByRole("link", {name:"Settings"});
  fireEvent.click(screen.getByLabelText("Profile"));
  expect(screen.getAllByRole("button", {name:"Sign out"})).toHaveLength(1);
  vi.mocked(api.authStatus).mockResolvedValue({ authenticated: true, password_required: false });
  fireEvent(window, new Event("posterview:security-changed"));
  await waitFor(() => expect(screen.queryAllByRole("button", { name: "Sign out" })).toHaveLength(0));
});

it("returns to the PosterView dashboard instead of a server catalog", async () => {
  vi.mocked(api.authStatus).mockResolvedValue({ authenticated: true, password_required: false });
  render(
    <MemoryRouter initialEntries={["/server/7/item/classroom?return_library=novels"]}>
      <AuthGate>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/server/:serverId/item/:itemId" element={<CurrentLocation />} />
            <Route path="/settings" element={<CurrentLocation />} /><Route path="/" element={<CurrentLocation />} />
          </Route>
        </Routes>
      </AuthGate>
    </MemoryRouter>,
  );

  await screen.findByText("/server/7/item/classroom?return_library=novels");
  expect(screen.queryByRole("link", {name:"Overview"})).toBeNull();
  fireEvent.click(screen.getByRole("link", {name: "Settings"}));
  await screen.findByText("/settings");
  expect(screen.getByRole("link", {name:"Overview"})).toBeTruthy();
  fireEvent.click(screen.getAllByRole("link", {name:"Home"})[0]);
  expect(await screen.findByText("/")).toBeTruthy();
  expect(screen.queryByRole("link", {name:"Overview"})).toBeNull();
});

it("makes both PosterView logos link to the Dashboard root", async () => {
  vi.mocked(api.authStatus).mockResolvedValue({ authenticated: true, password_required: false });
  sessionStorage.setItem("posterview.libraryTab.7", "manga");
  sessionStorage.setItem("posterview.dashboardLocation.7", "/server/7/item/manga");
  render(
    <MemoryRouter initialEntries={["/settings"]}>
      <AuthGate>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<CurrentLocation />} />
            <Route path="/settings" element={<CurrentLocation />} />
          </Route>
        </Routes>
      </AuthGate>
    </MemoryRouter>,
  );

  const logoLinks = await screen.findAllByRole("link", { name: "Go to Home" });
  expect(logoLinks).toHaveLength(2);
  fireEvent.click(logoLinks[0]);
  expect(await screen.findByText("/")).toBeTruthy();
  expect(screen.queryByLabelText("Active server")).toBeNull();
});

it("shows user navigation without administrator controls",async()=>{
  vi.mocked(api.authStatus).mockResolvedValue({authenticated:true,user:{id:"viewer",username:"viewer",display_name:"Viewer",role:"user",enabled:true,revision:1,created_at:"",permissions:{all_libraries:true,library_ids:[],max_movie_rating:null,max_tv_rating:null,allow_unrated:false}}});
  render(<MemoryRouter initialEntries={["/settings/playback"]}><AuthGate><Layout/></AuthGate></MemoryRouter>);
  expect(await screen.findByRole("link",{name:"Playback"})).toBeTruthy();
  expect(screen.getByRole("link",{name:"Reading"})).toBeTruthy();
  for(const label of ["Users","Plugins","Artwork","Dashboard","Search Providers","Scheduled Tasks","Appearance","Privacy / Security"])expect(screen.queryByRole("link",{name:label})).toBeNull();
  expect(screen.queryByRole("link",{name:"Playback & transcoding"})).toBeNull();
  expect(screen.queryByRole("link",{name:"Libraries"})).toBeNull();
  expect(screen.getByRole("link",{name:"Settings"}).getAttribute("href")).toBe("/settings/playback");
  fireEvent.click(screen.getByLabelText("Profile"));
  expect(screen.getByText("Viewer")).toBeTruthy();
});

it("orders Preferences, Profile, Settings and opens personal preference links",async()=>{
 vi.mocked(api.authStatus).mockResolvedValue({authenticated:true,password_required:false});
 render(<MemoryRouter><AuthGate><Layout/></AuthGate></MemoryRouter>);
 const preferences=await screen.findByLabelText("Preferences");
 const profile=screen.getByLabelText("Profile");const settings=screen.getByRole("link",{name:"Settings"});
 expect(preferences.compareDocumentPosition(profile)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 expect(profile.compareDocumentPosition(settings)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 fireEvent.click(preferences);
 const navigation=screen.getByRole("navigation",{name:"Personal preferences"});
 expect(within(navigation).getByRole("link",{name:"Playback preferences"}).getAttribute("href")).toBe("/settings/playback");
 expect(within(navigation).getByRole("link",{name:"Reading preferences"}).getAttribute("href")).toBe("/settings/reading");
 fireEvent.keyDown(window,{key:"Escape"});
 expect(preferences.closest("details")?.open).toBe(false);
 expect(document.activeElement).toBe(preferences);
});

it("does not offer the retired headline artwork preference",async()=>{
 vi.mocked(api.authStatus).mockResolvedValue({authenticated:true,password_required:false});
 render(<MemoryRouter><AuthGate><Layout/></AuthGate></MemoryRouter>);
 fireEvent.click(await screen.findByLabelText("Preferences"));
 expect(screen.queryByRole("combobox",{name:"Headline artwork"})).toBeNull();
});

it("returns from a library to the homepage using the header back button",async()=>{
 vi.mocked(api.authStatus).mockResolvedValue({authenticated:true,password_required:false});
 render(<MemoryRouter initialEntries={["/media/Anime"]}><AuthGate><Layout><CurrentLocation/></Layout></AuthGate></MemoryRouter>);
 const back=await screen.findByRole("link",{name:"Back"});
 expect(back.getAttribute("href")).toBe("/");
 expect(back.className).toContain("size-11");
 fireEvent.click(back);
 await waitFor(()=>expect(screen.queryByRole("link",{name:"Back"})).toBeNull());
 expect(screen.getByText("/")).toBeTruthy();
});

it.each(["/media/Anime/title","/server/7/item/show","/server/7/series/show/season/one"])("keeps only the header Back link on %s",async path=>{
 vi.mocked(api.authStatus).mockResolvedValue({authenticated:true,password_required:false});
 render(<MemoryRouter initialEntries={[path]}><AuthGate><Layout><LibraryPageBack><button>Duplicate Back</button></LibraryPageBack><p>Library details</p></Layout></AuthGate></MemoryRouter>);
 const back=await screen.findByRole("link",{name:"Back"});
 expect(back.getAttribute("href")).not.toBe(path);
 expect(screen.queryByRole("button",{name:"Duplicate Back"})).toBeNull();
});

it("places library search in the same header as navigation and account controls",async()=>{
 vi.mocked(api.authStatus).mockResolvedValue({authenticated:true,password_required:false});
 render(<MemoryRouter initialEntries={["/media/Anime/season"]}><AuthGate><Layout><HeaderSearchControl><input aria-label="Search episodes"/></HeaderSearchControl></Layout></AuthGate></MemoryRouter>);
 const input=await screen.findByRole("textbox",{name:"Search episodes"});
 expect(within(screen.getByRole("banner")).getByRole("textbox",{name:"Search episodes"})).toBe(input);
 expect(screen.getAllByRole("textbox",{name:"Search episodes"})).toHaveLength(1);
 fireEvent.change(input,{target:{value:"Maomao"}});expect((input as HTMLInputElement).value).toBe("Maomao");
});

it("retraces library, series and season navigation including the original query",async()=>{
 vi.mocked(api.authStatus).mockResolvedValue({authenticated:true,password_required:false});
 render(<MemoryRouter initialEntries={["/media/TV-Series?search=wick"]}><AuthGate><Layout><CurrentLocation/><Link to="/media/TV-Series/Show">Open series</Link><Link to="/media/TV-Series/Show/Season-01">Open season</Link></Layout></AuthGate></MemoryRouter>);
 fireEvent.click(await screen.findByRole("link",{name:"Open series"}));
 await waitFor(()=>expect(screen.getByRole("link",{name:"Back"}).getAttribute("href")).toBe("/media/TV-Series?search=wick"));
 fireEvent.click(screen.getByRole("link",{name:"Open season"}));
 await waitFor(()=>expect(screen.getByRole("link",{name:"Back"}).getAttribute("href")).toBe("/media/TV-Series/Show"));
 fireEvent.click(screen.getByRole("link",{name:"Back"}));
 await waitFor(()=>expect(screen.getByText("/media/TV-Series/Show")).toBeTruthy());
 fireEvent.click(screen.getByRole("link",{name:"Back"}));
 await waitFor(()=>expect(screen.getByRole("link",{name:"Back"}).getAttribute("href")).toBe("/"));
});

it("falls back to the parent series when a season is opened directly",async()=>{
 vi.mocked(api.authStatus).mockResolvedValue({authenticated:true,password_required:false});
 render(<MemoryRouter initialEntries={["/media/TV-Series/Show/Season-01"]}><AuthGate><Layout><CurrentLocation/></Layout></AuthGate></MemoryRouter>);
 fireEvent.click(await screen.findByRole("link",{name:"Back"}));
 await waitFor(()=>expect(screen.getByText("/media/TV-Series/Show")).toBeTruthy());
 fireEvent.click(screen.getByRole("link",{name:"Back"}));
 await waitFor(()=>expect(screen.getByText("/media/TV-Series")).toBeTruthy());
});
