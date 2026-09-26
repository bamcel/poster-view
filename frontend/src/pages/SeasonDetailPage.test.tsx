import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "../api/client";
import { seasonsApi, type SeasonDetail } from "../api/seasons";
import SeasonDetailPage from "./SeasonDetailPage";
vi.mock("../api/client", () => ({ api: { getItemDetail: vi.fn() }, imageUrl: (_server: number, ref?: string) => ref ? `/image/${ref}` : undefined }));
vi.mock("../api/seasons", () => ({ seasonsApi: { get: vi.fn() } }));
const season: SeasonDetail = { id: "s1", series_id: "show", title: "Season One", index: 1, poster: "season-poster", background: null, summary: "A season overview.", episodes: [
  { id: "e1", index: 1, index_end: null, title: "Pilot", image: "still", summary: "The story begins.", aired: "2020-03-01T00:00:00Z", runtime_minutes: 42, rating: 8.5, directors: ["A Director"], writers: ["A Writer"], cast: ["Guest Actor"] },
  { id: "e2", index: 2, index_end: 3, title: "Double feature", image: null, summary: null, aired: null, runtime_minutes: null, rating: null, directors: [], writers: [], cast: [] },
] };
const clients: QueryClient[] = [];
beforeEach(() => {
  vi.mocked(api.getItemDetail).mockResolvedValue({ id: "show", title: "Example Series", type: "show", background: "backdrop", seasons: [{ id: "s1", title: "Season One" }, { id: "s2", title: "Season Two" }], members: [], external_ids: {} });
  vi.mocked(seasonsApi.get).mockResolvedValue(structuredClone(season));
});
afterEach(() => { cleanup(); clients.forEach(c => c.clear()); clients.length = 0; vi.resetAllMocks(); });
function mount() { const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client); render(<MemoryRouter initialEntries={["/server/7/series/show/season/s1?return_library=tv"]}><QueryClientProvider client={client}><Routes><Route path="/server/:serverId/series/:seriesId/season/:seasonId" element={<SeasonDetailPage />} /></Routes></QueryClientProvider></MemoryRouter>); }
it("shows episode cards, reveals credits on demand, and searches without leaving the season", async () => {
  mount(); await screen.findByRole("heading", { name: "Season One" });
  expect(screen.getAllByRole("article")).toHaveLength(2);
  expect(screen.getByText("42 min")).toBeTruthy(); expect(screen.getByText("8.5")).toBeTruthy();
  expect(screen.getByText("Episode 02–03")).toBeTruthy();
  expect(screen.queryByText("A Director")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Episode details for Pilot" })); expect(screen.getByText("A Director")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Back to series" }).getAttribute("href")).toBe("/server/7/item/show?return_library=tv");
  fireEvent.change(screen.getByRole("textbox", { name: "Search episodes" }), { target: { value: "Double" } });expect(screen.getAllByRole("article")).toHaveLength(1);
  fireEvent.change(screen.getByRole("textbox", { name: "Search episodes" }), { target: { value: "not found" } });expect(screen.getByRole("status").textContent).toContain("No episodes match");
});
it("handles empty specials and a failed artwork image", async () => {
  vi.mocked(seasonsApi.get).mockResolvedValue({ ...season, title: "Bonus features", index: 0, episodes: [] });mount();await screen.findByText("No episodes available");expect(screen.getByText("Specials")).toBeTruthy();
  fireEvent.error(screen.getByRole("img", { name: "Bonus features poster" }));expect(screen.getByLabelText("Bonus features poster: no artwork")).toBeTruthy();
});
it("shows an actionable error and retries", async () => {
  vi.mocked(seasonsApi.get).mockRejectedValueOnce(new Error("Server offline"));mount();await screen.findByRole("alert");fireEvent.click(screen.getByRole("button", { name: "Try again" }));await screen.findByRole("heading", { name: "Season One" });
});
it("changes seasons and clears the previous search", async () => {
  mount();await screen.findByText("Pilot");fireEvent.change(screen.getByRole("textbox", { name: "Search episodes" }), { target: { value: "Pilot" } });
  vi.mocked(seasonsApi.get).mockResolvedValue({ ...season, id: "s2", title: "Season Two", index: 2 });
  fireEvent.change(screen.getByLabelText("Select season"), { target: { value: "s2" } });await screen.findByRole("heading", { name: "Season Two" });
  expect(seasonsApi.get).toHaveBeenLastCalledWith(7, "show", "s2");expect((screen.getByRole("textbox", { name: "Search episodes" }) as HTMLInputElement).value).toBe("");
});
