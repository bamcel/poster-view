import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {afterEach, expect, it, vi} from "vitest";
import PosterEdit from "./PosterEdit";
import {nativeLibraries, type NativeCatalogEntry} from "../api/nativeLibraries";
import {api} from "../api/client";
vi.mock("../api/client",()=>({api:{applyUpload:vi.fn()}}));
vi.mock("../api/nativeLibraries",()=>({nativeLibraries:{catalog:vi.fn(),editItem:vi.fn(),upload:vi.fn()}}));
vi.mock("../lib/toast",()=>({useToast:()=>({push:vi.fn()})}));
afterEach(()=>{cleanup();vi.clearAllMocks();vi.restoreAllMocks();vi.unstubAllGlobals();});
function show(poster="/poster.png",logo:string|undefined="/logo.png",native=false) {
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 return render(<QueryClientProvider client={client}><PosterEdit serverId={native?0:1} item={{id:native?"native:library:series":"series",title:"Series",type:"show",poster,logo,seasons:[],members:[],external_ids:{}}}/></QueryClientProvider>);
}
it("positions and resizes the logo without altering the poster preview",()=>{
 show();
 fireEvent.change(screen.getByRole("slider",{name:"Logo size"}),{target:{value:"40"}});
 fireEvent.click(screen.getByRole("button",{name:"Center"}));
 const logo=screen.getByAltText("Drag series logo");
 expect(logo.style.width).toBe("40%");expect(logo.style.left).toBe("30%");
 fireEvent.click(screen.getByRole("checkbox",{name:"Display logo"}));
 expect(screen.queryByAltText("Drag series logo")).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"Reset"}));
 expect(screen.getByAltText("Drag series logo").style.width).toBe("70%");
});
it("downloads and applies a new poster through the normal artwork replacement workflow",async()=>{
 const drawImage=vi.fn();let downloaded="";
 vi.stubGlobal("Image",class {naturalWidth=1000;naturalHeight=1500;onload?:()=>void;set src(_value:string){queueMicrotask(()=>this.onload?.());}});
 vi.stubGlobal("URL",class extends URL {static createObjectURL(){return "blob:poster";}static revokeObjectURL(){}});
 vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockReturnValue({drawImage,globalAlpha:1} as unknown as CanvasRenderingContext2D);
 vi.spyOn(HTMLCanvasElement.prototype,"toBlob").mockImplementation(callback=>callback(new Blob(["poster"],{type:"image/png"})));
 vi.spyOn(HTMLAnchorElement.prototype,"click").mockImplementation(function(this: HTMLAnchorElement){downloaded=this.download;});
 vi.mocked(api.applyUpload).mockResolvedValue({ok:true,message:"Saved"});
 show();fireEvent.click(screen.getByRole("button",{name:"Download"}));
 await waitFor(()=>expect(downloaded).toBe("Series-poster.png"));
 expect(drawImage).toHaveBeenCalledTimes(2);
 expect(api.applyUpload).toHaveBeenCalledWith(expect.objectContaining({server_id:1,item_id:"series",target:"poster",file:expect.any(File)}));expect(nativeLibraries.upload).not.toHaveBeenCalled();
});
it("applies native downloads and marks the logo as already combined",async()=>{
 const entry={id:"series",revision:1,title:"Series",metadata:{},artwork:[{kind:"poster",path:"poster.jpg",source:"local"}]} as NativeCatalogEntry;
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([entry]);
 vi.mocked(nativeLibraries.editItem).mockResolvedValue({entry,warnings:[]});
 vi.mocked(nativeLibraries.upload).mockResolvedValue();
 vi.mocked(api.applyUpload).mockResolvedValue({ok:true,message:"Saved in database and media folder"});
 vi.stubGlobal("Image",class {naturalWidth=1000;naturalHeight=1500;onload?:()=>void;set src(_value:string){queueMicrotask(()=>this.onload?.());}});
 vi.stubGlobal("URL",class extends URL {static createObjectURL(){return "blob:poster";}static revokeObjectURL(){}});
 vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockReturnValue({drawImage:vi.fn(),globalAlpha:1} as unknown as CanvasRenderingContext2D);
 vi.spyOn(HTMLCanvasElement.prototype,"toBlob").mockImplementation(callback=>callback(new Blob(["poster"],{type:"image/png"})));
 vi.spyOn(HTMLAnchorElement.prototype,"click").mockImplementation(()=>{});
 show("/poster.png","/logo.png",true);
 await waitFor(()=>expect((screen.getByRole("button",{name:"Download"}) as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(screen.getByRole("button",{name:"Download"}));
 await waitFor(()=>expect(nativeLibraries.editItem).toHaveBeenCalledWith("library",entry,{posteredit:expect.objectContaining({mode:"flattened",poster_path:"poster.jpg"}),poseredit:null}));
 expect(api.applyUpload).toHaveBeenCalledWith(expect.objectContaining({server_id:0,item_id:"native:library:series",target:"poster"}));
 expect(nativeLibraries.upload).toHaveBeenCalledWith("library","series","poster-edit-original",expect.any(File));
});
it("saves only overlay placement in the native database",async()=>{
 const entry={id:"series",revision:1,title:"Series",metadata:{},artwork:[{kind:"poster",path:"poster.jpg",source:"local"}]} as NativeCatalogEntry;
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([entry]);
 vi.mocked(nativeLibraries.editItem).mockResolvedValue({entry,warnings:[]});
 show("/poster.png","/logo.png",true);
 await waitFor(()=>expect((screen.getByRole("button",{name:"Save Overlay"}) as HTMLButtonElement).disabled).toBe(false));
 fireEvent.change(screen.getByRole("slider",{name:"Logo size"}),{target:{value:"50"}});
 fireEvent.click(screen.getByRole("button",{name:"Save Overlay"}));
 await waitFor(()=>expect(nativeLibraries.editItem).toHaveBeenCalledWith("library",entry,{posteredit:expect.objectContaining({mode:"overlay",width:50,poster_path:"poster.jpg"}),poseredit:null}));
 expect(api.applyUpload).not.toHaveBeenCalled();expect(nativeLibraries.upload).not.toHaveBeenCalled();
});
it("explains missing logo before allowing editing",()=>{show("/poster.png","");expect(screen.getByText(/Add a poster and a series logo/)).toBeTruthy();expect(screen.queryByRole("button",{name:"Save Overlay"})).toBeNull();});
