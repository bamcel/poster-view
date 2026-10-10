import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import NativeLibrarySettings from "./NativeLibrarySettings";
import { defaultNativeOptions } from "../api/nativeLibraries";
afterEach(cleanup);
function Harness({section}: {section: number}) {
  const [options, setOptions] = useState({...defaultNativeOptions});
  return <><NativeLibrarySettings options={options} type="anime" animeContent="both" section={section} onChange={setOptions} /><output data-testid="options">{JSON.stringify(options)}</output></>;
}
it("updates language and sample settings while unsupported switches remain disabled", () => {
  render(<Harness section={2} />);
  fireEvent.change(screen.getByLabelText("Preferred metadata download language"), {target: {value: "ja"}});
  fireEvent.change(screen.getByLabelText("Certification country"), {target: {value: "JP"}});
  fireEvent.change(screen.getByLabelText("Ignore sample files below (MB)"), {target: {value: "0"}});
  fireEvent.click(screen.getByRole("switch", {name: "Enable real-time monitoring"}));
  const options = JSON.parse(screen.getByTestId("options").textContent!);
  expect(options.real_time_monitor).toBe(true);
  expect(options.metadata_language).toBe("ja"); expect(options.certification_country).toBe("JP"); expect(options.sample_ignore_mb).toBe(0);
  expect((screen.getByRole("switch", {name: "Exclude from global search"}) as HTMLInputElement).disabled).toBe(true);
});
it("keeps provider priorities scoped by media type and supports disabling every source", () => {
  render(<Harness section={3} />);
  fireEvent.click(screen.getByLabelText("Series Metadata Downloaders: TheMovieDb"));
  fireEvent.click(screen.getByRole("button", {name: "Move TheMovieDb up in Series Metadata Downloaders"}));
  expect(JSON.parse(screen.getByTestId("options").textContent!).metadata_providers.series).toEqual(["tmdb", "anilist"]);
  expect(JSON.parse(screen.getByTestId("options").textContent!).metadata_providers.movie).toBeUndefined();
  fireEvent.click(screen.getByLabelText("Series Metadata Downloaders: TheMovieDb"));
  fireEvent.click(screen.getByLabelText("Series Metadata Downloaders: AniList"));
  expect(JSON.parse(screen.getByTestId("options").textContent!).metadata_providers.series).toEqual([]);
  expect((screen.getByLabelText("Series Metadata Downloaders: TheTVDB") as HTMLInputElement).disabled).toBe(false);
});
it("stores image choices separately from metadata and shows playback as unavailable", () => {
  const view = render(<Harness section={4} />);
  fireEvent.click(screen.getByRole("switch", {name: "Save artwork into media folders"}));
  fireEvent.click(screen.getByRole("switch", {name: "Download logo"}));
  fireEvent.click(screen.getByLabelText("Series Image Fetchers: TheMovieDb"));
  const options = JSON.parse(screen.getByTestId("options").textContent!);
  expect(options.save_artwork).toBe(true);
  expect(options.image_types).not.toContain("logo");
  expect(options.image_providers.series).toEqual(["anilist", "tmdb"]);
  expect(options.metadata_providers).toEqual({});
  view.unmount(); render(<Harness section={5} />);
  expect((screen.getByLabelText("Minimum resume percentage") as HTMLInputElement).disabled).toBe(true);
});

it("lets a book library exclude manga metadata providers", () => {
 function Books() {const [options,setOptions]=useState({...defaultNativeOptions});return <><NativeLibrarySettings options={options} type="books" animeContent="both" section={3} onChange={setOptions}/><output data-testid="books">{JSON.stringify(options)}</output></>;}
 render(<Books/>);
 fireEvent.click(screen.getByLabelText("Book metadata providers: AniList"));
 fireEvent.click(screen.getByLabelText("Book metadata providers: MyAnimeList"));
 expect(JSON.parse(screen.getByTestId("books").textContent!).metadata_providers.book_series).toEqual(["comicvine"]);
 fireEvent.click(screen.getByLabelText("Book metadata providers: ComicVine"));
 expect(JSON.parse(screen.getByTestId("books").textContent!).metadata_providers.book_series).toEqual([]);
});

it("offers ComicVine as a book image fetcher without changing metadata providers",()=>{
 function Books(){const [options,setOptions]=useState({...defaultNativeOptions});return <><NativeLibrarySettings options={options} type="books" animeContent="both" section={4} onChange={setOptions}/><output data-testid="books">{JSON.stringify(options)}</output></>;}
 render(<Books/>);
 fireEvent.click(screen.getByLabelText("Book series Image Fetchers: ComicVine"));
 const options=JSON.parse(screen.getByTestId("books").textContent!);
 expect(options.image_providers.book_series).toEqual(["anilist","comicvine"]);
 expect(options.metadata_providers).toEqual({});
});

it("omits video setup fields for book libraries and retains relevant settings",()=>{
 const options={...defaultNativeOptions};
 const view=render(<NativeLibrarySettings options={options} type="books" animeContent="both" section={2} onChange={()=>{}}/>);
 expect(screen.queryByLabelText("Certification country")).toBeNull();
 expect(screen.queryByLabelText("Prefer embedded titles over filenames")).toBeNull();
 expect(screen.queryByLabelText("Ignore sample files below (MB)")).toBeNull();
 expect(screen.getByLabelText("Enable real-time monitoring")).toBeTruthy();
 view.rerender(<NativeLibrarySettings options={options} type="books" animeContent="both" section={3} onChange={()=>{}}/>);
 expect(screen.getByLabelText("NFO saver")).toBeTruthy();
 expect(screen.queryByLabelText("Allow adult metadata")).toBeNull();
 expect(screen.queryByLabelText("Refresh episode placeholder titles such as TBA")).toBeNull();
 view.rerender(<NativeLibrarySettings options={options} type="books" animeContent="both" section={4} onChange={()=>{}}/>);
 expect(screen.getByLabelText("Download cover")).toBeTruthy();
 expect(screen.queryByLabelText("Download thumb")).toBeNull();
 view.rerender(<NativeLibrarySettings options={options} type="books" animeContent="both" section={5} onChange={()=>{}}/>);
 expect(screen.queryByText("Playback")).toBeNull();
 expect(screen.queryByLabelText("Generate chapters for videos without embedded chapters")).toBeNull();
});

it("enables MangaDex metadata for a book library independently of images",()=>{
 function Books(){const [options,setOptions]=useState({...defaultNativeOptions});return <><NativeLibrarySettings options={options} type="books" animeContent="both" section={3} onChange={setOptions}/><output data-testid="books">{JSON.stringify(options)}</output></>;}
 render(<Books/>);fireEvent.click(screen.getByLabelText("Book metadata providers: MangaDex"));
 expect(JSON.parse(screen.getByTestId("books").textContent!).metadata_providers.book_series).toContain("mangadex");
 expect(JSON.parse(screen.getByTestId("books").textContent!).image_providers).toEqual({});
});

it("places missing specials under episode discovery and defaults it off",()=>{
 render(<Harness section={2}/>);
 const specials=screen.getByRole("switch",{name:"Show Missing Specials"}) as HTMLInputElement;
 expect(specials.checked).toBe(false);
 fireEvent.click(specials);
 expect(JSON.parse(screen.getByTestId("options").textContent!).show_missing_specials).toBe(true);
 fireEvent.click(screen.getByRole("switch",{name:"Find Missing Episodes"}));
 expect(screen.queryByRole("switch",{name:"Show Missing Specials"})).toBeNull();
});
