import {AuthSessionContext} from "../../lib/authContext";
import {LibraryNavigationContext} from '../../lib/libraryNavigation';
import {HeaderSearchTarget} from "../../lib/headerSearch";
import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {MemoryRouter,useLocation} from "react-router-dom";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import YouTubeLibraryBrowser from "./YouTubeLibraryBrowser";
import {nativeLibraries,type NativeLibrary,type NativeCatalogEntry} from "../../api/nativeLibraries";
vi.mock("../../api/nativeLibraries",()=>({nativeLibraries:{catalog:vi.fn(),artworkUrl:(_library:string,_item:string,kind:string)=>`/api/native/libraries/youtube/items/video/artwork/${kind}`}}));
vi.mock("../../components/DashboardBackdrop",()=>({default:({desktopUrls}:{desktopUrls:string[]})=><div data-testid="background" data-urls={desktopUrls.join(",")}/> }));
beforeEach(()=>{HTMLDialogElement.prototype.showModal=function(){this.setAttribute("open","");};HTMLDialogElement.prototype.close=function(){this.removeAttribute("open");};});
afterEach(()=>{cleanup();localStorage.clear();});
const video:NativeCatalogEntry={id:"video",path:"channel/video.mp4",kind:"episode",parent_path:"channel",title:"Camping video",available:true,revision:1,files:[],nfo_path:null,artwork:[{kind:"thumb",path:"thumb.jpg",source:"local"}],metadata:{youtube:{channel_id:"channel",channel:"Outdoor Boys",playlists:[{id:"camping",title:"Camping"}]}}};
it.each(["single_channel","multiple_channels"] as const)("shows channels before playlists for saved %s libraries",async youtube_mode=>{
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([{...video,id:"channel-art",kind:"series",path:"channel",parent_path:null,title:"Outdoor Boys",artwork:[{kind:"poster",path:"poster.jpg",source:"local"},{kind:"backdrop",path:"backdrop.jpg",source:"local"}],metadata:{youtube:{channel_id:"channel",channel:"Outdoor Boys"}}},video]);
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
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([{...video,id:"channel-art",kind:"series",path:"channel",parent_path:null,title:"Outdoor Boys",artwork:[{kind:"poster",path:"poster.jpg",source:"local"},{kind:"backdrop",path:"backdrop.jpg",source:"local"}],metadata:{youtube:{channel_id:"channel",channel:"Outdoor Boys"}}},video]);
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

it("does not substitute video thumbnails for missing channel artwork",async()=>{
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([video]);
 render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><YouTubeLibraryBrowser library={{id:"youtube",name:"YouTube"} as NativeLibrary}/></MemoryRouter></QueryClientProvider>);
 const card=await screen.findByRole("button",{name:"Outdoor Boys 1 videos"});
 expect(card.querySelector("img")).toBeNull();
});

it("shows channel-owned poster and synopsis above its playlist collection",async()=>{
 const channel={...video,id:'channel',kind:'series',path:'channel',parent_path:null,title:'Outdoor Boys',artwork:[{kind:'poster',path:'poster.jpg',source:'local' as const}],metadata:{plot:'Channel adventures and family trips.',youtube:{channel_id:'channel',channel:'Outdoor Boys'}}};
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([channel,video]);
 render(<QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={['/?youtube_channel=channel']}><YouTubeLibraryBrowser library={{id:'youtube',name:'YouTube'} as NativeLibrary}/></MemoryRouter></QueryClientProvider>);
 expect(await screen.findByRole('img',{name:'Outdoor Boys channel poster'})).toBeTruthy();
 expect(screen.getAllByText('Channel adventures and family trips.').length).toBeGreaterThan(0);
 expect(screen.getByRole('heading',{name:'Playlists'})).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'All Videos'}));
 expect(await screen.findByRole('button',{name:'Camping video'})).toBeTruthy();
});

