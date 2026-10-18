import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { readYoutubeHomepagePreferences, useYoutubeHomepagePreferences, useYoutubeHomepagePreferencesRevision } from "./youtubeHomepagePreferences";

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

function Controls({ library }: { library: string }) {
  const prefs = useYoutubeHomepagePreferences(library);
  const revision = useYoutubeHomepagePreferencesRevision();
  return <><button onClick={() => prefs.setFeatured(!prefs.featured)}>Featured {String(prefs.featured)}</button><button onClick={() => prefs.setBackground(!prefs.background)}>Background {String(prefs.background)}</button><output>{revision}</output></>;
}

it("defaults to isolated artwork and rejects malformed or nonboolean saved preferences", () => {
  expect(readYoutubeHomepagePreferences("youtube")).toEqual({ featured: false, background: false });
  for (const saved of ["broken", "null", '"true"', '{"featured":"true","background":1}']) {
    localStorage.setItem("posterview.youtubeHomepage.youtube", saved);
    expect(readYoutubeHomepagePreferences("youtube")).toEqual({ featured: false, background: false });
  }
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("unavailable"); });
  expect(readYoutubeHomepagePreferences("youtube")).toEqual({ featured: false, background: false });
});

it("updates independently, persists and notifies other mounted consumers", () => {
  const { rerender } = render(<><Controls library="first" /><Controls library="first" /></>);
  fireEvent.click(screen.getAllByRole("button", { name: "Featured false" })[0]);
  expect(screen.getAllByRole("button", { name: "Featured true" })).toHaveLength(2);
  expect(readYoutubeHomepagePreferences("first")).toEqual({ featured: true, background: false });
  expect(screen.getAllByRole("status")[0].textContent).toContain('"featured":true');
  fireEvent.click(screen.getAllByRole("button", { name: "Background false" })[0]);
  rerender(<Controls library="second" />);
  expect(screen.getByRole("button", { name: "Featured false" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Background false" })).toBeTruthy();
  rerender(<Controls library="first" />);
  expect(screen.getByRole("button", { name: "Featured true" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Background true" })).toBeTruthy();
});

it("refreshes flags and the shared revision on storage updates and clearing", () => {
  render(<Controls library="youtube" />);
  act(() => {
    localStorage.setItem("posterview.youtubeHomepage.youtube", '{"featured":true,"background":true}');
    window.dispatchEvent(new StorageEvent("storage", { key: "posterview.youtubeHomepage.youtube" }));
  });
  expect(screen.getByRole("button", { name: "Featured true" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain('"background":true');
  act(() => { localStorage.clear(); window.dispatchEvent(new StorageEvent("storage", { key: null })); });
  expect(screen.getByRole("button", { name: "Background false" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("");
});
