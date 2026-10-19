import {AuthSessionContext} from "../lib/authContext";
import {useArtworkPlugin} from "../lib/artworkPlugin";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import NativeLibraryBrowser from "./NativeLibraryBrowser";
import {collectionsApi} from "../features/collections/client";
vi.mock("../features/collections/client",async original=>{const module=await original<typeof import("../features/collections/client")>();module.collectionsApi.list=vi.fn(async()=>[]);module.collectionsApi.preferences=vi.fn(async()=>({group_collections:false}));module.collectionsApi.setPreferences=vi.fn(async(_id,input)=>input);return module;});
vi.mock("../lib/artworkPlugin",()=>({useArtworkPlugin:vi.fn(()=>({data:{enabled:true}}))}));
vi.mock("../lib/libraryDisplay",()=>({useTrackingOverlays:()=>[true,vi.fn(),{coloredEffect:"both",coloredTitle:true}]}));
vi.mock("./ArtworkPanel", () => ({default: ({serverId, item}: {serverId:number;item:import("../types").ItemDetail}) => <div data-testid="shared-artwork" data-server={serverId} data-item={item.id} data-seasons={item.seasons.map(s=>s.id).join(",")}>Shared artwork lookup</div>}));
import {
  nativeLibraries,
  defaultNativeOptions as importedDefaults,
  type NativeCatalogEntry,
  type NativeLibrary,
} from "../api/nativeLibraries";
vi.mock("../api/nativeLibraries", async (original) => ({
  ...(await original<typeof import("../api/nativeLibraries")>()),
  nativeLibraries: {
    status: vi.fn(),
    catalog: vi.fn(),
    summaries: vi.fn(),
    item: vi.fn(),
    editItem: vi.fn(),
    refreshArtwork: vi.fn(),
    scanFolder: vi.fn(async()=>undefined),
    upload: vi.fn(),
    artworkUrl: vi.fn((l, i, k) => `/art/${l}/${i}/${k}`),
  },
}));
const library: NativeLibrary = {
  id: "native",
  name: "Anime",
  library_type: "anime",
  anime_content: "both",
  paths: ["Anime"],
  revision: 1,
  created_at: "",
  updated_at: "",
};
const series: NativeCatalogEntry = {
  id: "show",
  path: "Anime/Show",
  kind: "series",
  title: "Example Series",
  parent_path: null,
  metadata: {
    title: "Example Series",
    plot: "Series synopsis",
    year: 2024,
    rating: 8.5,
    genres: ["Action"],
    studios: ["Studio"],
  },
  artwork: [{ kind: "poster", path: "poster.jpg", source: "local" }],
  files: [],
  nfo_path: null,
  available: true,
  revision: 1,
};
const season = {
  ...series,
  id: "season",
  path: "Anime/Show/Season 1",
  kind: "season",
  title: "Season 1",
  parent_path: series.path,
  metadata: { season: 1 },
};
const episode = {
  ...series,
  id: "episode",
  path: "Anime/Show/Season 1/S01E01.mkv",
  kind: "episode",
  title: "First Episode",
  parent_path: season.path,
  metadata: {
    title: "First Episode",
    plot: "Episode synopsis",
    season: 1,
    episode: 1,
  },
  artwork: [{ kind: "thumb", path: "S01E01.jpg", source: "local" }],
};
function LocationProbe(){const location=useLocation();return <output data-testid="location">{location.pathname}{location.search}</output>;}
function mount(url = "/", selectedLibrary = library) {
  render(
    <MemoryRouter initialEntries={[url]}>
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <NativeLibraryBrowser library={selectedLibrary} /><LocationProbe/>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}
beforeEach(() => {
  vi.stubGlobal("matchMedia",vi.fn(()=>({matches:true,addEventListener:vi.fn(),removeEventListener:vi.fn()})));
  vi.mocked(collectionsApi.list).mockResolvedValue([]);
  vi.mocked(collectionsApi.preferences).mockResolvedValue({group_collections:false});
  vi.mocked(nativeLibraries.summaries).mockImplementation(id=>nativeLibraries.catalog(id));
  vi.mocked(nativeLibraries.item).mockImplementation(async (_library,id)=>{const result=vi.mocked(nativeLibraries.catalog).mock.results.at(-1);const entries=await result?.value as NativeCatalogEntry[];const entry=entries?.find(entry=>entry.id===id);if(!entry)throw new Error("Missing test item");return entry;});
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  vi.mocked(nativeLibraries.status).mockResolvedValue({
    status: "complete",
    count: 3,
    warnings: [],
  });
  vi.mocked(nativeLibraries.catalog).mockResolvedValue([
    series,
    season,
    episode,
    { ...series, id: "old", title: "NCOP", available: false },
  ]);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  localStorage.clear();
});
function alphabeticalTitles(sorttitle?: string): NativeCatalogEntry[] {
  return ["Dandadan", "The Apothecary Diaries", "Blue Box"].map((title, index) => ({
    ...series, id: `title-${index}`, path: `Anime/Title-${index}`, title,
    metadata: { title, ...(title.startsWith("The ") && sorttitle != null ? {sorttitle} : {}) },
  }));
}
it("retains selected titles while filtering and clears selection with Escape",async()=>{
  vi.mocked(nativeLibraries.catalog).mockResolvedValue(alphabeticalTitles());
  mount();
  fireEvent.click(await screen.findByRole("button",{name:"Select Blue Box"}));
  fireEvent.change(screen.getByRole("textbox",{name:"Search titles"}),{target:{value:"Dandadan"}});
  expect(screen.getByRole("toolbar",{name:"Library selection"}).textContent).toContain("1 selected (1 hidden by filters)");
  fireEvent.click(screen.getByRole("button",{name:"Select all visible"}));
  expect(screen.getByRole("toolbar").textContent).toContain("2 selected");
  fireEvent.keyDown(window,{key:"Escape"});
  expect(screen.queryByRole("toolbar",{name:"Library selection"})).toBeNull();
});
it("keeps the duplicate-add result visible after clearing the library selection",async()=>{
 const collection={id:"group",title:"Anime Collection",overview:"",ordering:"release" as const,revision:1,created_at:"",updated_at:"",members:[{library_id:library.id,item_id:series.id,library_name:library.name,entry:series}]};
 vi.mocked(collectionsApi.list).mockResolvedValue([collection]);
 const add=vi.spyOn(collectionsApi,"addMembers").mockResolvedValue({collection,added:0,existing:1});
 mount();
 fireEvent.click(await screen.findByRole("button",{name:"Select Example Series"}));
 fireEvent.click(screen.getByRole("button",{name:"Add to collection…"}));
 fireEvent.click(await screen.findByLabelText(/Anime Collection/));
 fireEvent.click(screen.getByRole("button",{name:"Add titles"}));
 expect((await within(screen.getByRole("dialog",{name:"Add to collection"})).findByRole("status")).textContent).toContain("0 added, 1 already included");
 expect(screen.getByRole("dialog",{name:"Add to collection"})).toBeTruthy();
 expect(screen.queryByRole("toolbar",{name:"Library selection"})).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"Done"}));
 expect(screen.queryByRole("dialog",{name:"Add to collection"})).toBeNull();
 add.mockRestore();
});

