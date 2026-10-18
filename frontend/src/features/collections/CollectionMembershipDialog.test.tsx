import {describe,it,expect,vi,beforeEach,afterEach} from "vitest";
import {cleanup,render,screen,fireEvent,waitFor} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {AuthSessionContext} from "../../lib/authContext";
import type {AuthSession} from "../../api/client";
import CollectionMembershipDialog from "./CollectionMembershipDialog";
import {collectionsApi} from "./client";
afterEach(cleanup);
const saga={id:"saga",title:"Star Wars",overview:"",ordering:"release",revision:3,created_at:"",updated_at:"2026-01-01",members:[]};
function mount(role="admin",onClose=vi.fn()){return render(<AuthSessionContext.Provider value={{user:{id:"u",role}} as AuthSession}><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><CollectionMembershipDialog members={[{library_id:"movies",item_id:"a"},{library_id:"movies",item_id:"a"}]} onClose={onClose}/></QueryClientProvider></AuthSessionContext.Provider>);}
beforeEach(()=>{vi.spyOn(collectionsApi,"addMembers");vi.spyOn(collectionsApi,"create");vi.spyOn(collectionsApi,"list").mockResolvedValue([saga as never]);});
describe("collection picker",()=>{
 it("uses selected revision and unique members, then reports duplicates",async()=>{vi.mocked(collectionsApi.addMembers).mockResolvedValue({collection:saga as never,added:0,existing:1});mount();fireEvent.click(await screen.findByLabelText(/Star Wars/));fireEvent.click(screen.getByRole("button",{name:"Add titles"}));expect((await screen.findByRole("status")).textContent).toContain("0 added, 1 already included");expect(collectionsApi.addMembers).toHaveBeenCalledWith("saga",{revision:3,members:[{library_id:"movies",item_id:"a"}]});});
 it("searches existing collections and creates with release order",async()=>{vi.mocked(collectionsApi.create).mockResolvedValue(saga as never);mount();await screen.findByText("Star Wars");fireEvent.change(screen.getByLabelText("Find collection"),{target:{value:"Other"}});expect(screen.queryByText("Star Wars")).toBeNull();fireEvent.change(screen.getByLabelText("Collection name"),{target:{value:" New Saga "}});fireEvent.click(screen.getByRole("button",{name:"Add titles"}));await waitFor(()=>expect(collectionsApi.create).toHaveBeenCalledWith({title:"New Saga",overview:"",ordering:"release",members:[{library_id:"movies",item_id:"a"}]}));});
 it("supports native dialog dismissal and keeps an accessible search field",async()=>{const close=vi.fn();mount("admin",close);await screen.findByText("Star Wars");expect(screen.getByLabelText("Find collection")).toBeTruthy();fireEvent(screen.getByRole("dialog"),new Event("cancel",{bubbles:false,cancelable:true}));expect(close).toHaveBeenCalledTimes(1);});
 it("hides management for regular users",()=>{mount("user");expect(screen.queryByRole("dialog")).toBeNull();});
 it("keeps conflict error visible without closing",async()=>{vi.mocked(collectionsApi.addMembers).mockRejectedValue(new Error("Collection changed. Reload before saving."));mount();fireEvent.click(await screen.findByLabelText(/Star Wars/));fireEvent.click(screen.getByRole("button",{name:"Add titles"}));expect((await screen.findByRole("alert")).textContent).toContain("Collection changed");expect(screen.getByRole("dialog")).toBeTruthy();});
});
