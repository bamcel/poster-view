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

it.each(["tmdb","tvdb"])("sends only the strict preview selection when a full %s search result is selected",async provider=>{
 const candidate={provider,provider_id:"404609",title:"John Wick Collection",overview:"Description",poster_url:"https://image.tmdb.org/t/p/original/poster.jpg",backdrop_url:"https://image.tmdb.org/t/p/original/backdrop.jpg"};
 const preview={metadata:candidate,matches:[],unmatched:4};
 const fetchMock=vi.spyOn(globalThis,"fetch").mockImplementation(async(_url,init)=>{
  const selection=JSON.parse(String(init?.body));
  if(Object.keys(selection).some(key=>!["provider","provider_id"].includes(key)))return new Response(JSON.stringify({detail:"Unknown selection field"}),{status:422});
  return new Response(JSON.stringify(preview),{status:200});
 });
 await expect(collectionsApi.previewMetadata("john wick",candidate)).resolves.toEqual(preview);
 expect(fetchMock).toHaveBeenCalledWith("/api/collections/john%20wick/metadata/preview",expect.objectContaining({method:"POST",body:JSON.stringify({provider,provider_id:"404609"})}));
});
