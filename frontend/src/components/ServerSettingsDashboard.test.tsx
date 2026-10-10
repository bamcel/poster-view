import {render,screen,cleanup} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {MemoryRouter} from "react-router-dom";
import {afterEach,it,expect,vi} from "vitest";
import ServerSettingsDashboard,{groupNotices} from "./ServerSettingsDashboard";
vi.mock("../api/client",()=>({apiRequest:vi.fn(async(path:string)=>path==="/tasks"?[]:{name:"PosterView",version:"1.2.3",data_dir:"/data"}),api:{listServers:vi.fn(async()=>[])}}));
vi.mock("../api/nativeLibraries",()=>({nativeLibraries:{list:vi.fn(async()=>[{id:"anime",name:"Anime",options:{server_sync:{enabled:true}}}]),status:vi.fn(async()=>({status:"scanning",count:10,warnings:["Provider unavailable"]})),syncStatus:vi.fn(async()=>({status:"synced",pending:0,failed:0,notices:[]}))}}));
afterEach(cleanup);
it("shows actual server details, library activity and provider notices",async()=>{
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 render(<MemoryRouter><QueryClientProvider client={client}><ServerSettingsDashboard/></QueryClientProvider></MemoryRouter>);
 expect(await screen.findByText("1.2.3")).toBeTruthy();
 expect(await screen.findByRole("heading",{name:"Needs attention"})).toBeTruthy();
 expect(screen.getAllByText("Provider unavailable").length).toBeGreaterThan(0);
 expect(await screen.findByText(/Starting scan/)).toBeTruthy();
 expect(screen.getByRole("link",{name:"1 libraries"}).getAttribute("href")).toBe("/settings/libraries");
 client.clear();
});

it("groups repeated provider failures within each library and deduplicates messages",()=>{
 const groups=groupNotices([{library:"Anime",message:"One: Jikan connection failed."},{library:"Anime",message:"Two: Jikan connection failed."},{library:"Anime",message:"One: Jikan connection failed."},{library:"Books",message:"One: Jikan connection failed."},{library:"Anime",message:"Linked server was removed."}]);
 expect(groups).toHaveLength(3);expect(groups[0].summary).toBe("Jikan connection failed.");expect(groups[0].messages).toHaveLength(2);expect(groups[1].library).toBe("Books");
});
