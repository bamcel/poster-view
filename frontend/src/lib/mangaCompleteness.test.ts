import { expect, it } from "vitest";
import { parseOwnedVolumes, volumeInventory } from "./mangaCompleteness";
const files = (...titles: string[]) => titles.map((title, i) => ({ id: String(i), title, type: "book" as const }));
it("finds missing volumes without counting duplicate copies", () => {
  expect(volumeInventory(files("Series Vol. 01", "Series v1", "Series Volume 3"), 4, "Series"))
    .toEqual({ owned: [1, 3], missing: [2, 4], uncertain: 0 });
});
it("leaves ambiguous, mismatched, fractional, and omnibus files unresolved", () => {
  expect(volumeInventory(files("Other Vol. 2", "Series Vol. 1-3", "Series Vol. 2.5", "Series Omnibus Vol. 1", "Series special", "Series Vol. 8"), 4, "Series").uncertain).toBe(6);
});
it("parses explicit volume coverage and rejects invalid ranges", () => {
  expect(parseOwnedVolumes("1-3, 3, 5")).toEqual([1, 2, 3, 5]);
  for (const value of ["3-1", "0", "1-999999", "2.5", "one"]) expect(parseOwnedVolumes(value)).toBeNull();
});
it("uses metadata and filenames while rejecting conflicting numbers", () => {
  const items = [
    { ...files("Chapter title")[0], volume: "1" },
    { ...files("Another title")[0], file_name: "Series 02.cbz" },
    { ...files("Series Vol. 3")[0], volume: "4", file_name: "Series 03.cbz" },
  ];
  expect(volumeInventory(items, 4, "Series")).toEqual({ owned: [1, 2], missing: [3, 4], uncertain: 1 });
});
