import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import NativeLibraryBrowser from "./NativeLibraryBrowser";
vi.mock("../lib/libraryDisplay",()=>({useTrackingOverlays:()=>[true,vi.fn(),{coloredEffect:"both",coloredTitle:true}]}));
vi.mock("./ArtworkPanel", () => ({default: ({serverId, item}: {serverId:number;item:import("../types").ItemDetail}) => <div data-testid="shared-artwork" data-server={serverId} data-item={item.id} data-seasons={item.seasons.map(s=>s.id).join(",")}>Shared artwork lookup</div>}));
import {
  nativeLibraries,
  type NativeCatalogEntry,
  type NativeLibrary,
} from "../api/nativeLibraries";
vi.mock("../api/nativeLibraries", async (original) => ({
  ...(await original<typeof import("../api/nativeLibraries")>()),
  nativeLibraries: {
    status: vi.fn(),
    catalog: vi.fn(),
    editItem: vi.fn(),
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
function mount(url = "/", selectedLibrary = library) {
  render(
    <MemoryRouter initialEntries={[url]}>
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <NativeLibraryBrowser library={selectedLibrary} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}
beforeEach(() => {
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
  vi.clearAllMocks();
  localStorage.clear();
});
it("browses series, seasons and episodes with detail views rather than editors", async () => {
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: /Open Example Series/ }),
  );
  expect(screen.getByRole("heading", { name: "Example Series" })).toBeTruthy();
  expect(screen.getAllByText("Series synopsis").length).toBeGreaterThan(0);
  expect(screen.getByLabelText("Title information")).toBeTruthy();
  expect(screen.queryByText("Save metadata")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Open Season 1/ }));
  expect(screen.getByRole("heading", { name: "Episodes" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open First Episode" }));
  expect(screen.getByRole("heading", { name: "First Episode" })).toBeTruthy();
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
  fireEvent.click(screen.getByRole("button", { name: "Edit Artwork" }));
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
 const heading=screen.getByRole("heading",{name:"Volumes"});expect(heading.nextElementSibling?.className).toContain("grid");
 expect(screen.getByText("2 Volumes")).toBeTruthy();
 expect(screen.getAllByLabelText("Colored edition")).toHaveLength(3);
 expect(screen.getByRole("heading",{name:"Example Series"}).className).toContain("poster-colored-title");
 expect(document.querySelectorAll(".poster-colored-shimmer")).toHaveLength(3);
 expect(screen.queryByText("Old Actor")).toBeNull();expect(screen.getByText("Old Character")).toBeTruthy();
});
