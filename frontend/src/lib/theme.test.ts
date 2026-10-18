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


describe("independent accent roles", () => {
  it("keeps legacy imports and stored themes inheriting the general accent", () => {
    const legacy = JSON.parse(serializeTheme(getTheme("Everforest")));
    legacy.name = "Legacy accents";
    legacy.colors.Accent = "#123456";
    delete legacy.colors["General Accent"];
    delete legacy.colors["Media Detail Links"];
    const theme = parseThemeJson(JSON.stringify(legacy));
    expect(theme.accent).toBe("#123456");
    expect(theme.detailLink).toBe("#123456");
    expect(theme.sidebarAccent).toBeUndefined();
    localStorage.setItem("posterview.customThemes", JSON.stringify([theme]));
    expect(loadCustomThemes()).toEqual([theme]);
    applyTheme({ ...theme, accent: "#ABCDEF" });
    for (const role of ["glass-tint", "sidebar-accent", "poster-outline", "selection-accent", "focus-accent", "link-accent"]) {
      expect(document.documentElement.style.getPropertyValue(`--color-${role}`)).toBe("#ABCDEF");
    }
    expect(JSON.parse(serializeTheme(theme)).colors["Left Panel Accent"]).toBeUndefined();
  });

  it("round-trips independent overrides without changing other accent consumers", () => {
    const theme = { ...getTheme("Everforest"), name: "Independent accents", glassTint: "#BD4455", sidebarAccent: "#123456", posterOutline: "#654321", selectionAccent: "#AABBCC", focusAccent: "#112233", linkAccent: "#445566" };
    expect(parseThemeJson(serializeTheme(theme))).toEqual(theme);
    saveCustomTheme(theme);
    expect(loadCustomThemes()).toEqual([theme]);
    const root = document.documentElement.style;
    expect(root.getPropertyValue("--color-glass-tint")).toBe("#BD4455");
    expect(root.getPropertyValue("--color-sidebar-accent")).toBe("#123456");
    expect(root.getPropertyValue("--color-poster-outline")).toBe("#654321");
    expect(root.getPropertyValue("--color-selection-accent")).toBe("#AABBCC");
    expect(root.getPropertyValue("--color-focus-accent")).toBe("#112233");
    expect(root.getPropertyValue("--color-link-accent")).toBe("#445566");
    expect(root.getPropertyValue("--color-accent")).toBe(theme.accent);
    applyTheme("Everforest");
    expect(root.getPropertyValue("--color-glass-tint")).toBe(getTheme("Everforest").accent);
    expect(root.getPropertyValue("--color-poster-outline")).toBe(getTheme("Everforest").accent);
  });

  it("rejects malformed explicit role overrides", () => {
    const json = JSON.parse(serializeTheme(getTheme("Everforest")));
    json.colors["Poster Hover Outline"] = "red";
    expect(() => parseThemeJson(JSON.stringify(json))).toThrow(/Poster Hover Outline/);
  });
});
