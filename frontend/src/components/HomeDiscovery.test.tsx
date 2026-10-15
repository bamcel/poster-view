import {cleanup, fireEvent, render, screen, within} from "@testing-library/react";
import {MemoryRouter} from "react-router-dom";
import {afterEach, expect, it, vi} from "vitest";
import HomeDiscovery, {FeaturedTitle, type HomeTitle} from "./HomeDiscovery";
import type {NativeLibrary} from "../api/nativeLibraries";

afterEach(() => {cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();});

function title(id: string, metadata: Record<string, unknown> = {}): HomeTitle {
  return {
    library: {id: "movie library", name: "Movies"} as NativeLibrary,
    entry: {id, title: id, path: `/movies/${id}`, kind: "movie", parent_path: null, available: true, revision: 1, metadata, artwork: [], files: [{path: "movie.mkv", extension: "mkv", size: 1}], nfo_path: null},
  };
}

it("features a title with landscape art and uses existing encoded playback and detail routes", () => {
  const featured = title("movie/one", {plot: "An actual synopsis", year: 2025, genres: ["Drama"]});
  featured.entry.artwork = [{kind: "backdrop", path: "backdrop.jpg", source: "local"}];
  render(<MemoryRouter><FeaturedTitle titles={[title("Without artwork"), featured]}/></MemoryRouter>);
  const region = screen.getByRole("region", {name: "Featured title"});
  expect(within(region).getByRole("heading", {name: "movie/one"})).toBeTruthy();
  expect(within(region).getByText("An actual synopsis")).toBeTruthy();
  expect(within(region).getByRole("link", {name: "Play movie/one"}).getAttribute("href")).toBe("/play/native/movie%20library/movie%2Fone?return=%2F");
  expect(within(region).getByRole("link", {name: "More info about movie/one"}).getAttribute("href")).toBe("/media/movie%20library?native_library=movie%20library&native_item=movie%2Fone");
});

it("offers details without a broken play action for series or movies with no files", () => {
  const series = title("Series");
  series.entry.kind = "series";
  const noFiles = title("No files");
  noFiles.entry.files = [];
  render(<MemoryRouter><FeaturedTitle titles={[series]}/><HomeDiscovery titles={[series, noFiles]}/></MemoryRouter>);
  expect(screen.queryByRole("link", {name: /^Play /})).toBeNull();
  expect(screen.getAllByRole("link", {name: "More info about Series"})).toHaveLength(2);
  expect(screen.getByRole("link", {name: "More info about No files"})).toBeTruthy();
});

it("orders ratings and release years using real valid metadata and picks the largest genre rows", () => {
  const titles = [
    title("Older", {year: 2000, rating: "8.1", genres: ["Drama", "Action"]}),
    title("Newest", {year: "2026", rating: 9.2, genres: ["Drama", "Comedy"]}),
    title("Poor", {year: 2023, rating: 2, genres: ["Drama", "Comedy"]}),
    title("Invalid", {year: "unknown", rating: 99, genres: ["Action"]}),
    title("Unknown", {year: null, rating: true}),
  ];
  render(<MemoryRouter><HomeDiscovery titles={titles}/></MemoryRouter>);
  const names = (row: string) => within(screen.getByRole("region", {name: row})).getAllByRole("link", {name: /^Open /}).map(link => link.textContent);
  expect(names("Highly Rated")).toEqual(["Newest", "Older"]);
  expect(names("Recent Releases")).toEqual(["Newest", "Poor", "Older"]);
  expect(names("Drama")).toEqual(["Older", "Newest", "Poor"]);
  expect(names("Action")).toEqual(["Older", "Invalid"]);
  expect(screen.queryByRole("region", {name: "Comedy"})).toBeNull();
});

it("falls back to browsing titles when metadata is absent and keeps quick actions visible", () => {
  render(<MemoryRouter><HomeDiscovery titles={[title("Unidentified")]}/></MemoryRouter>);
  const region = screen.getByRole("region", {name: "Explore Your Libraries"});
  expect(within(region).getByRole("link", {name: "Play Unidentified"})).toBeTruthy();
  expect(within(region).getByRole("link", {name: "More info about Unidentified"})).toBeTruthy();
  expect(screen.queryByRole("region", {name: "Highly Rated"})).toBeNull();
});

it("removes broken artwork while preserving the title and its actions", () => {
  const item = title("Missing art");
  item.entry.artwork = [{kind: "poster", path: "missing.jpg", source: "local"}];
  const view = render(<MemoryRouter><HomeDiscovery titles={[item]}/></MemoryRouter>);
  const image = view.container.querySelector("img")!;
  expect(image.getAttribute("src")).toContain("/artwork/poster?v=");
  fireEvent.error(image);
  expect(view.container.querySelector("img")).toBeNull();
  expect(screen.getByRole("link", {name: "Open Missing art in Movies"})).toBeTruthy();
});

it("renders no discovery or featured sections without available titles", () => {
  render(<MemoryRouter><FeaturedTitle titles={[]}/><HomeDiscovery titles={[]}/></MemoryRouter>);
  expect(screen.queryByRole("region")).toBeNull();
});

it("opens quick view from banner and row info actions without navigating", () => {
  const item=title("Quick view title");
  const open=vi.fn();
  render(<MemoryRouter><FeaturedTitle titles={[item]} onQuickView={open}/><HomeDiscovery titles={[item]} onQuickView={open}/></MemoryRouter>);
  const actions=screen.getAllByRole("button",{name:"More info about Quick view title"});
  expect(actions).toHaveLength(2);
  actions.forEach(action=>{expect(action.getAttribute("aria-haspopup")).toBe("dialog");fireEvent.click(action);});
  expect(open).toHaveBeenNthCalledWith(1,item);
  expect(open).toHaveBeenNthCalledWith(2,item);
});

it("bounds a discovery row and scrolls by page with reduced motion respected", () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(500);
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(2000);
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({matches: true}));
  const scrollBy = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollBy", {configurable: true, value: scrollBy});
  render(<MemoryRouter><HomeDiscovery titles={Array.from({length: 30}, (_, i) => title(`Title ${i}`))}/></MemoryRouter>);
  expect(screen.getAllByRole("link", {name: /^Open /})).toHaveLength(20);
  expect(screen.getByRole("button", {name: "Scroll Explore Your Libraries left"}).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", {name: "Scroll Explore Your Libraries right"}));
  expect(scrollBy).toHaveBeenCalledWith({left: 400, behavior: "instant"});
  delete (HTMLElement.prototype as {scrollBy?: unknown}).scrollBy;
});
