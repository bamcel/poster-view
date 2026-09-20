import { expect, it } from "vitest";
import type { ItemDetail } from "../types";
import { buildApplyTargets } from "./targets";

const bookSeries: ItemDetail = {
  id: "series-1",
  title: "Book Series",
  type: "folder",
  seasons: [],
  members: [],
  external_ids: {},
};

it("offers a manual backdrop for folder-based book series", () => {
  expect(buildApplyTargets(bookSeries, true).slice(0, 2)).toEqual([
    { label: "Series cover", itemId: "series-1", target: "poster" },
    { label: "Series backdrop", itemId: "series-1", target: "background" },
  ]);
});

it("does not add a folder backdrop outside book libraries", () => {
  expect(buildApplyTargets(bookSeries)).toEqual([
    { label: "Series cover", itemId: "series-1", target: "poster" },
  ]);
});
