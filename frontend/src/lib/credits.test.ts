import { afterEach, expect, it } from "vitest";
import type { Credit, CreditSource } from "../api/credits";
import { castGroups, displayCredits, readCastPreference } from "./credits";

const credit = (language: string | null, overrides: Partial<Credit> = {}): Credit => ({ person_id: "1", name: "Actor", image: null, person_url: null, character_id: "10", character: "Hero", character_image: null, category: "cast", role: "Voice", language, dub_group: null, notes: null, order: 0, ...overrides });
const source = (credits: Credit[], provider = "anilist"): CreditSource => ({ provider, external_id: "1", title: "Series", source_url: "https://anilist.co/anime/1", original_language: null, fetched_at: null, credits });
afterEach(() => localStorage.clear());
it("separates original and English performances without deleting other languages", () => {
  const rows = displayCredits([source([credit("ja"), credit("en"), credit("fr"), credit(null), credit(null, { category: "crew", role: "Director" })])]);
  const groups = castGroups(rows, "ja", { mode: "both", language: "en" });
  expect(groups.map(g => g.label)).toEqual(["Original cast · Japanese", "English cast", "Cast · language unspecified"]);
  expect(groups.map(g => g.credits.length)).toEqual([1, 1, 1]);
  expect(castGroups(rows, "ja", { mode: "dub", language: "fr" })[0].credits).toHaveLength(1);
  expect(rows).toHaveLength(5);
});
it("coalesces identical labels but retains alternate dubs and roles", () => {
  const rows = displayCredits([source([credit("en"), credit("en", { dub_group: "1990 dub" }), credit(null, { category: "crew", role: "Director" })]), source([credit("en"), credit(null, { category: "crew", role: "Writer" })], "mal")]);
  expect(rows).toHaveLength(4); expect(rows[0].sources).toHaveLength(2);
});
it("does not assign an unknown language to the original or selected dub", () => {
  const rows = displayCredits([source([credit(null)])]);
  expect(castGroups(rows, null, { mode: "both", language: "en" }).map(g => g.credits.length)).toEqual([0, 0, 1]);
  expect(castGroups(rows, "ja", { mode: "dub", language: "en" })[0].credits).toHaveLength(0);
});
it("uses English plus original by default and isolates browser preference keys", () => {
  localStorage.setItem("alice", JSON.stringify({ mode: "dub", language: "de" }));
  expect(readCastPreference("alice")).toEqual({ mode: "dub", language: "de" });
  expect(readCastPreference("bob")).toEqual({ mode: "both", language: "en" });
  localStorage.setItem("bob", "bad-json");
  expect(readCastPreference("bob").mode).toBe("both");
});
