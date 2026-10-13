import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {YtdlPopup} from "./YtdlPlugin";
import {ytdl,type YtdlSettings} from "./client";
import {nativeLibraries,defaultNativeOptions} from "../../../api/nativeLibraries";
vi.mock("./client",async original=>({...await original<typeof import("./client")>(),ytdl:{configuration:vi.fn(),save:vi.fn(),inspect:vi.fn(),jobs:vi.fn(),submit:vi.fn(),action:vi.fn()}}));
vi.mock("../../../api/nativeLibraries",async original=>({...await original<typeof import("../../../api/nativeLibraries")>(),nativeLibraries:{list:vi.fn(),folders:vi.fn()}}));
const settings:YtdlSettings={enabled:true,library_id:"yt",directory:"YouTube",video_codec:"auto",audio_codec:"auto",container:"mp4",max_height:1080,max_fps:60,fallback:"best",convert:false,subtitles:false,subtitle_languages:["en"],chapters:true,thumbnail:true};
beforeEach(()=>{
 HTMLDialogElement.prototype.showModal=vi.fn(function(this:HTMLDialogElement){this.setAttribute("open","");});
 vi.mocked(ytdl.configuration).mockResolvedValue({settings,dependencies:{yt_dlp:"1",ffmpeg:"7",js_runtime:"1"}});
 vi.mocked(ytdl.jobs).mockResolvedValue([]);
 vi.mocked(ytdl.save).mockImplementation(async value=>value);
 vi.mocked(ytdl.submit).mockResolvedValue({id:"job"});
 vi.mocked(nativeLibraries.list).mockResolvedValue([{id:"yt",name:"YouTube",library_type:"youtube",anime_content:"both",paths:["YouTube"],options:{...defaultNativeOptions,youtube_channels:["@channel"],youtube_mode:"single_channel"},revision:1,created_at:"",updated_at:""}]);
 vi.mocked(nativeLibraries.folders).mockResolvedValue({root:"/media",path:"",folders:[]});
});
afterEach(()=>{cleanup();vi.clearAllMocks();});
function mount(){render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><YtdlPopup onClose={()=>{}}/></QueryClientProvider>);}
it("saves codec and fallback settings through the plugin popup",async()=>{
 mount();await screen.findByLabelText("Video codec");
 fireEvent.change(screen.getByLabelText("Video codec"),{target:{value:"av1"}});
 fireEvent.change(screen.getByLabelText("Unavailable format"),{target:{value:"strict"}});
 fireEvent.click(screen.getByRole("button",{name:"Save configuration"}));
 await waitFor(()=>expect(ytdl.save).toHaveBeenCalledWith({...settings,video_codec:"av1",fallback:"strict"}));
 expect((await screen.findByRole("status")).textContent).toBe("Configuration saved.");
});
it("inspects a playlist and queues only selected videos with its settings snapshot",async()=>{
 vi.mocked(ytdl.inspect).mockResolvedValue({id:"pl",title:"Playlist",description:"Playlist description",channel:"Channel",channel_id:"ch",kind:"playlist",formats:[],entries:["a","b"].map(id=>({id,url:`https://www.youtube.com/watch?v=${id}`,title:`Video ${id}`,description:"A description",channel:"Channel",channel_id:"ch",duration:120,upload_date:"20260101",thumbnail:null,playlist_id:"pl",playlist_title:"Playlist",playlist_index:1}))});
 mount();await screen.findByLabelText("Video codec");
 fireEvent.click(screen.getByRole("button",{name:"Downloads"}));
 fireEvent.change(screen.getByLabelText("YouTube URL"),{target:{value:"https://www.youtube.com/playlist?list=pl"}});
 fireEvent.click(screen.getByRole("button",{name:"Fetch Info"}));
 fireEvent.click(await screen.findByRole("checkbox",{name:"Select Video b"}));
 fireEvent.click(screen.getByRole("button",{name:"Download 1 selected"}));
 await waitFor(()=>expect(ytdl.submit).toHaveBeenCalledWith("https://www.youtube.com/playlist?list=pl",["a"],settings));
 expect(screen.getByRole("button",{name:"Queue"}).getAttribute("aria-pressed")).toBe("true");
});
it("shows job failure and retries the saved job",async()=>{
 const job={id:"job",url:"https://youtube.com/watch?v=a",title:"Video a",status:"failed",progress:null,speed:null,eta:null,error:"Format unavailable",created_at:"",settings};
 vi.mocked(ytdl.jobs).mockResolvedValue([job]);vi.mocked(ytdl.action).mockResolvedValue({...job,status:"queued"});
 mount();fireEvent.click(screen.getByRole("button",{name:"Queue"}));
 expect(await screen.findByText("Format unavailable")).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Retry"}));
 await waitFor(()=>expect(ytdl.action).toHaveBeenCalledWith("job","retry"));
});

