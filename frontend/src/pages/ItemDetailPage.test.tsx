import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api } from "../api/client";
import ItemDetailPage from "./ItemDetailPage";

vi.mock("../components/ArtworkPanel", () => ({ default: () => null }));
vi.mock("../api/client", () => ({ imageUrl: () => undefined, api: { getItemDetail: vi.fn(), refreshArtworkItem: vi.fn() } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("refreshes artwork for the current server and title, prevents duplicate requests, and displays failures", async () => {
  vi.mocked(api.getItemDetail).mockResolvedValue({ id: "movie", title: "Movie", type: "movie", seasons: [], external_ids: {}, members: [] });
  let finish!: (value: Awaited<ReturnType<typeof api.refreshArtworkItem>>) => void;
  vi.mocked(api.refreshArtworkItem).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MemoryRouter initialEntries={["/item/7/movie"]}><QueryClientProvider client={client}><Routes><Route path="/item/:serverId/:itemId" element={<ItemDetailPage />} /></Routes></QueryClientProvider></MemoryRouter>);
  fireEvent.click(await screen.findByRole("button", { name: "Refresh artwork" }));
  await waitFor(() => expect(api.refreshArtworkItem).toHaveBeenCalledWith(7, "movie"));
  expect((await screen.findByRole("button", { name: "Refreshing artwork…" })).hasAttribute("disabled")).toBe(true);
  finish({ ok: false, message: "Provider unavailable", providers_warmed: 0 });
  expect(await screen.findByText("Provider unavailable")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Refresh artwork" }).hasAttribute("disabled")).toBe(false);
  client.clear();
});
