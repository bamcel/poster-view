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
  it("applies and round-trips the shared pill identity", () => {
    const theme = { ...getTheme("Gotham"), pillBackground: "#123456", pillBorder: "#ABCDEF", pillText: "#FEDCBA" };
    applyTheme(theme);
    expect(document.documentElement.style.getPropertyValue("--color-pill-background")).toBe("#123456");
    expect(document.documentElement.style.getPropertyValue("--color-pill-border")).toBe("#ABCDEF");
    expect(document.documentElement.style.getPropertyValue("--color-pill-text")).toBe("#FEDCBA");
    expect(parseThemeJson(serializeTheme(theme))).toEqual(theme);
    const legacy = JSON.parse(serializeTheme(theme));
    delete legacy.colors["Media Detail Pills Background"];
    delete legacy.colors["Media Detail Pills Border"];
    delete legacy.colors["Media Detail Pills Text"];
    expect(parseThemeJson(JSON.stringify(legacy)).pillBackground).toBe("#FFFFFF");
  });
  it("round-trips a complete theme through the editable JSON format", () => {
    const gotham = getTheme("Gotham");
    expect(parseThemeJson(serializeTheme(gotham))).toEqual(gotham);
  });

  it("saves, lists, and applies a custom theme", () => {
    const custom = { ...getTheme("Gotham"), name: "Movie Night", accent: "#FF3366" };

    saveCustomTheme(custom);

    expect(loadCustomThemes()).toEqual([custom]);
    expect(getAllThemes().some((theme) => theme.name === "Movie Night")).toBe(true);
    expect(getStoredThemeName()).toBe("Movie Night");
    expect(document.documentElement.style.getPropertyValue("--color-accent")).toBe("#FF3366");
  });

  it("protects built-in themes from being overwritten", () => {
    expect(() => saveCustomTheme(getTheme("Gotham"))).toThrow(/built-in theme/i);
    expect(loadCustomThemes()).toEqual([]);
  });

  it("falls back to Everforest when the selected custom theme is removed", () => {
    const custom = { ...getTheme("Gotham"), name: "Temporary" };
    saveCustomTheme(custom);
    applyTheme(custom.name);

    removeCustomTheme(custom.name);

    expect(loadCustomThemes()).toEqual([]);
    expect(getStoredThemeName()).toBe("Everforest");
    expect(document.documentElement.dataset.theme).toBe("Everforest");
  });

  it("uses Everforest by default without replacing a saved selection", () => {
    expect(getStoredThemeName()).toBe("Everforest");
    applyTheme("Gotham");
    expect(getStoredThemeName()).toBe("Gotham");
  });
});

it("inherits media detail roles in every built-in theme and migrates old custom themes", () => {
  for (const theme of getAllThemes()) {
    expect(theme.detailTitle).toBe(theme.text);
    expect(theme.detailText).toBe(theme.text);
    expect(theme.detailMetadata).toBe(theme.muted);
    expect(theme.detailLink).toBe(theme.accent);
  }
  const legacy = JSON.parse(serializeTheme(getTheme("Everforest")));
  legacy.name = "Legacy";
  for (const key of Object.keys(legacy.colors)) if (key.startsWith("Media Detail")) delete legacy.colors[key];
  const migrated = parseThemeJson(JSON.stringify(legacy));
  expect(migrated.detailText).toBe(migrated.text);
  const customized = { ...migrated, detailText: "#FFFFFF" };
  saveCustomTheme(customized);
  expect(loadCustomThemes()[0].detailText).toBe("#FFFFFF");
  expect(document.documentElement.style.getPropertyValue("--color-detail-text")).toBe("#FFFFFF");
});
