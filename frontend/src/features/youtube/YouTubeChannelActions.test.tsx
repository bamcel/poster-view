import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import YouTubeChannelActions from "./YouTubeChannelActions";
import {useIsAdmin} from "../../lib/authContext";
import {useArtworkPreferences} from "../artwork/preferences";
import {ytdl,type YtdlSettings} from "../settings/ytdl/client";
import type {NativeCatalogEntry,NativeLibrary} from "../../api/nativeLibraries";
vi.mock("../../lib/authContext",()=>({useIsAdmin:vi.fn(()=>true)}));
vi.mock("../artwork/preferences",()=>({useArtworkPreferences:vi.fn(()=>({data:{enabled:true}}))}));
vi.mock("../settings/ytdl/client",()=>({ytdl:{configuration:vi.fn(),submit:vi.fn()}}));
vi.mock("../artwork/ArtworkPanel",()=>({default:({manualOnly,onClose}:{manualOnly:boolean;onClose:()=>void})=><div>Artwork {manualOnly?"Manual only":"Providers"}<button onClick={onClose}>Close artwork</button></div>}));
vi.mock("../../components/NativeCatalogPanel",()=>({EntryEditor:({onSaved}:{onSaved:()=>void})=><button onClick={onSaved}>Save metadata</button>}));
const library:NativeLibrary={id:"youtube",name:"YouTube",library_type:"youtube",anime_content:"both",paths:["YouTube"],revision:1,created_at:"",updated_at:""};
const entry:NativeCatalogEntry={id:"channel",kind:"series",path:"YouTube/Outdoor Boys",parent_path:null,title:"Outdoor Boys",available:true,revision:1,files:[],nfo_path:null,artwork:[],metadata:{youtube:{channel_id:"UCfpCQ89W9wjkHc8J_6eTbBg"}}};
const settings:YtdlSettings={enabled:true,library_id:"other",directory:"different",video_codec:"auto",audio_codec:"auto",container:"mkv",max_height:1080,max_fps:60,fallback:"best",convert:false,subtitles:true,subtitle_languages:["en"],chapters:true,thumbnail:true};
const mount=(item=entry)=>{const updated=vi.fn();render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}})}><YouTubeChannelActions library={library} entry={item} entries={[item]} onUpdated={updated}/></QueryClientProvider>);return updated;};
afterEach(cleanup);
Object.defineProperty(HTMLDialogElement.prototype,"showModal",{configurable:true,value:function(){this.setAttribute("open","");}});
Object.defineProperty(HTMLDialogElement.prototype,"close",{configurable:true,value:function(){this.removeAttribute("open");}});
beforeEach(()=>{vi.clearAllMocks();vi.mocked(useIsAdmin).mockReturnValue(true);vi.mocked(useArtworkPreferences).mockReturnValue({data:{enabled:true}} as ReturnType<typeof useArtworkPreferences>);vi.mocked(ytdl.configuration).mockResolvedValue({settings,dependencies:{yt_dlp:"1",ffmpeg:"1",js_runtime:"1"}});vi.mocked(ytdl.submit).mockResolvedValue({id:"job"});});
describe("YouTube channel management",()=>{
 it("hides management from viewers",()=>{vi.mocked(useIsAdmin).mockReturnValue(false);mount();expect(screen.queryByRole("button")).toBeNull();});
 it("opens the metadata editor and reports saved changes",()=>{const updated=mount();fireEvent.click(screen.getByRole("button",{name:"Edit Metadata"}));fireEvent.click(screen.getByRole("button",{name:"Save metadata"}));expect(updated).toHaveBeenCalledOnce();});
 it("opens only manual artwork editing",()=>{const updated=mount();fireEvent.click(screen.getByRole("button",{name:"Edit Images"}));expect(screen.getByText("Artwork Manual only")).toBeTruthy();fireEvent.click(screen.getByText("Close artwork"));expect(updated).toHaveBeenCalledOnce();});
 it("keeps manual artwork available when automatic fetching is disabled",()=>{vi.mocked(useArtworkPreferences).mockReturnValue({data:{enabled:false}} as ReturnType<typeof useArtworkPreferences>);mount();expect(screen.getByRole("button",{name:"Edit Images"})).toBeTruthy();});
 it("refreshes this channel through YTDL using its actual local parent folder",async()=>{mount();fireEvent.click(screen.getByRole("button",{name:"Refresh"}));await waitFor(()=>expect(ytdl.submit).toHaveBeenCalledWith("https://www.youtube.com/channel/UCfpCQ89W9wjkHc8J_6eTbBg",[],{...settings,library_id:"youtube",directory:"YouTube"},true));expect((await screen.findByRole("status")).textContent).toContain("queued");});
 it("surfaces refresh failures",async()=>{vi.mocked(ytdl.submit).mockRejectedValue(new Error("Download directory is unavailable"));mount();fireEvent.click(screen.getByRole("button",{name:"Refresh"}));expect((await screen.findByRole("alert")).textContent).toContain("Download directory is unavailable");});
 it("does not start an unrelated provider lookup for unidentified channels",async()=>{mount({...entry,metadata:{}});fireEvent.click(screen.getByRole("button",{name:"Refresh"}));expect((await screen.findByRole("alert")).textContent).toContain("no valid YouTube channel ID");expect(ytdl.submit).not.toHaveBeenCalled();});
});


