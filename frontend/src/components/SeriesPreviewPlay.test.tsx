import {cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {MemoryRouter, useLocation} from "react-router-dom";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import SeriesPreviewPlay from "./SeriesPreviewPlay";
import {nativeLibraries, type NativeCatalogEntry, type NativeLibrary} from "../api/nativeLibraries";
import {watchApi, type WatchState, type ContinueItem} from "../features/playback/api/watch";
import type {HomeTitle} from "./HomeDiscovery";

vi.mock("../api/nativeLibraries", () => ({nativeLibraries: {catalog: vi.fn()}}));
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
async function open() {fireEvent.click(screen.getByRole("button", {name: "Play Anime"})); await screen.findByRole("group", {name: "Playback options for Anime"});}
beforeEach(() => {vi.clearAllMocks(); vi.mocked(nativeLibraries.catalog).mockResolvedValue([series, one, two]); vi.mocked(watchApi.states).mockResolvedValue({}); vi.mocked(watchApi.continue).mockResolvedValue([]);});
afterEach(cleanup);

it("loads only after Play, starts S1E1 rather than specials and explicitly starts at zero", async () => {
  vi.mocked(nativeLibraries.catalog).mockResolvedValue([series, episode("special", 0), two, one]);
  setup(); expect(nativeLibraries.catalog).not.toHaveBeenCalled(); expect(watchApi.states).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", {name: "Play Anime"}));
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("/play/native/library/one?return=%2F&start=0"));
});
it("asks before resuming an interrupted rewatch and focuses the beginning choice", async () => {
  vi.mocked(watchApi.continue).mockResolvedValue([continued(two)]); setup(); await open();
  expect(document.activeElement).toBe(screen.getByRole("button", {name: "Play from beginning"}));
  expect(screen.getByRole("status").textContent).toBe("/");
  fireEvent.click(screen.getByRole("button", {name: "Continue where you left off"}));
  expect(screen.getByRole("status").textContent).toBe("/play/native/library/two?return=%2F");
});
it("beginning overrides saved resume without modifying watch state", async () => {
  vi.mocked(watchApi.continue).mockResolvedValue([continued(two)]); setup(); await open();
  fireEvent.click(screen.getByRole("button", {name: "Play from beginning"}));
  expect(screen.getByRole("status").textContent).toBe("/play/native/library/one?return=%2F&start=0");
});
it("advances past completed episodes", async () => {
  vi.mocked(watchApi.states).mockResolvedValue({one: {...state, watched: true, play_count: 1}}); setup(); await open();
  fireEvent.click(screen.getByRole("button", {name: "Continue where you left off"}));
  expect(screen.getByRole("status").textContent).toContain("/two?");
});
it("falls back to S1E1 when all episodes are completed", async () => {
  vi.mocked(watchApi.states).mockResolvedValue({one: {...state, watched: true}, two: {...state, watched: true}}); setup(); await open();
  fireEvent.click(screen.getByRole("button", {name: "Continue where you left off"})); expect(screen.getByRole("status").textContent).toBe("/play/native/library/one?return=%2F&start=0");
});
it("selects the latest unfinished progress when continue entry is unavailable", async () => {
  vi.mocked(watchApi.states).mockResolvedValue({one: {...state, position_seconds: 50, last_played_at: "2026-01-01"}, two: {...state, position_seconds: 100, last_played_at: "2026-02-01"}});
  setup(); await open(); fireEvent.click(screen.getByRole("button", {name: "Continue where you left off"})); expect(screen.getByRole("status").textContent).toContain("/two?");
});
it("groups series aliases by identity", async () => {
  const canonical = {...series, metadata: {identifiers: {tvdb: "1"}}};
  vi.mocked(nativeLibraries.catalog).mockResolvedValue([canonical, {...canonical, id: "alias", path: "/alias"}, {...one, path: "/alias/one"}]);
  setup({...title, entry: canonical}); fireEvent.click(screen.getByRole("button", {name: "Play Anime"}));
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("/one?"));
});
it("ignores other libraries, unrelated series, and unplayable episodes", async () => {
  vi.mocked(watchApi.continue).mockResolvedValue([continued(two, "other"), continued(episode("elsewhere", 1, 1, "/different/one"))]);
  vi.mocked(watchApi.states).mockResolvedValue({elsewhere: {...state, watched: true}});
  vi.mocked(nativeLibraries.catalog).mockResolvedValue([series, {...one, available: false}, two, {...episode("missing"), metadata: {season: 1, episode: 1, missing: true}}]);
  setup(); fireEvent.click(screen.getByRole("button", {name: "Play Anime"})); await waitFor(() => expect(screen.getByRole("status").textContent).toContain("/two?"));
});
it("fails safely and allows retry", async () => {
  vi.mocked(watchApi.states).mockRejectedValueOnce(new Error("offline")); setup(); fireEvent.click(screen.getByRole("button", {name: "Play Anime"}));
  await screen.findByRole("alert"); expect(screen.getByRole("status").textContent).toBe("/");
  fireEvent.click(screen.getByRole("button", {name: "Play Anime"})); await waitFor(() => expect(screen.getByRole("status").textContent).toContain("/one?"));
});
it("cancel closes choices and releases the hover card", async () => {
  vi.mocked(watchApi.continue).mockResolvedValue([continued()]); const view = setup(); await open(); fireEvent.click(screen.getByRole("button", {name: "Cancel"}));
  expect(screen.queryByRole("group")).toBeNull(); expect(view.onChoosingChange).toHaveBeenLastCalledWith(false); expect(screen.getByRole("status").textContent).toBe("/");
  expect(document.activeElement).toBe(screen.getByRole("button", {name: "Play Anime"}));
});
it("bounds double clicks and ignores completion after unmount", async () => {
  let resolve!: (value: NativeCatalogEntry[]) => void;
  vi.mocked(nativeLibraries.catalog).mockReturnValue(new Promise(done => {resolve = done;}));
  const view = setup(); const button = screen.getByRole("button", {name: "Play Anime"}); fireEvent.click(button); fireEvent.click(button);
  expect(nativeLibraries.catalog).toHaveBeenCalledTimes(1); view.unmount(); resolve([series, one]);
  await Promise.resolve(); expect(view.onChoosingChange).toHaveBeenLastCalledWith(false);
});
it("does not offer playback for unavailable or missing series", () => {
  const view = setup({...title, entry: {...series, available: false}});
  expect(screen.queryByRole("button")).toBeNull(); view.unmount();
  setup({...title, entry: {...series, metadata: {missing: true}}});
  expect(screen.queryByRole("button")).toBeNull(); expect(nativeLibraries.catalog).not.toHaveBeenCalled();
});
it("reports an empty playable catalog without navigating", async () => {
  vi.mocked(nativeLibraries.catalog).mockResolvedValue([series, {...one, files: []}]); setup();
  fireEvent.click(screen.getByRole("button", {name: "Play Anime"}));
  expect((await screen.findByRole("alert")).textContent).toBe("No playable episodes are available.");
  expect(screen.getByRole("status").textContent).toBe("/");
});
it("ignores a pending result after the hovered title changes", async () => {
  let resolve!: (value: NativeCatalogEntry[]) => void;
  vi.mocked(nativeLibraries.catalog).mockReturnValue(new Promise(done => {resolve = done;}));
  const client = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: 0}}});
  const contents = (item: HomeTitle) => <QueryClientProvider client={client}><MemoryRouter><SeriesPreviewPlay title={item}/><Destination/></MemoryRouter></QueryClientProvider>;
  const view = render(contents(title)); fireEvent.click(screen.getByRole("button", {name: "Play Anime"}));
  view.rerender(contents({...title, entry: {...series, id: "other", path: "/other", title: "Other"}}));
  resolve([series, one]); await waitFor(() => expect(screen.getByRole("button", {name: "Play Other"}).hasAttribute("disabled")).toBe(false));
  expect(screen.getByRole("status").textContent).toBe("/");
});
