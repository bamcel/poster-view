import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import WatchHistoryPage from "./WatchHistoryPage";
import { watchApi } from "../features/playback/api/watch";

vi.mock("../features/playback/api/watch", () => ({ watchApi: { history: vi.fn() } }));
afterEach(cleanup);

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter><WatchHistoryPage /></MemoryRouter>
    </QueryClientProvider>,
  );
}

it("links personal history back to playback and identifies completed items", async () => {
  vi.mocked(watchApi.history).mockResolvedValue([{
    library_id: "family", item_id: "film", title: "Family film", library_name: "Family",
    kind: "movie", entry: {} as never, state: { watched: true } as never,
  }]);
  mount();
  expect((await screen.findByRole("link", { name: /Family film/ })).getAttribute("href"))
    .toContain("/play/native/family/film");
  expect(screen.getByText("Watched")).toBeTruthy();
});

it("shows a useful empty history", async () => {
  vi.mocked(watchApi.history).mockResolvedValue([]);
  mount();
  expect(await screen.findByText(/history will appear/)).toBeTruthy();
});