it("groups collection members only when enabled and restores individual search matches",async()=>{
  const entries=alphabeticalTitles();
  vi.mocked(nativeLibraries.catalog).mockResolvedValue(entries);
  vi.mocked(collectionsApi.preferences).mockResolvedValue({group_collections:true});
  vi.mocked(collectionsApi.list).mockResolvedValue([{id:"group",title:"Anime Collection",overview:"",ordering:"release",revision:1,created_at:"",updated_at:"",members:entries.slice(0,2).map(entry=>({library_id:library.id,item_id:entry.id,library_name:library.name,entry}))}]);
  mount();
  await screen.findByRole("link",{name:/Anime Collection/});
  expect(screen.queryByRole("button",{name:"Select Dandadan"})).toBeNull();
  fireEvent.change(screen.getByRole("textbox",{name:"Search titles"}),{target:{value:"Dandadan"}});
  expect(screen.getByRole("button",{name:"Select Dandadan"})).toBeTruthy();
  expect(screen.queryByRole("link",{name:/Anime Collection/})).toBeNull();
});
it("saves grouping preference to the library account preference endpoint",async()=>{
  mount();
  await screen.findByRole("button",{name:"Select Example Series"});
  fireEvent.click(screen.getByRole("button",{name:"Library preferences"}));
  const checkbox=await screen.findByRole("checkbox",{name:"Group titles into collections"});
  await waitFor(()=>expect((checkbox as HTMLInputElement).disabled).toBe(false));
  fireEvent.click(checkbox);
  await waitFor(()=>expect(collectionsApi.setPreferences).toHaveBeenCalledWith(library.id,{group_collections:true}));
  await waitFor(()=>expect((checkbox as HTMLInputElement).checked).toBe(true));
});
it.each(["anime", "shows", "movies", "books"] as const)("sorts %s titles after The while keeping the displayed title", async (library_type) => {
  const kind = library_type === "books" ? "book_series" : library_type === "movies" ? "movie" : "series";
  vi.mocked(nativeLibraries.catalog).mockResolvedValue(alphabeticalTitles().map(entry => ({...entry, kind})));
  mount("/", {...library, library_type});
  await screen.findByRole("button", {name: /Open The Apothecary Diaries/});
  expect(screen.getAllByRole("button", {name: /Open /}).map(button => within(button).getByText(/^(The Apothecary Diaries|Blue Box|Dandadan)$/).textContent))
    .toEqual(["The Apothecary Diaries", "Blue Box", "Dandadan"]);
});
it("uses the imported NFO sort title to retain The in alphabetical order", async () => {
  vi.mocked(nativeLibraries.catalog).mockResolvedValue(alphabeticalTitles("The Apothecary Diaries"));
  mount();
  await screen.findByRole("button", {name: /Open The Apothecary Diaries/});
  expect(screen.getAllByRole("button", {name: /Open /}).map(button => within(button).getByText(/^(The Apothecary Diaries|Blue Box|Dandadan)$/).textContent))
    .toEqual(["Blue Box", "Dandadan", "The Apothecary Diaries"]);
});
it("browses series, seasons and episodes with detail views rather than editors", async () => {
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: /Open Example Series/ }),
  );
  expect(await screen.findByRole("heading", { name: "Example Series" })).toBeTruthy();
  expect(screen.getAllByText("Series synopsis").length).toBeGreaterThan(0);
  expect(screen.getByLabelText("Title information")).toBeTruthy();
  expect(screen.queryByText("Save metadata")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Open Season 1/ }));
  expect(await screen.findByRole("heading", { name: "Episodes" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open First Episode" }));
  expect(await screen.findByRole("heading", { name: "S1:E1 - First Episode" })).toBeTruthy();
  expect(screen.getByText("Episode synopsis")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.getByRole("heading", { name: "Season 1" })).toBeTruthy();
});
it("opens deep links and keeps editing separate from the detail page", async () => {
  mount("/?native_library=native&native_item=show");
  await screen.findByRole("heading", { name: "Example Series" });
  fireEvent.click(screen.getByRole("button", { name: "Edit Metadata" }));
  expect(screen.getByRole("dialog", { name: "Edit Metadata" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Save metadata" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Edit Images" }));
  expect(screen.getByRole("region", { name: "Artwork for Example Series" })).toBeTruthy();
  const panel = screen.getByTestId("shared-artwork");
  expect(panel.getAttribute("data-server")).toBe("0");
  expect(panel.getAttribute("data-item")).toBe("native:native:show");
  expect(panel.getAttribute("data-seasons")).toBe("native:native:season");
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  await waitFor(() => expect(screen.queryByRole("region", {name: "Artwork for Example Series"})).toBeNull());
  expect(screen.getByLabelText("Search titles")).toBeTruthy();
});
it("searches all available titles and filters missing artwork", async () => {
  mount();
  await screen.findByText("Example Series");
  expect(screen.queryByText("NCOP")).toBeNull();
  fireEvent.change(screen.getByLabelText("Search titles"), {
    target: { value: "First Episode" },
  });
  expect(screen.getByText("First Episode")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Search titles"), {
    target: { value: "NCOP" },
  });
  expect(screen.queryByText("NCOP")).toBeNull();
  fireEvent.change(screen.getByLabelText("Search titles"), {
    target: { value: "" },
  });
  fireEvent.click(screen.getByRole("button",{name:"Filter and sort titles"}));
  fireEvent.change(screen.getByLabelText("Filter by artwork"), {
    target: { value: "missing-poster" },
  });
  expect(screen.queryByText("Example Series")).toBeNull();
});

it("opens an old duplicate-series link through its grouped identity", async () => {
  vi.mocked(nativeLibraries.catalog).mockResolvedValue([
    {...series,metadata:{...series.metadata,identifiers:{tvdb:"79525"}}},
    {...series,id:"alternate",path:"Anime/Akito",artwork:[],metadata:{...series.metadata,identifiers:{tvdb:"79525"}}},
    season,episode,
  ]);
  mount("/?native_library=native&native_item=alternate");
  await screen.findByRole("heading",{name:"Example Series"});
  expect(screen.getByRole("button",{name:/Open Season 1/})).toBeTruthy();
});

it("does not reload the catalog when initial scan status is already complete", async () => {
  vi.mocked(nativeLibraries.catalog).mockClear();
  mount();
  await screen.findByText("Example Series");
  expect(nativeLibraries.catalog).toHaveBeenCalledTimes(1);
});

it("refreshes the catalog after an active scan finishes", async () => {
  vi.mocked(nativeLibraries.catalog).mockClear();
  vi.mocked(nativeLibraries.status).mockResolvedValue({status: "scanning", count: 3, warnings: []});
  const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
  render(<MemoryRouter><QueryClientProvider client={client}><NativeLibraryBrowser library={library} /></QueryClientProvider></MemoryRouter>);
  await screen.findByText("Example Series");
  await waitFor(() => expect(client.getQueryData(["native-scan", library.id])).toMatchObject({status: "scanning"}));
  client.setQueryData(["native-scan", library.id], {status: "complete", count: 3, warnings: []});
  await waitFor(() => expect(nativeLibraries.catalog).toHaveBeenCalledTimes(2));
});

it("reuses catalog across navigation remounts and detects artwork changes while away", async () => {
  vi.mocked(nativeLibraries.catalog).mockClear();
  vi.mocked(nativeLibraries.status).mockResolvedValue({status: "complete", count: 3, warnings: [], artwork_revision: "art-1"});
  const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
  const view = () => render(<MemoryRouter><QueryClientProvider client={client}><NativeLibraryBrowser library={library} /></QueryClientProvider></MemoryRouter>);
  const first = view();
  await screen.findByText("Example Series");
  await waitFor(() => expect(client.getQueryData(["native-catalog-artwork-revision", library.id])).toBe("art-1"));
  expect(nativeLibraries.catalog).toHaveBeenCalledTimes(1);
  first.unmount();
  const second = view();
  await screen.findByText("Example Series");
  await waitFor(() => expect(nativeLibraries.status).toHaveBeenCalled());
  expect(nativeLibraries.catalog).toHaveBeenCalledTimes(1);
  second.unmount();
  vi.mocked(nativeLibraries.status).mockResolvedValue({status: "complete", count: 3, warnings: [], artwork_revision: "art-2"});
  view();
  await waitFor(() => expect(nativeLibraries.catalog).toHaveBeenCalledTimes(2));
});

