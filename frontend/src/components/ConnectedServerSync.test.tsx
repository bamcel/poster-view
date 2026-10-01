import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {afterEach,expect,it,vi} from "vitest";
import ConnectedServerSync,{SyncActions} from "./ConnectedServerSync";
import {defaultServerSync,nativeLibraries} from "../api/nativeLibraries";
import {api} from "../api/client";
vi.mock("../api/client",()=>({api:{listServers:vi.fn(),getLibraries:vi.fn()}}));
vi.mock("../api/nativeLibraries",async original=>({...await original<typeof import("../api/nativeLibraries")>(),nativeLibraries:{syncStatus:vi.fn(),sync:vi.fn(),catalog:vi.fn()}}));
function mount(component:React.ReactNode){return render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}>{component}</QueryClientProvider>);}
afterEach(()=>{cleanup();vi.clearAllMocks();});
it("defaults outgoing pushes to all servers and allows individual destinations",async()=>{
 vi.mocked(api.listServers).mockResolvedValue([{id:1,name:"Emby",type:"emby"},{id:2,name:"Jellyfin",type:"jellyfin"}] as never);
 vi.mocked(api.getLibraries).mockResolvedValue([]);
 const update=vi.fn();mount(<ConnectedServerSync value={{...defaultServerSync,server_id:1}} onChange={update}/>);
 expect(defaultServerSync.enabled).toBe(false);expect(defaultServerSync.push_to_all).toBe(true);
 await screen.findByRole("option",{name:"Jellyfin"});
 fireEvent.click(screen.getByRole("switch",{name:"Push changes to all connected servers"}));
 expect(update).toHaveBeenCalledWith(expect.objectContaining({push_to_all:false,server_id:1}));
});
it("imports all shared fields by default with optional lock override and NFO writing",async()=>{
 vi.mocked(nativeLibraries.syncStatus).mockResolvedValue({enabled:true,status:"synced",pending:0,matched:1,unmatched:0,failed:0,notices:[],activity:[]} as never);
 vi.mocked(nativeLibraries.sync).mockResolvedValue({} as never);
 mount(<SyncActions library="anime"/>);
 fireEvent.click(await screen.findByRole("button",{name:"Import metadata"}));
 await waitFor(()=>expect((screen.getByRole("button",{name:"Import metadata"}) as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(screen.getByRole("button",{name:"Import metadata"}));
 const checkboxes=screen.getAllByRole("checkbox");expect(checkboxes.length).toBe(18);for(const box of checkboxes)expect((box as HTMLInputElement).checked).toBe(true);
 fireEvent.click(screen.getByRole("checkbox",{name:"Provider IDs"}));
 fireEvent.click(screen.getByRole("button",{name:"Import selected fields"}));
 await waitFor(()=>expect(nativeLibraries.sync).toHaveBeenCalledWith("anime",expect.objectContaining({override_locked:false,write_nfo:false,fields:expect.not.arrayContaining(["identifiers"])})));
});
