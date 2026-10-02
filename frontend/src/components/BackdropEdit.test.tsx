import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {afterEach,it,expect,vi} from "vitest";
import BackdropEdit from "./BackdropEdit";
import {nativeLibraries,type NativeCatalogEntry} from "../api/nativeLibraries";
import {connectedBackdropUrl,framingFromUrl} from "../lib/backdropFraming";
vi.mock("../api/nativeLibraries",()=>({nativeLibraries:{catalog:vi.fn(),editItem:vi.fn()}}));
vi.mock("../lib/toast",()=>({useToast:()=>({push:vi.fn()})}));
afterEach(()=>{cleanup();localStorage.clear();vi.clearAllMocks();});
function show(native=false){return render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><BackdropEdit serverId={native?0:1} item={{id:native?"native:library:item":"item",title:"Title",type:"show",background:"/backdrop.jpg",seasons:[],members:[],external_ids:{}}}/></QueryClientProvider>);}
it("saves and resets connected-item framing locally without changing artwork",async()=>{
 show();fireEvent.change(screen.getByRole("slider",{name:"Backdrop zoom"}),{target:{value:"140"}});
 fireEvent.change(screen.getByRole("slider",{name:"Backdrop horizontal position"}),{target:{value:"25"}});
 fireEvent.click(screen.getByRole("button",{name:"Save Adjustments"}));
 await waitFor(()=>expect(framingFromUrl(connectedBackdropUrl("/backdrop.jpg",1,"item")!)).toEqual({x:25,y:50,zoom:140,fit:"cover"}));
 expect(nativeLibraries.editItem).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole("button",{name:"Reset Adjustments"}));
 await waitFor(()=>expect(localStorage.getItem("posterview.backdropEdit.1.item")).toBeNull());
});
it("persists native framing as enhanced metadata",async()=>{
 const entry:NativeCatalogEntry={id:"item",path:"Title",kind:"series",parent_path:null,title:"Title",metadata:{},artwork:[],files:[],nfo_path:null,available:true,revision:1};
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([entry]);vi.mocked(nativeLibraries.editItem).mockResolvedValue({entry,warnings:[]});
 show(true);await waitFor(()=>expect((screen.getByRole("button",{name:"Save Adjustments"}) as HTMLButtonElement).disabled).toBe(false));
 fireEvent.change(screen.getByRole("combobox",{name:"Backdrop fit"}),{target:{value:"contain"}});
 fireEvent.click(screen.getByRole("button",{name:"Save Adjustments"}));
 await waitFor(()=>expect(nativeLibraries.editItem).toHaveBeenCalledWith("library",entry,{backdropedit:{x:50,y:50,zoom:100,fit:"contain"}}));
});
