import { expect, it } from "vitest";
import { detectManga, normalizeVolume } from "./manga";

it.each([
  "Food Wars - Volume 14.epub",
  "Food Wars Vol 14.epub",
  "Food Wars v14.epub",
  "Food Wars 14.epub",
])("detects %s", (title) => {
  expect(detectManga({ title })).toEqual({ series: "Food Wars", volume: "14" });
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
