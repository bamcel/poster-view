import { beforeEach, describe, expect, it } from "vitest";
import {
  applyTheme,
  getAllThemes,
  getStoredThemeName,
  getTheme,
  loadCustomThemes,
  parseThemeJson,
  removeCustomTheme,
  saveCustomTheme,
  serializeTheme,
} from "./theme";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("style");
});

describe("custom themes", () => {
  it("round-trips a complete theme through the editable JSON format", () => {
    const gotham = getTheme("Gotham");
    expect(parseThemeJson(serializeTheme(gotham))).toEqual(gotham);
  });

  it("saves, lists, and applies a custom theme", () => {
    const custom = { ...getTheme("Gotham"), name: "Movie Night", accent: "#FF3366" };

    saveCustomTheme(custom);

    expect(loadCustomThemes()).toEqual([custom]);
    expect(getAllThemes().at(-1)?.name).toBe("Movie Night");
    expect(getStoredThemeName()).toBe("Movie Night");
    expect(document.documentElement.style.getPropertyValue("--color-accent")).toBe("#FF3366");
  });

  it("protects built-in themes from being overwritten", () => {
    expect(() => saveCustomTheme(getTheme("Gotham"))).toThrow(/built-in theme/i);
    expect(loadCustomThemes()).toEqual([]);
  });

  it("falls back to Gotham when the selected custom theme is removed", () => {
    const custom = { ...getTheme("Gotham"), name: "Temporary" };
    saveCustomTheme(custom);
    applyTheme(custom.name);

    removeCustomTheme(custom.name);

    expect(loadCustomThemes()).toEqual([]);
    expect(getStoredThemeName()).toBe("Gotham");
    expect(document.documentElement.dataset.theme).toBe("Gotham");
  });
});
