import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {MemoryRouter,Route,Routes} from "react-router-dom";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {AuthSessionContext} from "../../lib/authContext";
import type {AuthSession} from "../../api/client";
import {nativeLibraries} from "../../api/nativeLibraries";
import CollectionPage from "./CollectionPage";
import {collectionsApi,type Collection,type CollectionMember} from "./client";
const member=(id:string,kind="movie"):CollectionMember=>({library_id:"lib",library_name:"Movies",item_id:id,entry:{id,title:id,path:id,parent_path:null,kind,artwork:[],files:[],metadata:{year:2000},available:true,revision:1,nfo_path:null}});
const collection:Collection={id:"saga",title:"Saga",overview:"Shared story",ordering:"custom",revision:2,created_at:"",updated_at:"",members:[member("A"),member("B"),member("C","series")]};
function mount(role="admin"){return render(<AuthSessionContext.Provider value={{user:{id:"account",role}} as AuthSession}><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MemoryRouter initialEntries={["/collections/saga"]}><Routes><Route path="/collections/:id" element={<CollectionPage/>}/><Route path="/collections" element={<h1>Collections</h1>}/></Routes></MemoryRouter></QueryClientProvider></AuthSessionContext.Provider>);}
beforeEach(()=>{vi.spyOn(collectionsApi,"get").mockResolvedValue(collection);vi.spyOn(collectionsApi,"update").mockResolvedValue(collection);vi.spyOn(nativeLibraries,"list").mockResolvedValue([]);});afterEach(cleanup);
it("browses movies and series through existing media routes without management for users",async()=>{mount("user");await screen.findByText("Saga");expect(screen.getByRole("heading",{name:"Movies"})).toBeTruthy();expect(screen.getByRole("heading",{name:"Series"})).toBeTruthy();expect(screen.getByRole("link",{name:/^A/}).getAttribute("href")).toContain("native_item=A");expect(screen.queryByRole("button",{name:"Edit collection"})).toBeNull();});
it("persists custom reordering and removal using the collection revision",async()=>{mount();fireEvent.click(await screen.findByRole("button",{name:"Edit collection"}));fireEvent.click(screen.getByRole("button",{name:"Move B up"}));fireEvent.click(screen.getByRole("button",{name:"Remove C"}));fireEvent.change(screen.getByLabelText("Name"),{target:{value:"Renamed"}});fireEvent.click(screen.getByRole("button",{name:"Save collection"}));await waitFor(()=>expect(collectionsApi.update).toHaveBeenCalledWith("saga",{revision:2,title:"Renamed",overview:"Shared story",ordering:"custom",members:[{library_id:"lib",item_id:"B"},{library_id:"lib",item_id:"A"}]}));});

it("returns to collection browsing with the shared detail back control",async()=>{mount();await screen.findByRole("heading",{name:"Saga"});expect(screen.getByRole("img",{name:"Saga collection artwork"})).toBeTruthy();fireEvent.click(screen.getByRole("button",{name:/^Back$/}));expect(await screen.findByRole("heading",{name:"Collections"})).toBeTruthy();});
