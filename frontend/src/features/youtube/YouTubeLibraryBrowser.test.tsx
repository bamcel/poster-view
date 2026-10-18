import {HeaderSearchTarget} from "../../lib/headerSearch";
import {cleanup,fireEvent,render,screen} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {MemoryRouter} from "react-router-dom";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import YouTubeLibraryBrowser from "./YouTubeLibraryBrowser";
import {nativeLibraries,type NativeLibrary,type NativeCatalogEntry} from "../../api/nativeLibraries";
vi.mock("../../api/nativeLibraries",()=>({nativeLibraries:{catalog:vi.fn(),artworkUrl:()=>"/api/native/libraries/youtube/items/video/artwork/thumb"}}));
vi.mock("../playback/components/NativePlaybackActions",()=>({default:()=>null}));
beforeEach(()=>{HTMLDialogElement.prototype.showModal=function(){this.setAttribute("open","");};HTMLDialogElement.prototype.close=function(){this.removeAttribute("open");};});
afterEach(()=>{cleanup();localStorage.clear();});
const video:NativeCatalogEntry={id:"video",path:"channel/video.mp4",kind:"episode",parent_path:"channel",title:"Camping video",available:true,revision:1,files:[],nfo_path:null,artwork:[{kind:"thumb",path:"thumb.jpg",source:"local"}],metadata:{youtube:{channel_id:"channel",channel:"Outdoor Boys",playlists:[{id:"camping",title:"Camping"}]}}};
it.each(["single_channel","multiple_channels"] as const)("shows channels before playlists for saved %s libraries",async youtube_mode=>{
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([video]);
 render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MemoryRouter><YouTubeLibraryBrowser library={{id:"youtube",name:"YouTube",options:{youtube_mode}} as NativeLibrary}/></MemoryRouter></QueryClientProvider>);
 const channel=await screen.findByRole("button",{name:"Outdoor Boys 1 videos"});
 expect(screen.queryByRole("button",{name:"Camping 1 videos"})).toBeNull();
 expect(new URL(channel.querySelector("img")!.src).searchParams.get("width")).toBe("640");
 expect(channel.querySelector("img")!.className).toContain("aspect-video");
 expect(screen.queryByRole("combobox",{name:"Display"})).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"Library preferences"}));
 fireEvent.change(screen.getByRole("combobox",{name:"Display"}),{target:{value:"poster"}});
 expect(channel.querySelector("img")!.className).toContain("aspect-[2/3]");
 expect(new URL(channel.querySelector("img")!.src).searchParams.get("width")).toBe("480");
 expect(localStorage.getItem("posterview.libraryView.youtube")).toBe("poster");
 fireEvent.click(screen.getByRole("button",{name:"Close Preferences"}));
 fireEvent.click(channel);fireEvent.click(await screen.findByRole("button",{name:"Camping 1 videos"}));
 expect(await screen.findByRole("button",{name:"Camping video"})).toBeTruthy();
});

it("matches the library toolbar and filters channels with accurate counts",async()=>{
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([video,{...video,id:"second",title:"Music",metadata:{youtube:{channel_id:"music",channel:"Music"}}}]);
 render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><YouTubeLibraryBrowser library={{id:"youtube",name:"YouTube"} as NativeLibrary}/></MemoryRouter></QueryClientProvider>);
 await screen.findByRole("heading",{name:"YouTube",level:1});
 expect(screen.getByText("2 channels")).toBeTruthy();
 fireEvent.change(screen.getByRole("textbox",{name:"Search titles"}),{target:{value:"Outdoor"}});
 expect(screen.getByText("1 channel")).toBeTruthy();
 expect(screen.queryByRole("button",{name:"Music 1 videos"})).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"Outdoor Boys 1 videos"}));
 expect((screen.getByRole("textbox",{name:"Search titles"}) as HTMLInputElement).value).toBe("");
 expect(screen.getByText("2 playlists")).toBeTruthy();
 fireEvent.change(screen.getByRole("textbox",{name:"Search titles"}),{target:{value:"missing"}});
 expect(screen.getByText("No titles match your search.")).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Filter and sort titles"}));
 fireEvent.change(screen.getByRole("combobox",{name:"Sort titles"}),{target:{value:"reverse"}});
 expect((screen.getByRole("combobox",{name:"Sort titles"}) as HTMLSelectElement).value).toBe("reverse");
});

