import {expect,it} from "vitest";
import type {NativeCatalogEntry} from "../../../api/nativeLibraries";
import {startupArtworkState,startupArtworkUrl} from "./startupArtwork";

it("carries the series backdrop to an episode instead of using its poster",()=>{
 const entry={id:"series",revision:1,metadata:{},artwork:[{kind:"poster"},{kind:"backdrop"}]} as NativeCatalogEntry;
 const state=startupArtworkState("library",entry,"episode");
 expect(startupArtworkUrl(state,"library","episode")).toContain("/items/series/artwork/backdrop?");
 expect(startupArtworkUrl(state,"library","episode")).toContain("still=1");
 expect(startupArtworkUrl(state,"library","other")).toBeUndefined();
 expect(startupArtworkUrl(state,"other","episode")).toBeUndefined();
});
it("handles missing artwork and rejects external navigation image URLs",()=>{
 expect(startupArtworkState("library",{id:"movie",artwork:[]} as unknown as NativeCatalogEntry).playbackArtwork.url).toBeUndefined();
 expect(startupArtworkUrl({playbackArtwork:{libraryId:"library",itemId:"movie",url:"https://external.example/image"}},"library","movie")).toBeUndefined();
});