it("retains the channel hero on a playlist page and lists its videos beneath",async()=>{
 const channel={...video,id:'channel',kind:'series',path:'channel',parent_path:null,title:'Outdoor Boys',artwork:[{kind:'poster',path:'poster.jpg',source:'local' as const}],metadata:{plot:'Channel description',youtube:{channel_id:'channel',channel:'Outdoor Boys'}}};
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([channel,video]);
 render(<QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={['/?youtube_channel=channel&youtube_playlist=camping']}><YouTubeLibraryBrowser library={{id:'youtube',name:'YouTube'} as NativeLibrary}/></MemoryRouter></QueryClientProvider>);
 expect(await screen.findByRole('heading',{name:'Outdoor Boys',level:1})).toBeTruthy();
 expect(screen.getByRole('img',{name:'Outdoor Boys channel poster'})).toBeTruthy();
 expect(screen.getAllByText('Channel description').length).toBeGreaterThan(0);
 expect(screen.getByRole('heading',{name:'Camping',level:2})).toBeTruthy();
 expect(screen.getByRole('button',{name:'Camping video'})).toBeTruthy();
 expect(screen.queryByRole('heading',{name:'Playlists'})).toBeNull();
});

function LocationProbe(){const location=useLocation();return <output data-testid="location">{location.pathname+location.search}</output>;}
function renderPlaylist(entries:NativeCatalogEntry[],url='/?youtube_channel=channel&youtube_playlist=camping'){
 vi.mocked(nativeLibraries.catalog).mockResolvedValue(entries);
 return render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MemoryRouter initialEntries={[url]}><YouTubeLibraryBrowser library={{id:'youtube',name:'YouTube',library_type:'youtube'} as NativeLibrary}/><LocationProbe/></MemoryRouter></QueryClientProvider>);
}
const playableVideo={...video,files:[{path:'channel/video.mp4',size:1,extension:'mp4'}]};
it('lists playlist videos as season-style rows with synopsis, date and duration without starting playback',async()=>{
 renderPlaylist([{...playableVideo,metadata:{plot:'An adventure in the mountains.',youtube:{...video.metadata.youtube as object,published_at:'2026-10-01',duration_seconds:125}}}]);
 const article=await screen.findByRole('article',{name:'Camping video'});
 expect(article.querySelector('img')?.alt).toBe('Camping video video thumbnail');
 expect(article.querySelector('.detail-synopsis')?.textContent).toBe('An adventure in the mountains.');
 expect(screen.getByText('2026-10-01 · 3 min')).toBeTruthy();
 expect(screen.getByTestId('location').textContent).toBe('/?youtube_channel=channel&youtube_playlist=camping');
 expect(screen.queryByText('View on YouTube')).toBeNull();
 fireEvent.change(screen.getByRole('textbox',{name:'Search titles'}),{target:{value:'absent'}});
 expect(screen.queryByRole('article')).toBeNull();
 expect(screen.getByText('No titles match your search.')).toBeTruthy();
});
it.each(['Play Camping video','Camping video'])('starts playback directly from %s and returns to its playlist',async label=>{
 renderPlaylist([playableVideo]);
 fireEvent.click(await screen.findByRole('button',{name:label}));
 const location=screen.getByTestId('location').textContent!;
 expect(location.startsWith('/play/native/youtube/video?')).toBe(true);
 expect(new URLSearchParams(location.split('?')[1]).get('return')).toBe('/?youtube_channel=channel&youtube_playlist=camping');
});
it('disables videos without a playable file and explains why',async()=>{
 renderPlaylist([video]);
 expect((await screen.findByRole('button',{name:'Play Camping video'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'Camping video'}));
 expect(screen.getByText('No playable file available.')).toBeTruthy();
 expect(screen.getByTestId('location').textContent).not.toContain('/play/');
});
it('plays old query video links and removes the video from the player return destination',async()=>{
 renderPlaylist([playableVideo],'/?youtube_channel=channel&youtube_playlist=camping&youtube_video=video&keep=yes');
 await waitFor(()=>expect(screen.getByTestId('location').textContent?.startsWith('/play/native/youtube/video?')).toBe(true));
 const location=screen.getByTestId('location').textContent!;
 expect(location.startsWith('/play/native/youtube/video?')).toBe(true);
 expect(new URLSearchParams(location.split('?')[1]).get('return')).toBe('/?youtube_channel=channel&youtube_playlist=camping&keep=yes');
});
it('shows a clear error for an unavailable old video link instead of opening details',async()=>{
 renderPlaylist([{...playableVideo,available:false}],'/?youtube_video=video');
 expect(await screen.findByRole('alert')).toHaveProperty('textContent','This video is unavailable or has no playable file.');
 expect(screen.getByTestId('location').textContent).not.toContain('/play/');
});
it('lets YouTube page backgrounds prefer banners independently of backdrop cards with fallback',async()=>{
 localStorage.setItem('posterview.dashboardBackdropEnabled','true');
 const channel={...video,id:'channel-art',kind:'series',path:'channel',parent_path:null,title:'Outdoor Boys',metadata:{youtube:{channel_id:'channel'}},artwork:[{kind:'banner',path:'banner.jpg',source:'local' as const},{kind:'backdrop',path:'backdrop.jpg',source:'local' as const}]};
 renderPlaylist([channel,playableVideo],'/');
 const card=await screen.findByRole('button',{name:'Outdoor Boys 1 videos'});
 expect(card.querySelector('img')?.src).toContain('/artwork/backdrop?');
 fireEvent.click(screen.getByRole('button',{name:'Library preferences'}));
 fireEvent.change(screen.getByRole('combobox',{name:'Page background'}),{target:{value:'banner'}});
 expect(screen.getByTestId('background').getAttribute('data-urls')).toContain('/artwork/banner?');
 expect(card.querySelector('img')?.src).toContain('/artwork/backdrop?');
 expect(localStorage.getItem('posterview.youtubeBackground.youtube')).toBe('banner');
});
it('falls back to channel backdrop when banner background is preferred but absent',async()=>{
 localStorage.setItem('posterview.dashboardBackdropEnabled','true');
 localStorage.setItem('posterview.youtubeBackground.youtube','banner');
 renderPlaylist([{...video,id:'channel-art',kind:'series',path:'channel',parent_path:null,title:'Outdoor Boys',metadata:{youtube:{channel_id:'channel'}},artwork:[{kind:'backdrop',path:'backdrop.jpg',source:'local'}]},playableVideo],'/');
 await screen.findByRole('button',{name:'Outdoor Boys 1 videos'});
 expect(screen.getByTestId('background').getAttribute('data-urls')).toContain('/artwork/backdrop?');
});

it('returns canonical video deep links to the playlist instead of replaying on player close',async()=>{
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([playableVideo]);
 const navigate=vi.fn();
 const params=new URLSearchParams('youtube_channel=channel&youtube_playlist=camping&youtube_video=video');
 render(<QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={['/media/Youtube/Outdoor-Boys/Camping/Camping-video?keep=yes']}><LibraryNavigationContext.Provider value={{navigate,params:{},searchParams:params,setSearchParams:vi.fn()}}><YouTubeLibraryBrowser library={{id:'youtube',name:'YouTube'} as NativeLibrary}/></LibraryNavigationContext.Provider></MemoryRouter></QueryClientProvider>);
 await waitFor(()=>expect(navigate).toHaveBeenCalled());
 const destination=navigate.mock.calls[0][0] as string;
 expect(destination.startsWith('/play/native/youtube/video?')).toBe(true);
 expect(new URLSearchParams(destination.split('?')[1]).get('return')).toBe('/media/Youtube/Outdoor-Boys/Camping?keep=yes');
 expect(navigate.mock.calls[0][1]).toEqual({replace:true});
});

it("can hide both All Videos entries while retaining playlists and saved preference",async()=>{
 vi.mocked(nativeLibraries.catalog).mockResolvedValue([video]);
 const view=render(<QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={["/?youtube_channel=channel"]}><YouTubeLibraryBrowser library={{id:"youtube",name:"YouTube"} as NativeLibrary}/></MemoryRouter></QueryClientProvider>);
 await screen.findByRole("button",{name:"All Videos 1 videos"});
 expect(screen.getByRole("button",{name:/^All Videos$/})).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Library preferences"}));
 fireEvent.click(screen.getByRole("switch",{name:"Hide All Videos"}));
 expect(localStorage.getItem("posterview.youtubeAllVideos.youtube")).toBe("hidden");
 expect(screen.getByText("Changes saved automatically")).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Close Preferences"}));
 expect(screen.queryByRole("button",{name:/^All Videos/})).toBeNull();
 expect(screen.getByRole("button",{name:"Camping 1 videos"})).toBeTruthy();
 view.unmount();
 render(<QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={["/?youtube_channel=channel"]}><YouTubeLibraryBrowser library={{id:"youtube",name:"YouTube"} as NativeLibrary}/></MemoryRouter></QueryClientProvider>);
 await screen.findByRole("button",{name:"Camping 1 videos"});
 expect(screen.queryByRole("button",{name:/^All Videos/})).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"Library preferences"}));
 fireEvent.click(screen.getByRole("switch",{name:"Hide All Videos"}));
 fireEvent.click(screen.getByRole("button",{name:"Close Preferences"}));
 expect(screen.getByRole("button",{name:"All Videos 1 videos"})).toBeTruthy();
});

