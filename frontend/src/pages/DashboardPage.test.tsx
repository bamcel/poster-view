import {nativeLibraries, defaultNativeOptions} from "../api/nativeLibraries";
vi.mock("../api/nativeLibraries", async original => ({...await original<typeof import("../api/nativeLibraries")>(), nativeLibraries: {list: vi.fn(), status: vi.fn(), catalog: vi.fn(), scan: vi.fn(), remove: vi.fn(), editItem: vi.fn(), upload: vi.fn(), artworkUrl: vi.fn()}}));

it.each(["movie", "show", "collection", "other"] as const)("preserves %s library controls, sorting, and metadata navigation", async (type) => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  vi.mocked(api.getLibraries).mockResolvedValue([{ id: "movies", title: "Test Library", type }]);
  vi.mocked(api.getItems).mockResolvedValue([{ id: "two", title: "Title 2", type: "movie" }, { id: "ten", title: "Title 10", type: "movie" }]);
  const { client, container } = renderDashboard();
  await screen.findByText("Title 2");
  expect(screen.queryByRole("button", { name: "Library preferences" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Select Title 2" })).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
  const cards = container.querySelectorAll('button[title*="right-click for options"]');
  expect(cards[0].getAttribute("title")).toContain("Title 10");
  const filter = screen.getByLabelText("Filter and sort titles");
  const details = filter.closest("details")!;
  fireEvent.click(filter);
  expect(details.open).toBe(true);
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(details.open).toBe(false);
  fireEvent.click(filter);
  fireEvent.pointerDown(document.body);
  expect(details.open).toBe(false);
  fireEvent.contextMenu(screen.getByTitle("Title 2 · right-click for options"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Edit Metadata" }));
  expect(screen.queryByRole("dialog", { name: "Metadata editor" })).toBeNull();
  expect(screen.getByTestId("location").textContent).toContain("/server/1/item/two?");
  expect(screen.getByTestId("location").textContent).toContain("edit_metadata=1");
  client.clear();
});

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import DashboardPage from "./DashboardPage";
import { api } from "../api/client";
vi.mock("../components/LibraryMetadataEditor", () => ({ default: ({ item, onClose }: { item: { title: string }; onClose: () => void }) => <div role="dialog" aria-label="Metadata editor">{item.title}<button onClick={onClose}>Close Editor</button></div> }));
function CurrentLocation() { const location = useLocation(); return <output data-testid="location">{location.pathname}{location.search}</output>; }

HTMLDialogElement.prototype.showModal = function () { this.open = true; };
HTMLDialogElement.prototype.close = function () { this.open = false; };

vi.mock("../lib/toast", () => ({ useToast: () => ({ push: vi.fn() }) }));
vi.mock("../lib/serverContext", () => ({
  useServers: () => ({
    selectedServer: { id: 1, name: "Media" },
    isLoading: false,
  }),
}));
vi.mock("../api/client", () => ({
  api: { getLibraries: vi.fn(), getItems: vi.fn() },
  imageUrl: (_serverId: number, image?: string | null) => image ? `/api/image/${image}` : undefined,
}));
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function renderDashboard(initialEntry = "/?lib=movies") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const result = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <CurrentLocation />
        <DashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, client };
}

it.each(["book", "audiobook"] as const)(
  "opens a Preferences popup for %s libraries", async (type) => {
    vi.mocked(api.getLibraries).mockResolvedValue([{ id: "library", title: "Test Library", type }]);
    vi.mocked(api.getItems).mockResolvedValue([]);
    const { client } = renderDashboard("/?lib=library");
    await screen.findByRole("button", { name: "Test Library" });
    fireEvent.click(screen.getByRole("button", { name: "Library preferences" }));
    expect(screen.getByRole("dialog", { name: "Preferences" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close Preferences" }));
    expect(screen.queryByRole("dialog", { name: "Preferences" })).toBeNull();
    client.clear();
  },
);

it("edits metadata without leaving the library or resetting its filter", async () => {
  vi.mocked(api.getLibraries).mockResolvedValue([{ id: "manga", title: "Manga", type: "book" }]);
  vi.mocked(api.getItems).mockResolvedValue([{ id: "series", title: "Chainsaw Man", type: "folder" }]);
  const { client } = renderDashboard("/?lib=manga");
  await screen.findByText("Chainsaw Man");
  fireEvent.change(screen.getByLabelText("Search titles"), { target: { value: "Chainsaw" } });
  fireEvent.contextMenu(screen.getByTitle("Chainsaw Man · right-click for options"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Edit Metadata" }));
  expect(screen.getByRole("dialog", { name: "Metadata editor" })).toBeTruthy();
  expect(screen.getByTestId("location").textContent).toBe("/?lib=manga");
  fireEvent.click(screen.getByText("Close Editor"));
  expect((screen.getByLabelText("Search titles") as HTMLInputElement).value).toBe("Chainsaw");
  expect(screen.getByTestId("location").textContent).toBe("/?lib=manga");
  client.clear();
});

it("waits for NFO titles without flashing folder names", async () => {
  vi.mocked(api.getLibraries).mockResolvedValue([{ id: "manga", title: "Manga", type: "book" }]);
  vi.mocked(api.getItems).mockResolvedValue([{ id: "colored", title: "Chainsaw Man [Colored]", type: "folder" }]);
  let complete!: (value: unknown) => void;
  const pending = new Promise(resolve => { complete = resolve; });
  vi.stubGlobal("fetch", vi.fn((url: string) => url.includes("/reader/info/") ? pending : Promise.resolve({ ok: true, json: async () => ({ tracking_overlays: true }) })));
  const { client } = renderDashboard("/?lib=manga");
  await waitFor(() => expect(api.getItems).toHaveBeenCalled());
  expect(screen.queryByText("Chainsaw Man [Colored]")).toBeNull();
  expect(screen.getByText("Loading titles…")).toBeTruthy();
  complete({ ok: true, json: async () => ({ title: "Chainsaw Man", colored_edition: true }) });
  expect(await screen.findByText("Chainsaw Man")).toBeTruthy();
  expect(screen.queryByText("Chainsaw Man [Colored]")).toBeNull();
  client.clear();
});

it("selects a range without navigation and clears selection when done", async () => {
  vi.mocked(api.getLibraries).mockResolvedValue([{ id: "manga", title: "Manga", type: "book" }]);
  vi.mocked(api.getItems).mockResolvedValue(["A", "B", "C"].map(id => ({ id, title: id, type: "folder" as const })));
  const { client } = renderDashboard("/?lib=manga");
  expect(screen.queryByRole("button", { name: "Select Items" })).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "Select A" }));
  fireEvent.click(screen.getByRole("button", { name: "Select C" }), { shiftKey: true });
  expect(screen.getByText("3 Selected")).toBeTruthy();
  expect(screen.getByTestId("location").textContent).toBe("/?lib=manga");
  expect((screen.getByRole("button", { name: "Bulk Edit" }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.getByRole("button", { name: "Select A" }).getAttribute("aria-pressed")).toBe("false");
  client.clear();
});

it("uses full-width overflow tabs even with legacy collapse preferences", async () => {
  localStorage.setItem("posterview.libraryTabsCollapsed", "true");
  localStorage.setItem("posterview.libraryVisibleCount", "1");
  vi.mocked(api.getLibraries).mockResolvedValue([{ id: "movies", title: "Movies", type: "movie" }]);
  vi.mocked(api.getItems).mockResolvedValue([]);
  const { client } = renderDashboard();
  const tab = await screen.findByRole("button", { name: "Movies" });
  const tabs = screen.getByRole("group", { name: "Libraries" });
  expect(tabs.classList.contains("overflow-x-auto")).toBe(true);
  expect(tabs.style.width).toBe("");
  expect(tab.style.opacity).toBe("");
  expect(screen.queryByRole("button", { name: "Scroll libraries left" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Scroll libraries right" })).toBeNull();
  client.clear();
});

it("restores the last library tab for the selected server", async () => {
  sessionStorage.setItem("posterview.libraryTab.1", "anime");
  vi.mocked(api.getLibraries).mockResolvedValue([
    { id: "movies", title: "Movies", type: "movie" },
    { id: "anime", title: "Anime", type: "show" },
  ]);
  vi.mocked(api.getItems).mockResolvedValue([]);

  const { client } = renderDashboard("/");
  await waitFor(() => expect(screen.getByRole("button", { name: "Anime", pressed: true })).toBeTruthy());
  client.clear();
});

it("shows backdrops from the selected library when enabled", async () => {
  localStorage.setItem("posterview.dashboardBackdropEnabled", "true");
  vi.mocked(api.getLibraries).mockResolvedValue([{ id: "movies", title: "Movies", type: "movie" }]);
  vi.mocked(api.getItems).mockResolvedValue([
    { id: "alien", title: "Alien", type: "movie", poster: "alien-poster", background: "alien-backdrop" },
    { id: "arrival", title: "Arrival", type: "movie", poster: "arrival-poster", background: "arrival-backdrop" },
  ]);

  const { client } = renderDashboard();
  await screen.findByText("Alien");
  const backdrop = screen.getByTestId("dashboard-backdrop");
  const mobileLayers = backdrop.querySelector('[data-backdrop-source="mobile"]')!;
  const desktopLayers = backdrop.querySelector('[data-backdrop-source="desktop"]')!;
  expect(mobileLayers.classList.contains("absolute")).toBe(true);
  expect(mobileLayers.classList.contains("inset-0")).toBe(true);
  expect(mobileLayers.querySelectorAll("img")).toHaveLength(2);
  expect(desktopLayers.querySelectorAll("img")).toHaveLength(2);
  expect(mobileLayers.firstElementChild?.classList.contains("object-cover")).toBe(true);
  expect(desktopLayers.firstElementChild?.classList.contains("object-cover")).toBe(true);
  expect(mobileLayers.innerHTML).toContain("alien-poster");
  expect(mobileLayers.innerHTML).toContain("arrival-poster");
  expect(desktopLayers.innerHTML).toContain("alien-backdrop");
  expect(desktopLayers.innerHTML).toContain("arrival-backdrop");
  client.clear();
});

it("filters by artwork and sorts titles from the compact filter menu", async () => {
  vi.mocked(api.getLibraries).mockResolvedValue([{ id: "movies", title: "Movies", type: "movie" }]);
  vi.mocked(api.getItems).mockResolvedValue([
    { id: "older", title: "Older", type: "movie", year: 1990, poster: "older-poster" },
    { id: "newer", title: "Newer", type: "movie", year: 2020 },
  ]);

  const { container, client } = renderDashboard();
  await screen.findByText("Older");
  fireEvent.click(screen.getByLabelText("Filter and sort titles"));
  fireEvent.change(screen.getByLabelText("Filter by artwork"), { target: { value: "missing-poster" } });
  expect(screen.queryByRole("option", { name: "Has backdrop" })).toBeNull();
  expect(screen.queryByText("Older")).toBeNull();
  expect(screen.getByText("Newer")).toBeTruthy();

  fireEvent.change(screen.getByLabelText("Filter by artwork"), { target: { value: "all" } });
  fireEvent.change(screen.getByLabelText("Sort titles"), { target: { value: "newest" } });
  const cards = container.querySelectorAll('button[title*="right-click for options"]');
  expect(cards).toHaveLength(2);
  expect(cards[0].getAttribute("title")).toContain("Newer");
  client.clear();
});

it("opens the filter popup and closes it through its close button", async () => {
  vi.mocked(api.getLibraries).mockResolvedValue([{ id: "movies", title: "Books", type: "book" }]);
  vi.mocked(api.getItems).mockResolvedValue([{ id: "alien", title: "Alien", type: "folder" }]);

  const { client } = renderDashboard();
  await screen.findByText("Alien");
  const toggle = screen.getByLabelText("Filter and sort titles");
  fireEvent.click(toggle);
  const menu = screen.getByRole("dialog", { name: "Filter & Sort" }) as HTMLDialogElement;
  expect(menu.open).toBe(true);
  fireEvent.click(screen.getByLabelText("Close Filter & Sort"));
  expect(menu.open).toBe(false);
  client.clear();
});

it("applies live panel solidity and blur settings to search controls", async () => {
  localStorage.setItem("posterview.panelSolidity", "65");
  localStorage.setItem("posterview.backdropBlur", "20");
  vi.mocked(api.getLibraries).mockResolvedValue([{ id: "movies", title: "Movies", type: "movie" }]);
  vi.mocked(api.getItems).mockResolvedValue([{ id: "alien", title: "Alien", type: "movie" }]);

  const { client } = renderDashboard();
  await screen.findByText("Alien");
  const search = screen.getByLabelText("Search titles");
  const filterButton = screen.getByLabelText("Filter and sort titles");
  for (const control of [search, filterButton]) {
    expect(control.getAttribute("style")).toContain("65%");
    expect(control.getAttribute("style")).toContain("blur(20px)");
  }

  window.dispatchEvent(new CustomEvent("posterview:panel-solidity", { detail: 30 }));
  window.dispatchEvent(new CustomEvent("posterview:backdrop-blur", { detail: 6 }));
  window.dispatchEvent(new CustomEvent("posterview:panel-overlay", { detail: 25 }));
  await waitFor(() => {
    expect(search.getAttribute("style")).toContain("30%");
    expect(search.getAttribute("style")).toContain("75%");
    expect(filterButton.getAttribute("style")).toContain("blur(6px)");
  });
  client.clear();
});

it("restores a library's scroll position once without jumping during filtering", async () => {
  vi.mocked(api.getLibraries).mockResolvedValue([
    { id: "movies", title: "Movies", type: "movie" },
  ]);
  vi.mocked(api.getItems).mockResolvedValue([
    { id: "alien", title: "Alien", type: "movie" },
    { id: "arrival", title: "Arrival", type: "movie" },
  ]);
  sessionStorage.setItem("posterview.libraryScroll.1.movies.root", "240");

  const { container, client } = renderDashboard();
  await screen.findByText("Alien");
  const scrollContainer = container.querySelector(".overflow-y-auto");
  expect(scrollContainer).toBeTruthy();
  expect(scrollContainer!.classList.contains("scrollbar-hidden")).toBe(true);
  expect(scrollContainer!.scrollTop).toBe(240);

  scrollContainer!.scrollTop = 360;
  fireEvent.change(screen.getByPlaceholderText("Search titles"), {
    target: { value: "Alien" },
  });
  expect(scrollContainer!.scrollTop).toBe(360);
  client.clear();
});

it("keeps folder scroll positions separate from the library root", async () => {
  vi.mocked(api.getLibraries).mockResolvedValue([
    { id: "manga", title: "Manga", type: "book" },
  ]);
  vi.mocked(api.getItems).mockResolvedValue([
    { id: "volume", title: "Volume 1", type: "book" },
  ]);
  sessionStorage.setItem("posterview.libraryScroll.1.manga.root", "120");
  sessionStorage.setItem("posterview.libraryScroll.1.manga.series", "480");

  const { container, client } = renderDashboard(
    "/?lib=manga&folder=series&folder_title=Series",
  );
  await screen.findByText("Volume 1");
  const scrollContainer = container.querySelector(".overflow-y-auto");
  expect(scrollContainer).toBeTruthy();
  expect(scrollContainer!.scrollTop).toBe(480);
  client.clear();
});

it.each(["book", "other"] as const)(
  "shows an enabled manga library classified as %s",
  async (type) => {
    vi.mocked(api.getLibraries).mockResolvedValue([
      { id: "manga", title: "Manga", type },
    ]);
    vi.mocked(api.getItems)
      .mockResolvedValueOnce([
        { id: "series", title: "Food Wars!", type: "folder" },
      ])
      .mockResolvedValueOnce([
        { id: "book", title: "Volume 14", type: "book" },
      ]);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <DashboardPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("button", { name: "Manga" })).toBeTruthy();
    await waitFor(() =>
      expect(api.getItems).toHaveBeenCalledWith(1, "manga", true, "manga"),
    );
    fireEvent.click(await screen.findByText("Food Wars!"));
    await waitFor(() =>
      expect(api.getItems).toHaveBeenCalledWith(1, "manga", true, "series"),
    );
    client.clear();
  },
);

it("lists manual libraries after server libraries in the same dashboard navigation", async () => {
  vi.mocked(api.getLibraries).mockResolvedValue([{id: "movies", title: "Server Movies", type: "movie"}]);
  vi.mocked(api.getItems).mockResolvedValue([{id: "remote", title: "Server Title", type: "movie"}]);
  vi.mocked(nativeLibraries.list).mockResolvedValue([{id: "manual", name: "Local Anime", library_type: "anime", anime_content: "both", paths: ["Anime"], options: defaultNativeOptions, revision: 1, created_at: "", updated_at: ""}]);
  vi.mocked(nativeLibraries.status).mockResolvedValue({status: "complete", count: 1, warnings: []});
  vi.mocked(nativeLibraries.catalog).mockResolvedValue([{id: "local", title: "Manual Title", kind: "series", path: "Anime/Example", parent_path: null, metadata: {title: "Manual Title"}, artwork: [], files: [], nfo_path: null, available: true, revision: 1}]);
  const {client} = renderDashboard();
  await screen.findByText("Server Title");
  fireEvent.click(screen.getByRole("button", {name: "Local Anime · Manual library"}));
  await screen.findByText("Manual Title");
  expect(screen.getByRole("region", {name: "Local Anime library"})).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(nativeLibraries.catalog).toHaveBeenCalledWith("manual");
  expect(screen.queryByLabelText("Library source")).toBeNull();
  const tabs = screen.getByRole("group", {name: "Libraries"}).querySelectorAll("button");
  expect(Array.from(tabs).map(tab => tab.textContent)).toEqual(["Server Movies", "Local AnimeManual"]);
  fireEvent.click(screen.getByRole("button", {name: "Server Movies"}));
  await screen.findByText("Server Title");
  expect(screen.queryByText("Manual Title")).toBeNull();
  client.clear();
});

it("opens manual title links and returns to the same manual library", async () => {
  vi.mocked(nativeLibraries.list).mockResolvedValue([{id:"manual",name:"Local Anime",library_type:"anime",anime_content:"both",paths:["Anime"],revision:1,created_at:"",updated_at:""}]);
  vi.mocked(nativeLibraries.status).mockResolvedValue({status:"complete",count:1,warnings:[]});
  vi.mocked(nativeLibraries.catalog).mockResolvedValue([{id:"local",title:"Manual Title",kind:"series",path:"Anime/Example",parent_path:null,metadata:{title:"Manual Title"},artwork:[],files:[],nfo_path:null,available:true,revision:1}]);
  const {client}=renderDashboard("/?native_library=manual&native_item=local");
  await screen.findByRole("heading",{name:"Manual Title"});
  expect(screen.queryByLabelText("Library source")).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"Back"}));
  await screen.findByLabelText("Search titles");
  expect(screen.getByRole("button",{name:"Local Anime · Manual library"}).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("region",{name:"Local Anime library"})).toBeTruthy();
  client.clear();
});
