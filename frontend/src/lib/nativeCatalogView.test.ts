import { expect, it } from "vitest";
import { nativeCatalogView } from "./nativeCatalogView";
import type { NativeCatalogEntry } from "../api/nativeLibraries";
const entry = (
  id: string,
  kind = "series",
  parent_path: string | null = null,
  metadata: Record<string, unknown> = {},
): NativeCatalogEntry => ({
  id,
  path: id,
  title: "Code Geass",
  kind,
  parent_path,
  metadata,
  artwork: [],
  files: [],
  nfo_path: null,
  available: true,
  revision: 1,
});
it("groups confirmed series IDs and combines their season children without losing episodes", () => {
  const items = [
    entry("a", "series", null, { identifiers: { tvdb: "123" } }),
    entry("b", "series", null, { identifiers: { tvdb: 123 } }),
    entry("a/season", "season", "a", { season: 1 }),
    entry("b/season", "season", "b", { season: 1 }),
    entry("ep1", "episode", "a/season"),
    entry("ep2", "episode", "b/season"),
  ];
  const result = nativeCatalogView(items);
  expect(result.entries.filter((e) => e.kind === "series")).toHaveLength(1);
  expect(result.entries.filter((e) => e.kind === "season")).toHaveLength(1);
  expect(
    result.entries
      .filter((e) => e.kind === "episode")
      .map((e) => e.parent_path),
  ).toEqual(["a/season", "a/season"]);
  expect(result.aliases.get("b")).toBe("a");
  expect(items[5].parent_path).toBe("b/season");
});
it("keeps title-only matches and contradictory confirmed identities separate", () => {
  expect(nativeCatalogView([entry("a"), entry("b")]).entries).toHaveLength(2);
  expect(
    nativeCatalogView([
      entry("a", "series", null, { identifiers: { tvdb: "123", tmdb: "1" } }),
      entry("b", "series", null, { identifiers: { tvdb: "123", tmdb: "2" } }),
    ]).entries,
  ).toHaveLength(2);
});
