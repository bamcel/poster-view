import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {afterEach,it,expect,vi} from "vitest";
import {defaultNativeOptions,nativeLibraries,type NativeLibrary} from "../api/nativeLibraries";
import ServerConnectLibraries from "./ServerConnectLibraries";
vi.mock("../api/nativeLibraries",async original=>({...await original<typeof import("../api/nativeLibraries")>(),nativeLibraries:{list:vi.fn(),save:vi.fn()}}));
vi.mock("./ConnectedServerSync",()=>({default:({value,onChange,library}:{value:object;onChange:(v:object)=>void;library?:string})=><><button onClick={()=>onChange({...value,enabled:true,server_id:1,library_id:"remote"})}>Connect server</button>{library&&<span>Saved actions available</span>}</>}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
it("excludes books and preserves library settings when saving a connection",async()=>{
 const library:NativeLibrary={id:"anime",name:"Anime",library_type:"anime",anime_content:"both",paths:["Anime"],revision:3,created_at:"",updated_at:"",options:{...defaultNativeOptions,save_nfo:true}};
 vi.mocked(nativeLibraries.list).mockResolvedValue([library,{...library,id:"book",name:"Books",library_type:"books"}]);
 vi.mocked(nativeLibraries.save).mockResolvedValue(library);
 render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><ServerConnectLibraries enabled/></QueryClientProvider>);
 await screen.findByRole("option",{name:"Anime"});expect(screen.queryByRole("option",{name:"Books"})).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"Connect server"}));expect(screen.queryByText("Saved actions available")).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"Save connection"}));
 await waitFor(()=>expect(nativeLibraries.save).toHaveBeenCalledWith(expect.objectContaining({revision:3,paths:["Anime"],options:expect.objectContaining({save_nfo:true,server_sync:expect.objectContaining({enabled:true,server_id:1,library_id:"remote"})})}),"anime"));
});
