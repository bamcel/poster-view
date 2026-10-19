import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import ArtworkHistory,{ArtworkHistoryGrid} from "./ArtworkHistory";
import {artworkHistory,type HistoryEntry} from "./historyClient";

vi.mock("./historyClient",()=>({artworkHistory:{entries:vi.fn(),groups:vi.fn(),restore:vi.fn()}}));
const entries:HistoryEntry[]=[
 {id:"poster",server_id:0,item_id:"native:library:series",group_id:"native:library:series",title:"Series",item_title:"Series",kind:"poster",created_at:"2026-10-19T12:00:00Z",preview_url:"/api/artwork/history/poster/image",has_image:true,adjustments:true},
 {id:"season",server_id:0,item_id:"native:library:specials",group_id:"native:library:series",title:"Series",item_title:"Specials",kind:"background",created_at:"2026-10-19T11:00:00Z",preview_url:null,has_image:false,adjustments:false},
];
let client:QueryClient;
beforeEach(()=>{vi.clearAllMocks();client=new QueryClient({defaultOptions:{queries:{retry:false}}});vi.mocked(artworkHistory.entries).mockResolvedValue(entries);vi.mocked(artworkHistory.restore).mockResolvedValue({ok:true,message:"Artwork restored."});});
afterEach(()=>{cleanup();client.clear();});
function show(){render(<QueryClientProvider client={client}><ArtworkHistory serverId={0} itemId="native:library:series" title="Series" onClose={vi.fn()}/></QueryClientProvider>);}
describe("Artwork history",()=>{
 it("explains empty history without disabling access",async()=>{vi.mocked(artworkHistory.entries).mockResolvedValue([]);show();expect((await screen.findByText(/No artwork history yet/)).textContent).toContain("20 changes");expect(screen.getByRole("dialog")).toBeTruthy();});
 it("previews locally then restores only after explicit action",async()=>{
  const invalidate=vi.spyOn(client,"invalidateQueries");show();fireEvent.click(await screen.findByRole("button",{name:/Preview Series poster/}));
  expect(screen.getByRole("img",{name:"Previous poster for Series"}).getAttribute("src")).toBe(entries[0].preview_url);
  expect(artworkHistory.restore).not.toHaveBeenCalled();fireEvent.click(screen.getByRole("button",{name:"Restore artwork"}));
  await waitFor(()=>expect(artworkHistory.restore).toHaveBeenCalledWith("poster"));expect((await screen.findByRole("status")).textContent).toContain("Artwork restored.");expect(invalidate).toHaveBeenCalledWith({queryKey:["artwork-history"]});
 });
 it("filters Specials and supports restoring a version without an image",async()=>{
  show();await screen.findByRole("button",{name:/Preview Series poster/});fireEvent.change(screen.getByLabelText("Filter series or season"),{target:{value:"native:library:specials"}});
  expect(screen.queryByRole("button",{name:/Preview Series poster/})).toBeNull();fireEvent.click(screen.getByRole("button",{name:/Preview Specials background/}));expect(screen.getAllByText("No artwork was assigned in this version.").length).toBeGreaterThan(0);
 });
 it("keeps restore failures visible",async()=>{vi.mocked(artworkHistory.restore).mockRejectedValue(new Error("Restore failed"));show();fireEvent.click(await screen.findByRole("button",{name:/Preview Series poster/}));fireEvent.click(screen.getByRole("button",{name:"Restore artwork"}));expect((await screen.findByRole("alert")).textContent).toContain("Restore failed");});
 it("previews saved poster overlay using the cached logo",async()=>{
  vi.mocked(artworkHistory.entries).mockResolvedValue([{...entries[0],preview_logo_url:"/api/artwork/history/poster/image?asset=logo",preview_settings:{posteredit:{x:12,y:65,width:70,opacity:80,enabled:true}}}]);show();fireEvent.click(await screen.findByRole("button",{name:/Preview Series poster/}));
  const preview=screen.getByLabelText("Artwork history preview");const logo=preview.querySelector('img[src*="asset=logo"]') as HTMLImageElement;expect(logo.style.left).toBe("12%");expect(logo.style.opacity).toBe("0.8");expect(artworkHistory.restore).not.toHaveBeenCalled();
 });
 it("applies saved backdrop framing only to the cached preview",async()=>{
  vi.mocked(artworkHistory.entries).mockResolvedValue([{...entries[0],kind:"background",preview_settings:{backdropedit:{x:25,y:20,zoom:140,fit:"cover"}}}]);show();fireEvent.click(await screen.findByRole("button",{name:/Preview Series background/}));
  const image=screen.getByRole("img",{name:"Previous background for Series"});expect(image.style.objectPosition).toBe("25% 20%");expect(image.style.transform).toBe("scale(1.4)");expect(artworkHistory.restore).not.toHaveBeenCalled();
 });
 it("shows WebM preview with muted explicit playback controls",async()=>{
  vi.mocked(artworkHistory.entries).mockResolvedValue([{...entries[0],content_type:"video/webm"}]);show();fireEvent.click(await screen.findByRole("button",{name:/Preview Series poster/}));
  const video=screen.getByLabelText("Previous poster for Series") as HTMLVideoElement;expect(video.tagName).toBe("VIDEO");expect(video.muted).toBe(true);expect(video.controls).toBe(true);expect(video.autoplay).toBe(false);expect(video.getAttribute("src")).toBe(entries[0].preview_url);
 });
 it("shows only titles with history and opens the same popup",async()=>{
  vi.mocked(artworkHistory.groups).mockResolvedValue([{server_id:0,group_id:"native:library:series",title:"Series",poster_url:"/poster",count:2,latest_at:"2026-10-19"},{server_id:0,group_id:"empty",title:"Empty",poster_url:null,count:0,latest_at:"2026-10-19"}]);
  render(<QueryClientProvider client={client}><ArtworkHistoryGrid/></QueryClientProvider>);fireEvent.click(await screen.findByRole("button",{name:/Series.*2.*saved.*changes/}));expect(screen.queryByText("Empty")).toBeNull();expect(await screen.findByRole("dialog")).toBeTruthy();expect(artworkHistory.entries).toHaveBeenCalledWith(0,"native:library:series");
 });
});
