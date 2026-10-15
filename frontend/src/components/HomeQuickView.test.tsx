import {cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {MemoryRouter, Route, Routes, useLocation} from "react-router-dom";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import HomeQuickView from "./HomeQuickView";
import type {HomeTitle} from "./HomeDiscovery";
import {nativeLibraries, type NativeLibrary} from "../api/nativeLibraries";
import {watchApi, type WatchState} from "../features/playback/api/watch";

vi.mock("../features/playback/api/watch", () => ({watchApi: {state: vi.fn(), continue: vi.fn(), states: vi.fn()}}));
vi.mock("../api/nativeLibraries", () => ({nativeLibraries: {catalog: vi.fn(), artworkUrl: vi.fn(() => "/artwork")}}));

const state: WatchState = {position_seconds: 0, duration_seconds: 7200, watched: false, play_count: 0, last_played_at: null, audio_index: null, subtitle_index: null, session_id: null, version: 1};
function title(): HomeTitle {
  return {library: {id: "movie library", name: "Movies"} as NativeLibrary, entry: {id: "title/one", path: "/movies/one", title: "A title", kind: "movie", parent_path: null, available: true, revision: 1, metadata: {year: 2025, plot: "A complete synopsis.\nWith another paragraph.", rating: "8.2", runtime: 120, mpaa: "PG-13", genres: ["Drama", "Mystery"]}, files: [{path: "/movie.mkv", size: 1, extension: "mkv"}], artwork: [], nfo_path: null}};
}
function Destination() {const location = useLocation(); return <p>Destination {location.pathname}{location.search}</p>;}
function setup(item = title(), onClose = vi.fn()) {
  const client = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: 0}}});
  const view = render(<QueryClientProvider client={client}><MemoryRouter><Routes><Route path="/" element={<HomeQuickView title={item} onClose={onClose}/>}/><Route path="/play/native/:library/:item" element={<Destination/>}/></Routes></MemoryRouter></QueryClientProvider>);
  return {...view, client, onClose};
}
beforeEach(() => {
  vi.clearAllMocks();
  HTMLDialogElement.prototype.showModal = vi.fn(function(this: HTMLDialogElement) {this.setAttribute("open", "");});
  HTMLDialogElement.prototype.close = vi.fn(function(this: HTMLDialogElement) {this.removeAttribute("open");});
  vi.mocked(watchApi.state).mockResolvedValue(state);
  vi.mocked(watchApi.continue).mockResolvedValue([]);
  vi.mocked(watchApi.states).mockResolvedValue({});
  vi.mocked(nativeLibraries.catalog).mockResolvedValue([]);
});
afterEach(() => {cleanup(); vi.restoreAllMocks();});

it("opens a named modal with full real metadata and an encoded details link", async () => {
  setup();
  expect(screen.getByRole("dialog", {name: "A title"}).getAttribute("aria-modal")).toBe("true");
  for (const text of ["Movies", "2025", "★ 8.2", "120 min", "PG-13", "Drama · Mystery"]) expect(screen.getByText(text)).toBeTruthy();
  expect(screen.getByText(/A complete synopsis/).textContent).toBe("A complete synopsis.\nWith another paragraph.");
  expect(screen.getByRole("link", {name: "Full Details"}).getAttribute("href")).toBe("/media/movie%20library?native_library=movie%20library&native_item=title%2Fone");
  expect(await screen.findByRole("link", {name: "Play"})).toBeTruthy();
  expect(screen.queryByText(/My List/)).toBeNull();
});

it("focuses close and restores the opening control when unmounted", () => {
  const trigger = document.createElement("button");
  document.body.append(trigger); trigger.focus();
  const originalOverflow = document.body.style.overflow;
  const view = setup();
  expect(document.activeElement).toBe(screen.getByRole("button", {name: "Close quick view"}));
  expect(document.body.style.overflow).toBe("hidden");
  view.unmount();
  expect(document.activeElement).toBe(trigger);
  expect(document.body.style.overflow).toBe(originalOverflow);
  trigger.remove();
});

