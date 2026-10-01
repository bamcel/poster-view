import { QueryClient } from "@tanstack/react-query";
import {expect,it} from "vitest";
import {invalidateArtworkItems} from "./artworkTarget";
it("refreshes the native database catalog without invalidating connected server libraries", async () => {
 const client = new QueryClient();
 client.setQueryData(["native-catalog","library"], []);
 client.setQueryData(["items", 1], []);
 await invalidateArtworkItems(client,0,"native:library:item");
 expect(client.getQueryState(["native-catalog","library"])?.isInvalidated).toBe(true);
 expect(client.getQueryState(["items",1])?.isInvalidated).toBe(false);
 client.clear();
});
