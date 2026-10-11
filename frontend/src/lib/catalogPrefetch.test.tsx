import {render,waitFor,cleanup} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {afterEach,it,expect,vi} from "vitest";
import {nativeLibraries,type NativeLibrary} from "../api/nativeLibraries";
import {useCatalogPrefetch} from "./catalogPrefetch";
vi.mock("../api/nativeLibraries",()=>({nativeLibraries:{catalog:vi.fn()}}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
it("prefetches two catalogs at a time into the shared query cache",async()=>{
 let finish!:()=>void;
 vi.mocked(nativeLibraries.catalog).mockImplementation(async id=>{if(id==="a")await new Promise<void>(resolve=>finish=resolve);return [];});
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 function Warm(){useCatalogPrefetch([{id:"a"},{id:"b"},{id:"c"}] as NativeLibrary[]);return null;}
 render(<QueryClientProvider client={client}><Warm/></QueryClientProvider>);
 await waitFor(()=>expect(client.getQueryData(["native-catalog","c"])).toEqual([]));
 finish();await waitFor(()=>expect(client.getQueryData(["native-catalog","a"])).toEqual([]));
 expect(nativeLibraries.catalog).toHaveBeenCalledTimes(3);
});
