vi.mock("./AnimatedArtwork",()=>({default:({alt}:{alt:string})=><img alt={alt}/>}));
import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import NativeCatalogPanel, {EntryEditor} from "./NativeCatalogPanel";
import {nativeLibraries,type NativeLibrary,type NativeCatalogEntry} from "../api/nativeLibraries";
vi.mock("../api/nativeLibraries",async original=>({...await original<typeof import("../api/nativeLibraries")>(),nativeLibraries:{status:vi.fn(),catalog:vi.fn(),scan:vi.fn(),remove:vi.fn(),editItem:vi.fn(),upload:vi.fn(),removeVariant:vi.fn(async()=>undefined),artworkUrl:vi.fn()}}));
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
it("saves metadata using the catalog revision",async()=>{mount();fireEvent.click(await screen.findByRole("button",{name:/Example/}));fireEvent.change(screen.getByLabelText("Title"),{target:{value:"Manual Title"}});fireEvent.click(screen.getByRole("button",{name:"Save metadata"}));await waitFor(()=>expect(nativeLibraries.editItem).toHaveBeenCalledWith("native",item,{title:"Manual Title"}));});
it("keeps scan notices visible and disables destructive actions during a scan",async()=>{vi.mocked(nativeLibraries.status).mockResolvedValue({status:"scanning",count:1,warnings:["Title needs review"]});mount();await screen.findByText("Title needs review");expect((screen.getByRole("button",{name:"Delete library"}) as HTMLButtonElement).disabled).toBe(true);expect((screen.getByRole("button",{name:"Scanning…"}) as HTMLButtonElement).disabled).toBe(true);});

it("hides unavailable scan exclusions in browsing and search",async()=>{
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([item,{...item,id:"credits",title:"NCOP",path:"Anime/NCOP.mkv",available:false}]);
 mount();await screen.findByRole("button",{name:/Example/});
 expect(screen.queryByRole("button",{name:/NCOP/})).toBeNull();
 fireEvent.change(screen.getByLabelText("Search catalog"),{target:{value:"NCOP"}});
 expect(screen.queryByRole("button",{name:/NCOP/})).toBeNull();
 expect(screen.getByText(/No matching items/)).toBeTruthy();
});

it("offers icon deletion for every artwork preview",async()=>{
 const saved=vi.fn();
 const confirm=vi.spyOn(window,"confirm").mockReturnValue(true);
 const entry={...item,artwork:[{kind:"poster",path:"poster.jpg",source:"local"},{kind:"poster-animated",path:"poster.gif",source:"manual"},{kind:"poster-edit-original",path:"@managed/original.jpg",source:"manual"}]};
 render(<QueryClientProvider client={new QueryClient()}><EntryEditor library={library} entry={entry} busy={false} onSaved={saved}/></QueryClientProvider>);
 expect(screen.queryByText("Remove animation")).toBeNull();
 for(const art of entry.artwork)expect(screen.getByRole("button",{name:`Delete ${art.kind} artwork`})).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Delete poster artwork"}));
 await waitFor(()=>expect(nativeLibraries.removeVariant).toHaveBeenCalledWith("native","series","poster"));
 await waitFor(()=>expect(saved).toHaveBeenCalled());
 confirm.mockRestore();
});
const special:NativeCatalogEntry={...item,id:"special",kind:"episode",metadata:{title:"Special",season:0,episode:1,airs_before_season:2,airs_before_episode:5}};
function mountSpecial(entry=special,lib=library){return render(<QueryClientProvider client={new QueryClient()}><EntryEditor library={lib} entry={entry} busy={false} onSaved={vi.fn()}/></QueryClientProvider>);}
it("edits special placement using numeric changes without changing season zero",async()=>{
 mountSpecial();fireEvent.change(screen.getByLabelText("Airs before episode"),{target:{value:"6"}});fireEvent.click(screen.getByRole("button",{name:"Save metadata"}));
 await waitFor(()=>expect(nativeLibraries.editItem).toHaveBeenCalledWith("native",special,{airs_before_episode:6}));
});
it("keeps unchanged provider placement out of a manual metadata patch",async()=>{
 mountSpecial();fireEvent.change(screen.getByLabelText("Title"),{target:{value:"Updated special"}});fireEvent.click(screen.getByRole("button",{name:"Save metadata"}));
 await waitFor(()=>expect(nativeLibraries.editItem).toHaveBeenCalledWith("native",special,{title:"Updated special"}));
});
it("clears existing special placement as null and supports after-season placement",async()=>{
 mountSpecial();fireEvent.change(screen.getByLabelText("Airs during season"),{target:{value:""}});
 expect((screen.getByRole("button",{name:"Save metadata"}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.change(screen.getByLabelText("Airs before episode"),{target:{value:""}});fireEvent.change(screen.getByLabelText("Airs after season"),{target:{value:"2"}});fireEvent.click(screen.getByRole("button",{name:"Save metadata"}));
 await waitFor(()=>expect(nativeLibraries.editItem).toHaveBeenCalledWith("native",special,{airs_before_season:null,airs_before_episode:null,airs_after_season:2}));
});
it("rejects nonpositive, fractional, and conflicting special placement",()=>{
 mountSpecial();for(const value of ["0","-1","1.5"]){fireEvent.change(screen.getByLabelText("Airs during season"),{target:{value}});expect((screen.getByRole("button",{name:"Save metadata"}) as HTMLButtonElement).disabled).toBe(true);expect(screen.getByRole("alert").textContent).toContain("positive whole numbers");}
 fireEvent.change(screen.getByLabelText("Airs during season"),{target:{value:"2"}});fireEvent.change(screen.getByLabelText("Airs after season"),{target:{value:"2"}});
 expect((screen.getByRole("button",{name:"Save metadata"}) as HTMLButtonElement).disabled).toBe(true);expect(screen.getByRole("alert").textContent).toContain("Choose either");
});
it("limits special placement fields to season-zero show episodes",()=>{
 for(const [entry,lib] of [[{...special,metadata:{...special.metadata,season:1}},library],[{...special,kind:"series"},library],[special,{...library,library_type:"youtube"}]] as const){const view=mountSpecial(entry,lib);expect(screen.queryByLabelText("Airs during season")).toBeNull();expect(screen.queryByLabelText("airs before season")).toBeNull();view.unmount();}
});
