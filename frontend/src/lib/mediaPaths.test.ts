import {describe,it,expect} from "vitest";
import {libraryPath,itemPath,resolveNamed,namedSlug} from "./mediaPaths";
describe("readable media paths",()=>{
 it("uses safe library and title segments",()=>{
  const library={id:"lib",name:"Anime"},item={id:"item",title:"Dragon Ball"};
  expect(itemPath(library,[library],item,[item])).toBe("/media/Anime/Dragon-Ball");
  expect(libraryPath({id:"lib",name:"Books / Manga"})).toBe("/media/Books---Manga");
 });
 it("scopes seasons to their series without suffixes from other shows",()=>{
  const library={id:"lib",name:"Anime"};
  const series={id:"show",title:"Attack on Titan",kind:"series",path:"anime/aot"};
  const season={id:"s1",title:"Season 1",kind:"season",path:"anime/aot/s1",parent_path:series.path};
  const other={id:"s2",title:"Season 1",kind:"season",path:"anime/other/s1",parent_path:"anime/other"};
  expect(itemPath(library,[library],season,[series,season,other])).toBe("/media/Anime/Attack-on-Titan/Season-1");
 });
 it("resolves old IDs and disambiguates duplicate names",()=>{
  const items=[{id:"a",title:"Kingdom"},{id:"b",title:"Kingdom"}];
  expect(namedSlug(items[0],items)).toBe("Kingdom~a");
  expect(resolveNamed("Kingdom~b",items)?.id).toBe("b");
  expect(resolveNamed("a",items)?.id).toBe("a");
  expect(resolveNamed("Kingdom",items)).toBeUndefined();
 });
});
