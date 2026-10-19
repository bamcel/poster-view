import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import {nativeLibraries,type NativeCatalogEntry} from "../api/nativeLibraries";
import BulkMetadataDialog from "./BulkMetadataDialog";

vi.mock("../api/nativeLibraries",()=>({nativeLibraries:{item:vi.fn(),editItem:vi.fn()}}));
afterEach(()=>{cleanup();vi.resetAllMocks();});
const entry=(id:string,metadata:Record<string,unknown>={},revision=9)=>({id,title:`Title ${id}`,metadata,revision} as NativeCatalogEntry);
function setup(ids=["a","b"]){const onSaved=vi.fn(),onClose=vi.fn();render(<BulkMetadataDialog libraryId="lib" itemIds={ids} onSaved={onSaved} onClose={onClose}/>);return {onSaved,onClose};}

it("fetches fresh revisions and merges only changed fields for unique targets",async()=>{
 vi.mocked(nativeLibraries.item).mockImplementation(async(_library,id)=>entry(id,{tags:["Existing","ADVENTURE"],genres:["Drama"],plot:"Preserved"}));
 vi.mocked(nativeLibraries.editItem).mockResolvedValue({entry:entry("a"),warnings:[]});
 const {onSaved}=setup(["a","a","b"]);
 expect(screen.getByText(/2 unique items selected/)).toBeTruthy();
 fireEvent.change(screen.getByLabelText("Tags to add"),{target:{value:"adventure, New\nNEW"}});
 fireEvent.change(screen.getByLabelText("Genres to add"),{target:{value:"drama"}});
 fireEvent.click(screen.getByRole("button",{name:"Apply"}));
 await waitFor(()=>expect(onSaved).toHaveBeenCalledOnce());
 expect(nativeLibraries.item).toHaveBeenCalledTimes(2);
 expect(nativeLibraries.editItem).toHaveBeenCalledTimes(2);
 expect(nativeLibraries.editItem).toHaveBeenCalledWith("lib",expect.objectContaining({id:"a",revision:9}),{tags:["Existing","ADVENTURE","New"]});
 expect(screen.getByText(/2 succeeded, 0 failed/)).toBeTruthy();
});

it("reports conflicts and warnings and retries only failed items against fresh metadata",async()=>{
 vi.mocked(nativeLibraries.item).mockImplementation(async(_library,id)=>entry(id,{tags:["Original"]},id==="b"?12:9));
 vi.mocked(nativeLibraries.editItem).mockResolvedValueOnce({entry:entry("a"),warnings:["Could not write NFO"]}).mockRejectedValueOnce(new Error("Revision conflict"));
 const {onSaved}=setup();
 fireEvent.change(screen.getByLabelText("Tags to add"),{target:{value:"New"}});
 fireEvent.click(screen.getByRole("button",{name:"Apply"}));
 await waitFor(()=>expect(onSaved).toHaveBeenCalledOnce());
 expect(screen.getByText(/Warning: Could not write NFO/)).toBeTruthy();
 expect(screen.getByText(/Failed: Revision conflict/)).toBeTruthy();
 vi.mocked(nativeLibraries.item).mockResolvedValueOnce(entry("b",{tags:["Original","Concurrent"]},15));
 vi.mocked(nativeLibraries.editItem).mockResolvedValueOnce({entry:entry("b"),warnings:[]});
 fireEvent.click(screen.getByRole("button",{name:"Retry failed items (1)"}));
 await waitFor(()=>expect(onSaved).toHaveBeenCalledTimes(2));
 expect(nativeLibraries.item).toHaveBeenCalledTimes(3);
 expect(nativeLibraries.editItem).toHaveBeenLastCalledWith("lib",expect.objectContaining({id:"b",revision:15}),{tags:["Original","Concurrent","New"]});
 expect(screen.queryByText(/Failed: Revision conflict/)).toBeNull();
});

it("does not submit blank input or rewrite unchanged values",async()=>{
 const {onSaved}=setup(["a"]);
 fireEvent.change(screen.getByLabelText("Tags to add"),{target:{value:" ,\n "}});
 expect((screen.getByRole("button",{name:"Apply"}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByRole("button",{name:"Apply"}));
 expect(nativeLibraries.item).not.toHaveBeenCalled();
 vi.mocked(nativeLibraries.item).mockResolvedValue(entry("a",{tags:["Test"]}));
 fireEvent.change(screen.getByLabelText("Tags to add"),{target:{value:"test"}});
 fireEvent.click(screen.getByRole("button",{name:"Apply"}));
 await waitFor(()=>expect(onSaved).toHaveBeenCalledOnce());
 expect(nativeLibraries.editItem).not.toHaveBeenCalled();
 expect(screen.getByText(/Already contains these values/)).toBeTruthy();
});

it("prevents dismissal while a write is pending",async()=>{
 let finish!:(value:NativeCatalogEntry)=>void;
 vi.mocked(nativeLibraries.item).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 const {onClose,onSaved}=setup(["a"]);
 fireEvent.change(screen.getByLabelText("Tags to add"),{target:{value:"test"}});
 fireEvent.click(screen.getByRole("button",{name:"Apply"}));
 fireEvent.keyDown(screen.getByRole("dialog"),{key:"Escape"});
 fireEvent.click(screen.getByRole("button",{name:"Cancel"}));
 expect(onClose).not.toHaveBeenCalled();
 finish(entry("a",{tags:["test"]}));
 await waitFor(()=>expect(onSaved).toHaveBeenCalledOnce());
 fireEvent.click(screen.getByRole("button",{name:"Done"}));
 expect(onClose).toHaveBeenCalledOnce();
});
