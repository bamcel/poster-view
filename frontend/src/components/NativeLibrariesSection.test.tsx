import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {api} from "../api/client";
import {useServerConnectPlugin} from "../lib/serverConnectPlugin";
vi.mock("../api/client",()=>({api:{listServers:vi.fn()}}));
vi.mock("../lib/serverConnectPlugin",()=>({useServerConnectPlugin:vi.fn(),SERVER_CONNECT_AVAILABLE:false}));
import NativeLibrariesSection, { LibraryDialog } from "./NativeLibrariesSection";
import { defaultNativeOptions, nativeLibraries, type NativeLibrary } from "../api/nativeLibraries";

vi.mock("../api/nativeLibraries", async importOriginal => ({...(await importOriginal<typeof import("../api/nativeLibraries")>()), nativeLibraries: { list: vi.fn(), save: vi.fn(), folders: vi.fn(), status: vi.fn(), catalog: vi.fn(), previews: vi.fn(), scan: vi.fn(), refresh:vi.fn(), remove: vi.fn() } }));
const saved: NativeLibrary = { id: "library", name: "Anime", library_type: "anime", anime_content: "both", paths: ["Shows", "Movies"], revision: 1, created_at: "", updated_at: "" };
function mount(component: React.ReactNode) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{component}</QueryClientProvider>);
}
beforeEach(() => {
  vi.mocked(useServerConnectPlugin).mockReturnValue({data:{enabled:false,pinned:false}} as ReturnType<typeof useServerConnectPlugin>);
  vi.mocked(api.listServers).mockResolvedValue([]);
  vi.mocked(nativeLibraries.list).mockResolvedValue([]);
  vi.mocked(nativeLibraries.previews).mockResolvedValue([]);
  vi.mocked(nativeLibraries.save).mockResolvedValue(saved);
  vi.mocked(nativeLibraries.folders).mockImplementation(async path => ({ root: "/media", path, folders: path ? [{ name: "Season 1", path: `${path}/Season 1`, has_nfo: false }] : [{ name: "Shows", path: "Shows", has_nfo: false }, { name: "Movies", path: "Movies", has_nfo: false }] }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("creates an Anime library with multiple media folders and no remote-server import", async () => {
  mount(<NativeLibrariesSection />);
  fireEvent.click(screen.getByRole("button", { name: "New Library" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Anime" } });
  fireEvent.change(screen.getByLabelText("Library type"), { target: { value: "anime" } });
  expect((screen.getByLabelText("Anime content") as HTMLSelectElement).value).toBe("both");
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  fireEvent.click(await screen.findByRole("checkbox", { name: "Shows" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Movies" }));
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  fireEvent.click(screen.getByRole("button", { name: /Review/ }));
  fireEvent.click(screen.getByRole("button", { name: "Create library" }));
  await waitFor(() => expect(nativeLibraries.save).toHaveBeenCalledWith({ name: "Anime", library_type: "anime", anime_content: "both", paths: ["Shows", "Movies"], options: defaultNativeOptions, revision: null }, undefined));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("keeps selected folders across navigation and prevents overlapping roots", async () => {
  mount(<LibraryDialog onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "TV" } });
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  fireEvent.click(await screen.findByRole("checkbox", { name: "Shows" }));
  fireEvent.click(screen.getByRole("button", { name: "Open Shows" }));
  fireEvent.click(await screen.findByRole("checkbox", { name: "Season 1" }));
  expect(screen.getByText(/Selected folders overlap/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Remove /media/Shows" }));
  expect(screen.getByText("/media/Shows/Season 1")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(false);
});

it("protects dirty drafts on Escape and restores body scrolling", () => {
  const close = vi.fn();
  const view = mount(<LibraryDialog onClose={close} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Books" } });
  fireEvent.keyDown(document, { key: "Escape" });
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  expect(close).toHaveBeenCalledOnce();
  view.unmount(); expect(document.body.style.overflow).toBe("");
});

it("submits the existing revision when editing and keeps errors visible", async () => {
  vi.mocked(nativeLibraries.save).mockRejectedValue(new Error("Library changed since it was opened."));
  mount(<LibraryDialog library={saved} onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: /Review/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save library" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Library changed since it was opened.");
  expect(nativeLibraries.save).toHaveBeenCalledWith(expect.objectContaining({ revision: 1 }), "library");
});

it("groups library actions in the menu and confirms removal", async () => {
  vi.mocked(nativeLibraries.list).mockResolvedValue([saved]);
  vi.mocked(nativeLibraries.status).mockResolvedValue({status: "complete", count: 4, warnings: []});
  vi.mocked(nativeLibraries.scan).mockResolvedValue(undefined);
  vi.mocked(nativeLibraries.remove).mockResolvedValue(undefined);
  mount(<NativeLibrariesSection />);
  fireEvent.click(await screen.findByLabelText("Actions for Anime"));
  expect(screen.getByRole("region", {name:"Library actions for Anime"}).parentElement).toBe(document.body);
  fireEvent.click(await screen.findByRole("button", {name: "Scan Library Files"}));
  await waitFor(() => expect(nativeLibraries.scan).toHaveBeenCalledWith(saved.id));
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect((screen.getByRole("button", {name: "Remove"}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", {name: "Remove"}));
  expect(nativeLibraries.remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", {name: "Confirm removal"}));
  await waitFor(() => expect(nativeLibraries.remove).toHaveBeenCalledWith(saved.id, saved.revision));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("starts scans for every library from the top toolbar", async () => {
  vi.mocked(nativeLibraries.list).mockResolvedValue([saved, {...saved, id: "second", name: "TV"}]);
  mount(<NativeLibrariesSection />);
  await screen.findByText("Anime");
  fireEvent.click(screen.getByRole("button", {name: "Scan Libraries"}));
  await waitFor(() => expect(nativeLibraries.scan).toHaveBeenCalledWith("library"));
  expect(nativeLibraries.scan).toHaveBeenCalledWith("second");
});

it("closes a dirty library editor with its X",()=>{
 const close=vi.fn();mount(<LibraryDialog onClose={close} onSaved={vi.fn()}/>);
 fireEvent.change(screen.getByLabelText("Name"),{target:{value:"Books"}});
 fireEvent.click(screen.getByRole("button",{name:"Close library dialog"}));
 expect(close).toHaveBeenCalledOnce();
});
it("allows dismissing library actions while removal is pending",async()=>{
 vi.mocked(nativeLibraries.list).mockResolvedValue([saved]);
 vi.mocked(nativeLibraries.status).mockResolvedValue({status:"complete",count:0,warnings:[]});
 vi.mocked(nativeLibraries.remove).mockImplementation(()=>new Promise(()=>{}));
 mount(<NativeLibrariesSection/>);
 fireEvent.click(await screen.findByRole("button",{name:"Actions for Anime"}));
 fireEvent.click(screen.getByRole("button",{name:"Remove"}));
 fireEvent.click(screen.getByRole("button",{name:"Confirm removal"}));
 await screen.findByRole("button",{name:"Removing…"});
 fireEvent.click(screen.getByRole("button",{name:"Cancel"}));
 expect(screen.queryByRole("region",{name:"Library actions for Anime"})).toBeNull();
});
it("closes the actions and removes the card after successful removal",async()=>{
 vi.mocked(nativeLibraries.list).mockResolvedValueOnce([saved]).mockResolvedValue([]);
 vi.mocked(nativeLibraries.status).mockResolvedValue({status:"complete",count:0,warnings:[]});
 vi.mocked(nativeLibraries.remove).mockResolvedValue(undefined);
 mount(<NativeLibrariesSection/>);
 fireEvent.click(await screen.findByRole("button",{name:"Actions for Anime"}));
 fireEvent.click(screen.getByRole("button",{name:"Remove"}));
 fireEvent.click(screen.getByRole("button",{name:"Confirm removal"}));
 await waitFor(()=>expect(screen.queryByRole("region",{name:"Library actions for Anime"})).toBeNull());
 expect(screen.queryByRole("button",{name:"Actions for Anime"})).toBeNull();
});

it("skips Advanced and Server Connect when setting up a book library",()=>{
 mount(<LibraryDialog library={{...saved,library_type:"books"}} onClose={vi.fn()} onSaved={vi.fn()}/>);
 expect(screen.queryByRole("button",{name:/Advanced/})).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:/Artwork/}));
 fireEvent.click(screen.getByRole("button",{name:"Next"}));
 expect(screen.getByText("Review your library")).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Back"}));
 expect(screen.getByText("Local Artwork")).toBeTruthy();
});

it("hides Import Library even with saved server connections",async()=>{
 vi.mocked(useServerConnectPlugin).mockReturnValue({data:{enabled:true,pinned:true}} as ReturnType<typeof useServerConnectPlugin>);
 mount(<NativeLibrariesSection />);
 await screen.findByRole("button",{name:"New Library"});
 expect(screen.queryByRole("button",{name:/Import library/i})).toBeNull();
});

it("allows a manual scan request while a hidden automatic scan is running",async()=>{
 vi.mocked(nativeLibraries.list).mockResolvedValue([saved]);vi.mocked(nativeLibraries.status).mockResolvedValue({status:"scanning",show_progress:false,count:1,warnings:[]});
 mount(<NativeLibrariesSection/>);fireEvent.click(await screen.findByRole("button",{name:"Actions for Anime"}));
 await screen.findByText("A scan is running. You can queue a manual scan.");const button=screen.getByRole("button",{name:"Scan Library Files"});expect((button as HTMLButtonElement).disabled).toBe(false);
 fireEvent.click(button);await waitFor(()=>expect(nativeLibraries.scan).toHaveBeenCalledWith(saved.id));
});


it("reveals automatic scan progress only when requested",async()=>{
 vi.mocked(nativeLibraries.list).mockResolvedValue([saved]);
 vi.mocked(nativeLibraries.status).mockResolvedValue({status:"scanning",show_progress:false,count:100,warnings:[],progress:{phase:"reading",processed:25,total:100,current:"Anime/episode.mkv"}});
 mount(<NativeLibrariesSection/>);
 fireEvent.click(await screen.findByRole("button",{name:"Actions for Anime"}));
 const view=await screen.findByRole("button",{name:"View scan progress"});
 expect(screen.queryByRole("progressbar")).toBeNull();
 fireEvent.click(view);
 expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("25");
 expect(screen.getByText("/media/Anime/episode.mkv")).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Hide scan progress"}));
 expect(screen.queryByRole("progressbar")).toBeNull();
});

it("refreshes an entire library from its action menu with the selected options",async()=>{
 vi.mocked(nativeLibraries.list).mockResolvedValue([saved]);
 vi.mocked(nativeLibraries.status).mockResolvedValue({status:"idle",count:1,warnings:[]});
 vi.mocked(nativeLibraries.refresh).mockResolvedValue(undefined);
 mount(<NativeLibrariesSection/>);
 fireEvent.click(await screen.findByRole("button",{name:"Actions for Anime"}));
 fireEvent.click(screen.getByRole("button",{name:"Refresh Metadata"}));
 expect(screen.getByRole("dialog",{name:"Refresh Metadata — Anime"})).toBeTruthy();
 fireEvent.change(screen.getByLabelText("Refresh mode"),{target:{value:"missing"}});
 fireEvent.click(screen.getByRole("button",{name:/^Refresh$/}));
 await waitFor(()=>expect(nativeLibraries.refresh).toHaveBeenCalledWith(saved.id,{replaceMetadata:false,replaceImages:false}));
});