vi.mock("../../components/BulkMetadataDialog",()=>({default:({itemIds,onSaved}:{itemIds:string[];onSaved:()=>void})=><div role="dialog" aria-label="Bulk metadata" data-items={itemIds.join(",")}><button onClick={onSaved}>Simulate bulk saved</button></div> }));
function renderSelection(entries:NativeCatalogEntry[],path="/",viewer=false){
 vi.mocked(nativeLibraries.catalog).mockResolvedValue(entries);
 return render(<AuthSessionContext.Provider value={viewer?{user:{role:"user"}} as never:null}><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MemoryRouter initialEntries={[path]}><YouTubeLibraryBrowser library={{id:"youtube",name:"YouTube"} as NativeLibrary}/></MemoryRouter></QueryClientProvider></AuthSessionContext.Provider>);
}
it("expands selected channels to their videos without collection controls",async()=>{
 renderSelection([video,{...video,id:"second"}]);
 fireEvent.click(await screen.findByRole("button",{name:"Library preferences"}));
 fireEvent.click(screen.getByRole("button",{name:"Select items"}));
 fireEvent.click(screen.getByRole("button",{name:"Close Preferences"}));
 fireEvent.click(screen.getByRole("checkbox",{name:"Select Outdoor Boys"}));
 expect(screen.getByText("2 unique videos affected")).toBeTruthy();
 expect(screen.queryByRole("button",{name:"Add to collection…"})).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"Edit tags and genres…"}));
 expect(screen.getByRole("dialog",{name:"Bulk metadata"}).getAttribute("data-items")?.split(",").sort()).toEqual(["second","video"]);
 fireEvent.click(screen.getByRole("button",{name:"Simulate bulk saved"}));
 expect(screen.getByRole("dialog",{name:"Bulk metadata"})).toBeTruthy();
});
it("deduplicates overlapping selected playlists including All Videos",async()=>{
 renderSelection([video,{...video,id:"second"}],"/?youtube_channel=channel");
 fireEvent.click(await screen.findByRole("button",{name:"Library preferences"}));
 fireEvent.click(screen.getByRole("button",{name:"Select items"}));
 fireEvent.click(screen.getByRole("button",{name:"Close Preferences"}));
 fireEvent.click(screen.getByRole("checkbox",{name:"Select All Videos"}));
 fireEvent.click(screen.getByRole("checkbox",{name:"Select Camping"}));
 expect(screen.getByText("2 unique videos affected")).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Edit tags and genres…"}));
 expect(screen.getByRole("dialog",{name:"Bulk metadata"}).getAttribute("data-items")?.split(",").sort()).toEqual(["second","video"]);
});
it("selects individual playlist videos without starting playback",async()=>{
 renderSelection([video,{...video,id:"second",title:"Second video"}],"/?youtube_channel=channel&youtube_playlist=camping");
 fireEvent.click(await screen.findByRole("button",{name:"Library preferences"}));
 fireEvent.click(screen.getByRole("button",{name:"Select items"}));
 fireEvent.click(screen.getByRole("button",{name:"Close Preferences"}));
 fireEvent.click(screen.getByRole("checkbox",{name:"Select Camping video"}));
 expect(screen.getByText("1 unique video affected")).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Edit tags and genres…"}));
 expect(screen.getByRole("dialog",{name:"Bulk metadata"}).getAttribute("data-items")).toBe("video");
});
it("does not offer bulk metadata selection to viewers",async()=>{
 renderSelection([video],"/",true);
 fireEvent.click(await screen.findByRole("button",{name:"Library preferences"}));
 expect(screen.queryByRole("button",{name:"Select items"})).toBeNull();
});

it("selects only visible filtered videos",async()=>{
 renderSelection([video,{...video,id:"second",title:"Second video"}],"/?youtube_channel=channel&youtube_playlist=camping");
 fireEvent.click(await screen.findByRole("button",{name:"Library preferences"}));
 fireEvent.click(screen.getByRole("button",{name:"Select items"}));
 fireEvent.click(screen.getByRole("button",{name:"Close Preferences"}));
 fireEvent.change(screen.getByRole("textbox",{name:"Search titles"}),{target:{value:"Second"}});
 fireEvent.click(screen.getByRole("button",{name:"Select all visible"}));
 expect(screen.getByText("1 unique video affected")).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Edit tags and genres…"}));
 expect(screen.getByRole("dialog",{name:"Bulk metadata"}).getAttribute("data-items")).toBe("second");
});
