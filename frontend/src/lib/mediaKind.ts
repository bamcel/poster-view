import type { ItemDetail, Library, MediaItem } from "../types";

export type ArtworkMediaKind = "screen" | "book" | "ambiguous";

const BOOK_LIBRARY_WORDS = /\b(?:comics?|comic[\s_-]+books?|books?|manga|manhwa|manhua|webtoons?|graphic[\s_-]+novels?)\b/i;

export function isBookRelatedLibraryName(title: string): boolean {
  return BOOK_LIBRARY_WORDS.test(title);
}

export function artworkMediaKind(
  itemType: ItemDetail["type"],
  libraryType?: Library["type"],
  libraryTitle = "",
): ArtworkMediaKind {
  if (itemType === "book") return "book";
  if (itemType === "movie" || itemType === "show") return "screen";
  if (libraryType === "book") return "book";
  if (libraryType === "movie" || libraryType === "show") return "screen";
  if (itemType === "folder" && isBookRelatedLibraryName(libraryTitle)) return "book";
  return "ambiguous";
}

const SCREEN_PROVIDERS = new Set(["posterdb", "fanart", "tvdb", "anilist", "mediux", "manual"]);
const BOOK_PROVIDERS = new Set(["anilist-manga", "mangadex", "viz", "comicvine", "manual"]);

export function providerMatchesMediaKind(provider: string, kind: ArtworkMediaKind): boolean {
  if (kind === "screen") return SCREEN_PROVIDERS.has(provider);
  if (kind === "book") return BOOK_PROVIDERS.has(provider);
  return true;
}

export function seriesInstallmentSummary(members: MediaItem[]): string {
  // A leading underscore/dot is the library convention for companion content
  // (for example `_Art Book`) that belongs beside a series but is not one of
  // its numbered volumes or chapters.
  const installments = members.filter((member) => !/^[_.]/.test(member.title.trimStart()));
  const volumePattern = /(?:^|[\s._-])(?:volume|vol\.?|v)[\s._-]*#?\d+(?=$|[\s._-])/i;
  const chapterPattern = /(?:^|[\s._-])(?:chapter|chap\.?|ch\.?)[\s._-]*#?\d+(?=$|[\s._-])/i;
  const volumeCount = installments.filter((member) => volumePattern.test(member.title)).length;
  const chapterCount = installments.filter((member) => chapterPattern.test(member.title)).length;

  // Once a naming scheme is detectable, count only matching installments so
  // unprefixed extras (art books, specials, notes) cannot inflate the total.
  // Unknown libraries retain the previous visible-child fallback.
  const usesChapters = chapterCount > volumeCount;
  const count = usesChapters
    ? chapterCount
    : volumeCount > 0
      ? volumeCount
      : installments.length;
  const unit = usesChapters ? "Chapter" : "Volume";
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}
