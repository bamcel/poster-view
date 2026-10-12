import { expect, it } from "vitest";
import { titleSortKey } from "./titleSort";

it("ignores a leading The without changing other articles or words", () => {
  expect(titleSortKey("The Apothecary Diaries")).toBe("Apothecary Diaries");
  expect(titleSortKey("  tHe  Apothecary Diaries  ")).toBe("Apothecary Diaries");
  for (const title of ["The", "Theater", "Them", "A Silent Voice", "An Example", "After The Rain"])
    expect(titleSortKey(title)).toBe(title);
});

it("honors explicit NFO ordering, including The, and treats blank overrides as automatic", () => {
  expect(titleSortKey("The Apothecary Diaries", " The Apothecary Diaries ")).toBe("The Apothecary Diaries");
  expect(titleSortKey("The Apothecary Diaries", "Z Apothecary Diaries")).toBe("Z Apothecary Diaries");
  for (const blank of [undefined, null, "", "  ", 42])
    expect(titleSortKey("The Apothecary Diaries", blank)).toBe("Apothecary Diaries");
});
