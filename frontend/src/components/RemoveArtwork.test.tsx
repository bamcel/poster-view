import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { ItemDetail } from "../types";
import RemoveArtwork from "./RemoveArtwork";

const push = vi.fn();

vi.mock("../api/client", () => ({ api: { removeArtwork: vi.fn() } }));
vi.mock("../lib/toast", () => ({ useToast: () => ({ push }) }));

const item: ItemDetail = {
  id: "series",
  title: "Example series",
  type: "folder",
  external_ids: {},
  seasons: [{ id: "season-1", title: "Season 1", index: 1 }],
  members: [{ id: "volume-1", title: "Volume 1", type: "book", year: null }],
};

let client: QueryClient;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.mocked(api.removeArtwork).mockResolvedValue({ ok: true, message: "Removed." });
});

afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  push.mockReset();
});

it("removes every exposed series, season, and member artwork target", async () => {
  render(
    <QueryClientProvider client={client}>
      <RemoveArtwork serverId={7} item={item} includeFolderBackdrop />
    </QueryClientProvider>,
  );

  fireEvent.click(screen.getByRole("button", { name: "Remove All" }));

  await waitFor(() => expect(api.removeArtwork).toHaveBeenCalledTimes(4));
  expect(vi.mocked(api.removeArtwork).mock.calls.map(([request]) => request)).toEqual([
    { server_id: 7, item_id: "series", target: "poster" },
    { server_id: 7, item_id: "series", target: "background" },
    { server_id: 7, item_id: "season-1", target: "poster" },
    { server_id: 7, item_id: "volume-1", target: "poster" },
  ]);
  expect(push).toHaveBeenCalledWith("success", "Removed artwork from 4 targets.");
});
