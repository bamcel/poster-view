import {render,screen,cleanup} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {MemoryRouter} from "react-router-dom";
import {afterEach,it,expect,vi} from "vitest";
import ServerSettingsDashboard from "./ServerSettingsDashboard";
vi.mock("../api/client",()=>({apiRequest:vi.fn(async()=>({name:"PosterView",version:"1.2.3",data_dir:"/data"})),api:{listServers:vi.fn(async()=>[])}}));
vi.mock("../api/nativeLibraries",()=>({nativeLibraries:{list:vi.fn(async()=>[{id:"anime",name:"Anime",options:{server_sync:{enabled:true}}}]),status:vi.fn(async()=>({status:"scanning",count:10,warnings:["Provider unavailable"]})),syncStatus:vi.fn(async()=>({status:"synced",pending:0,failed:0,notices:[]}))}}));
afterEach(cleanup);
it("shows actual server details, library activity and provider notices",async()=>{
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 render(<MemoryRouter><QueryClientProvider client={client}><ServerSettingsDashboard/></QueryClientProvider></MemoryRouter>);
 expect(await screen.findByText("1.2.3")).toBeTruthy();
 expect(await screen.findByText("Provider unavailable")).toBeTruthy();
 expect(await screen.findByText(/Starting scan/)).toBeTruthy();
 expect(screen.getByRole("link",{name:"1 libraries"}).getAttribute("href")).toBe("/settings/libraries");
 client.clear();
});
