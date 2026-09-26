import { beforeEach, expect, it } from "vitest";
import { applyMediaLibraryAppearance, mediaLibraryAppearance, pillBackgroundOpacity, setPillBackgroundOpacity } from "./mediaLibrarySettings";

beforeEach(() => { localStorage.clear(); document.documentElement.style.removeProperty("--pill-background-opacity"); });

it("persists and clamps pill opacity while applying it immediately", () => {
  expect(pillBackgroundOpacity()).toBe(5);
  setPillBackgroundOpacity(150);
  expect(pillBackgroundOpacity()).toBe(100);
  expect(document.documentElement.style.getPropertyValue("--pill-background-opacity")).toBe("100%");
  setPillBackgroundOpacity(-10);
  expect(pillBackgroundOpacity()).toBe(0);
  expect(mediaLibraryAppearance().pill_background_opacity).toBe(0);
});

it("restores the saved pill opacity on appearance bootstrap", () => {
  applyMediaLibraryAppearance({ ...mediaLibraryAppearance(), pill_background_opacity: 35 });
  expect(pillBackgroundOpacity()).toBe(35);
  expect(document.documentElement.style.getPropertyValue("--pill-background-opacity")).toBe("35%");
});
