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
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.clearAllMocks();
});

function renderLibrary(initialEntry = "/?lib=movies") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const result = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <LibraryPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, client };
}

it("restores a library's scroll position once without jumping during filtering", async () => {
  vi.mocked(api.getLibraries).mockResolvedValue([
    { id: "movies", title: "Movies", type: "movie" },
  ]);
  vi.mocked(api.getItems).mockResolvedValue([
    { id: "alien", title: "Alien", type: "movie" },
    { id: "arrival", title: "Arrival", type: "movie" },
  ]);
  sessionStorage.setItem("posterview.libraryScroll.1.movies.root", "240");

  const { container, client } = renderLibrary();
  await screen.findByText("Alien");
  const scrollContainer = container.querySelector(".overflow-y-auto");
  expect(scrollContainer).toBeTruthy();
  expect(scrollContainer!.scrollTop).toBe(240);

  scrollContainer!.scrollTop = 360;
  fireEvent.change(screen.getByPlaceholderText("Search Titles…"), {
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

  const { container, client } = renderLibrary(
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
          <LibraryPage />
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
