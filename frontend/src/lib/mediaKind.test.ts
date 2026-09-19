import { expect, it } from "vitest";
import { artworkMediaKind, providerMatchesMediaKind } from "./mediaKind";

it("uses server types before folder naming conventions", () => {
  expect(artworkMediaKind("book", "other", "Television")).toBe("book");
  expect(artworkMediaKind("show", "book", "Manga")).toBe("screen");
  expect(artworkMediaKind("movie", "movie", "Graphic Novels")).toBe("screen");
});

it("recognizes book-related folder library names case-insensitively", () => {
  for (const title of ["Comics", "Comic Books", "BOOKS", "Manga", "Manhwa", "Manhua", "Webtoons", "Graphic Novels"]) {
    expect(artworkMediaKind("folder", "other", title)).toBe("book");
  }
  expect(artworkMediaKind("folder", "other", "Documentaries")).toBe("ambiguous");
});

it("filters providers while keeping manual available everywhere", () => {
  expect(providerMatchesMediaKind("tvdb", "screen")).toBe(true);
  expect(providerMatchesMediaKind("mangadex", "screen")).toBe(false);
  expect(providerMatchesMediaKind("comicvine", "book")).toBe(true);
  expect(providerMatchesMediaKind("anilist-manga", "book")).toBe(true);
  expect(providerMatchesMediaKind("anilist", "book")).toBe(false);
  expect(providerMatchesMediaKind("manual", "screen")).toBe(true);
  expect(providerMatchesMediaKind("manual", "book")).toBe(true);
  expect(providerMatchesMediaKind("comicvine", "ambiguous")).toBe(true);
});
