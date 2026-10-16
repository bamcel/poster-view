import {cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {MemoryRouter, useLocation} from "react-router-dom";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import SeriesBannerPlay from "./SeriesBannerPlay";
import {nativeLibraries, type NativeCatalogEntry, type NativeLibrary} from "../api/nativeLibraries";
import {watchApi, type WatchState, type ContinueItem} from "../features/playback/api/watch";
import type {HomeTitle} from "./HomeDiscovery";

vi.mock("../api/nativeLibraries", () => ({nativeLibraries: {catalog: vi.fn(), summaries: vi.fn()}}));
vi.mock("../features/playback/api/watch", () => ({watchApi: {states: vi.fn(), continue: vi.fn()}}));
const state: WatchState = {position_seconds: 0, duration_seconds: 1000, watched: false, play_count: 0, last_played_at: null, audio_index: null, subtitle_index: null, session_id: null, version: 1};
const series: NativeCatalogEntry = {id: "series", path: "/series", title: "Anime", kind: "series", parent_path: null, available: true, revision: 1, metadata: {}, files: [], artwork: [], nfo_path: null};
const title: HomeTitle = {entry: series, library: {id: "library", name: "Anime"} as NativeLibrary};
function episode(id: string, season = 1, number = 1, path = `/series/${id}`): NativeCatalogEntry {return {...series, id, kind: "episode", path, metadata: {season, episode: number}, files: [{path: `${path}.mkv`, size: 1, extension: "mkv"}]};}
const one = episode("one"), two = episode("two", 1, 2);
function continued(item = one, library = "library"): ContinueItem {return {library_id: library, library_name: "Anime", item_id: item.id, title: item.title, kind: "episode", entry: item, state: {...state, position_seconds: 200}};}
function Destination() {const location = useLocation(); return <output>{location.pathname}{location.search}</output>;}
function setup(item = title) {
  const client = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: 0}}});
  const onChoosingChange = vi.fn();
  const view = render(<QueryClientProvider client={client}><MemoryRouter><SeriesBannerPlay title={item}/><Destination/></MemoryRouter></QueryClientProvider>);
  return {...view, client, onChoosingChange};
}
beforeEach(() => {vi.clearAllMocks(); vi.mocked(nativeLibraries.summaries).mockResolvedValue([series, one, two].map(item => ({...item, files: [], metadata: {...item.metadata, _has_files: item.kind === "episode"}}))); vi.mocked(nativeLibraries.catalog).mockResolvedValue([series, one, two]); vi.mocked(watchApi.states).mockResolvedValue({}); vi.mocked(watchApi.continue).mockResolvedValue([]);});
afterEach(cleanup);

it("resolves summary-only episodes without fetching the full catalog or starting playback", async () => {
  setup(); await waitFor(() => expect(screen.getByRole("button", {name: "Play from beginning"}).hasAttribute("disabled")).toBe(false));
  expect(nativeLibraries.catalog).not.toHaveBeenCalled(); expect(screen.getByRole("status").textContent).toBe("/");
  fireEvent.click(screen.getByRole("button", {name: "Play from beginning"})); await waitFor(() => expect(screen.getByRole("status").textContent).toBe("/play/native/library/one?return=%2F&start=0"));
});
it("shows adjacent restart and continue buttons for history and resumes the correct episode", async () => {
  vi.mocked(watchApi.continue).mockResolvedValue([continued(two)]); setup();
  await screen.findByRole("button", {name: "Resume"});
  fireEvent.click(screen.getByRole("button", {name: "Resume"}));
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("/play/native/library/two?return=%2F"));
});
it("restarts at S1E1 without touching saved watch state", async () => {
  vi.mocked(watchApi.states).mockResolvedValue({two: {...state, watched: true}}); setup();
  await waitFor(() => expect(screen.getByRole("button", {name: "Play from beginning"}).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", {name: "Play from beginning"}));
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("/play/native/library/one?return=%2F&start=0"));
});
it("does not navigate when no playable episodes are available", async () => {
  vi.mocked(nativeLibraries.summaries).mockResolvedValue([series]); vi.mocked(nativeLibraries.catalog).mockResolvedValue([series]); setup();
  await waitFor(() => expect(screen.getByRole("button", {name: "Play from beginning"}).hasAttribute("disabled")).toBe(false)); fireEvent.click(screen.getByRole("button", {name: "Play from beginning"}));
  expect((await screen.findByRole("alert")).textContent).toBe("No playable episodes are available."); expect(screen.getByRole("status").textContent).toBe("/");
});
it("allows retry after a failed history request", async () => {
  vi.mocked(watchApi.states).mockRejectedValueOnce(new Error("offline")); setup();
  fireEvent.click(await screen.findByRole("button", {name: "Retry playback"}));
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("/one?"));
});
it("ignores pending playback completion after title changes", async () => {
  vi.mocked(nativeLibraries.summaries).mockResolvedValue([series]);
  let resolve!: (items: NativeCatalogEntry[]) => void;
  vi.mocked(nativeLibraries.catalog).mockReturnValue(new Promise(done => {resolve = done;}));
  const client = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: 0}}});
  const content = (item: HomeTitle) => <QueryClientProvider client={client}><MemoryRouter><SeriesBannerPlay title={item}/><Destination/></MemoryRouter></QueryClientProvider>;
  const view = render(content(title));
  await waitFor(() => expect(screen.getByRole("button", {name: "Play from beginning"}).hasAttribute("disabled")).toBe(false)); fireEvent.click(screen.getByRole("button", {name: "Play from beginning"}));
  view.rerender(content({...title, entry: {...series, id: "other", path: "/other"}}));
  resolve([series, one]); await waitFor(() => expect(screen.getByRole("button", {name: "Play from beginning"}).hasAttribute("disabled")).toBe(false)); expect(screen.getByRole("status").textContent).toBe("/");
});
