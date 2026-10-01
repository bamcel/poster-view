import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import NativeLibraryBrowser from "./NativeLibraryBrowser";
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
function mount(url = "/") {
  render(
    <MemoryRouter initialEntries={[url]}>
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <NativeLibraryBrowser library={library} />
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
  expect(screen.getByRole("dialog", { name: "Edit Artwork" })).toBeTruthy();
  expect(screen.getByLabelText("Artwork type")).toBeTruthy();
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
  mount("/?native_library=native&native_item=show");
  expect((await screen.findByRole("img", {name: "Character"})).getAttribute("src")).toBe("https://s4.anilist.co/character.jpg");
  const portrait = screen.getByRole("img", {name: "Actor"});
  expect(portrait.getAttribute("src")).toBe("https://image.tmdb.org/t/p/w185/actor.jpg");
  expect(portrait.getAttribute("loading")).toBe("lazy");
  fireEvent.error(portrait);
  expect(screen.queryByRole("img", {name: "Actor"})).toBeNull();
  expect(screen.getByText("Actor")).toBeTruthy();
  expect(screen.getByText("Writer")).toBeTruthy();
});
