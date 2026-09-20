import { expect, it } from "vitest";
import { detectManga, missingComicVineCoverAssignments, normalizeVolume } from "./manga";

it.each([
  "Food Wars - Volume 14.epub",
  "Food Wars Vol 14.epub",
  "Food Wars v14.epub",
  "Food Wars 14.epub",
])("detects %s", (title) => {
  expect(detectManga({ title })).toEqual({ series: "Food Wars", volume: "14" });
});

it("matches ComicVine artwork only to volumes that are missing covers", () => {
  const item = {
    id: "series", title: "Series", type: "folder" as const, seasons: [], external_ids: {},
    members: [
      { id: "1", title: "Series - Volume 01", type: "book" as const, poster: null },
      { id: "2", title: "Volume 02", type: "book" as const, poster: "cover" },
      { id: "extra", title: "_Art Book", type: "book" as const, poster: null },
    ],
  };
  const artwork = ["1", "2"].map((volume) => ({
    id: volume, provider: "comicvine", type: "poster" as const, kind: "book" as const, title: null,
    season_number: null, lang: "en", likes: null, thumb_url: "thumb", download_url: "cover",
    applyable: true, source_url: null, manga: { mangadex_id: "", volume, locale: "en", description: null },
  }));
  expect(missingComicVineCoverAssignments(item, artwork).map(({ member }) => member.id)).toEqual(["1"]);
});
it("uses a filename when the title has no volume, with metadata taking precedence", () => {
  expect(
    detectManga({
      title: "Food Wars",
      file_name: "Food Wars v14.epub",
      volume: "015",
    }),
  ).toEqual({ series: "Food Wars", volume: "15" });
  expect(detectManga({ title: "Food Wars" }).volume).toBe("");
  expect(detectManga({ title: "Food Wars 2012" }).volume).toBe("");
  expect(normalizeVolume("014.0")).toBe("14");
  expect(normalizeVolume("1.5")).toBe("1.5");
  expect(normalizeVolume("Omnibus 1–3")).toBe("omnibus 1–3");
});