it("keeps artwork URLs stable when only catalog metadata revisions change", async () => {
  const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
  render(<MemoryRouter><QueryClientProvider client={client}><NativeLibraryBrowser library={library} /></QueryClientProvider></MemoryRouter>);
  await screen.findByText("Example Series");
  const poster = () => document.querySelector<HTMLImageElement>('img[src^="/art/native/show/poster?"]')?.getAttribute("src");
  const original = poster();
  expect(original).toBeTruthy();
  client.setQueryData(["native-catalog", library.id,"summary"], [{...series, revision: 99}]);
  await waitFor(() => expect(poster()).toBe(original));
  client.setQueryData(["native-catalog", library.id,"summary"], [{...series, artwork: [{kind: "poster", path: "replacement.jpg", source: "local"}]}]);
  await waitFor(() => expect(poster()).not.toBe(original));
});

it("shows stored character and cast portraits including relative TMDB paths", async () => {
  vi.mocked(nativeLibraries.catalog).mockResolvedValue([{...series, metadata: {...series.metadata,
    characters: [{name: "Character", image: "https://s4.anilist.co/character.jpg"}],
    credits: [{name: "Actor", image: "/actor.jpg", provider: "tmdb"}, {name: "Writer", image: null}],
  }}]);
  mount("/?native_library=native&native_item=show", {...library,library_type:"shows"});
  expect((await screen.findByRole("img", {name: "Character"})).getAttribute("src")).toBe("https://s4.anilist.co/character.jpg");
  const portrait = screen.getByRole("img", {name: "Actor"});
  expect(portrait.getAttribute("src")).toBe("https://image.tmdb.org/t/p/w185/actor.jpg");
  expect(portrait.getAttribute("loading")).toBe("lazy");
  fireEvent.error(portrait);
  expect(screen.queryByRole("img", {name: "Actor"})).toBeNull();
  expect(screen.getByText("Actor")).toBeTruthy();
  expect(screen.getByText("Writer")).toBeTruthy();
});

it("uses cached provider portraits for NFO credits without replacing local portraits", async () => {
  vi.mocked(nativeLibraries.catalog).mockResolvedValue([{...series, metadata: {...series.metadata,
    credits: [{name: "Local Actor", image: null}, {name: "Another Actor", image: "https://example.com/local.jpg"}, {name: "Unknown Actor"}],
    tmdb_data: {credits: {cast: [{name: "Local Actor", profile_path: "/cached.jpg"}, {name: "Another Actor", profile_path: "/other.jpg"}], crew: []}},
  }}]);
  mount("/?native_library=native&native_item=show", {...library,library_type:"shows"});
  expect((await screen.findByRole("img", {name: "Local Actor"})).getAttribute("src")).toBe("https://image.tmdb.org/t/p/w185/cached.jpg");
  expect(screen.getByRole("img", {name: "Another Actor"}).getAttribute("src")).toBe("https://example.com/local.jpg");
  expect(screen.queryByRole("img", {name: "Unknown Actor"})).toBeNull();
});

it("prefers cached AniList portraits over TMDB for matching anime voice cast", async () => {
  vi.mocked(nativeLibraries.catalog).mockResolvedValue([{...series, metadata: {...series.metadata,
    credits: [{name: "Actor Name", image: null}],
    country_of_origin:"JP",voice_cast:[{name:"Actor Name",language:"Japanese",image:null}],
    anilist_data: {characters: {edges: [{voiceActors: [{name: {full: "Name, Actor"}, image: {large: "https://s4.anilist.co/actor.jpg"}}]}]}},
    tmdb_data: {credits: {cast: [{name: "Actor Name", profile_path: "/tmdb.jpg"}]}},
  }}]);
  mount("/?native_library=native&native_item=show");
  expect((await screen.findByRole("img", {name: "Actor Name"})).getAttribute("src")).toBe("https://s4.anilist.co/actor.jpg");
});

it("shows anime voice casts and hides the separate production crew row", async () => {
  vi.mocked(nativeLibraries.catalog).mockResolvedValue([{...series, metadata: {...series.metadata,
    country_of_origin: "KR", voice_cast_schema: 1,
    voice_cast: [{name:"Korean Actor",language:"Korean",role:"Lead",image:"https://example.com/ko.jpg"},{name:"English Actor",language:"English",role:"Lead",image:"https://example.com/en.jpg"}],
    characters: [{name:"Lead Character",image:"https://example.com/character.jpg"}],
    credits: [{name:"Korean Actor",category:"voice"},{name:"Other Dub Actor",category:"voice"},{name:"Lead Character"},{name:"Director",category:"crew",role:"Director"},{name:"Lead Character",category:"crew",role:"Writer"}],
  }}]);
  mount("/?native_library=native&native_item=show");
  expect(await screen.findByRole("heading",{name:"Korean Cast"})).toBeTruthy();
  expect(screen.getByRole("heading",{name:"English Cast"})).toBeTruthy();
  expect(screen.getAllByText("Korean Actor")).toHaveLength(1);
  expect(screen.queryByText("Other Dub Actor")).toBeNull();
  // Anime keeps characters and voice casts while hiding the separate crew row.
  expect(screen.getAllByText("Lead Character", {selector:"p.text-sm"})).toHaveLength(1);
  expect(screen.queryByText("Writer")).toBeNull();
  expect(screen.queryByText("Director", {selector:"p.text-sm"})).toBeNull();
  expect(screen.queryByRole("heading",{name:"Cast and crew"})).toBeNull();
});

it("edits genre rows without saving until the fixed save button is clicked", async()=>{
  vi.mocked(nativeLibraries.editItem).mockResolvedValue({entry:series,warnings:[]});
  mount("/?native_library=native&native_item=show");
  await screen.findByRole("heading",{name:"Example Series"});
  fireEvent.click(screen.getByRole("button",{name:"Edit Metadata"}));
  fireEvent.change(screen.getByLabelText("Add genres"),{target:{value:"Comedy"}});
  fireEvent.click(screen.getByRole("button",{name:"Add to genres"}));
  fireEvent.click(screen.getByRole("button",{name:"Remove genres: Action"}));
  expect(nativeLibraries.editItem).not.toHaveBeenCalled();
  expect(screen.getByRole("button",{name:"Save metadata"}).closest("footer")).toBeTruthy();
  fireEvent.click(screen.getByRole("button",{name:"Save metadata"}));
  await waitFor(()=>expect(nativeLibraries.editItem).toHaveBeenCalledWith("native",series,expect.objectContaining({genres:["Comedy"]})));
});

it("hides anime character and cast rows according to saved preferences",async()=>{
 localStorage.setItem("posterview.animePreferences.native",JSON.stringify({characters:false,casts:true,original:false,dub:true}));
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([{...series,metadata:{...series.metadata,country_of_origin:"JP",people:[{name:"Crew member",type:"Director"}],characters:[{name:"Character"}],voice_cast:[{name:"Original actor",language:"Japanese"},{name:"Dub actor",language:"English"}]}}]);
 mount("/?native_library=native&native_item=show");
 expect(await screen.findByRole("heading",{name:"English Cast"})).toBeTruthy();
 expect(screen.queryByRole("heading",{name:"Japanese Cast"})).toBeNull();
 expect(screen.queryByRole("heading",{name:"Characters"})).toBeNull();
 expect(screen.queryByRole("heading",{name:"Cast and crew"})).toBeNull();
});

