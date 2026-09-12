import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import MangaDexPanel from "./MangaDexPanel";
import { api } from "../api/client";
import type { ArtworkItem, ItemDetail } from "../types";

vi.mock("../lib/toast", () => ({ useToast: () => ({ push: vi.fn() }) }));
vi.mock("../api/client", () => ({
  api: {
    mangaSelection: vi.fn(),
    saveMangaSelection: vi.fn(),
    searchArtwork: vi.fn(),
    getArtwork: vi.fn(),
    applyPoster: vi.fn(),
  },
}));
const id = "5f20891f-0136-4fa8-afb7-d72f2af23c65";
const item: ItemDetail = {
  id: "book",
  title: "Food Wars Vol 14",
  type: "book",
  seasons: [],
  external_ids: {},
  members: [],
};
const art: ArtworkItem = {
  id: "cover",
  provider: "mangadex",
  type: "poster",
  kind: "book",
  title: "Food Wars!",
  thumb_url: "/thumb",
  download_url: "https://uploads.mangadex.org/covers/test.jpg",
  applyable: true,
  manga: { mangadex_id: id, volume: "14", locale: "ja", description: null },
};
let client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  vi.mocked(api.mangaSelection).mockResolvedValue({
    mangadex_id: "",
    title: "",
    volume: null,
    cover: null,
  });
  vi.mocked(api.saveMangaSelection).mockImplementation(
    async (_s, _i, selection) => selection,
  );
  vi.mocked(api.searchArtwork).mockResolvedValue({
    provider: "mangadex",
    results: [{ id, name: "Food Wars!", alternate_titles: ["食戟のソーマ"] }],
  });
  vi.mocked(api.getArtwork).mockResolvedValue({
    provider: "mangadex",
    items: [art],
  });
  vi.mocked(api.applyPoster).mockResolvedValue({
    ok: true,
    message: "Applied",
  });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.useRealTimers();
});
function show() {
  return render(
    <QueryClientProvider client={client}>
      <MangaDexPanel serverId={1} item={item} onManual={vi.fn()} />
    </QueryClientProvider>,
  );
}

it("persists the chosen series, suggests volume 14, and applies only after preview confirmation", async () => {
  show();
  fireEvent.click(
    await screen.findByRole("button", { name: /Food Wars!.*Select series/ }),
  );
  expect(await screen.findByText("Suggested volume match")).toBeTruthy();
  expect(api.saveMangaSelection).toHaveBeenCalledWith(
    1,
    "book",
    expect.objectContaining({ mangadex_id: id, volume: "14" }),
  );
  expect(api.applyPoster).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /Volume 14.*Suggested/ }));
  expect(screen.getByAltText("Volume 14 cover preview")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Use Cover" }));
  await waitFor(() =>
    expect(api.applyPoster).toHaveBeenCalledWith(
      expect.objectContaining({
        item_id: "book",
        target: "poster",
        provider: "mangadex",
        download_url: art.download_url,
      }),
    ),
  );
  await waitFor(() =>
    expect(api.saveMangaSelection).toHaveBeenCalledWith(
      1,
      "book",
      expect.objectContaining({ cover: art }),
    ),
  );
});

it("restores a saved series, handles missing metadata, filters languages, and keeps manual fallback", async () => {
  vi.mocked(api.mangaSelection).mockResolvedValue({
    mangadex_id: id,
    title: "Food Wars!",
    volume: "14",
    cover: null,
  });
  vi.mocked(api.getArtwork).mockResolvedValue({
    provider: "mangadex",
    items: [
      art,
      {
        ...art,
        id: "unknown",
        manga: {
          mangadex_id: id,
          volume: null,
          locale: null,
          description: null,
        },
      },
    ],
  });
  show();
  expect(await screen.findByText("Volume unknown")).toBeTruthy();
  expect(api.searchArtwork).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Language"), {
    target: { value: "ja" },
  });
  expect(screen.queryByText("Volume unknown")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Choose artwork manually" }),
  ).toBeTruthy();
});

it("debounces typing and ignores stale search results", async () => {
  let finishOld!: (
    value: Awaited<ReturnType<typeof api.searchArtwork>>,
  ) => void;
  vi.mocked(api.searchArtwork).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishOld = resolve;
      }),
  );
  show();
  await waitFor(() => expect(api.searchArtwork).toHaveBeenCalledTimes(1));
  const input = screen.getByLabelText("Search MangaDex");
  fireEvent.change(input, { target: { value: "Nar" } });
  fireEvent.change(input, { target: { value: "Naruto" } });
  await waitFor(() => expect(api.searchArtwork).toHaveBeenCalledTimes(2));
  finishOld({
    provider: "mangadex",
    results: [{ id: "old", name: "Stale series" }],
  });
  await waitFor(() => expect(screen.queryByText("Stale series")).toBeNull());
  expect(api.searchArtwork).toHaveBeenLastCalledWith(
    "mangadex",
    1,
    "book",
    "Naruto",
    false,
  );
});

it("allows retry after a cover lookup failure without losing the saved series", async () => {
  vi.mocked(api.mangaSelection).mockResolvedValue({
    mangadex_id: id,
    title: "Food Wars!",
    volume: "14",
    cover: null,
  });
  vi.mocked(api.getArtwork).mockRejectedValueOnce(
    new Error("Unable to reach MangaDex"),
  );
  show();
  expect(await screen.findByRole("alert")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Suggested volume match")).toBeTruthy();
  expect(api.getArtwork).toHaveBeenLastCalledWith(
    "mangadex",
    1,
    "book",
    id,
    true,
  );
});

it("applies matched covers across every volume from a series page", async () => {
  const series: ItemDetail = {
    ...item,
    id: "series",
    title: "Food Wars!",
    type: "folder",
    members: [
      { id: "v1", title: "Volume 01", type: "book" },
      { id: "v2", title: "Volume 02", type: "book" },
    ],
  };
  const volume1 = { ...art, manga: { ...art.manga!, volume: "1" } };
  const volume2 = {
    ...art,
    id: "cover2",
    download_url: "https://uploads.mangadex.org/covers/volume2.jpg",
    manga: { ...art.manga!, volume: "2" },
  };
  vi.mocked(api.mangaSelection).mockResolvedValue({
    mangadex_id: id,
    title: "Food Wars!",
    volume: null,
    cover: null,
  });
  vi.mocked(api.getArtwork).mockResolvedValue({
    provider: "mangadex",
    items: [volume1, volume2],
  });
  render(
    <QueryClientProvider client={client}>
      <MangaDexPanel serverId={1} item={series} onManual={vi.fn()} />
    </QueryClientProvider>,
  );
  expect(
    await screen.findByRole("button", { name: "→ Volume 01" }),
  ).toBeTruthy();
  expect(screen.getAllByRole("button", { name: /Custom/ })).toHaveLength(2);
  fireEvent.click(screen.getAllByRole("button", { name: /Custom/ })[0]);
  fireEvent.click(screen.getByRole("button", { name: "Series cover" }));
  await waitFor(() =>
    expect(api.applyPoster).toHaveBeenCalledWith(
      expect.objectContaining({ item_id: "series", target: "poster" }),
    ),
  );
  vi.mocked(api.applyPoster).mockClear();
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Apply matching covers to 2 volumes",
    }),
  );
  await waitFor(() => expect(api.applyPoster).toHaveBeenCalledTimes(2));
  expect(api.applyPoster).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({
      item_id: "v1",
      download_url: volume1.download_url,
    }),
  );
  expect(api.applyPoster).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      item_id: "v2",
      download_url: volume2.download_url,
    }),
  );
});