it("dismisses by close button, Escape cancel, and backdrop but not dialog content", () => {
  const {onClose} = setup();
  const dialog = screen.getByRole("dialog");
  vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue({left: 100, right: 500, top: 100, bottom: 500} as DOMRect);
  fireEvent.click(screen.getByRole("heading", {name: "A title"}));
  fireEvent.click(dialog, {clientX: 200, clientY: 200});
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(dialog, {clientX: 10, clientY: 10});
  fireEvent(dialog, new Event("cancel", {cancelable: true}));
  fireEvent.click(screen.getByRole("button", {name: "Close quick view"}));
  expect(onClose).toHaveBeenCalledTimes(3);
});

it("waits for progress then offers Resume without starting playback on open", async () => {
  let resolve!: (value: WatchState) => void;
  vi.mocked(watchApi.state).mockReturnValue(new Promise(done => {resolve = done;}));
  setup();
  expect(screen.getByText("Loading playback…")).toBeTruthy();
  expect(screen.queryByRole("link", {name: "Play"})).toBeNull();
  resolve({...state, position_seconds: 345});
  const action = await screen.findByRole("link", {name: "Resume"});
  expect(action.getAttribute("href")).toBe("/play/native/movie%20library/title%2Fone?return=%2F");
  expect(watchApi.state).toHaveBeenCalledWith("movie library", "title/one");
  expect(screen.queryByText(/Destination/)).toBeNull();
});

it("keeps a Play fallback and reports a watch-progress failure", async () => {
  vi.mocked(watchApi.state).mockRejectedValue(new Error("Network unavailable"));
  setup();
  expect(await screen.findByRole("link", {name: "Play"})).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("Watch progress is unavailable");
});

it.each(["unavailable", "missing", "no files"])("does not offer playback or fetch progress for a %s movie", mode => {
  const item = title();
  if (mode === "unavailable") item.entry.available = false;
  if (mode === "missing") item.entry.metadata.missing = true;
  if (mode === "no files") item.entry.files = [];
  setup(item);
  expect(screen.queryByRole("link", {name: "Play"})).toBeNull();
  expect(watchApi.state).not.toHaveBeenCalled();
  expect(screen.getByRole("link", {name: "Full Details"})).toBeTruthy();
});

it("selects resumable episodes across grouped series paths and returns to Home", async () => {
  const item = title(); item.entry.kind = "series"; item.entry.files = []; item.entry.metadata.identifiers = {tvdb: "12"};
  const alias = {...item.entry, id: "alias", path: "/other/show"};
  const episode = {...item.entry, id: "episode-2", kind: "episode", path: "/other/show/Season 1/E02.mkv", parent_path: "/other/show/Season 1", metadata: {season: 1, episode: 2}, files: [{path: "/episode.mkv", extension: "mkv", size: 1}]};
  vi.mocked(nativeLibraries.catalog).mockResolvedValue([item.entry, alias, episode]);
  vi.mocked(watchApi.continue).mockResolvedValue([{library_id: item.library.id, library_name: "Movies", item_id: episode.id, title: episode.title, kind: "episode", entry: episode, state: {...state, position_seconds: 50}}]);
  setup(item);
  const action = await screen.findByRole("button", {name: "Resume"});
  expect(screen.queryByText(/Destination/)).toBeNull();
  fireEvent.click(action);
  expect(await screen.findByText("Destination /play/native/movie%20library/episode-2?return=%2F")).toBeTruthy();
});

it("shows series loading and failure without a broken action", async () => {
  const item = title(); item.entry.kind = "series";
  let reject!: (error: Error) => void;
  vi.mocked(nativeLibraries.catalog).mockReturnValue(new Promise((_, fail) => {reject = fail;}));
  setup(item);
  expect(screen.getByText("Loading episodes…")).toBeTruthy();
  reject(new Error("Network unavailable"));
  expect(await screen.findByText(/Episodes could not be loaded/)).toBeTruthy();
  expect(screen.queryByRole("button", {name: "Play"})).toBeNull();
});

it("does not offer series playback when only missing episodes are present", async () => {
  const item = title(); item.entry.kind = "series";
  vi.mocked(nativeLibraries.catalog).mockResolvedValue([{...item.entry, kind: "episode", path: `${item.entry.path}/S01E01.mkv`, metadata: {missing: true}}]);
  setup(item);
  await waitFor(() => expect(screen.getByText("No playable episodes are available.")).toBeTruthy());
  expect(watchApi.continue).not.toHaveBeenCalled();
});
