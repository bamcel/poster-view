import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import MangaCompleteness from "./MangaCompleteness";
import { api } from "../api/client";
vi.mock("../api/client", () => ({ api: { mangaCatalog: vi.fn() } }));
afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks(); });
const item = { id: "series", title: "Series", type: "folder" as const, seasons: [], external_ids: {}, members: [1, 3].map(v => ({ id: String(v), title: `Series Vol. ${v}`, type: "book" as const })) };
const entry = { id: 123, title: { english: "Series", romaji: null, native: null }, status: "FINISHED", volumes: 3, siteUrl: "https://anilist.co/manga/123", format: "MANGA" };
function mount() { const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); return render(<QueryClientProvider client={client}><MangaCompleteness serverId={7} item={item} /></QueryClientProvider>); }
it("requires a confirmed match before reporting missing volumes", async () => {
  vi.mocked(api.mangaCatalog).mockResolvedValue([entry]);
  mount();
  expect(screen.getByText(/Unknown · 2 numbered/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Search manga" }));
  fireEvent.click(await screen.findByRole("button", { name: /Match Series/ }));
  expect(await screen.findByText("Missing volumes · 2 of 3 volumes")).toBeTruthy();
  expect(screen.getByText("Missing: 2")).toBeTruthy();
});
it("supports edition coverage overrides scoped to the server and folder", () => {
  mount();
  fireEvent.click(screen.getByText("Edition and volume overrides"));
  fireEvent.change(screen.getByLabelText(/Expected volumes/), { target: { value: "3" } });
  fireEvent.click(screen.getByLabelText("This edition is finished"));
  fireEvent.click(screen.getByLabelText("Specify owned volumes manually"));
  fireEvent.change(screen.getByLabelText("Owned volumes"), { target: { value: "1-3" } });
  fireEvent.click(screen.getByRole("button", { name: "Save collection settings" }));
  expect(screen.getByText("Complete · 3 of 3 volumes")).toBeTruthy();
  expect(JSON.parse(localStorage.getItem("posterview.manga-completeness.7.series")!).owned).toBe("1-3");
  expect(localStorage.getItem("posterview.manga-completeness.8.series")).toBeNull();
});
