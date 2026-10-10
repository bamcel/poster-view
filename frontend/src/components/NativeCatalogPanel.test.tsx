import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import NativeCatalogPanel, {EntryEditor} from "./NativeCatalogPanel";
import {nativeLibraries,type NativeLibrary,type NativeCatalogEntry} from "../api/nativeLibraries";
vi.mock("../api/nativeLibraries",async original=>({...await original<typeof import("../api/nativeLibraries")>(),nativeLibraries:{status:vi.fn(),catalog:vi.fn(),scan:vi.fn(),remove:vi.fn(),editItem:vi.fn(),upload:vi.fn(),artworkUrl:vi.fn()}}));
const library:NativeLibrary={id:"native",name:"Anime",library_type:"anime",anime_content:"both",paths:["Anime"],revision:2,created_at:"",updated_at:""};
const item:NativeCatalogEntry={id:"series",path:"Anime/Example",kind:"series",title:"Example",parent_path:null,metadata:{title:"Example",genres:["Action"]},artwork:[],files:[],nfo_path:null,available:true,revision:4};
const mount=()=>render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><NativeCatalogPanel library={library} onClose={vi.fn()} onDeleted={deleted}/></QueryClientProvider>);
const deleted=vi.fn();
beforeEach(()=>{vi.mocked(nativeLibraries.status).mockResolvedValue({status:"complete",count:1,warnings:[]});vi.mocked(nativeLibraries.catalog).mockResolvedValue([item]);vi.mocked(nativeLibraries.scan).mockResolvedValue(undefined);vi.mocked(nativeLibraries.remove).mockResolvedValue(undefined);vi.mocked(nativeLibraries.editItem).mockResolvedValue({entry:item,warnings:[]});});
afterEach(()=>{cleanup();vi.clearAllMocks();});
it("only shows video provider ID fields in non-anime video libraries",()=>{
 render(<QueryClientProvider client={new QueryClient()}><EntryEditor library={{...library,library_type:"shows"}} entry={item} busy={false} onSaved={vi.fn()}/></QueryClientProvider>);
 expect(screen.getByLabelText("TheTVDB ID")).toBeTruthy();
 expect(screen.getByLabelText("IMDb ID")).toBeTruthy();
 expect(screen.queryByLabelText("AniList ID")).toBeNull();
 expect(screen.queryByLabelText("MyAnimeList ID")).toBeNull();
 expect(screen.queryByLabelText("AniDB ID")).toBeNull();
});
it("scans manually and requires confirmation before deleting catalog records",async()=>{mount();await screen.findByRole("button",{name:/Example/});fireEvent.click(screen.getByRole("button",{name:"Scan library"}));await waitFor(()=>expect(nativeLibraries.scan).toHaveBeenCalledWith("native"));fireEvent.click(screen.getByRole("button",{name:"Delete library"}));expect(nativeLibraries.remove).not.toHaveBeenCalled();expect(screen.getByText(/Media, NFO files, and local artwork stay on disk/)).toBeTruthy();fireEvent.click(screen.getByRole("button",{name:"Cancel"}));expect(nativeLibraries.remove).not.toHaveBeenCalled();fireEvent.click(screen.getByRole("button",{name:"Delete library"}));fireEvent.click(screen.getByRole("alertdialog").querySelectorAll("button")[1]);await waitFor(()=>expect(nativeLibraries.remove).toHaveBeenCalledWith("native",2));expect(deleted).toHaveBeenCalled();});
it("saves metadata using the catalog revision",async()=>{mount();fireEvent.click(await screen.findByRole("button",{name:/Example/}));fireEvent.change(screen.getByLabelText("Title"),{target:{value:"Manual Title"}});fireEvent.click(screen.getByRole("button",{name:"Save metadata"}));await waitFor(()=>expect(nativeLibraries.editItem).toHaveBeenCalledWith("native",item,expect.objectContaining({title:"Manual Title",genres:["Action"]})));});
it("keeps scan notices visible and disables destructive actions during a scan",async()=>{vi.mocked(nativeLibraries.status).mockResolvedValue({status:"scanning",count:1,warnings:["Title needs review"]});mount();await screen.findByText("Title needs review");expect((screen.getByRole("button",{name:"Delete library"}) as HTMLButtonElement).disabled).toBe(true);expect((screen.getByRole("button",{name:"Scanning…"}) as HTMLButtonElement).disabled).toBe(true);});

it("hides unavailable scan exclusions in browsing and search",async()=>{
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([item,{...item,id:"credits",title:"NCOP",path:"Anime/NCOP.mkv",available:false}]);
 mount();await screen.findByRole("button",{name:/Example/});
 expect(screen.queryByRole("button",{name:/NCOP/})).toBeNull();
 fireEvent.change(screen.getByLabelText("Search catalog"),{target:{value:"NCOP"}});
 expect(screen.queryByRole("button",{name:/NCOP/})).toBeNull();
 expect(screen.getByText(/No matching items/)).toBeTruthy();
});
