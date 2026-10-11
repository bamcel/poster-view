import {render,waitFor,cleanup,fireEvent,screen} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {afterEach,it,expect,vi} from "vitest";
import {nativeLibraries} from "../api/nativeLibraries";
import {useCatalogPrefetch} from "./catalogPrefetch";
vi.mock("../api/nativeLibraries",()=>({nativeLibraries:{catalog:vi.fn()}}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
it("loads only the library the user approaches and reuses its cached catalog",async()=>{
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([]);
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 function Tiles(){const prefetch=useCatalogPrefetch();return <>{["a","b","c"].map(id=><button key={id} onMouseEnter={()=>prefetch(id)} onFocus={()=>prefetch(id)}>{id}</button>)}</>;}
 render(<QueryClientProvider client={client}><Tiles/></QueryClientProvider>);
 expect(nativeLibraries.catalog).not.toHaveBeenCalled();
 fireEvent.mouseEnter(screen.getByRole("button",{name:"b"}));
 await waitFor(()=>expect(client.getQueryData(["native-catalog","b"])).toEqual([]));
 fireEvent.focus(screen.getByRole("button",{name:"b"}));
 expect(nativeLibraries.catalog).toHaveBeenCalledTimes(1);
 expect(nativeLibraries.catalog).toHaveBeenCalledWith("b");
 expect(client.getQueryData(["native-catalog","a"])).toBeUndefined();
 expect(client.getQueryData(["native-catalog","c"])).toBeUndefined();
 fireEvent.focus(screen.getByRole("button",{name:"a"}));
 await waitFor(()=>expect(client.getQueryData(["native-catalog","a"])).toEqual([]));
 client.clear();
});
