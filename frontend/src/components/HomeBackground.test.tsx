import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { nativeLibraries, type NativeCatalogEntry, type NativeLibrary } from "../api/nativeLibraries";
import { setBackdropOverlay } from "../lib/dashboardSettings";
import HomeBackground from "./HomeBackground";

vi.mock("./DashboardBackdrop", () => ({ default: (props: unknown) => <div data-testid="background">{JSON.stringify(props)}</div> }));
const library = (id: string, library_type: NativeLibrary["library_type"] = "anime") => ({ id, library_type } as NativeLibrary);
const entry = (id: string, kinds = ["backdrop"]): NativeCatalogEntry => ({ id, title: id, path: id, kind: "series", parent_path: null, available: true, metadata: {}, revision: 1, nfo_path: null, files: [], artwork: kinds.map(kind => ({ kind, path: `${id}-${kind}.jpg`, source: "local" })) });
const clients: QueryClient[] = [];
function mount(libraries: NativeLibrary[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const content = (items: NativeLibrary[]) => <QueryClientProvider client={client}><HomeBackground libraries={items} /></QueryClientProvider>;
  const view = render(content(libraries));
  return { ...view, update: (items: NativeLibrary[]) => view.rerender(content(items)) };
}
const props = () => JSON.parse(screen.getByTestId("background").textContent!) as { desktopUrls: string[]; mobileUrls: string[]; overlayStrength: number };
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); localStorage.clear(); vi.restoreAllMocks(); });

it("collects every accessible library's backdrops including books without loading full catalogs", async () => {
  const summaries = vi.spyOn(nativeLibraries, "summaries").mockImplementation(async id => id === "books" ? [entry("book", ["fanart"])] : Array.from({ length: 24 }, (_, index) => entry(`${id}-${index}`, ["backdrop", "fanart"])));
  const catalog = vi.spyOn(nativeLibraries, "catalog");
  mount([library("anime"), library("movies", "movies"), library("books", "books"), library("youtube", "youtube")]);
  await waitFor(() => expect(props().desktopUrls).toHaveLength(49));
  expect(summaries.mock.calls.map(call => call[0]).sort()).toEqual(["anime", "books", "movies"]);
  expect(catalog).not.toHaveBeenCalled();
  expect(props().mobileUrls).toEqual(props().desktopUrls);
  expect(props().desktopUrls.filter(url => url.includes("/artwork/fanart?"))).toHaveLength(1);
  expect(props().desktopUrls.every(url => new URL(url, "http://localhost").searchParams.has("v"))).toBe(true);
});

it("immediately removes revoked libraries even while their summaries remain cached", async () => {
  vi.spyOn(nativeLibraries, "summaries").mockImplementation(async id => [entry(id)]);
  const view = mount([library("allowed"), library("revoked")]);
  await waitFor(() => expect(props().desktopUrls).toHaveLength(2));
  view.update([library("allowed")]);
  expect(props().desktopUrls).toHaveLength(1);
  expect(props().desktopUrls[0]).not.toContain("revoked");
  view.update([]);
  expect(screen.queryByTestId("background")).toBeNull();
});

it("excludes missing or unavailable artwork and responds to appearance changes", async () => {
  vi.spyOn(nativeLibraries, "summaries").mockResolvedValue([entry("good"), entry("landscape", ["landscape"]), { ...entry("missing"), metadata: { missing: true } }, { ...entry("offline"), available: false }]);
  mount([library("anime")]);
  await waitFor(() => expect(props().desktopUrls).toHaveLength(1));
  expect(props().desktopUrls[0]).toContain("good");
  act(() => setBackdropOverlay(35));
  expect(props().overlayStrength).toBe(35);
});
