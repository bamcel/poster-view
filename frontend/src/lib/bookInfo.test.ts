import { expect, it } from "vitest";
import { bookTitleOrder } from "./bookInfo";
import { normalizeState } from "./reader";

it("sorts editions side by side with stable identities", () => {
  const items = [{ id: "color", title: "Chainsaw Man" }, { id: "other", title: "Dandadan" }, { id: "bw", title: "Chainsaw Man" }];
  expect(items.sort((a,b) => bookTitleOrder(a,b,{})).map(i=>i.id)).toEqual(["bw", "color", "other"]);
  expect(bookTitleOrder(items[0], items[2], { bw: { sort_title: "Z" } })).toBeGreaterThan(0);
});
it("finishing is explicit and survives reopening", () => {
  expect(normalizeState({ page: 99 }, 100).finished).toBe(false);
  expect(normalizeState({ page: 0, finished: true }, 100).finished).toBe(true);
});
it("ignores The by default while retaining explicit NFO sort titles", () => {
  const the = { id: "the", title: "The Apothecary Diaries" };
  const other = { id: "other", title: "Dandadan" };
  expect(bookTitleOrder(the, other, {})).toBeLessThan(0);
  expect(bookTitleOrder(the, other, { the: { sort_title: the.title } })).toBeGreaterThan(0);
  expect(bookTitleOrder(the, other, { the: { sort_title: " " } })).toBeLessThan(0);
});
