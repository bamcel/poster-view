import {cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {MemoryRouter, useLocation} from "react-router-dom";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import SeriesPreviewPlay from "./SeriesPreviewPlay";
import {seriesPlaybackSelection} from "../lib/seriesPlaybackSelection";
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
  const view = render(<QueryClientProvider client={client}><MemoryRouter><SeriesPreviewPlay title={item} onChoosingChange={onChoosingChange}/><Destination/></MemoryRouter></QueryClientProvider>);
  return {...view, client, onChoosingChange};
}
beforeEach(() => {vi.clearAllMocks(); vi.mocked(nativeLibraries.summaries).mockResolvedValue([series, one, two].map(item => ({...item, files: [], metadata: {...item.metadata, _has_files: item.kind === "episode"}}))); vi.mocked(nativeLibraries.catalog).mockResolvedValue([series, one, two]); vi.mocked(watchApi.states).mockResolvedValue({}); vi.mocked(watchApi.continue).mockResolvedValue([]);});
afterEach(cleanup);

it("resolves summary-only episodes without fetching the full catalog or starting playback", async () => {
  const view = setup(); await waitFor(() => expect(screen.getByRole("button", {name: "Play"}).hasAttribute("disabled")).toBe(false));
  expect(view.onChoosingChange).not.toHaveBeenCalled(); expect(nativeLibraries.catalog).not.toHaveBeenCalled(); expect(screen.getByRole("status").textContent).toBe("/");
  fireEvent.click(screen.getByRole("button", {name: "Play"})); await waitFor(() => expect(screen.getByRole("status").textContent).toBe("/play/native/library/one?return=%2F&start=0"));
  expect(view.onChoosingChange).toHaveBeenLastCalledWith(false);
});
it("opens playback choices only after Play and resumes the correct episode", async () => {
 vi.mocked(watchApi.continue).mockResolvedValue([continued(two)]); const view=setup();
 await waitFor(()=>expect(screen.getByRole("button",{name:"Play"}).hasAttribute("disabled")).toBe(false));
 expect(screen.queryByRole("button",{name:"Resume"})).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"Play"}));
 expect(await screen.findByRole("dialog",{name:"Play video"})).toBeTruthy();
 expect(view.onChoosingChange).toHaveBeenLastCalledWith(true);
 fireEvent.click(screen.getByRole("button",{name:"Resume"}));
 await waitFor(()=>expect(screen.getByRole("status").textContent).toBe("/play/native/library/two?return=%2F"));
});
it("restarts at S1E1 without touching saved watch state", async () => {
  vi.mocked(watchApi.states).mockResolvedValue({two: {...state, watched: true}}); setup();
  await waitFor(()=>expect(screen.getByRole("button",{name:"Play"}).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button",{name:"Play"}));
  fireEvent.click(await screen.findByRole("button", {name: "Play from beginning"}));
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("/play/native/library/one?return=%2F&start=0"));
});
it("does not navigate when no playable episodes are available", async () => {
  vi.mocked(nativeLibraries.summaries).mockResolvedValue([series]); vi.mocked(nativeLibraries.catalog).mockResolvedValue([series]); setup();
  await waitFor(() => expect(screen.getByRole("button", {name: "Play"}).hasAttribute("disabled")).toBe(false)); fireEvent.click(screen.getByRole("button", {name: "Play"}));
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
  const content = (item: HomeTitle) => <QueryClientProvider client={client}><MemoryRouter><SeriesPreviewPlay title={item}/><Destination/></MemoryRouter></QueryClientProvider>;
  const view = render(content(title));
  await waitFor(() => expect(screen.getByRole("button", {name: "Play"}).hasAttribute("disabled")).toBe(false)); fireEvent.click(screen.getByRole("button", {name: "Play"}));
  view.rerender(content({...title, entry: {...series, id: "other", path: "/other"}}));
  resolve([series, one]); await waitFor(() => expect(screen.getByRole("button", {name: "Play"}).hasAttribute("disabled")).toBe(false)); expect(screen.getByRole("status").textContent).toBe("/");
});

it("chooses S1E1 before specials and handles grouped series aliases", () => {
  const canonical = {...series, metadata: {identifiers: {tvdb: "1"}}};
  const alias = {...canonical, id: "alias", path: "/alias"};
  const result = seriesPlaybackSelection([canonical, alias, episode("special", 0), two, {...one, path: "/alias/one"}], canonical, title.library, {}, []);
  expect(result.first.id).toBe("one"); expect(result.history).toBe(false);
});
it("ignores unrelated series and inaccessible or missing episodes", () => {
  const items = [series, {...one, available: false}, two, {...episode("missing"), metadata: {season: 1, episode: 1, missing: true}}, episode("unrelated", 1, 1, "/different/one")];
  const result = seriesPlaybackSelection(items, series, title.library, {}, [continued(one), continued(two, "other")]);
  expect(result.first.id).toBe("two"); expect(result.history).toBe(false);
});
it("uses latest unfinished progress or advances after completed episodes", () => {
  const entries = [series, one, two];
  expect(seriesPlaybackSelection(entries, series, title.library, {one: {...state, position_seconds: 50, last_played_at: "2026-01-01"}, two: {...state, position_seconds: 100, last_played_at: "2026-02-01"}}, []).resume.id).toBe("two");
  expect(seriesPlaybackSelection(entries, series, title.library, {one: {...state, watched: true}}, []).resume.id).toBe("two");
  expect(seriesPlaybackSelection(entries, series, title.library, {one: {...state, watched: true}, two: {...state, watched: true}}, []).restart).toBe(true);
});
it("offers no playback for unavailable series", () => {
  setup({...title, entry: {...series, available: false}});
  expect(screen.queryByRole("button")).toBeNull(); expect(nativeLibraries.summaries).not.toHaveBeenCalled();
});