it("shows book series NFO pills and a wrapping grid of volume covers",async()=>{
 const bookSeries={...series,kind:"book_series",metadata:{edition:"Colored",year:2020,publisher:"Viz",translatedtitle:"English",volumes:21,sourcematerial:"Original",credits:[{name:"Old Actor",category:"cast"}],characters:[{name:"Old Character"}]}};
 const books=[1,2].map(volume=>({...series,id:`volume${volume}`,path:`${series.path}/Volume ${volume}.cbz`,kind:"book",parent_path:series.path,title:`Volume ${volume}`,metadata:{volume}}));
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([bookSeries,...books]);
 mount("/?native_library=native&native_item=show",{...library,library_type:"books"});
 await screen.findByRole("heading",{name:"Example Series"});
 expect(screen.getByText("Translation")).toBeTruthy();expect(screen.getByText("English",{exact:false})).toBeTruthy();
 expect(screen.getByText("19 Volumes Missing")).toBeTruthy();
 expect(screen.getByRole("button",{name:"Fetch Metadata"})).toBeTruthy();
 const heading=screen.getByRole("heading",{name:"Volumes"});expect(heading.parentElement?.nextElementSibling?.className).toContain("grid");
 expect(screen.getByText("2 Volumes")).toBeTruthy();
 expect(screen.getAllByLabelText("Colored edition")).toHaveLength(3);
 expect(screen.getByRole("heading",{name:"Example Series"}).className).toContain("poster-colored-title");
 expect(document.querySelectorAll(".poster-colored-shimmer")).toHaveLength(3);
 expect(screen.queryByText("Old Actor")).toBeNull();expect(screen.getByText("Old Character")).toBeTruthy();
});

it("shows missing book cards without counting them as available and opens their artwork target",async()=>{
 const bookSeries={...series,kind:"book_series",metadata:{volumes:2}};
 const book={...series,id:"volume1",kind:"book",parent_path:series.path,path:`${series.path}/Volume 01.cbz`,title:"Volume 01",metadata:{volume:1,missing:false}};
 const missing={...book,id:"missing2",path:`${series.path}/@missing-volume-2`,title:"Volume 02",metadata:{volume:2,missing:true},artwork:[],files:[]};
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([bookSeries,book,missing]);
 mount("/?native_library=native&native_item=show",{...library,library_type:"books"});
 await screen.findByRole("heading",{name:"Example Series"});
 expect(screen.getByText("1 Volume")).toBeTruthy();expect(screen.getByText("1 Volume Missing")).toBeTruthy();
 expect(screen.getByText("Missing")).toBeTruthy();
 fireEvent.click(screen.getByText("Volume 02").closest("button")!);
 expect(screen.getByRole("heading",{name:"Example Series"})).toBeTruthy();
 expect(screen.queryByRole("heading",{name:"Media information"})).toBeNull();
 expect((await screen.findByTestId("shared-artwork")).getAttribute("data-item")).toBe("native:native:missing2");
});

it("refreshes selected series artwork before reloading the catalog",async()=>{
 vi.mocked(nativeLibraries.refreshArtwork).mockResolvedValue({updated:1,warnings:[]});
 mount("/?native_library=native&native_item=show");await screen.findByRole("heading",{name:"Example Series"});
 const before=vi.mocked(nativeLibraries.catalog).mock.calls.length;
 fireEvent.click(screen.getByRole("button",{name:"Refresh"}));
 await waitFor(()=>expect(nativeLibraries.refreshArtwork).toHaveBeenCalledWith("native","show"));
 await waitFor(()=>expect(vi.mocked(nativeLibraries.catalog).mock.calls.length).toBeGreaterThan(before));
});


it("launches book files in the reader and returns to their series",async()=>{
 const bookSeries={...series,kind:"book_series",metadata:{volumes:1}};
 const book={...series,id:"volume1",kind:"book",parent_path:series.path,path:`${series.path}/Volume 01.cbz`,title:"Volume 01",metadata:{volume:1}};
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([bookSeries,book]);
 mount("/?native_library=native&native_item=show",{...library,library_type:"books"});
 fireEvent.click((await screen.findByText("Volume 01")).closest("button")!);
 const destination=screen.getByTestId("location").textContent!;
 expect(destination.startsWith("/read/native/native/volume1?")).toBe(true);
 expect(new URLSearchParams(destination.split("?")[1]).get("return")).toBe("/media/native?native_library=native&native_item=show");
});

it("keeps old individual book links on the parent series page",async()=>{
 const bookSeries={...series,kind:"book_series",metadata:{volumes:1}};
 const book={...series,id:"volume1",kind:"book",parent_path:series.path,path:`${series.path}/Volume 01.cbz`,title:"Volume 01",metadata:{volume:1}};
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([bookSeries,book]);
 mount("/?native_library=native&native_item=volume1",{...library,library_type:"books"});
 expect(await screen.findByRole("heading",{name:"Example Series"})).toBeTruthy();
 expect(screen.queryByRole("heading",{name:"Volume 01"})).toBeNull();
});


it("hides missing cards without changing the catalog or missing count",async()=>{
 const bookSeries={...series,kind:"book_series",metadata:{volumes:2}};
 const book={...series,id:"volume1",kind:"book",parent_path:series.path,path:`${series.path}/Volume 01.cbz`,title:"Volume 01",metadata:{volume:1,missing:false}};
 const missing={...book,id:"missing2",title:"Volume 02",metadata:{volume:2,missing:true}};
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([bookSeries,book,missing]);
 mount("/?native_library=native&native_item=show",{...library,library_type:"books",options:{...importedDefaults,show_missing_files:false}});
 await screen.findByText("Volume 01");expect(screen.queryByText("Volume 02")).toBeNull();expect(screen.getByText("1 Volume Missing")).toBeTruthy();expect(nativeLibraries.editItem).not.toHaveBeenCalled();
});


it("opens the shared filter popup and filters missing metadata IDs",async()=>{
 const identified={...series,id:"identified",path:"Anime/Identified",title:"Identified Series",metadata:{identifiers:{anilist:"123"}}};
 const unlinked={...series,id:"unlinked",path:"Anime/Unlinked",title:"Unlinked Series",metadata:{identifiers:{anilist:" "}}};
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([identified,unlinked]);mount();
 await screen.findByText("Identified Series");fireEvent.click(screen.getByRole("button",{name:"Filter and sort titles"}));
 const dialog=screen.getByRole("dialog",{name:"Filters and sorting"});expect(dialog).toBeTruthy();
 expect(screen.getByRole("heading",{name:"Metadata"})).toBeTruthy();
 fireEvent.change(screen.getByLabelText("Filter by metadata"),{target:{value:"missing-id-anilist"}});
 expect(screen.queryByText("Identified Series")).toBeNull();expect(screen.getByText("Unlinked Series")).toBeTruthy();
 fireEvent.change(screen.getByLabelText("Filter by metadata"),{target:{value:"all"}});
 expect(screen.getByText("Identified Series")).toBeTruthy();fireEvent.click(screen.getByRole("button",{name:"Close Filters and sorting"}));
 expect(dialog.hasAttribute("open")).toBe(false);
});


it("marks missing episodes and hides them when disabled",async()=>{
 const missing={...episode,id:"missing",title:"Missing Episode",metadata:{season:1,episode:2,missing:true,aired:"2020-01-01"}};
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([series,season,episode,missing]);mount("/?native_library=native&native_item=season");
 expect(await screen.findByRole("button",{name:"Open Missing Episode"})).toBeTruthy();expect(screen.getByText("Missing")).toBeTruthy();cleanup();
 mount("/?native_library=native&native_item=season",{...library,options:{...importedDefaults,show_missing_files:false}});
 await screen.findByRole("button",{name:"Open First Episode"});expect(screen.queryByRole("button",{name:"Open Missing Episode"})).toBeNull();
});

