import {cleanup,fireEvent,render,screen,waitFor,within} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {MemoryRouter} from "react-router-dom";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {AuthSessionContext} from "../../lib/authContext";
import type {AuthSession} from "../../api/client";
import {nativeLibraries,type NativeCatalogEntry} from "../../api/nativeLibraries";
import VirtualTvPage from "./VirtualTvPage";
import {virtualTv,type Channel} from "./client";

vi.mock("./client",()=>({virtualTv:{settings:vi.fn(),channels:vi.fn(),guide:vi.fn(),save:vi.fn(),remove:vi.fn()}}));
vi.mock("../../api/nativeLibraries",()=>({nativeLibraries:{list:vi.fn(),summaries:vi.fn()}}));
const channel:Channel={id:"comedy",name:"Comedy",number:2,library_ids:["tv"],show_ids:[],movie_ids:[],genres:[],order:"random_shows",start_at:"2026-01-01T00:00:00Z",revision:1};
beforeEach(()=>{
 vi.mocked(virtualTv.settings).mockResolvedValue({enabled:true});
 vi.mocked(virtualTv.channels).mockResolvedValue([channel]);
 vi.mocked(virtualTv.guide).mockResolvedValue([{id:"program",library_id:"tv",item_id:"episode",title:"Pilot",series_title:"Example show",season:1,episode:1,starts_at:new Date(Date.now()-60000).toISOString(),ends_at:new Date(Date.now()+60000).toISOString(),artwork_url:"/api/virtual-tv/program/artwork"}]);
 vi.mocked(nativeLibraries.list).mockResolvedValue([]);
 vi.mocked(nativeLibraries.summaries).mockResolvedValue([]);
});
afterEach(()=>{cleanup();vi.clearAllMocks();});
function mount(role:"user"|"admin"="user"){
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 return {...render(<AuthSessionContext.Provider value={{user:{role}} as AuthSession}><QueryClientProvider client={client}><MemoryRouter><VirtualTvPage/></MemoryRouter></QueryClientProvider></AuthSessionContext.Provider>),client};
}
it("shows the accessible live guide and tune link without administrator controls",async()=>{
 mount();expect(await screen.findByRole("button",{name:/Comedy: Pilot,/})).toBeTruthy();
 expect(screen.getByRole("table",{name:"Channel schedule"})).toBeTruthy();
 expect(screen.getByRole("button",{name:/Comedy: Pilot,/})).toBeTruthy();
 expect(screen.queryAllByRole("article")).toHaveLength(0);
 expect(screen.getByRole("link",{name:"Watch Comedy live"}).getAttribute("href")).toBe("/play/virtual-tv/comedy");
 expect(screen.queryByRole("button",{name:"Create channel"})).toBeNull();
 expect(screen.queryByRole("button",{name:"Edit channels"})).toBeNull();
 expect(screen.queryByRole("button",{name:"Edit Comedy"})).toBeNull();
});
it("does not fetch guide or channels when disabled",async()=>{
 vi.mocked(virtualTv.settings).mockResolvedValue({enabled:false});mount();
 expect(await screen.findByText(/Virtual TV is disabled/)).toBeTruthy();
 expect(virtualTv.channels).not.toHaveBeenCalled();expect(virtualTv.guide).not.toHaveBeenCalled();
});
it("allows administrators to edit a channel while preserving its revision",async()=>{
 vi.mocked(virtualTv.save).mockResolvedValue({...channel,name:"Updated"});mount("admin");
 fireEvent.click(await screen.findByRole("button",{name:"Edit channels"}));
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
it("keeps edit and remove actions inside the channel management list",async()=>{
 mount("admin");
 const edit=await screen.findByRole("button",{name:"Edit channels"});
 expect(screen.queryByRole("button",{name:"Edit Comedy"})).toBeNull();
 expect(screen.queryByRole("button",{name:"Remove Comedy"})).toBeNull();
 fireEvent.click(edit);
 const dialog=screen.getByRole("dialog",{name:"Edit channels"});
 expect(within(dialog).getByRole("button",{name:"Edit Comedy"})).toBeTruthy();
 const confirm=vi.spyOn(window,"confirm").mockReturnValue(true);
 vi.mocked(virtualTv.remove).mockResolvedValue(undefined);
 vi.mocked(virtualTv.channels).mockResolvedValue([]);
 fireEvent.click(within(dialog).getByRole("button",{name:"Remove Comedy"}));
 await waitFor(()=>expect(virtualTv.remove).toHaveBeenCalledWith("comedy",expect.anything()));
 await within(dialog).findByText("No channels to edit.");
 fireEvent.click(within(dialog).getByRole("button",{name:"Close"}));
 expect(screen.queryByRole("dialog")).toBeNull();
 confirm.mockRestore();
});
it("offers main titles rather than Specials folders or trailers when adding a library",async()=>{
 vi.mocked(nativeLibraries.list).mockResolvedValue([{id:"tv",name:"Anime",library_type:"anime"}] as Awaited<ReturnType<typeof nativeLibraries.list>>);
 vi.mocked(nativeLibraries.summaries).mockResolvedValue([
  {id:"show",kind:"series",path:"Anime/Example",title:"Example show",metadata:{}},
  {id:"specials",kind:"series",path:"Anime/Example/Specials",title:"Specials",metadata:{}},
  {id:"trailer",kind:"movie",path:"Anime/Example/Trailers/Trailer 1.mp4",title:"Example Trailer 1",metadata:{}},
  {id:"movie",kind:"movie",path:"Movies/Film/Film.mkv",title:"Feature film",metadata:{}},
 ] as NativeCatalogEntry[]);
 mount("admin");
 fireEvent.click(await screen.findByRole("button",{name:"Create channel"}));
 fireEvent.click(await screen.findByRole("checkbox",{name:"Anime"}));
 expect(await screen.findByRole("checkbox",{name:"Example show"})).toBeTruthy();
 expect(screen.getByRole("checkbox",{name:"Feature film"})).toBeTruthy();
 expect(screen.queryByRole("checkbox",{name:"Specials"})).toBeNull();
 expect(screen.queryByRole("checkbox",{name:"Example Trailer 1"})).toBeNull();
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
 mount();await screen.findByRole("button",{name:/Comedy: Pilot,/});
 const initial=vi.mocked(virtualTv.guide).mock.calls[0];
 expect(Date.parse(initial[2]!)-Date.parse(initial[1]!)).toBe(3*60*60*1000);
 fireEvent.click(screen.getByRole("button",{name:"Next 3 hours"}));
 await waitFor(()=>expect(virtualTv.guide).toHaveBeenCalledTimes(2));
 const next=vi.mocked(virtualTv.guide).mock.calls[1];
 expect(next[1]).toBe(initial[2]);
 expect(screen.queryByRole("button",{name:/Comedy: Pilot,/})).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"Previous 3 hours"}));
 await screen.findByRole("button",{name:/Comedy: Pilot,/});
 fireEvent.change(screen.getByLabelText("Guide date"),{target:{value:"2027-02-10"}});
 await waitFor(()=>expect((screen.getByLabelText("Guide date") as HTMLInputElement).value).toBe("2027-02-10"));
 fireEvent.click(screen.getByRole("button",{name:"Now"}));
 await screen.findByRole("button",{name:/Comedy: Pilot,/});
});
it("hides cached program titles and artwork when guide access fails",async()=>{
 const {client}=mount();await screen.findByRole("button",{name:/Comedy: Pilot,/});
 vi.mocked(virtualTv.guide).mockRejectedValue(new Error("Forbidden"));
 await client.invalidateQueries({queryKey:["virtual-tv-guide"]});
 await waitFor(()=>expect(screen.queryByRole("button",{name:/Comedy: Pilot,/})).toBeNull());
 expect(screen.queryByRole("button",{name:/Comedy: Pilot,/})).toBeNull();
 expect(screen.queryByRole("link",{name:"Watch Comedy live"})).toBeNull();
});
it("removes channel details when channel access is revoked",async()=>{
 const {client}=mount();await screen.findByRole("button",{name:/Comedy: Pilot,/});
 vi.mocked(virtualTv.channels).mockResolvedValue([]);
 await client.invalidateQueries({queryKey:["virtual-tv-channels"]});
 await screen.findByText("No channels available.");
 expect(screen.queryByRole("button",{name:/Comedy: Pilot,/})).toBeNull();
 expect(screen.queryByRole("link",{name:"Watch Comedy live"})).toBeNull();
});
it("shows selected program details with its corresponding thumbnail and live progress",async()=>{
 mount();const hero=await screen.findByRole("region",{name:"Selected program"});
 await within(hero).findByRole("heading",{name:"Pilot"});
 expect(within(hero).getByRole("img",{name:"Pilot thumbnail"}).getAttribute("src")).toBe("/api/virtual-tv/program/artwork");
 expect(within(hero).getByRole("progressbar",{name:"Current program progress"})).toBeTruthy();
 expect(within(hero).getByText(/min left/)).toBeTruthy();
 expect(screen.queryByLabelText("Channel image")).toBeNull();
});
it("previews the clicked future episode and returns to the live episode when selecting its channel",async()=>{
 const now=Date.now();
 vi.mocked(virtualTv.guide).mockResolvedValue([
  {id:"live",library_id:"tv",item_id:"pilot",title:"Pilot",series_title:"Example show",season:1,episode:1,starts_at:new Date(now-60000).toISOString(),ends_at:new Date(now+60000).toISOString(),artwork_url:"/pilot.jpg"},
  {id:"future",library_id:"tv",item_id:"second",title:"Second episode",series_title:"Example show",season:1,episode:2,starts_at:new Date(now+60000).toISOString(),ends_at:new Date(now+120000).toISOString(),artwork_url:"/second.jpg"},
 ]);
 mount();fireEvent.error(await screen.findByRole("img",{name:"Pilot thumbnail"}));
 fireEvent.click(await screen.findByRole("button",{name:/Comedy: Second episode,/}));
 const hero=screen.getByRole("region",{name:"Selected program"});
 expect(within(hero).getByRole("heading",{name:"Second episode"})).toBeTruthy();
 expect(within(hero).getByRole("img",{name:"Second episode thumbnail"}).getAttribute("src")).toBe("/second.jpg");
 expect(within(hero).getByText(/Upcoming/)).toBeTruthy();
 expect(within(hero).queryByRole("progressbar")).toBeNull();
 expect(within(hero).getByRole("link",{name:"Watch Comedy live"}).getAttribute("href")).toBe("/play/virtual-tv/comedy");
 fireEvent.click(screen.getByRole("button",{name:"Select channel 2 Comedy"}));
 expect(within(hero).getByRole("heading",{name:"Pilot"})).toBeTruthy();
 expect(within(hero).getByRole("img",{name:"Pilot thumbnail"}).getAttribute("src")).toBe("/pilot.jpg");
});
it("uses a clean image fallback for unavailable thumbnails",async()=>{
 mount();const image=await screen.findByRole("img",{name:"Pilot thumbnail"});
 fireEvent.error(image);
 expect(screen.queryByRole("img",{name:"Pilot thumbnail"})).toBeNull();
 expect(screen.getByLabelText("Program image unavailable")).toBeTruthy();
});
