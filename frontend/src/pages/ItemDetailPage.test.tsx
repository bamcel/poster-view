import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { api } from "../api/client";
import ItemDetailPage from "./ItemDetailPage";

vi.mock("../components/ArtworkPanel", () => ({ default: () => null }));
vi.mock("../api/client", () => ({ imageUrl: (_serverId: number, image?: string | null) => image ? `/api/image/${image}` : undefined, api: { getItemDetail: vi.fn(), getNfoMetadata: vi.fn(), refreshArtworkItem: vi.fn() } }));
vi.mock("../lib/toast", () => ({ useToast: () => ({ push: vi.fn() }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); localStorage.clear(); });

function LocationProbe() {
  const location = useLocation();
  return <div>{location.pathname}{location.search}</div>;
}

it("shows a populated manga edition immediately after volumes", async () => {
  vi.mocked(api.getItemDetail).mockResolvedValue({ id: "manga", title: "Manga", type: "folder", seasons: [], external_ids: {}, members: [] });
  vi.mocked(api.getNfoMetadata).mockResolvedValue({
    title: "Manga", year: "", publisher: "", edition: "Color", volumes: "12", status: "", plot: "",
    anilist_id: "", comicvine_id: "", source_url: "", native_title: "", translation: "", mal_id: "",
    genres: "", tags: "", creators: "", country: "", source_material: "",
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MemoryRouter initialEntries={["/item/7/manga"]}><QueryClientProvider client={client}><Routes><Route path="/item/:serverId/:itemId" element={<ItemDetailPage />} /></Routes></QueryClientProvider></MemoryRouter>);

  await screen.findByText("Manga");
  const volumesPill = screen.getByText("Volumes").closest("span.inline-flex");
  const editionPill = screen.getByText("Edition").closest("span.inline-flex");
  expect(volumesPill?.textContent).toBe("Volumes · 12");
  expect(editionPill?.textContent).toBe("Edition · Color");
  expect(volumesPill?.nextElementSibling).toBe(editionPill);
  client.clear();
});

it("keeps mobile detail actions together and publisher metadata in a single pill", async () => {
  vi.mocked(api.getItemDetail).mockResolvedValue({ id: "manga", title: "Manga", type: "folder", seasons: [], external_ids: {}, members: [] });
  vi.mocked(api.getNfoMetadata).mockResolvedValue({
    title: "Manga", year: "", publisher: "Viz", edition: "", volumes: "", status: "", plot: "",
    anilist_id: "123", comicvine_id: "", source_url: "https://anilist.co/manga/123", native_title: "", translation: "", mal_id: "",
    genres: "", tags: "", creators: "", country: "", source_material: "",
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MemoryRouter initialEntries={["/item/7/manga"]}><QueryClientProvider client={client}><Routes><Route path="/item/:serverId/:itemId" element={<ItemDetailPage />} /></Routes></QueryClientProvider></MemoryRouter>);

  const mobileActions = (await screen.findByRole("button", { name: "Refresh artwork" })).parentElement;
  expect(mobileActions?.className).toContain("xl:hidden");
  expect(mobileActions?.querySelectorAll("button")).toHaveLength(3);
  expect(mobileActions?.textContent).toContain("Edit Metadata");
  expect(mobileActions?.textContent).toContain("Artwork");
  const publisherPill = screen.getByText("Publisher").closest("span.inline-flex");
  expect(publisherPill?.className).toContain("shrink-0");
  expect(publisherPill?.textContent).toContain("Publisher · Viz");
  client.clear();
});

it("renders a selected title backdrop across the viewport without a visible scrollbar", async () => {
  localStorage.setItem("posterview.dashboardBackdropEnabled", "true");
  vi.mocked(api.getItemDetail).mockResolvedValue({ id: "movie", title: "Movie", type: "movie", background: "movie-backdrop", seasons: [], external_ids: {}, members: [] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MemoryRouter initialEntries={["/item/7/movie"]}><QueryClientProvider client={client}><Routes><Route path="/item/:serverId/:itemId" element={<ItemDetailPage />} /></Routes></QueryClientProvider></MemoryRouter>);

  await screen.findByText("Movie");
  const backdrop = screen.getByTestId("item-backdrop");
  expect(backdrop.parentElement).toBe(document.body);
  expect(backdrop.querySelector("img")?.getAttribute("src")).toBe("/api/image/movie-backdrop");
  expect(screen.getByTestId("item-backdrop-overlay-mobile").parentElement).toBe(backdrop);
  expect(screen.getByTestId("item-backdrop-overlay-desktop").parentElement).toBe(backdrop);
  expect(document.querySelector(".overflow-y-auto")?.classList.contains("scrollbar-hidden")).toBe(true);
  client.clear();
});

it("returns directly to the manga series parent folder", async () => {
  vi.mocked(api.getItemDetail).mockResolvedValue({ id: "dragon-ball", title: "Dragon Ball", type: "folder", seasons: [], external_ids: {}, members: [] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter initialEntries={["/server/7/item/dragon-ball?return_library=manga&return_folder=jump-comics&return_folder_title=Jump+Comics"]}>
      <QueryClientProvider client={client}>
        <Routes>
          <Route path="/server/:serverId/item/:itemId" element={<ItemDetailPage />} />
          <Route path="/" element={<LocationProbe />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Back" }));
  expect(await screen.findByText("/?lib=manga&folder=jump-comics&folder_title=Jump+Comics")).toBeTruthy();
  client.clear();
});

it("makes manga volume files readable while nested folders remain openable", async () => {
  vi.mocked(api.getItemDetail).mockResolvedValue({
    id: "dragon-ball",
    title: "Dragon Ball",
    type: "folder",
    seasons: [],
    external_ids: {},
    members: [
      { id: "volume-2", title: "Volume 2", type: "book" },
      { id: "extras", title: "Extras", type: "folder" },
    ],
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter initialEntries={["/server/7/item/dragon-ball?return_library=manga"]}>
      <QueryClientProvider client={client}>
        <Routes><Route path="/server/:serverId/item/:itemId" element={<ItemDetailPage />} /></Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );

  const volume = await screen.findByText("Volume 2");
  expect(volume.closest("button")).toBeTruthy();
  expect(volume.closest("button")?.textContent).toContain("Read");
  expect(volume.closest("button")?.textContent).not.toContain("Open");
  expect(screen.queryByRole("button", { name: "Read" })).toBeNull();
  expect(screen.getByRole("button", { name: /Extras/ })).toBeTruthy();
  client.clear();
});

it("refreshes artwork for the current server and title, prevents duplicate requests, and displays failures", async () => {
  vi.mocked(api.getItemDetail).mockResolvedValue({ id: "movie", title: "Movie", type: "movie", seasons: [], external_ids: {}, members: [] });
  let finish!: (value: Awaited<ReturnType<typeof api.refreshArtworkItem>>) => void;
  vi.mocked(api.refreshArtworkItem).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MemoryRouter initialEntries={["/item/7/movie"]}><QueryClientProvider client={client}><Routes><Route path="/item/:serverId/:itemId" element={<ItemDetailPage />} /></Routes></QueryClientProvider></MemoryRouter>);
  expect((await screen.findByTitle("Refresh from server")).parentElement?.className).toContain("hidden");
  expect(screen.getByTitle("Refresh from server").parentElement?.className).toContain("xl:flex");
  fireEvent.click(await screen.findByRole("button", { name: "Refresh artwork" }));
  await waitFor(() => expect(api.refreshArtworkItem).toHaveBeenCalledWith(7, "movie"));
  expect((await screen.findByRole("button", { name: "Refresh artwork" })).hasAttribute("disabled")).toBe(true);
  finish({ ok: false, message: "Provider unavailable", providers_warmed: 0 });
  expect(await screen.findByText("Provider unavailable")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Refresh artwork" }).hasAttribute("disabled")).toBe(false);
  client.clear();
});