it("hides only missing specials unless enabled",async()=>{
 const missing={...episode,id:"missing-special",title:"Missing Special",metadata:{season:0,episode:2,missing:true,aired:"2020-01-01"}};
 const actual={...episode,metadata:{season:0,episode:1}};
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([series,{...season,metadata:{season:0}},actual,missing]);
 mount("/?native_library=native&native_item=season");
 await screen.findByRole("button",{name:"Open First Episode"});
 expect(screen.queryByRole("button",{name:"Open Missing Special"})).toBeNull();cleanup();
 mount("/?native_library=native&native_item=season",{...library,options:{...importedDefaults,show_missing_specials:true}});
 expect(await screen.findByRole("button",{name:"Open Missing Special"})).toBeTruthy();
});

it("hides a missing specials folder until enabled",async()=>{
 const specials={...season,id:"missing-specials",title:"Specials",metadata:{season:0,missing:true}};
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([series,season,specials]);
 mount("/?native_library=native&native_item=show");
 await screen.findByText("Season 1");
 expect(screen.queryByText("Specials")).toBeNull();cleanup();
 mount("/?native_library=native&native_item=show",{...library,options:{...importedDefaults,show_missing_specials:true}});
 expect(await screen.findByText("Specials")).toBeTruthy();
});

it("scans only the right-clicked series folder",async()=>{
 mount();
 fireEvent.contextMenu(await screen.findByTitle("Example Series · right-click for options"));
 fireEvent.click(screen.getByRole("menuitem",{name:"Scan library files"}));
 await waitFor(()=>expect(nativeLibraries.scanFolder).toHaveBeenCalledWith("native","show"));
});

it.each([1,0])("offers scoped scan and metadata refresh on season %s cards",async seasonNumber=>{
 const folder={...season,id:`season-${seasonNumber}`,title:seasonNumber===0?"Specials":"Season 1",metadata:{season:seasonNumber}};
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([series,folder]);
 mount("/?native_library=native&native_item=show");
 const card=await screen.findByTitle(`${folder.title} · right-click for options`);
 fireEvent.contextMenu(card);
 fireEvent.click(screen.getByRole("menuitem",{name:"Scan library files"}));
 await waitFor(()=>expect(nativeLibraries.scanFolder).toHaveBeenCalledWith("native",folder.id));
 fireEvent.contextMenu(card);
 fireEvent.click(screen.getByRole("menuitem",{name:"Refresh Metadata"}));
 const dialog=await screen.findByRole("dialog",{name:"Refresh Metadata"});
 fireEvent.click(within(dialog).getByRole("button",{name:"Refresh"}));
 await waitFor(()=>expect(nativeLibraries.scanFolder).toHaveBeenCalledWith("native",folder.id,true,{replaceMetadata:true,replaceImages:false}));
});

it("offers series actions without delete and opens missing episodes",async()=>{
 mount();fireEvent.contextMenu(await screen.findByTitle("Example Series · right-click for options"));
 for(const name of ["Edit Metadata","Edit Images","Identify","Remove Identification","Refresh Metadata","Scan library files","View Missing Episodes"])expect(screen.getByRole("menuitem",{name})).toBeTruthy();
 expect(screen.queryByRole("menuitem",{name:"Delete"})).toBeNull();
 fireEvent.click(screen.getByRole("menuitem",{name:"View Missing Episodes"}));
 expect(await screen.findByRole("dialog",{name:"Missing Episodes"})).toBeTruthy();
});
it("confirms identification removal and preserves other fields",async()=>{
 mount();fireEvent.contextMenu(await screen.findByTitle("Example Series · right-click for options"));
 fireEvent.click(screen.getByRole("menuitem",{name:"Remove Identification"}));
 expect(nativeLibraries.editItem).not.toHaveBeenCalled();
 fireEvent.click(await screen.findByRole("button",{name:"Remove identification"}));
 await waitFor(()=>expect(nativeLibraries.editItem).toHaveBeenCalledWith("native",expect.objectContaining({id:"show"}),{identifiers:{}}));
});

it("offers refresh modes and sends explicit replacement choices",async()=>{
 mount();fireEvent.contextMenu(await screen.findByTitle("Example Series · right-click for options"));
 fireEvent.click(screen.getByRole("menuitem",{name:"Refresh Metadata"}));
 expect((await screen.findByLabelText("Refresh mode") as HTMLSelectElement).value).toBe("replace");
 expect((screen.getByRole("switch",{name:"Replace existing video preview thumbnails"}) as HTMLInputElement).disabled).toBe(true);
 fireEvent.change(screen.getByLabelText("Refresh mode"),{target:{value:"missing"}});
 fireEvent.click(screen.getByRole("switch",{name:"Replace existing images"}));
 fireEvent.click(screen.getByRole("button",{name:"Refresh"}));
 await waitFor(()=>expect(nativeLibraries.scanFolder).toHaveBeenCalledWith("native","show",true,{replaceMetadata:false,replaceImages:true}));
});

it("opens the selected series and artwork panel from Edit Images",async()=>{
 mount();fireEvent.contextMenu(await screen.findByTitle("Example Series · right-click for options"));
 fireEvent.click(screen.getByRole("menuitem",{name:"Edit Images"}));
 expect(await screen.findByTestId("shared-artwork")).toHaveProperty("textContent","Shared artwork lookup");
 expect(screen.getByRole("button",{name:"Back"})).toBeTruthy();
 expect(screen.getAllByText("Series synopsis").length).toBeGreaterThan(0);
 fireEvent.click(screen.getByRole("button",{name:"Back"}));
 await waitFor(()=>expect(screen.queryByTestId("shared-artwork")).toBeNull());
});

it("hides Edit Images when the artwork plugin is disabled",async()=>{
 vi.mocked(useArtworkPlugin).mockReturnValue({data:{enabled:false}} as ReturnType<typeof useArtworkPlugin>);
 mount();fireEvent.contextMenu(await screen.findByTitle("Example Series · right-click for options"));
 expect(screen.queryByRole("menuitem",{name:"Edit Images"})).toBeNull();
 fireEvent.click(screen.getByRole("menuitem",{name:"View Missing Episodes"}));
 expect(screen.queryByTestId("shared-artwork")).toBeNull();
 vi.mocked(useArtworkPlugin).mockReturnValue({data:{enabled:true}} as ReturnType<typeof useArtworkPlugin>);
});

it("allows identity and refresh actions while another scan is running",async()=>{
 vi.mocked(nativeLibraries.status).mockResolvedValue({status:"scanning",count:3,warnings:[]});
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([{...series,metadata:{...series.metadata,identifiers:{anilist:"1281"}}},season,episode]);
 mount();fireEvent.contextMenu(await screen.findByTitle("Example Series · right-click for options"));
 expect(screen.getByRole("menuitem",{name:"Refresh Metadata"}).getAttribute("aria-disabled")).not.toBe("true");
 fireEvent.click(screen.getByRole("menuitem",{name:"Identify"}));
 expect((await screen.findByRole("button",{name:"Save identification"}) as HTMLButtonElement).disabled).toBe(false);
});


it("saves a TV title without resubmitting invalid imported credits", async()=>{
 const imported={...series,metadata:{...series.metadata,credits:[{name:"Imported person",category:"Director"},{name:"",category:"cast"}],_sources:{credits:"tmdb"}}};
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([imported]);
 vi.mocked(nativeLibraries.editItem).mockResolvedValue({entry:imported,warnings:[]});
 mount("/?native_library=native&native_item=show");
 await screen.findByRole("heading",{name:"Example Series"});
 fireEvent.click(screen.getByRole("button",{name:"Edit Metadata"}));
 fireEvent.change(screen.getByLabelText("Title"),{target:{value:"New title"}});
 fireEvent.click(screen.getByRole("button",{name:"Save metadata"}));
 await waitFor(()=>expect(nativeLibraries.editItem).toHaveBeenCalledWith("native",imported,{title:"New title"}));
});

