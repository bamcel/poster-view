import {act, cleanup, fireEvent, render, screen} from "@testing-library/react";
import {MemoryRouter} from "react-router-dom";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import DiscoveryHoverCard from "./DiscoveryHoverCard";
import type {HomeTitle} from "./HomeDiscovery";
import type {NativeLibrary} from "../api/nativeLibraries";
import {nativeLibraries} from "../api/nativeLibraries";
import {watchApi} from "../features/playback/api/watch";
const title = (name = "Sample"): HomeTitle => ({library: {id: "movie library", name: "Movies"} as NativeLibrary, entry: {id: name, title: name, path: "/movie", kind: "movie", parent_path: null, available: true, revision: 1, metadata: {year: 2025, mpaa: "PG", runtime: 92, rating: 8.2, genres: ["Drama"], plot: "A real synopsis"}, artwork: [], files: [{path: "movie.mkv", extension: "mkv", size: 1}], nfo_path: null}});
function mount(item = title()) {return render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MemoryRouter><DiscoveryHoverCard title={item}><a href="/details">Details {item.entry.title}</a></DiscoveryHoverCard></MemoryRouter></QueryClientProvider>);}
const anchor = () => screen.getByRole("link", {name: "Details Sample"}).parentElement!;
beforeEach(() => {vi.spyOn(watchApi,"state").mockResolvedValue({position_seconds:0,duration_seconds:1000,watched:false,play_count:0,last_played_at:null,audio_index:null,subtitle_index:null,session_id:null,version:1});vi.useFakeTimers(); vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({left: 900, top: 100, width: 260, height: 146, right: 1160, bottom: 246, x: 900, y: 100, toJSON() {}});});
afterEach(() => {cleanup(); vi.useRealTimers(); vi.restoreAllMocks();});
it("delays hover and renders a viewport-clamped portal without shifting its anchor", () => {
  const view = mount(); expect(screen.queryByRole("button", {name: "Preview Sample"})).toBeNull(); fireEvent.mouseEnter(anchor());
  act(() => vi.advanceTimersByTime(349)); expect(screen.queryByRole("region")).toBeNull();
  act(() => vi.advanceTimersByTime(1)); const panel = screen.getByRole("region", {name: "Preview of Sample"});
  expect(view.container.contains(panel)).toBe(false); expect(panel.style.width).toBe("390px");
  expect(Number.parseFloat(panel.style.left) + 390).toBeLessThanOrEqual(window.innerWidth - 12);
  expect(screen.getByText("2025 · PG · 92 min · 8.2/10")).toBeTruthy();
  expect(screen.getByRole("button", {name: "Play Sample"}).textContent).toBe("Play");
});
it("allows crossing from the anchor to the portal and dismisses after leaving both", () => {
  mount(); fireEvent.mouseEnter(anchor()); act(() => vi.advanceTimersByTime(350));
  fireEvent.mouseLeave(anchor()); act(() => vi.advanceTimersByTime(100)); fireEvent.mouseEnter(screen.getByRole("region"));
  act(() => vi.advanceTimersByTime(500)); expect(screen.getByRole("region")).toBeTruthy();
  fireEvent.mouseLeave(screen.getByRole("region")); act(() => vi.advanceTimersByTime(180)); expect(screen.queryByRole("region")).toBeNull();
});
it("opens on keyboard focus and Escape restores the opener without reopening", () => {
  mount(); const trigger = screen.getByRole("link", {name: "Details Sample"}); act(() => trigger.focus());
  expect(screen.getByRole("region")).toBeTruthy(); fireEvent.keyDown(window, {key: "Escape"});
  expect(screen.queryByRole("region")).toBeNull(); expect(document.activeElement).toBe(trigger);
});
it("keeps only one focused preview and dismisses on scroll or resize", () => {
  mount(); mount(title("Other")); fireEvent.focus(screen.getByRole("link", {name: "Details Sample"}));
  fireEvent.focus(screen.getByRole("link", {name: "Details Other"})); expect(screen.getAllByRole("region")).toHaveLength(1);
  expect(screen.getByRole("region", {name: "Preview of Other"})).toBeTruthy(); fireEvent.scroll(document); expect(screen.queryByRole("region")).toBeNull();
  fireEvent.focus(screen.getByRole("link", {name: "Details Other"})); fireEvent.resize(window); expect(screen.queryByRole("region")).toBeNull();
});
it("does not create invalid play links or fabricate missing metadata", () => {
  const item = title(); item.entry.kind = "series"; item.entry.metadata = {year: true, runtime: "bad", rating: 99, genres: [false, "Action"]};
  mount(item); fireEvent.focus(screen.getByRole("link", {name: "Details Sample"})); expect(screen.queryByRole("button", {name: "Play Sample"})).toBeNull(); expect(screen.getByText("Series")).toBeTruthy(); expect(screen.getByText("Action")).toBeTruthy();
});
it("cancels pending hover on leave and unmount", () => {
  const view = mount(); fireEvent.mouseEnter(anchor()); fireEvent.mouseLeave(anchor()); act(() => vi.advanceTimersByTime(400)); expect(screen.queryByRole("region")).toBeNull();
  fireEvent.mouseEnter(anchor()); view.unmount(); act(() => vi.advanceTimersByTime(500)); expect(screen.queryByRole("region")).toBeNull();
});
it("lets keyboard users enter portal actions and return to the trigger on Escape", () => {
  mount(); const trigger = screen.getByRole("link", {name: "Details Sample"}); act(() => trigger.focus());
  fireEvent.keyDown(trigger, {key: "Tab"}); expect(document.activeElement).toBe(screen.getByRole("link", {name: "More info about Sample"}));
  fireEvent.keyDown(window, {key: "Escape"}); expect(screen.queryByRole("region")).toBeNull(); expect(document.activeElement).toBe(trigger);
});
it("fits a narrow viewport and provides details when a movie is unavailable", () => {
  vi.spyOn(window, "innerWidth", "get").mockReturnValue(320);
  const item = title(); item.entry.available = false; mount(item); fireEvent.focus(screen.getByRole("link", {name: "Details Sample"}));
  const panel = screen.getByRole("region"); expect(panel.style.width).toBe("296px"); expect(panel.style.left).toBe("12px");
  expect(screen.queryByRole("button", {name: "Play Sample"})).toBeNull(); expect(screen.getByRole("link", {name: "More info about Sample"})).toBeTruthy();
});
it("keeps its own scrolling panel open but closes on an ancestor scroll", () => {
  mount(); fireEvent.focus(screen.getByRole("link", {name: "Details Sample"}));
  const panel = screen.getByRole("region"); expect(panel.style.maxHeight).toContain("px"); fireEvent.scroll(panel); expect(screen.getByRole("region")).toBe(panel);
  fireEvent.scroll(window); expect(screen.queryByRole("region")).toBeNull();
});
it("does not offer playback for a missing file marker", () => {
  const item = title(); item.entry.metadata.missing = true; mount(item); fireEvent.focus(screen.getByRole("link", {name: "Details Sample"})); expect(screen.queryByRole("button", {name: "Play Sample"})).toBeNull();
});
it("dismisses a series preview normally while history is still loading",()=>{
 vi.spyOn(nativeLibraries,"summaries").mockReturnValue(new Promise(()=>{}));
 vi.spyOn(watchApi,"states").mockReturnValue(new Promise(()=>{}));
 vi.spyOn(watchApi,"continue").mockReturnValue(new Promise(()=>{}));
 const series=title();series.entry.kind="series";mount(series);
 fireEvent.focus(screen.getByRole("link", {name: "Details Sample"}));
 fireEvent.mouseLeave(screen.getByRole("region"));act(()=>vi.advanceTimersByTime(200));
 expect(screen.queryByRole("region")).toBeNull();
});
