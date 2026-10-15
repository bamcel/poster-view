import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {YtdlPopup} from "./YtdlPlugin";
import {ytdl,type YtdlSettings,type YtdlJob} from "./client";
import {nativeLibraries,defaultNativeOptions} from "../../../api/nativeLibraries";
vi.mock("./client",async original=>({...await original<typeof import("./client")>(),ytdl:{configuration:vi.fn(),save:vi.fn(),inspect:vi.fn(),jobs:vi.fn(),submit:vi.fn(),action:vi.fn()}}));
vi.mock("../../../api/nativeLibraries",async original=>({...await original<typeof import("../../../api/nativeLibraries")>(),nativeLibraries:{list:vi.fn(),folders:vi.fn()}}));
const settings:YtdlSettings={enabled:true,library_id:"",directory:"YouTube",video_codec:"auto",audio_codec:"auto",container:"mp4",max_height:1080,max_fps:60,fallback:"best",convert:false,subtitles:false,subtitle_languages:["en"],chapters:true,thumbnail:true};
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
it("restores the active queue when reopened and minimizes without cancelling",async()=>{
 vi.mocked(ytdl.jobs).mockResolvedValue([{id:"existing",title:"Active playlist",status:"downloading",progress:42,total_videos:7,completed_videos:1,current_video_title:"Second video",settings}] as YtdlJob[]);
 const onClose=vi.fn();
 render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><YtdlPopup onClose={onClose}/></QueryClientProvider>);
 expect(await screen.findByText("Active playlist")).toBeTruthy();
 expect(screen.getByText("1 of 7 videos complete · Second video")).toBeTruthy();
 expect(screen.getByRole("button",{name:"Queue"}).getAttribute("aria-pressed")).toBe("true");
 fireEvent.click(screen.getByRole("button",{name:"Minimize downloads"}));
 expect(onClose).toHaveBeenCalledOnce();expect(ytdl.submit).not.toHaveBeenCalled();expect(ytdl.action).not.toHaveBeenCalled();
});
it("saves codec and fallback settings through the plugin popup",async()=>{
 mount();await screen.findByLabelText("Video codec");
 fireEvent.change(screen.getByLabelText("Video codec"),{target:{value:"av1"}});
 fireEvent.change(screen.getByLabelText("If quality is unavailable"),{target:{value:"skip"}});
 fireEvent.click(screen.getByRole("button",{name:"Save configuration"}));
 await waitFor(()=>expect(ytdl.save).toHaveBeenCalledWith({...settings,video_codec:"av1",quality:1080,fallback:"skip"}));
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


it("uses library settings for setup and browses download folders in a dropdown",async()=>{
 vi.mocked(nativeLibraries.folders).mockImplementation(async path=>({root:"/media",path,folders:path==="YouTube"?[{name:"Downloads",path:"YouTube/Downloads",has_nfo:false}]:[]}));
 mount();await screen.findByLabelText("Video codec");
 expect(screen.queryByLabelText("YouTube library")).toBeNull();
 expect(screen.queryByRole("button",{name:"Create YouTube library"})).toBeNull();
 expect(screen.queryByRole("button",{name:"Edit channels and library"})).toBeNull();
 fireEvent.click(screen.getByLabelText("Download directory"));
 fireEvent.click(await screen.findByRole("button",{name:"Open folder Downloads"}));
 await waitFor(()=>expect(nativeLibraries.folders).toHaveBeenCalledWith("YouTube/Downloads"));
 await waitFor(()=>expect((screen.getByRole("button",{name:"Select This Folder"}) as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(screen.getByRole("button",{name:"Select This Folder"}));
 fireEvent.click(screen.getByRole("button",{name:"Save configuration"}));
 await waitFor(()=>expect(ytdl.save).toHaveBeenCalledWith({...settings,directory:"YouTube/Downloads"}));
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

it("saves HEVC conversion settings",async()=>{
 mount();await screen.findByLabelText("Video codec");
 fireEvent.change(screen.getByLabelText("Video codec"),{target:{value:"hevc"}});
 fireEvent.click(screen.getByLabelText("Convert to selected codecs"));
 fireEvent.click(screen.getByRole("button",{name:"Save configuration"}));
 await waitFor(()=>expect(ytdl.save).toHaveBeenCalledWith({...settings,video_codec:"hevc",convert:true}));
});

it("shows default CRF only during conversion and saves a custom value",async()=>{
 mount();await screen.findByLabelText("Convert to selected codecs");
 expect(screen.queryByLabelText("CRF")).toBeNull();
 fireEvent.click(screen.getByLabelText("Convert to selected codecs"));
 expect((screen.getByLabelText("CRF") as HTMLInputElement).value).toBe("23");
 fireEvent.change(screen.getByLabelText("CRF"),{target:{value:"19"}});
 fireEvent.click(screen.getByRole("button",{name:"Save configuration"}));
 await waitFor(()=>expect(ytdl.save).toHaveBeenCalledWith({...settings,convert:true,crf:19}));
 fireEvent.click(screen.getByLabelText("Convert to selected codecs"));
 expect(screen.queryByLabelText("CRF")).toBeNull();
});

it.each([720,1440])("saves %s quality and nearest higher fallback",async(quality)=>{
 mount();await screen.findByLabelText("Quality");
 fireEvent.change(screen.getByLabelText("Quality"),{target:{value:String(quality)}});
 fireEvent.change(screen.getByLabelText("If quality is unavailable"),{target:{value:"next_highest"}});
 fireEvent.click(screen.getByRole("button",{name:"Save configuration"}));
 await waitFor(()=>expect(ytdl.save).toHaveBeenCalledWith({...settings,quality,fallback:"next_highest"}));
});

it("saves a download destination without any media library",async()=>{
 vi.mocked(nativeLibraries.list).mockResolvedValue([]);
 mount();await screen.findByLabelText("Video codec");
 fireEvent.click(screen.getByRole("button",{name:"Save configuration"}));
 await waitFor(()=>expect(ytdl.save).toHaveBeenCalledWith(settings));
 expect(nativeLibraries.list).not.toHaveBeenCalled();
});