it("edits an episode NFO directly from its season row without navigating",async()=>{
 vi.mocked(nativeLibraries.editItem).mockResolvedValue({entry:episode,warnings:[]});
 mount("/?native_library=native&native_item=season");
 fireEvent.click(await screen.findByRole("button",{name:"Edit NFO metadata for First Episode"}));
 expect((await screen.findByLabelText("Title") as HTMLInputElement).value).toBe("First Episode");
 fireEvent.change(screen.getByLabelText("Title"),{target:{value:"Edited episode title"}});
 fireEvent.click(screen.getByRole("button",{name:"Save metadata"}));
 await waitFor(()=>expect(nativeLibraries.editItem).toHaveBeenCalledWith("native",episode,{title:"Edited episode title"}));
 expect(screen.getByTestId("location").textContent).toContain("native_item=season");
});
it("places a special before its target episode while keeping its identity",async()=>{
 const specials={...season,id:"specials",path:"Anime/Show/Specials",title:"Specials",metadata:{season:0}};
 const special={...episode,id:"ova",path:`${specials.path}/S00E01.mkv`,parent_path:specials.path,title:"Special OVA",metadata:{season:0,episode:1,airs_before_season:1,airs_before_episode:1}};
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([series,season,specials,special,episode]);
 mount("/?native_library=native&native_item=season",{...library,options:{...importedDefaults,show_specials_in_seasons:true}});
 await screen.findByRole("button",{name:"Edit NFO metadata for Special OVA"});
 const articles=screen.getAllByRole("article");
 expect(articles.map(article=>article.textContent).join("|")).toMatch(/Special OVA.*First Episode/);
});

it("includes explicitly edited credits in the metadata patch", async()=>{
 const imported={...series,metadata:{...series.metadata,credits:[{name:"Actor",category:"cast"}]}};
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([imported]);
 vi.mocked(nativeLibraries.editItem).mockResolvedValue({entry:imported,warnings:[]});
 mount("/?native_library=native&native_item=show");
 await screen.findByRole("heading",{name:"Example Series"});
 fireEvent.click(screen.getByRole("button",{name:"Edit Metadata"}));
 fireEvent.change(screen.getByLabelText("Credit 1 name"),{target:{value:"Correct actor"}});
 fireEvent.click(screen.getByRole("button",{name:"Save metadata"}));
 await waitFor(()=>expect(nativeLibraries.editItem).toHaveBeenCalledWith("native",imported,{credits:[{name:"Correct actor",category:"cast"}]}));
});

it("excludes specials from the series season count while keeping their folder",async()=>{
 const specials={...season,id:"specials",path:"Anime/Show/Specials",title:"Specials",metadata:{season:0}};
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([series,season,specials,episode,{...episode,id:"special-episode",path:"Anime/Show/Specials/S00E01.mkv",parent_path:specials.path,metadata:{season:0,episode:1}}]);
 mount("/?native_library=native&native_item=show");
 expect(await screen.findByText("1 Season")).toBeTruthy();
 expect(screen.queryByText("2 Seasons")).toBeNull();
 expect(screen.getByRole("button",{name:/Open Specials/})).toBeTruthy();
});

it("uses series header metadata on seasons while preserving season overrides",async()=>{
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([{...series,metadata:{...series.metadata,rating:8.1,year:2010,studios:["Example Network"],genres:["Comedy"],mpaa:"TV-MA"}},{...season,metadata:{season:1,year:2011,genres:[]}},episode]);
 mount("/?native_library=native&native_item=season");
 expect(await screen.findByLabelText("Rating 8.1 out of 10")).toBeTruthy();
 const header=within(screen.getByLabelText("Title information"));
 expect(header.getByText("Example Network")).toBeTruthy();
 expect(header.getByText("TV-MA")).toBeTruthy();
 expect(header.getByText("Comedy")).toBeTruthy();
 expect(header.getByText("2011")).toBeTruthy();
 expect(header.getByText("1 Season")).toBeTruthy();
});

it("filters books by volume or chapter number and title within the current series",async()=>{
 const root={...series,kind:"book_series"};
 const books=[{...series,id:"v2",kind:"book",parent_path:series.path,path:series.path+"/02.cbz",title:"Second book",metadata:{volume:2}},{...series,id:"v12",kind:"book",parent_path:series.path,path:series.path+"/12.cbz",title:"Final battle",metadata:{chapter:12}}];
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([root,...books]);mount("/?native_library=native&native_item=show",{...library,library_type:"books"});
 const input=await screen.findByRole("textbox",{name:"Search volumes and chapters"});
 fireEvent.change(input,{target:{value:"volume 02"}});expect(screen.getByText("Second book")).toBeTruthy();expect(screen.queryByText("Final battle")).toBeNull();
 fireEvent.change(input,{target:{value:"chapter 12"}});expect(screen.getByText("Final battle")).toBeTruthy();expect(screen.queryByText("Second book")).toBeNull();
 fireEvent.change(input,{target:{value:"nothing"}});expect(screen.getByText("No matching volumes or chapters.")).toBeTruthy();
 fireEvent.change(input,{target:{value:""}});expect(screen.getByText("Second book")).toBeTruthy();expect(screen.getByText("Final battle")).toBeTruthy();
});

it("shows episode context and navigates through the season thumbnail row",async()=>{
 const second={...episode,id:"second",title:"Second Episode",metadata:{season:1,episode:2}};
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([series,season,episode,second]);
 mount("/?native_library=native&native_item=episode");
 expect(await screen.findByRole("heading",{name:"S1:E1 - First Episode"})).toBeTruthy();
 expect(screen.getByRole("heading",{name:/More from Season/})).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Open episode 2: Second Episode"}));
 expect(await screen.findByRole("heading",{name:"S1:E2 - Second Episode"})).toBeTruthy();
 expect(screen.getByRole("button",{name:"Edit Metadata"})).toBeTruthy();
});

it("allows viewer browsing without editing artwork, metadata or scan actions",async()=>{
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 render(<QueryClientProvider client={client}><MemoryRouter><AuthSessionContext.Provider value={{authenticated:true,user:{id:"viewer",username:"viewer",display_name:"Viewer",role:"user",enabled:true,revision:1,created_at:"",permissions:{all_libraries:true,library_ids:[],max_movie_rating:null,max_tv_rating:null,allow_unrated:false}}}}><NativeLibraryBrowser library={library}/></AuthSessionContext.Provider></MemoryRouter></QueryClientProvider>);
 fireEvent.click(await screen.findByRole("button",{name:/Open Example Series/}));
 expect(screen.queryByRole("button",{name:"Edit Metadata"})).toBeNull();
 expect(screen.queryByRole("button",{name:"Edit Images"})).toBeNull();
 expect(screen.queryByRole("button",{name:"Identify"})).toBeNull();
 expect(nativeLibraries.status).not.toHaveBeenCalled();
});

it("refreshes fresh catalog when the library count changes while away",async()=>{
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 vi.mocked(nativeLibraries.catalog).mockClear();
 vi.mocked(nativeLibraries.status).mockResolvedValue({status:"complete",count:3,warnings:[]});
 const view=()=>render(<MemoryRouter><QueryClientProvider client={client}><NativeLibraryBrowser library={library}/></QueryClientProvider></MemoryRouter>);
 const first=view();await screen.findByText("Example Series");
 await waitFor(()=>expect(client.getQueryData(["native-catalog-scan-state",library.id])).toEqual({status:"complete",count:3}));
 first.unmount();vi.mocked(nativeLibraries.status).mockResolvedValue({status:"complete",count:4,warnings:[]});view();
 await waitFor(()=>expect(nativeLibraries.catalog).toHaveBeenCalledTimes(2));
});

