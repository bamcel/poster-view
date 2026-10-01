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
  fireEvent.click(screen.getByRole("switch", {name: "Download logo"}));
  fireEvent.click(screen.getByLabelText("Series Image Fetchers: TheMovieDb"));
  const options = JSON.parse(screen.getByTestId("options").textContent!);
  expect(options.image_types).not.toContain("logo");
  expect(options.image_providers.series).toEqual(["anilist", "tmdb"]);
  expect(options.metadata_providers).toEqual({});
  view.unmount(); render(<Harness section={5} />);
  expect((screen.getByLabelText("Minimum resume percentage") as HTMLInputElement).disabled).toBe(true);
});