it("drills from a channel into its playlist before allowing downloads",async()=>{
 const entry={id:"pl",url:"https://www.youtube.com/playlist?list=pl",title:"Channel playlist",description:"",channel:"Channel",channel_id:"ch",duration:null,upload_date:"",thumbnail:null,playlist_id:"pl",playlist_title:"Channel playlist",playlist_index:null,kind:"playlist" as const};
 vi.mocked(ytdl.inspect).mockResolvedValueOnce({id:"ch",title:"Channel",description:"",channel:"Channel",channel_id:"ch",kind:"channel",formats:[],entries:[entry]}).mockResolvedValueOnce({id:"pl",title:"Playlist",description:"",channel:"Channel",channel_id:"ch",kind:"playlist",formats:[],entries:[]});
 mount();await screen.findByLabelText("Video codec");fireEvent.click(screen.getByRole("button",{name:"Downloads"}));
 fireEvent.change(screen.getByLabelText("YouTube URL"),{target:{value:"https://www.youtube.com/@channel"}});fireEvent.click(screen.getByRole("button",{name:"Fetch Info"}));
 fireEvent.click(await screen.findByRole("button",{name:"Open playlist Channel playlist"}));
 await waitFor(()=>expect(ytdl.inspect).toHaveBeenLastCalledWith(entry.url));
 expect((screen.getByLabelText("YouTube URL") as HTMLInputElement).value).toBe(entry.url);
});
it("permits the library media root and retries interrupted downloads",async()=>{
 const rootSettings={...settings,directory:""};vi.mocked(ytdl.configuration).mockResolvedValue({settings:rootSettings,dependencies:{yt_dlp:"1",ffmpeg:"7",js_runtime:"1"}});
 vi.mocked(nativeLibraries.list).mockResolvedValue([{id:"yt",name:"YouTube",library_type:"youtube",anime_content:"both",paths:[""],options:defaultNativeOptions,revision:1,created_at:"",updated_at:""}]);
 const job={id:"interrupted",url:"https://youtube.com/watch?v=a",title:"Interrupted video",status:"interrupted",progress:null,speed:null,eta:null,error:null,created_at:"",settings:rootSettings};vi.mocked(ytdl.jobs).mockResolvedValue([job]);vi.mocked(ytdl.action).mockResolvedValue({...job,status:"queued"});
 mount();await screen.findByLabelText("Video codec");expect((screen.getByRole("button",{name:"Save configuration"}) as HTMLButtonElement).disabled).toBe(false);
 fireEvent.click(screen.getByRole("button",{name:"Queue"}));fireEvent.click(await screen.findByRole("button",{name:"Retry"}));await waitFor(()=>expect(ytdl.action).toHaveBeenCalledWith("interrupted","retry"));
});


it("keeps the library editor inside the modal popup",async()=>{
 mount();await screen.findByLabelText("Video codec");
 fireEvent.click(screen.getByRole("button",{name:"Create YouTube library"}));
 const editor=await screen.findByRole("dialog",{name:"Create library"});
 expect(screen.getByRole("dialog",{name:"YTDL configuration"}).contains(editor)).toBe(true);
});
it("saves a filename convention and previews the selected container",async()=>{
 mount();const convention=await screen.findByLabelText("Filename convention");
 expect((convention as HTMLSelectElement).value).toBe("id");
 fireEvent.change(convention,{target:{value:"date_title_id"}});
 fireEvent.change(screen.getByLabelText("Container"),{target:{value:"mkv"}});
 expect(screen.getByText("Example: 2026-01-02 - Example video [abc123].mkv")).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Save configuration"}));
 await waitFor(()=>expect(ytdl.save).toHaveBeenCalledWith({...settings,filename_convention:"date_title_id",container:"mkv"}));
});

it.each([["title","Example video"],["date_title","2026-01-02 - Example video"]])("saves ID-free filename option %s",async(value,example)=>{
 mount();const convention=await screen.findByLabelText("Filename convention");
 fireEvent.change(convention,{target:{value}});
 expect(screen.getByText(`Example: ${example}.mp4`)).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Save configuration"}));
 await waitFor(()=>expect(ytdl.save).toHaveBeenCalledWith({...settings,filename_convention:value}));
});
