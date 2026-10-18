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

it("limits native collection artwork to its own poster and background",()=>{
 expect(buildApplyTargets({...bookSeries,id:"collection:saga",type:"collection",members:[{id:"member",title:"Movie",type:"movie"}]})).toEqual([
  {label:"Poster",itemId:"collection:saga",target:"poster"},
  {label:"Background",itemId:"collection:saga",target:"background"},
 ]);
});
