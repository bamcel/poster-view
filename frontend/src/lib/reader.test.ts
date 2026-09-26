import { expect, it } from "vitest";
import { defaults, epubPath, normalizeState, readerUrl } from "./reader";

it("resumes valid progress and clamps corrupt/outdated positions", () => {
  expect(normalizeState({ page: 4, offset: 0.5 }, 10).page).toBe(4);
  expect(normalizeState({ page: 99, offset: -1 }, 4)).toMatchObject({
    page: 3,
    offset: 0,
  });
  expect(
    normalizeState(
      { page: NaN, settings: { ...defaults, zoom: 999, fontSize: 0 } },
      4,
    ),
  ).toMatchObject({ page: 0, settings: { zoom: 200, fontSize: 14 } });
});
it("retains valid bookmarks only", () => {
  expect(
    normalizeState(
      {
        bookmarks: [
          { page: 0, offset: 0.2, label: "Cover" },
          { page: 9, offset: 0, label: "Removed page" },
        ],
      },
      3,
    ).bookmarks,
  ).toEqual([{ page: 0, offset: 0.2, label: "Cover" }]);
});
it("resolves in-book relative resources without external URLs", () => {
  expect(epubPath("OPS/text/chapter.xhtml", "../images/cover.jpg")).toBe(
    "OPS/images/cover.jpg",
  );
  for (const path of [
    "https://tracker.test/a.png",
    "javascript:alert(1)",
    "//tracker.test/a.png",
    "/api/settings",
  ])
    expect(epubPath("OPS/chapter.xhtml", path)).toBeNull();
});
it("binds resource requests to a file revision and encodes archive names", () => {
  const url = readerUrl(
    {
      id: "book",
      title: "Test",
      format: "cbz",
      revision: "10-20",
      chapters: [],
    },
    "entry",
    "Chapter 1/page&2.jpg",
  );
  expect(url).toContain("revision=10-20");
  expect(url).toContain("name=Chapter+1%2Fpage%262.jpg");
});
