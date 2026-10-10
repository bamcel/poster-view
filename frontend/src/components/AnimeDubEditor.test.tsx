import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import AnimeDubEditor from "./AnimeDubEditor";
import {nativeLibraries,type NativeLibrary,type NativeCatalogEntry} from "../api/nativeLibraries";
vi.mock("../api/nativeLibraries",()=>({nativeLibraries:{editItem:vi.fn()}}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
it("saves manual dub corrections without changing the actor credit",async()=>{
 const entry={id:"item",revision:2,metadata:{voice_cast:[{name:"Hilary",role:"Satsuki",language:"English",provider_id:123,dub_group:null}]}} as unknown as NativeCatalogEntry;
 vi.mocked(nativeLibraries.editItem).mockResolvedValue({entry,warnings:[]});const saved=vi.fn();
 render(<AnimeDubEditor library={{id:"anime",library_type:"anime"} as NativeLibrary} entry={entry} onSaved={saved}/>);
 fireEvent.change(screen.getByLabelText("Dub edition for Hilary as Satsuki"),{target:{value:"ADV Films"}});
 fireEvent.change(screen.getByLabelText("Role notes for Hilary as Satsuki"),{target:{value:"Original release"}});
 fireEvent.click(screen.getByRole("button",{name:"Save dub credits"}));
 await waitFor(()=>expect(saved).toHaveBeenCalledOnce());
 expect(nativeLibraries.editItem).toHaveBeenCalledWith("anime",entry,{voice_cast:[{name:"Hilary",role:"Satsuki",language:"English",provider_id:123,dub_group:"ADV Films",role_notes:"Original release"}]});
});
