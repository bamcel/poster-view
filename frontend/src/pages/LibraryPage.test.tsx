import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import LibraryPage from "./LibraryPage";
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
  imageUrl: () => undefined,
}));
afterEach(cleanup);
it.each(["book", "other"] as const)(
  "shows an enabled manga library classified as %s",
  async (type) => {
    vi.mocked(api.getLibraries).mockResolvedValue([
      { id: "manga", title: "Manga", type },
    ]);
    vi.mocked(api.getItems).mockResolvedValue([
      { id: "book", title: "Food Wars Vol 14", type: "book" },
    ]);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <LibraryPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("button", { name: "Manga" })).toBeTruthy();
    await waitFor(() =>
      expect(api.getItems).toHaveBeenCalledWith(1, "manga", true),
    );
    expect(await screen.findByText("Food Wars Vol 14")).toBeTruthy();
    client.clear();
  },
);
