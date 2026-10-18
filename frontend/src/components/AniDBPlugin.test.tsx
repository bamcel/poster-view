import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {apiRequest} from "../api/client";
import AniDBPlugin from "./AniDBPlugin";
vi.mock("../api/client",()=>({apiRequest:vi.fn()}));
beforeEach(()=>{HTMLDialogElement.prototype.showModal=vi.fn(function(this:HTMLDialogElement){this.setAttribute("open","");});});
afterEach(()=>{cleanup();vi.resetAllMocks();});
it("preserves saved AniDB settings, saves changes, and reports a failed connection",async()=>{
 let settings={anidb_client:"existing_client",anidb_client_version:"1"};
 vi.mocked(apiRequest).mockImplementation(async(path,input)=>{
  if(path.endsWith("/test/anidb"))return {ok:false,message:"AniDB rejected the client."};
  if(input?.method==="PUT")settings=JSON.parse(input.body as string);
  return settings;
 });
 render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><AniDBPlugin/></QueryClientProvider>);
 fireEvent.click(await screen.findByRole("button",{name:/AniDB Anime metadata/}));
 const name=await screen.findByLabelText("AniDB registered client name");
 await waitFor(()=>expect(name).toHaveProperty("value","existing_client"));
 fireEvent.change(name,{target:{value:"new_client"}});
 expect(screen.getByRole("button",{name:"Test connection"})).toHaveProperty("disabled",true);
 await screen.findByText("Changes saved automatically");
 expect(apiRequest).toHaveBeenCalledWith("/native/providers/settings",{method:"PUT",body:JSON.stringify({anidb_enabled:true,anidb_client:"new_client",anidb_client_version:"1"})});
 fireEvent.click(screen.getByRole("button",{name:"Test connection"}));
 expect(await screen.findByRole("alert")).toHaveProperty("textContent","AniDB rejected the client.");
});
it("shows a successful connection result",async()=>{
 vi.mocked(apiRequest).mockImplementation(async path=>path.endsWith("/test/anidb")?{ok:true,message:"Provider connection succeeded."}:{anidb_client:"client",anidb_client_version:"1"});
 render(<QueryClientProvider client={new QueryClient()}><AniDBPlugin/></QueryClientProvider>);
 fireEvent.click(await screen.findByRole("button",{name:/AniDB Anime metadata/}));
 await waitFor(()=>expect(screen.getByRole("button",{name:"Test connection"})).toHaveProperty("disabled",false));
 fireEvent.click(screen.getByRole("button",{name:"Test connection"}));
 expect(await screen.findByText("Provider connection succeeded.")).toBeTruthy();
 expect(screen.queryByRole("alert")).toBeNull();
});

it("disables AniDB without clearing existing client credentials",async()=>{
 vi.mocked(apiRequest).mockImplementation(async(_path,input)=>input?.method==="PUT"?JSON.parse(input.body as string):{anidb_enabled:true,anidb_client:"saved_client",anidb_client_version:"2"});
 render(<QueryClientProvider client={new QueryClient()}><AniDBPlugin/></QueryClientProvider>);
 fireEvent.click(await screen.findByRole("button",{name:/AniDB Anime metadata/}));
 await waitFor(()=>expect(screen.getByLabelText("AniDB registered client name")).toHaveProperty("value","saved_client"));
 fireEvent.click(screen.getByRole("switch",{name:"Enable AniDB"}));
 await screen.findByText("Changes saved automatically");
 expect(apiRequest).toHaveBeenCalledWith("/native/providers/settings",{method:"PUT",body:JSON.stringify({anidb_enabled:false,anidb_client:"saved_client",anidb_client_version:"2"})});
});

it("does not save on hydration and automatically saves the first valid credentials",async()=>{
 vi.mocked(apiRequest).mockImplementation(async(_path,input)=>input?.method==="PUT"?JSON.parse(input.body as string):{anidb_enabled:true,anidb_client:"",anidb_client_version:""});
 render(<QueryClientProvider client={new QueryClient()}><AniDBPlugin/></QueryClientProvider>);
 fireEvent.click(await screen.findByRole("button",{name:/AniDB Anime metadata/}));
 await screen.findByLabelText("AniDB registered client name");
 expect(vi.mocked(apiRequest).mock.calls.some(([,input])=>input?.method==="PUT")).toBe(false);
 fireEvent.change(screen.getByLabelText("AniDB registered client name"),{target:{value:"client"}});
 fireEvent.change(screen.getByLabelText("AniDB client version"),{target:{value:"3"}});
 await screen.findByText("Changes saved automatically");
 expect(apiRequest).toHaveBeenCalledWith("/native/providers/settings",{method:"PUT",body:JSON.stringify({anidb_enabled:true,anidb_client:"client",anidb_client_version:"3"})});
});
