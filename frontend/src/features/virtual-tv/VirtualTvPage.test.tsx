import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {MemoryRouter} from "react-router-dom";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {AuthSessionContext} from "../../lib/authContext";
import type {AuthSession} from "../../api/client";
import {nativeLibraries} from "../../api/nativeLibraries";
import VirtualTvPage from "./VirtualTvPage";
import {virtualTv,type Channel} from "./client";

vi.mock("./client",()=>({virtualTv:{settings:vi.fn(),channels:vi.fn(),guide:vi.fn(),save:vi.fn(),remove:vi.fn()}}));
vi.mock("../../api/nativeLibraries",()=>({nativeLibraries:{list:vi.fn(),summaries:vi.fn()}}));
const channel:Channel={id:"comedy",name:"Comedy",number:2,library_ids:["tv"],show_ids:[],movie_ids:[],genres:[],order:"random_shows",start_at:"2026-01-01T00:00:00Z",revision:1};
beforeEach(()=>{
 vi.mocked(virtualTv.settings).mockResolvedValue({enabled:true});
 vi.mocked(virtualTv.channels).mockResolvedValue([channel]);
 vi.mocked(virtualTv.guide).mockResolvedValue([{id:"program",library_id:"tv",item_id:"episode",title:"Pilot",series_title:"Example show",season:1,episode:1,starts_at:new Date(Date.now()-60000).toISOString(),ends_at:new Date(Date.now()+60000).toISOString(),artwork_url:null}]);
 vi.mocked(nativeLibraries.list).mockResolvedValue([]);
 vi.mocked(nativeLibraries.summaries).mockResolvedValue([]);
});
afterEach(()=>{cleanup();vi.clearAllMocks();});
function mount(role:"user"|"admin"="user"){
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 return {...render(<AuthSessionContext.Provider value={{user:{role}} as AuthSession}><QueryClientProvider client={client}><MemoryRouter><VirtualTvPage/></MemoryRouter></QueryClientProvider></AuthSessionContext.Provider>),client};
}
it("shows the accessible live guide and tune link without administrator controls",async()=>{
 mount();expect(await screen.findByRole("heading",{name:"Pilot"})).toBeTruthy();
 expect(screen.getByRole("table",{name:"Channel schedule"})).toBeTruthy();
 expect(screen.getByRole("button",{name:/Comedy: Pilot,/})).toBeTruthy();
 expect(screen.getByText("ON NOW")).toBeTruthy();
 expect(screen.getByRole("link",{name:"Watch live"}).getAttribute("href")).toBe("/play/virtual-tv/comedy");
 expect(screen.queryByRole("button",{name:"Create channel"})).toBeNull();
 expect(screen.queryByRole("button",{name:"Edit Comedy"})).toBeNull();
});
it("does not fetch guide or channels when disabled",async()=>{
 vi.mocked(virtualTv.settings).mockResolvedValue({enabled:false});mount();
 expect(await screen.findByText(/Virtual TV is disabled/)).toBeTruthy();
 expect(virtualTv.channels).not.toHaveBeenCalled();expect(virtualTv.guide).not.toHaveBeenCalled();
});
it("allows administrators to edit a channel while preserving its revision",async()=>{
 vi.mocked(virtualTv.save).mockResolvedValue({...channel,name:"Updated"});mount("admin");
 fireEvent.click(await screen.findByRole("button",{name:"Edit Comedy"}));
 fireEvent.change(screen.getByLabelText("Channel name"),{target:{value:"Updated"}});
 await waitFor(()=>expect(screen.getByRole("button",{name:"Save channel"}).hasAttribute("disabled")).toBe(false));
 fireEvent.click(screen.getByRole("button",{name:"Save channel"}));
 const {id:_,...expected}=channel;
 await waitFor(()=>expect(virtualTv.save).toHaveBeenCalledWith({...expected,name:"Updated"},"comedy"));
});
it("shows no channels when the server excludes inaccessible library channels",async()=>{
 vi.mocked(virtualTv.channels).mockResolvedValue([]);mount();
 expect(await screen.findByText("No channels available.")).toBeTruthy();
 expect(virtualTv.guide).not.toHaveBeenCalled();
});
it("loads only eight visible channels at a time and pages to the remaining channels",async()=>{
 vi.mocked(virtualTv.channels).mockResolvedValue(Array.from({length:9},(_,index)=>({...channel,id:`channel-${index}`,name:`Channel ${index}`,number:index+1})));
 mount();
 await screen.findByRole("button",{name:"Select channel 1 Channel 0"});
 await waitFor(()=>expect(virtualTv.guide).toHaveBeenCalledTimes(8));
 expect(screen.queryByRole("button",{name:"Select channel 9 Channel 8"})).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"Next channels"}));
 await screen.findByRole("button",{name:"Select channel 9 Channel 8"});
 await waitFor(()=>expect(virtualTv.guide).toHaveBeenCalledTimes(9));
 expect(screen.queryByRole("button",{name:"Select channel 1 Channel 0"})).toBeNull();
});
it("requests bounded three hour windows and supports next, previous, now, and date navigation",async()=>{
 mount();await screen.findByRole("heading",{name:"Pilot"});
 const initial=vi.mocked(virtualTv.guide).mock.calls[0];
 expect(Date.parse(initial[2]!)-Date.parse(initial[1]!)).toBe(3*60*60*1000);
 fireEvent.click(screen.getByRole("button",{name:"Next 3 hours"}));
 await waitFor(()=>expect(virtualTv.guide).toHaveBeenCalledTimes(2));
 const next=vi.mocked(virtualTv.guide).mock.calls[1];
 expect(next[1]).toBe(initial[2]);
 expect(screen.queryByRole("heading",{name:"Pilot"})).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"Previous 3 hours"}));
 await screen.findByRole("heading",{name:"Pilot"});
 fireEvent.change(screen.getByLabelText("Guide date"),{target:{value:"2027-02-10"}});
 await waitFor(()=>expect((screen.getByLabelText("Guide date") as HTMLInputElement).value).toBe("2027-02-10"));
 fireEvent.click(screen.getByRole("button",{name:"Now"}));
 await screen.findByRole("heading",{name:"Pilot"});
});
it("hides cached program titles and artwork when guide access fails",async()=>{
 const {client}=mount();await screen.findByRole("heading",{name:"Pilot"});
 vi.mocked(virtualTv.guide).mockRejectedValue(new Error("Forbidden"));
 await client.invalidateQueries({queryKey:["virtual-tv-guide"]});
 await waitFor(()=>expect(screen.queryByRole("heading",{name:"Pilot"})).toBeNull());
 expect(screen.queryByRole("button",{name:/Comedy: Pilot,/})).toBeNull();
 expect(screen.queryByRole("link",{name:"Watch live"})).toBeNull();
});
it("removes channel details when channel access is revoked",async()=>{
 const {client}=mount();await screen.findByRole("heading",{name:"Pilot"});
 vi.mocked(virtualTv.channels).mockResolvedValue([]);
 await client.invalidateQueries({queryKey:["virtual-tv-channels"]});
 await screen.findByText("No channels available.");
 expect(screen.queryByRole("heading",{name:"Pilot"})).toBeNull();
 expect(screen.queryByRole("link",{name:"Watch live"})).toBeNull();
});
