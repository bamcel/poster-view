import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { api } from "../api/client";
import ItemDetailPage from "./ItemDetailPage";

vi.mock("../components/ArtworkPanel", () => ({ default: () => null }));
vi.mock("../api/client", () => ({ imageUrl: (_serverId: number, image?: string | null) => image ? `/api/image/${image}` : undefined, api: { getItemDetail: vi.fn(), refreshArtworkItem: vi.fn() } }));
vi.mock("../lib/toast", () => ({ useToast: () => ({ push: vi.fn() }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); localStorage.clear(); });

function LocationProbe() {
  const location = useLocation();
  return <div>{location.pathname}{location.search}</div>;
}

it("renders a selected title backdrop across the viewport", async () => {
  localStorage.setItem("posterview.dashboardBackdropEnabled", "true");
  vi.mocked(api.getItemDetail).mockResolvedValue({ id: "movie", title: "Movie", type: "movie", background: "movie-backdrop", seasons: [], external_ids: {}, members: [] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MemoryRouter initialEntries={["/item/7/movie"]}><QueryClientProvider client={client}><Routes><Route path="/item/:serverId/:itemId" element={<ItemDetailPage />} /></Routes></QueryClientProvider></MemoryRouter>);

  await screen.findByText("Movie");
  const backdrop = screen.getByTestId("item-backdrop");
  expect(backdrop.parentElement).toBe(document.body);
  expect(backdrop.querySelector("img")?.getAttribute("src")).toBe("/api/image/movie-backdrop");
  expect(screen.getByTestId("item-backdrop-mobile-shading").parentElement).toBe(backdrop);
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

it("refreshes artwork for the current server and title, prevents duplicate requests, and displays failures", async () => {
  vi.mocked(api.getItemDetail).mockResolvedValue({ id: "movie", title: "Movie", type: "movie", seasons: [], external_ids: {}, members: [] });
  let finish!: (value: Awaited<ReturnType<typeof api.refreshArtworkItem>>) => void;
  vi.mocked(api.refreshArtworkItem).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MemoryRouter initialEntries={["/item/7/movie"]}><QueryClientProvider client={client}><Routes><Route path="/item/:serverId/:itemId" element={<ItemDetailPage />} /></Routes></QueryClientProvider></MemoryRouter>);
  expect((await screen.findByTitle("Refresh from server")).className).toContain("hidden");
  expect(screen.getByTitle("Refresh from server").className).toContain("sm:flex");
  fireEvent.click(await screen.findByRole("button", { name: "Refresh artwork" }));
  await waitFor(() => expect(api.refreshArtworkItem).toHaveBeenCalledWith(7, "movie"));
  expect((await screen.findByRole("button", { name: "Refreshing artwork…" })).hasAttribute("disabled")).toBe(true);
  finish({ ok: false, message: "Provider unavailable", providers_warmed: 0 });
  expect(await screen.findByText("Provider unavailable")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Refresh artwork" }).hasAttribute("disabled")).toBe(false);
  client.clear();
});
