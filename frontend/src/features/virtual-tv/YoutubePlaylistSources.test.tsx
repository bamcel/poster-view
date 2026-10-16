import {useState} from "react";
import {cleanup,fireEvent,render,screen,waitFor,within} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {afterEach,expect,it,vi} from "vitest";
import {nativeLibraries,defaultNativeOptions,type NativeLibrary,type NativeCatalogEntry} from "../../api/nativeLibraries";
import YoutubePlaylistSources from "./YoutubePlaylistSources";
import type {YoutubePlaylistSelection} from "./client";
vi.mock("../../api/nativeLibraries",async importOriginal=>({...await importOriginal<object>(),nativeLibraries:{catalog:vi.fn()}}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
const library=(id="yt",multi=false):NativeLibrary=>({id,name:id,library_type:"youtube",anime_content:"both",paths:[],revision:1,created_at:"",updated_at:"",options:{...defaultNativeOptions,youtube_mode:multi?"multiple_channels":"single_channel"}});
function catalog():NativeCatalogEntry[]{
 const base={parent_path:null,artwork:[],files:[],nfo_path:null,available:true,revision:1};
 return ["Alpha","Beta"].flatMap(title=>[
  {...base,id:`series-${title}`,kind:"series",title,path:title,metadata:{youtube:{channel_id:title}}},
  ...["One","Two"].map(playlist=>({...base,id:`${title}-${playlist}`,kind:"episode",title:playlist,path:`${title}/${playlist}`,metadata:{youtube:{channel_id:title,playlists:[{id:playlist,title:`${title} ${playlist}`}]}}})),
  {...base,id:`${title}-missing`,kind:"episode",title:"Missing",path:`${title}/missing`,available:false,metadata:{youtube:{channel_id:title,playlists:[{id:"Missing",title:"Missing"}]}}}
 ]);
}
function mount(libraries=[library()],initial:YoutubePlaylistSelection[]=[],legacyShowIds?:string[]){
 vi.mocked(nativeLibraries.catalog).mockResolvedValue(catalog());
 const change=vi.fn();
 function Harness(){const [selections,setSelections]=useState(initial);return <YoutubePlaylistSources libraries={libraries} selections={selections} legacyShowIds={legacyShowIds} onChange={value=>{change(value);setSelections(value);}}/>;}
 render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><Harness/></QueryClientProvider>);
 return change;
}
it("shows downloaded playlists directly for single-channel libraries",async()=>{
 const change=mount();fireEvent.click(await screen.findByRole("checkbox",{name:"Alpha One (1 videos)"}));
 expect(change).toHaveBeenLastCalledWith([{library_id:"yt",channel_id:"Alpha",playlist_id:"One"}]);
 expect(screen.queryByText("Channels")).toBeNull();expect(screen.queryByText("Missing")).toBeNull();
 fireEvent.click(screen.getByRole("checkbox",{name:"Select all playlists for Alpha"}));expect(change.mock.lastCall?.[0]).toHaveLength(2);
});
it("populates playlists from selected channels and keeps the channel visible when all playlists are deselected",async()=>{
 const change=mount([library("yt",true)]);
 fireEvent.click(await screen.findByRole("checkbox",{name:"Alpha (2 playlists)"}));expect(change.mock.lastCall?.[0]).toHaveLength(2);
 fireEvent.click(screen.getByRole("checkbox",{name:"Select all playlists for Alpha"}));expect(change).toHaveBeenLastCalledWith([]);
 expect((screen.getByRole("checkbox",{name:"Alpha (2 playlists)"}) as HTMLInputElement).checked).toBe(true);
 expect(screen.getByRole("checkbox",{name:"Alpha One (1 videos)"})).toBeTruthy();
 fireEvent.click(screen.getByRole("checkbox",{name:"Alpha (2 playlists)"}));expect(screen.queryByRole("checkbox",{name:"Alpha One (1 videos)"})).toBeNull();
 fireEvent.click(screen.getByRole("checkbox",{name:"Select all channels"}));expect(change.mock.lastCall?.[0]).toHaveLength(4);
});
it("scopes matching channel and playlist IDs to each library",async()=>{
 const change=mount([library("first",true),library("second",true)],[{library_id:"first",channel_id:"Alpha",playlist_id:"One"}]);
 const first=await screen.findByRole("region",{name:"first YouTube sources"});
 await waitFor(()=>expect(within(first).getByRole("checkbox",{name:"Alpha One (1 videos)"})).toBeTruthy());
 const second=screen.getByRole("region",{name:"second YouTube sources"});expect(within(second).queryByRole("checkbox",{name:"Alpha One (1 videos)"})).toBeNull();
 fireEvent.click(within(second).getByRole("checkbox",{name:"Alpha (2 playlists)"}));expect(change.mock.lastCall?.[0]).toHaveLength(3);
 fireEvent.click(within(first).getByRole("checkbox",{name:"Alpha (2 playlists)"}));expect(change.mock.lastCall?.[0].every((value:YoutubePlaylistSelection)=>value.library_id==="second")).toBe(true);
});
it("initializes legacy channel choices once without selecting new explicit-empty drafts",async()=>{
 const change=mount([library("yt",true)],[],["series-Alpha"]);
 await waitFor(()=>expect(change).toHaveBeenCalledTimes(1));expect(change.mock.lastCall?.[0]).toHaveLength(2);
 fireEvent.click(screen.getByRole("checkbox",{name:"Select all playlists for Alpha"}));expect(change).toHaveBeenCalledTimes(2);
});
it("initializes all legacy playlists when the previous channel had no show filter",async()=>{
 const change=mount([library("yt",true)],[],[]);
 await waitFor(()=>expect(change).toHaveBeenCalledTimes(1));expect(change.mock.lastCall?.[0]).toHaveLength(4);
});
it("leaves a new draft unselected until a channel is chosen",async()=>{
 const change=mount([library("yt",true)]);
 const checkbox=await screen.findByRole("checkbox",{name:"Alpha (2 playlists)"});
 expect((checkbox as HTMLInputElement).checked).toBe(false);expect(change).not.toHaveBeenCalled();
});
