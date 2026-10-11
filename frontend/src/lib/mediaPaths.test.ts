import {describe,it,expect} from "vitest";
import {libraryPath,itemPath,resolveNamed,namedSlug} from "./mediaPaths";
describe("readable media paths",()=>{
 it("uses safe library and title segments",()=>{
  const library={id:"lib",name:"Anime"},item={id:"item",title:"Dragon Ball"};
  expect(itemPath(library,[library],item,[item])).toBe("/media/Anime/Dragon-Ball");
  expect(libraryPath({id:"lib",name:"Books / Manga"})).toBe("/media/Books---Manga");
 });
 it("resolves old IDs and disambiguates duplicate names",()=>{
  const items=[{id:"a",title:"Kingdom"},{id:"b",title:"Kingdom"}];
  expect(namedSlug(items[0],items)).toBe("Kingdom~a");
  expect(resolveNamed("Kingdom~b",items)?.id).toBe("b");
  expect(resolveNamed("a",items)?.id).toBe("a");
  expect(resolveNamed("Kingdom",items)).toBeUndefined();
 });
});