it("preserves newest upload ordering for playlist videos using published timestamps",async()=>{
 const older={...video,id:"older",title:"A older",metadata:{youtube:{channel_id:"channel",channel:"Outdoor Boys",published_at:"2020-01-01"}}};
 const newer={...older,id:"newer",title:"Z newer",metadata:{youtube:{channel_id:"channel",channel:"Outdoor Boys",published_at:"2026-01-01"}}};
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([older,newer]);
 render(<QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={["/?youtube_channel=channel&youtube_playlist=all"]}><YouTubeLibraryBrowser library={{id:"youtube",name:"YouTube"} as NativeLibrary}/></MemoryRouter></QueryClientProvider>);
 await screen.findByRole("button",{name:"Z newer"});
 expect(screen.getAllByRole("button").filter(button=>["A older","Z newer"].includes(button.textContent??"")).map(button=>button.textContent)).toEqual(["Z newer","A older"]);
});

it("places filter and preferences beside search in the shared header",async()=>{
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([video]);
 const target=document.createElement("div");document.body.appendChild(target);
 try{
  render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><HeaderSearchTarget.Provider value={target}><YouTubeLibraryBrowser library={{id:"youtube",name:"YouTube"} as NativeLibrary}/></HeaderSearchTarget.Provider></MemoryRouter></QueryClientProvider>);
  const search=await screen.findByRole("textbox",{name:"Search titles"});
  const filter=screen.getByRole("button",{name:"Filter and sort titles"});
  const preferences=screen.getByRole("button",{name:"Library preferences"});
  expect(target.contains(search)).toBe(true);
  expect(target.contains(filter)).toBe(true);
  expect(target.contains(preferences)).toBe(true);
  expect(filter.parentElement).toBe(preferences.parentElement);
  expect(filter.parentElement?.contains(search)).toBe(true);
 }finally{cleanup();target.remove();}
});

 it("pins All Videos before playlists for every sort while preserving search",async()=>{
  vi.mocked(nativeLibraries.catalog).mockResolvedValue([{...video,metadata:{youtube:{channel_id:"channel",channel:"Outdoor Boys",playlists:[{id:"a",title:"2018 World Tour"},{id:"z",title:"Z Camping"}]}}}]);
  render(<QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={["/?youtube_channel=channel"]}><YouTubeLibraryBrowser library={{id:"youtube",name:"YouTube"} as NativeLibrary}/></MemoryRouter></QueryClientProvider>);
  await screen.findByRole("button",{name:"All Videos 1 videos"});
  const titles=()=>screen.getAllByRole("button").filter(button=>button.classList.contains("poster-title-card")).map(button=>button.textContent);
  expect(titles()).toEqual(["All Videos1 videos","2018 World Tour1 videos","Z Camping1 videos"]);
  fireEvent.click(screen.getByRole("button",{name:"Filter and sort titles"}));
  fireEvent.change(screen.getByRole("combobox",{name:"Sort titles"}),{target:{value:"reverse"}});
  expect(titles()).toEqual(["All Videos1 videos","Z Camping1 videos","2018 World Tour1 videos"]);
  fireEvent.change(screen.getByRole("combobox",{name:"Sort titles"}),{target:{value:"newest"}});
  expect(titles()[0]).toBe("All Videos1 videos");
  fireEvent.change(screen.getByRole("textbox",{name:"Search titles"}),{target:{value:"2018"}});
  expect(titles()).toEqual(["2018 World Tour1 videos"]);
 });
