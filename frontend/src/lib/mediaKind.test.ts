import { expect, it } from "vitest";
import { artworkMediaKind, providerMatchesMediaKind, seriesInstallmentInfo, seriesInstallmentSummary } from "./mediaKind";

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

it("counts actual series installments without companion folders", () => {
  const item = (title: string) => ({ id: title, title, type: "book" as const });
  expect(seriesInstallmentSummary([
    ...Array.from({ length: 13 }, (_, index) => item(`Volume ${index + 1}`)),
    item("_Art Book"),
  ])).toBe("13 Volumes");
  expect(seriesInstallmentSummary([item("Chapter 1"), item("Ch. 2"), item(".extras")])).toBe("2 Chapters");
  expect(seriesInstallmentInfo([item("Chapter 1"), item("Ch. 2")])).toEqual({ count: 2, unit: "Chapter" });
});

it("recognizes volume and chapter markers throughout common title schemas", () => {
  const item = (title: string) => ({ id: title, title, type: "book" as const });
  expect(seriesInstallmentSummary([
    item("Volume 01"),
    item("The Apothecary Diaries - Volume 02"),
    item("The Apothecary Diaries Vol. 03"),
    item("The Apothecary Diaries_v04"),
    item("Art Book"),
  ])).toBe("4 Volumes");
  expect(seriesInstallmentSummary([
    item("Chapter 001"),
    item("Series Name - Chapter 002"),
    item("Series Name Chap. 003"),
    item("Series Name - Ch. 004"),
    item("Special"),
  ])).toBe("4 Chapters");
});
