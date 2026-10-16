import {expect, it} from "vitest";
import type {HomeTitle} from "../components/HomeDiscovery";
import {groupHomeTitles} from "./homeTitleGroups";

function title(id: string, metadata: Record<string, unknown> = {}, kind = "series", name = "Crash Landing on You"): HomeTitle {
  return {
    library: {id, name: id, library_type: "shows", anime_content: "both", paths: [], revision: 1, created_at: "", updated_at: ""},
    entry: {id, path: id, kind, title: name, parent_path: null, metadata, artwork: [], files: [], nfo_path: null, available: true, revision: 1},
  };
}

it("combines cross-library provider matches while retaining every source and input order", () => {
  const korean = title("korean", {identifiers: {TVDB: " 123 "}});
  const other = title("other", {identifiers: {tvdb: 456}});
  const television = title("television", {identifiers: {tvdb: 123}}, "series", "Alternate title");
  const result = groupHomeTitles([korean, other, television]);
  expect(result.map(group => group.library.id)).toEqual(["korean", "other"]);
  expect(result[0].sources).toEqual([korean, television]);
  expect(korean).not.toHaveProperty("sources");
});

it("rejects conflicting known identities including anime providers", () => {
  for (const provider of ["tvdb", "tmdb", "imdb", "anilist", "mal", "anidb"]) {
    const shared = provider === "tvdb" ? "tmdb" : "tvdb";
    expect(groupHomeTitles([
      title("a", {identifiers: {[shared]: 1, [provider]: 10}}),
      title("b", {identifiers: {[shared]: 1, [provider]: 20}}),
    ])).toHaveLength(2);
  }
});

it("does not allow partial identity bridges to join incompatible members", () => {
  const result = groupHomeTitles([
    title("a", {identifiers: {tvdb: 1, tmdb: 10}}),
    title("bridge", {identifiers: {tvdb: 1, imdb: "tt1"}}),
    title("b", {identifiers: {imdb: "tt1", tmdb: 20}}),
    title("c", {identifiers: {tmdb: 20}}),
  ]);
  expect(result.map(group => group.sources.map(source => source.library.id))).toEqual([["a", "bridge"], ["b", "c"]]);
});

it("falls back to normalized exact title and valid year only when both have no provider IDs", () => {
  const a = title("a", {year: 2019}, "series", " Ｃrash Landing on You ");
  const b = title("b", {year: "2019", identifiers: {tvdb: 0, tmdb: "", imdb: null}}, "series", "crash landing on you");
  expect(groupHomeTitles([a, b])).toHaveLength(1);
  expect(groupHomeTitles([a, title("identified", {year: 2019, identifiers: {tvdb: 1}})])).toHaveLength(2);
  expect(groupHomeTitles([a, title("unknown", {})])).toHaveLength(2);
  expect(groupHomeTitles([title("a"), title("b")])).toHaveLength(2);
});

it("preserves remakes, distinct media kinds and invalid year matches", () => {
  expect(groupHomeTitles([title("old", {year: 1990}), title("new", {year: 2020})])).toHaveLength(2);
  expect(groupHomeTitles([title("series", {identifiers: {tmdb: 1}}), title("movie", {identifiers: {tmdb: 1}}, "movie")])).toHaveLength(2);
  for (const year of [null, "", 0, -1, 2020.5, 10000, "n/a"]) {
    expect(groupHomeTitles([title("a", {year}), title("b", {year})])).toHaveLength(2);
  }
});

it("prefers an available playable movie without changing group position or sources", () => {
  const first = title("first", {identifiers: {tmdb: 1}}, "movie");
  const playable = title("playable", {identifiers: {tmdb: 1}}, "movie");
  playable.entry.files = [{path: "movie.mkv", size: 42, extension: "mkv"}];
  const unavailable = title("unavailable", {identifiers: {tmdb: 1}}, "movie");
  unavailable.entry.files = playable.entry.files;
  unavailable.entry.available = false;
  const result = groupHomeTitles([first, title("different"), unavailable, playable]);
  expect(result.map(group => group.library.id)).toEqual(["playable", "different"]);
  expect(result[0].sources).toEqual([first, unavailable, playable]);
});

it("leaves episodes and books separate", () => {
  for (const kind of ["episode", "book"]) {
    const records = [title("a", {year: 2020, identifiers: {tmdb: 1}}, kind), title("b", {year: 2020, identifiers: {tmdb: 1}}, kind)];
    expect(groupHomeTitles(records).map(group => group.sources)).toEqual(records.map(record => [record]));
  }
});