it("opens a quick character profile from the anime character row",async()=>{
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([{...series,metadata:{...series.metadata,characters:[{name:"Maomao",role:"MAIN",biography:"A curious apothecary.<br>Works at the palace."}]}}]);
 mount("/?native_library=native&native_item=show");
 fireEvent.click(await screen.findByRole("button",{name:"Preview Maomao"}));
 expect(screen.getByRole("region",{name:"Profile of Maomao"})).toBeTruthy();
 expect(screen.getByText(/A curious apothecary/)).toBeTruthy();
});

it("loads video summaries without fetching full records until a title is opened",async()=>{
 vi.mocked(nativeLibraries.catalog).mockClear();
 vi.mocked(nativeLibraries.summaries).mockResolvedValue([series,season,episode]);
 vi.mocked(nativeLibraries.item).mockImplementation(async (_library,id)=>[series,season,episode].find(entry=>entry.id===id)!);
 const errors=vi.spyOn(console,"error");
 mount();
 fireEvent.click(await screen.findByRole("button",{name:/Open Example Series/}));
 await screen.findByRole("heading",{name:"Example Series"});
 expect(nativeLibraries.item).toHaveBeenCalledTimes(1);
 expect(nativeLibraries.item).toHaveBeenCalledWith(library.id,series.id);
 fireEvent.click(screen.getByRole("button",{name:/Open Season 1/}));
 await screen.findByRole("heading",{name:"Episodes"});
 expect(nativeLibraries.item).toHaveBeenCalledTimes(2);
 expect(nativeLibraries.item).not.toHaveBeenCalledWith(library.id,episode.id);
 fireEvent.click(screen.getByRole("button",{name:"Back"}));
 await screen.findByRole("heading",{name:"Example Series"});
 fireEvent.click(screen.getByRole("button",{name:"Back"}));
 await screen.findByRole("button",{name:/Open Example Series/});
 expect(nativeLibraries.catalog).not.toHaveBeenCalled();
 expect(nativeLibraries.summaries).toHaveBeenCalledTimes(1);
 expect(errors).not.toHaveBeenCalled();
 errors.mockRestore();
});
it("fetches a movie's complete media files before showing detail",async()=>{
 const summary={...series,kind:"movie",metadata:{...series.metadata,_has_files:true}};
 const movie={...summary,revision:7,files:[{path:"movie.mkv",size:1234,extension:"mkv"}],metadata:{...series.metadata,plot:"Full movie synopsis"}};
 vi.mocked(nativeLibraries.summaries).mockResolvedValue([summary]);
 let resolve!:(entry:NativeCatalogEntry)=>void;
 vi.mocked(nativeLibraries.item).mockReturnValue(new Promise(done=>{resolve=done;}));
 mount("/?native_library=native&native_item=show",{...library,library_type:"movies"});
 await screen.findByText("Loading title…");
 expect(screen.queryByRole("heading",{name:movie.title})).toBeNull();
 resolve(movie);
 expect(await screen.findByText("movie.mkv")).toBeTruthy();
 expect(screen.getAllByText("Full movie synopsis").length).toBeGreaterThan(0);
});
it("does not open a metadata editor with incomplete summary metadata",async()=>{
 vi.mocked(nativeLibraries.summaries).mockResolvedValue([series]);
 let resolve!:(entry:NativeCatalogEntry)=>void;
 vi.mocked(nativeLibraries.item).mockReturnValue(new Promise(done=>{resolve=done;}));
 mount();
 fireEvent.contextMenu(await screen.findByTitle("Example Series · right-click for options"));
 expect(nativeLibraries.item).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole("menuitem",{name:"Edit Metadata"}));
 expect(await screen.findByText("Loading editor…")).toBeTruthy();
 expect(screen.queryByLabelText("Title")).toBeNull();
 resolve({...series,revision:23,metadata:{...series.metadata,title:"Complete metadata title",credits:[{name:"A credit"}]}});
 expect((await screen.findByLabelText("Title") as HTMLInputElement).value).toBe("Complete metadata title");
});

it("keeps cached full title details visible when its background refresh fails",async()=>{
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 client.setQueryData(["native-catalog",library.id,"summary"],[series,season,episode]);
 client.setQueryData(["native-catalog",library.id,"item",series.id],series,{updatedAt:Date.now()-6*60_000});
 vi.mocked(nativeLibraries.item).mockRejectedValue(new Error("Detail refresh unavailable"));
 render(<MemoryRouter initialEntries={["/?native_library=native&native_item=show"]}><QueryClientProvider client={client}><NativeLibraryBrowser library={library}/></QueryClientProvider></MemoryRouter>);
 expect(screen.getByRole("heading",{name:series.title})).toBeTruthy();
 await screen.findByText("Detail refresh unavailable");
 expect(screen.getByRole("heading",{name:series.title})).toBeTruthy();
 expect(screen.getByRole("button",{name:/Open Season 1/})).toBeTruthy();
});

it("filters missing banners independently of landscape and backdrop artwork",async()=>{
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([
  {...series,id:"with-banner",title:"Has banner",path:"Anime/HasBanner",artwork:[{kind:"banner",path:"banner.jpg",source:"local"}]},
  {...series,id:"without-banner",title:"Needs banner",path:"Anime/NeedsBanner",artwork:[{kind:"backdrop",path:"fanart.jpg",source:"local"},{kind:"landscape",path:"landscape.jpg",source:"local"}]},
 ]);
 mount();await screen.findByText("Has banner");
 fireEvent.click(screen.getByRole("button",{name:"Filter and sort titles"}));
 fireEvent.change(screen.getByLabelText("Filter by artwork"),{target:{value:"missing-banner"}});
 expect(screen.queryByText("Has banner")).toBeNull();
 expect(screen.getByText("Needs banner")).toBeTruthy();
 fireEvent.change(screen.getByLabelText("Filter by artwork"),{target:{value:"all"}});
 expect(screen.getByText("Has banner")).toBeTruthy();
});

