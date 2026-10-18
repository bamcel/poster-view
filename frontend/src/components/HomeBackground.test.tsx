import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { nativeLibraries, type NativeCatalogEntry, type NativeLibrary } from "../api/nativeLibraries";
import { setBackdropOverlay } from "../lib/dashboardSettings";
import { useYoutubeHomepagePreferences } from "../lib/youtubeHomepagePreferences";
import HomeBackground from "./HomeBackground";

vi.mock("./DashboardBackdrop", () => ({ default: (props: unknown) => <div data-testid="background">{JSON.stringify(props)}</div> }));
const library = (id: string, library_type: NativeLibrary["library_type"] = "anime") => ({ id, library_type } as NativeLibrary);
const entry = (id: string, kinds = ["backdrop"]): NativeCatalogEntry => ({ id, title: id, path: id, kind: "series", parent_path: null, available: true, metadata: {}, revision: 1, nfo_path: null, files: [], artwork: kinds.map(kind => ({ kind, path: `${id}-${kind}.jpg`, source: "local" })) });
const clients: QueryClient[] = [];
function mount(libraries: NativeLibrary[], cachedYoutube?: NativeCatalogEntry[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (cachedYoutube) client.setQueryData(["native-catalog", "youtube", "summary"], cachedYoutube);
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

function YoutubePreferences() {
  const preferences = useYoutubeHomepagePreferences("youtube");
  return <>
    <button onClick={() => preferences.setBackground(!preferences.background)}>Toggle channel backgrounds</button>
    <button onClick={() => preferences.setFeatured(!preferences.featured)}>Toggle featured channels</button>
  </>;
}

it("keeps cached YouTube artwork isolated until background opt-in, independently of featured channels", async () => {
  const summaries = vi.spyOn(nativeLibraries, "summaries").mockResolvedValue([entry("cached-channel")]);
  mount([library("youtube", "youtube")], [entry("cached-channel")]);
  render(<YoutubePreferences />);
  expect(screen.queryByTestId("background")).toBeNull();
  expect(summaries).not.toHaveBeenCalled();
  act(() => screen.getByText("Toggle featured channels").click());
  expect(screen.queryByTestId("background")).toBeNull();
  act(() => screen.getByText("Toggle channel backgrounds").click());
  await waitFor(() => expect(props().desktopUrls).toHaveLength(1));
  expect(props().desktopUrls[0]).toContain("cached-channel");
  act(() => screen.getByText("Toggle featured channels").click());
  expect(props().desktopUrls).toHaveLength(1);
  act(() => screen.getByText("Toggle channel backgrounds").click());
  expect(screen.queryByTestId("background")).toBeNull();
});

it("uses only available channel backdrops or fanart, never child series, video artwork or banners", async () => {
  render(<YoutubePreferences />);
  act(() => screen.getByText("Toggle channel backgrounds").click());
  vi.spyOn(nativeLibraries, "summaries").mockResolvedValue([
    entry("channel"), entry("fanart-channel", ["fanart"]), entry("banner-channel", ["banner"]),
    { ...entry("video"), kind: "episode", parent_path: "channel" },
    { ...entry("playlist"), kind: "season", parent_path: "channel" },
    { ...entry("nested-series"), parent_path: "channel" },
    { ...entry("missing-channel"), metadata: { missing: true } },
    { ...entry("offline-channel"), available: false },
  ]);
  const view = mount([library("youtube", "youtube")]);
  await waitFor(() => expect(props().desktopUrls).toHaveLength(2));
  expect(props().desktopUrls[0]).toContain("/items/channel/artwork/backdrop?");
  expect(props().desktopUrls[1]).toContain("/items/fanart-channel/artwork/fanart?");
  view.update([]);
  expect(screen.queryByTestId("background")).toBeNull();
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
