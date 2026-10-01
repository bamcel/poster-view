import {QueryClient} from "@tanstack/react-query";
import {expect, it, vi} from "vitest";
import {invalidateArtworkItems} from "./artworkTarget";
import type {NativeCatalogEntry} from "../api/nativeLibraries";

function entry(id: string, kind = "series"): NativeCatalogEntry {
  return {id, kind, path:id, parent_path:null, title:id, metadata:{}, artwork:[], files:[], nfo_path:null, available:true, revision:4};
}
it("refreshes the saved native image before the catalog refetch finishes",async()=>{
  const client=new QueryClient();
  client.setQueryData(["native-catalog","library"],[entry("series"),entry("other")]);
  let finish!: () => void;
  vi.spyOn(client,"invalidateQueries").mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));
  const pending=invalidateArtworkItems(client,0,"native:library:series","poster");
  const items=client.getQueryData<NativeCatalogEntry[]>(["native-catalog","library"])!;
  expect(items[0].revision).toBe(5);
  expect(items[0].artwork[0].kind).toBe("poster");
  expect(items[1].revision).toBe(4);
  finish(); await pending; client.clear();
});
it("uses thumbnails for episodes and does not add artwork during removal",async()=>{
  const client=new QueryClient();
  client.setQueryData(["native-catalog","library"],[entry("episode","episode")]);
  await invalidateArtworkItems(client,0,"native:library:episode","poster");
  expect(client.getQueryData<NativeCatalogEntry[]>(["native-catalog","library"])![0].artwork[0].kind).toBe("thumb");
  await invalidateArtworkItems(client,0,"native:library:episode");
  expect(client.getQueryData<NativeCatalogEntry[]>(["native-catalog","library"])![0].revision).toBe(5);
  client.clear();
});

it("refreshes the native catalog without invalidating connected server libraries", async () => {
 const client = new QueryClient();
 client.setQueryData(["native-catalog","library"], []);
 client.setQueryData(["items", 1], []);
 await invalidateArtworkItems(client,0,"native:library:item");
 expect(client.getQueryState(["native-catalog","library"])?.isInvalidated).toBe(true);
 expect(client.getQueryState(["items",1])?.isInvalidated).toBe(false);
 client.clear();
});
