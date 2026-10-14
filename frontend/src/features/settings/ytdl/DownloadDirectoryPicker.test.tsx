import {cleanup,fireEvent,render,screen,waitFor,within} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import DownloadDirectoryPicker from "./DownloadDirectoryPicker";
import {nativeLibraries} from "../../../api/nativeLibraries";
vi.mock("../../../api/nativeLibraries",()=>({nativeLibraries:{folders:vi.fn()}}));
beforeEach(()=>{vi.mocked(nativeLibraries.folders).mockImplementation(async path=>({root:"/media",path,folders:path==="youtube"?[{name:"Channels",path:"youtube/Channels",has_nfo:false},{name:"Playlists",path:"youtube/Playlists",has_nfo:false}]:[]}));});
afterEach(()=>{cleanup();vi.clearAllMocks();});
function mount(){const change=vi.fn();render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><DownloadDirectoryPicker value="youtube" onChange={change}/></QueryClientProvider>);return change;}
it("filters folders and confirms a nested destination without selecting during navigation",async()=>{
 const change=mount();expect(nativeLibraries.folders).not.toHaveBeenCalled();fireEvent.click(screen.getByLabelText("Download directory"));await screen.findByRole("button",{name:"Open folder Channels"});
 fireEvent.change(screen.getByLabelText("Search folders"),{target:{value:"play"}});expect(screen.queryByRole("button",{name:"Open folder Channels"})).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"Open folder Playlists"}));await screen.findByText("No subfolders. You can select this folder.");expect(change).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole("button",{name:"Use this folder"}));expect(change).toHaveBeenCalledWith("youtube/Playlists");expect(screen.getByLabelText("Download directory").getAttribute("aria-expanded")).toBe("false");
});
it("navigates to the media root through breadcrumbs and selects it",async()=>{
 const change=mount();fireEvent.click(screen.getByLabelText("Download directory"));await screen.findByRole("button",{name:"Open folder Channels"});
 fireEvent.click(within(screen.getByRole("navigation",{name:"Directory breadcrumbs"})).getByRole("button",{name:"/media"}));await waitFor(()=>expect(nativeLibraries.folders).toHaveBeenCalledWith(""));await screen.findByText("No subfolders. You can select this folder.");
 fireEvent.click(screen.getByRole("button",{name:"Use this folder"}));expect(change).toHaveBeenCalledWith("");
});
it("keeps confirmation disabled when folder loading fails",async()=>{
 vi.mocked(nativeLibraries.folders).mockRejectedValue(new Error("Folder unavailable"));mount();fireEvent.click(screen.getByLabelText("Download directory"));await screen.findByRole("alert");expect((screen.getByRole("button",{name:"Use this folder"}) as HTMLButtonElement).disabled).toBe(true);
});
