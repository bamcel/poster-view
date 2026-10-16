import {act,cleanup,renderHook,waitFor} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import type {ReactNode} from "react";
import {afterEach,expect,it,vi} from "vitest";
import {AuthSessionContext} from "../../lib/authContext";
import type {AuthSession} from "../../api/client";
import {collectionsApi,useCollections,type Collection} from "./client";

afterEach(()=>{cleanup();vi.restoreAllMocks();});
it("does not display the previous account's cached collections during an account switch",async()=>{
 let id="first";
 const first={id:"private",title:"Private collection",members:[]} as unknown as Collection;
 const second={id:"second",title:"Second account collection",members:[]} as unknown as Collection;
 let resolveSecond!:(value:Collection[])=>void;
 vi.spyOn(collectionsApi,"list").mockResolvedValueOnce([first]).mockImplementationOnce(()=>new Promise(resolve=>{resolveSecond=resolve;}));
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 const wrapper=({children}:{children:ReactNode})=><AuthSessionContext.Provider value={{user:{id}} as AuthSession}><QueryClientProvider client={client}>{children}</QueryClientProvider></AuthSessionContext.Provider>;
 const view=renderHook(()=>useCollections("movies"),{wrapper});
 await waitFor(()=>expect(view.result.current.data?.[0].id).toBe("private"));
 id="second";view.rerender();
 expect(view.result.current.data).toBeUndefined();
 await act(async()=>resolveSecond([second]));
 await waitFor(()=>expect(view.result.current.data?.[0].id).toBe("second"));
 expect(client.getQueryData(["collections","first","list","movies"])).toEqual([first]);
});
