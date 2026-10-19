import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {afterEach,it,expect,vi} from "vitest";
import BackdropEdit from "./BackdropEdit";
import {nativeLibraries,type NativeCatalogEntry} from "../../api/nativeLibraries";
import {connectedBackdropUrl,framingFromUrl} from "../../lib/backdropFraming";
vi.mock("../../api/nativeLibraries",()=>({nativeLibraries:{catalog:vi.fn(),item:vi.fn(),editItem:vi.fn()}}));
vi.mock("../../lib/toast",()=>({useToast:()=>({push:vi.fn()})}));
afterEach(()=>{cleanup();localStorage.clear();vi.clearAllMocks();});
function show(native=false,logo=false,client=new QueryClient({defaultOptions:{queries:{retry:false}}})){return render(<QueryClientProvider client={client}><BackdropEdit serverId={native?0:1} item={{id:native?"native:library:item":"item",title:"Title",type:"show",background:"/backdrop.jpg",logo:logo?"/api/native/libraries/library/items/item/artwork/logo":undefined,seasons:[],members:[],external_ids:{}}}/></QueryClientProvider>);}
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
 const fresh={...entry,revision:9};
 vi.mocked(nativeLibraries.item).mockResolvedValue(fresh).mockResolvedValueOnce(entry);vi.mocked(nativeLibraries.editItem).mockResolvedValue({entry,warnings:[]});
 show(true);await waitFor(()=>expect((screen.getByRole("button",{name:"Save Adjustments"}) as HTMLButtonElement).disabled).toBe(false));
 fireEvent.change(screen.getByRole("combobox",{name:"Backdrop fit"}),{target:{value:"contain"}});
 fireEvent.click(screen.getByRole("button",{name:"Save Adjustments"}));
 await waitFor(()=>expect(nativeLibraries.editItem).toHaveBeenCalledWith("library",fresh,{backdropedit:{x:50,y:50,zoom:100,fit:"contain"}}));
 expect(nativeLibraries.catalog).not.toHaveBeenCalled();
 expect(nativeLibraries.item).toHaveBeenCalledWith("library","item");
 fireEvent.click(screen.getByRole("button",{name:"Reset Adjustments"}));
 await waitFor(()=>expect(nativeLibraries.editItem).toHaveBeenCalledWith("library",fresh,{backdropedit:null}));
});

it("saves logo placement alongside framing without replacing backdrop artwork",async()=>{
 const entry:NativeCatalogEntry={id:"item",path:"Title",kind:"series",parent_path:null,title:"Title",metadata:{},artwork:[],files:[],nfo_path:null,available:true,revision:1};
 vi.mocked(nativeLibraries.item).mockResolvedValue(entry);vi.mocked(nativeLibraries.editItem).mockResolvedValue({entry,warnings:[]});
 show(true,true);await waitFor(()=>expect((screen.getByRole("button",{name:"Save Adjustments"}) as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(screen.getByRole("checkbox",{name:"Display backdrop logo"}));
 expect(screen.getByRole("img",{name:"Drag backdrop logo"})).toBeTruthy();
 fireEvent.change(screen.getByRole("slider",{name:"Logo width"}),{target:{value:"45"}});
 fireEvent.change(screen.getByRole("slider",{name:"Logo opacity"}),{target:{value:"80"}});
 fireEvent.click(screen.getByRole("button",{name:"Save Adjustments"}));
 await waitFor(()=>expect(nativeLibraries.editItem).toHaveBeenCalledWith("library",entry,{backdropedit:{x:50,y:50,zoom:100,fit:"cover",logo:{src:"/api/native/libraries/library/items/item/artwork/logo",enabled:true,x:15,y:72,width:45,opacity:80}}}));
});

it("keeps single-item and existing catalog caches in their own shapes",async()=>{
 const entry:NativeCatalogEntry={id:"item",path:"Title",kind:"series",parent_path:null,title:"Title",metadata:{},artwork:[],files:[],nfo_path:null,available:true,revision:1};
 const other={...entry,id:"other"};
 const result={...entry,revision:2,metadata:{backdropedit:{x:50,y:50,zoom:100,fit:"cover"}}};
 vi.mocked(nativeLibraries.item).mockResolvedValue(entry);
 vi.mocked(nativeLibraries.editItem).mockImplementation(async()=>{vi.mocked(nativeLibraries.item).mockResolvedValue(result);return {entry:result,warnings:[]};});
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 client.setQueryData(["native-catalog","library"],[entry,other]);
 show(true,false,client);
 await waitFor(()=>expect((screen.getByRole("button",{name:"Save Adjustments"}) as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(screen.getByRole("button",{name:"Save Adjustments"}));
 await waitFor(()=>expect(client.getQueryData(["native-catalog","library","item","item"])).toEqual(result));
 expect(client.getQueryData(["native-catalog","library"])).toEqual([result,other]);
 expect(nativeLibraries.catalog).not.toHaveBeenCalled();
});
