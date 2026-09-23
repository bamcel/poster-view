import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import DashboardPage from "./DashboardPage";
import { api } from "../api/client";

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
});

function renderDashboard(initialEntry = "/?lib=movies") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const result = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <DashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, client };
}

it.each([false, true])("uses the collapsed library layout only when enabled: %s", async (collapsed) => {
  if (collapsed) localStorage.setItem("posterview.libraryTabsCollapsed", "true");
  vi.mocked(api.getLibraries).mockResolvedValue([{ id: "movies", title: "Movies", type: "movie" }]);
  vi.mocked(api.getItems).mockResolvedValue([]);
  const { client } = renderDashboard();
  await screen.findByRole("button", { name: "Movies" });
  const tabs = screen.getByRole("group", { name: "Libraries" });
  expect(tabs.classList.contains("snap-mandatory")).toBe(collapsed);
  expect(tabs.closest(".md\\:grid-cols-2") !== null).toBe(collapsed);
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

it("closes the title filter menu when pressing outside it", async () => {
  vi.mocked(api.getLibraries).mockResolvedValue([{ id: "movies", title: "Movies", type: "movie" }]);
  vi.mocked(api.getItems).mockResolvedValue([{ id: "alien", title: "Alien", type: "movie" }]);

  const { client } = renderDashboard();
  await screen.findByText("Alien");
  const toggle = screen.getByLabelText("Filter and sort titles");
  const menu = toggle.closest("details")!;
  fireEvent.click(toggle);
  expect(menu.open).toBe(true);
  fireEvent.pointerDown(document.body);
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
