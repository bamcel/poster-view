import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import FolderBrowser from "./FolderBrowser";
import {nativeLibraries} from "../api/nativeLibraries";
vi.mock("../api/nativeLibraries",()=>({nativeLibraries:{folders:vi.fn()}}));
beforeEach(()=>{
 HTMLDialogElement.prototype.showModal=vi.fn(function(this:HTMLDialogElement){this.setAttribute("open","");});
 vi.mocked(nativeLibraries.folders).mockImplementation(async path=>({root:"/media",path,folders:path?[]:[{name:"YouTube",path:"youtube",has_nfo:false}]}));
});
afterEach(()=>{cleanup();vi.clearAllMocks();});
function mount(multiple=false){const select=vi.fn(),close=vi.fn();render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><FolderBrowser initial="" onClose={close} onSelect={select} onSelectMany={multiple?select:undefined}/></QueryClientProvider>);return {select,close};}
it("single-click selects a folder without navigating and confirms that selection",async()=>{
 const {select}=mount();
 fireEvent.click(await screen.findByRole("button",{name:"Open folder YouTube"}));
 expect(nativeLibraries.folders).not.toHaveBeenCalledWith("youtube");
 expect(screen.getByRole("row",{name:/YouTube/}).getAttribute("aria-selected")).toBe("true");
 fireEvent.click(screen.getByRole("button",{name:"Select This Folder"}));
 expect(select).toHaveBeenCalledWith("youtube");
});
it("double-click opens the folder without adding it to multi-selection",async()=>{
 const {select}=mount(true);
 const row=await screen.findByRole("button",{name:"Open folder YouTube"});
 fireEvent.click(row);fireEvent.click(row);fireEvent.doubleClick(row);
 await waitFor(()=>expect(nativeLibraries.folders).toHaveBeenCalledWith("youtube"));
 expect(select).not.toHaveBeenCalled();
 expect(screen.getByText("0 selected")).toBeTruthy();
});
it("right-click selects the clicked folder and Escape dismisses only the menu",async()=>{
 const {select,close}=mount();
 fireEvent.contextMenu(await screen.findByRole("button",{name:"Open folder YouTube"}),{clientX:40,clientY:80});
 fireEvent.keyDown(screen.getByRole("menu"),{key:"Escape"});
 expect(screen.queryByRole("menu")).toBeNull();expect(close).not.toHaveBeenCalled();
 fireEvent.contextMenu(screen.getByRole("button",{name:"Open folder YouTube"}));
 fireEvent.click(screen.getByRole("menuitem",{name:"Select This Folder"}));
 expect(select).toHaveBeenCalledWith("youtube");
});
it("right-click on empty space can select the directory being browsed",async()=>{
 const {select}=mount();
 fireEvent.doubleClick(await screen.findByRole("button",{name:"Open folder YouTube"}));
 fireEvent.contextMenu(await screen.findByText("No subfolders. You can select this folder."));
 fireEvent.click(screen.getByRole("menuitem",{name:"Select This Folder"}));
 expect(select).toHaveBeenCalledWith("youtube");
});