function expectDocumentOrder(...elements: Element[]) {
 for(let index=1;index<elements.length;index++) {
  expect(elements[index-1].compareDocumentPosition(elements[index]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 }
}

it.each(["movie","season","episode"] as const)("orders %s detail content from synopsis through people and About to media information",async kind=>{
 const base=kind==="season"?season:kind==="episode"?episode:{...series,kind:"movie"};
 const selected={...base,metadata:{...base.metadata,plot:"Selected title synopsis",characters:[{name:"Story Character"}],credits:[{name:"Screen Actor",role:"Lead",category:"cast"}]},files:[{path:"selected-title.mkv",size:1024,extension:"mkv"}]};
 const sibling={...episode,id:"next",title:"Next Episode",path:`${season.path}/S01E02.mkv`,metadata:{season:1,episode:2}};
 const records=kind==="movie"?[selected]:[series,season,episode,sibling].map(entry=>entry.id===selected.id?selected:entry);
 vi.mocked(nativeLibraries.catalog).mockResolvedValue(records);
 mount(`/?native_library=native&native_item=${selected.id}`,{...library,library_type:kind==="movie"?"movies":"shows"});
 const characterHeading=await screen.findByRole("heading",{name:"Characters"});
 const castHeading=screen.getByRole("heading",{name:"Cast and crew"});
 const aboutHeading=screen.getByRole("heading",{name:"About"});
 const mediaHeading=screen.getByRole("heading",{name:kind==="episode"?"Media Info":"Media information"});
 const synopsis=screen.getAllByText("Selected title synopsis")[0];
 const related=kind==="season"?[screen.getByRole("heading",{name:"Episodes"})]:kind==="episode"?[screen.getByRole("heading",{name:"More from Season 1"})]:[];
 expectDocumentOrder(synopsis,...related,characterHeading,castHeading,aboutHeading,mediaHeading);
 expect(screen.getByText("Story Character")).toBeTruthy();
 expect(screen.getByText("Screen Actor")).toBeTruthy();
 expect(screen.getByText("selected-title.mkv")).toBeTruthy();
 expect(screen.getByRole("button",{name:"Edit Metadata"})).toBeTruthy();
 expect(screen.getByRole("button",{name:"Edit Images"})).toBeTruthy();
});

it("keeps anime seasons, character profiles, original and dub casts in their canonical detail order",async()=>{
 const anime={...series,metadata:{...series.metadata,plot:"Anime layout synopsis",country_of_origin:"JP",voice_cast_schema:1,characters:[{name:"Story Character",biography:"A character biography"}],voice_cast:[{name:"Original Actor",language:"Japanese",role:"Lead"},{name:"Dub Actor",language:"English",role:"Lead"}],credits:[{name:"Production Director",role:"Director",category:"crew"}]},files:[{path:"series-media.mkv",size:1024,extension:"mkv"}]};
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([anime,season,episode]);
 mount("/?native_library=native&native_item=show");
 const japanese=await screen.findByRole("heading",{name:"Japanese Cast"});
 expectDocumentOrder(screen.getAllByText("Anime layout synopsis")[0],screen.getByRole("heading",{name:"Seasons"}),screen.getByRole("heading",{name:"Characters"}),japanese,screen.getByRole("heading",{name:"English Cast"}),screen.getByRole("heading",{name:"About"}),screen.getByRole("heading",{name:"Media information"}));
 expect(screen.queryByRole("heading",{name:"Cast and crew"})).toBeNull();
 expect(screen.getByText("Original Actor")).toBeTruthy();
 expect(screen.getByText("Dub Actor")).toBeTruthy();
 expect(screen.getByRole("button",{name:"Edit dub credits for English Cast"})).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Preview Story Character"}));
 expect(screen.getByRole("region",{name:"Profile of Story Character"})).toBeTruthy();
});

it.each(["series","movie","season","episode"] as const)("preserves the About visibility policy for a missing %s",async kind=>{
 const base=kind==="season"?season:kind==="episode"?episode:{...series,kind};
 const selected={...base,metadata:{...base.metadata,missing:true,plot:"Missing layout synopsis"}};
 const records=kind==="series"||kind==="movie"?[selected]:[series,season,episode].map(entry=>entry.id===selected.id?selected:entry);
 vi.mocked(nativeLibraries.catalog).mockResolvedValue(records);
 mount(`/?native_library=native&native_item=${selected.id}`,{...library,library_type:"shows"});
 await screen.findAllByText("Missing layout synopsis");
 expect(!!screen.queryByRole("heading",{name:"About"})).toBe(kind==="series");
});

it("keeps book volume navigation and metadata controls before character details without a video About section",async()=>{
 const root={...series,kind:"book_series",metadata:{plot:"Book layout synopsis",publisher:"Viz",year:2020,volumes:2,characters:[{name:"Book Character"}],credits:[{name:"Book Author",category:"cast"}]}};
 const volume={...series,id:"volume",kind:"book",path:`${series.path}/Volume 1.cbz`,parent_path:series.path,title:"Volume One",metadata:{volume:1}};
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([root,volume]);
 mount("/?native_library=native&native_item=show",{...library,library_type:"books"});
 const volumes=await screen.findByRole("heading",{name:"Volumes"});
 expectDocumentOrder(screen.getAllByText("Book layout synopsis")[0],volumes,screen.getByRole("heading",{name:"Characters"}));
 expect(screen.getByRole("textbox",{name:"Search volumes and chapters"})).toBeTruthy();
 expect(screen.getByRole("button",{name:/Read Volume One/})).toBeTruthy();
 expect(screen.getByRole("button",{name:"Fetch Metadata"})).toBeTruthy();
 expect(screen.getByRole("button",{name:"Identify"})).toBeTruthy();
 expect(screen.getByRole("button",{name:"Edit Metadata"})).toBeTruthy();
 expect(screen.queryByRole("heading",{name:"About"})).toBeNull();
 expect(screen.queryByRole("heading",{name:"Cast and crew"})).toBeNull();
});

it("shows audio and subtitles from the selected movie version",async()=>{
 const movie:NativeCatalogEntry={...series,kind:"movie",files:[
  {path:"movie-original.mkv",version_id:"original",version_name:"Original",size:1,extension:"mkv",media_info:{streams:[{codec_type:"audio",codec_name:"aac",tags:{language:"ja"}},{codec_type:"subtitle",codec_name:"ass",tags:{language:"en"}}]}},
  {path:"movie-uhd.mkv",version_id:"uhd",version_name:"UHD",size:2,extension:"mkv",media_info:{streams:[{codec_type:"audio",codec_name:"truehd",tags:{language:"en"}},{codec_type:"subtitle",codec_name:"subrip",tags:{language:"fr"}}]}}
 ]};
 vi.mocked(nativeLibraries.summaries).mockResolvedValue([movie]);vi.mocked(nativeLibraries.item).mockResolvedValue(movie);
 mount("/?native_library=native&native_item=show",{...library,library_type:"movies"});
 const selector=await screen.findByRole("combobox",{name:"Version"});
 expect(screen.getByLabelText("Movie media tracks").textContent).toContain("ja AAC");
 fireEvent.change(selector,{target:{value:"uhd"}});
 const tracks=screen.getByLabelText("Movie media tracks");
 expect(tracks.textContent).toContain("en TRUEHD");expect(tracks.textContent).toContain("fr SUBRIP");expect(tracks.textContent).not.toContain("ja AAC");
});

const channelArtwork = [
  {kind:"poster",path:"poster.jpg",source:"local"},
  {kind:"backdrop",path:"fanart.jpg",source:"local"},
  {kind:"banner",path:"banner.jpg",source:"local"},
  {kind:"landscape",path:"landscape.jpg",source:"local"},
];
it("uses a YouTube banner for page backgrounds while wide cards keep backdrops",async()=>{
 localStorage.setItem("posterview.dashboardBackdropEnabled","true");
 localStorage.setItem("posterview.libraryView.native","backdrop");
 localStorage.setItem("posterview.youtubeBackground.native","banner");
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([{...series,artwork:channelArtwork}]);
 mount("/",{...library,library_type:"youtube"});
 const card=await screen.findByRole("button",{name:/Open Example Series/});
 expect(card.querySelector("img")?.getAttribute("src")).toContain("/backdrop?");
 fireEvent.click(card);
 await screen.findByRole("heading",{name:"Example Series"});
 await waitFor(()=>expect(document.querySelector('img[src*="/banner?"]')).toBeTruthy());
});
it.each(["youtube","anime"] as const)("keeps backdrop fallback and non-YouTube backgrounds for %s",async type=>{
 localStorage.setItem("posterview.dashboardBackdropEnabled","true");
 localStorage.setItem("posterview.youtubeBackground.native","banner");
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([{...series,artwork:type==="youtube"?channelArtwork.filter(a=>a.kind!=="banner"):channelArtwork}]);
 mount("/?native_library=native&native_item=show",{...library,library_type:type});
 await screen.findByRole("heading",{name:"Example Series"});
 await waitFor(()=>expect(document.querySelector('img[src*="/backdrop?"]')).toBeTruthy());
 expect(document.querySelector('img[src*="/banner?"]')).toBeNull();
});
it("inherits a YouTube channel banner for video page backgrounds",async()=>{
 localStorage.setItem("posterview.dashboardBackdropEnabled","true");
 localStorage.setItem("posterview.youtubeBackground.native","banner");
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([{...series,artwork:channelArtwork},{...episode,parent_path:series.path}]);
 mount("/?native_library=native&native_item=episode",{...library,library_type:"youtube"});
 await screen.findByRole("heading",{name:"S1:E1 - First Episode"});
 await waitFor(()=>expect(document.querySelector('img[src*="/show/banner?"]')).toBeTruthy());
});
