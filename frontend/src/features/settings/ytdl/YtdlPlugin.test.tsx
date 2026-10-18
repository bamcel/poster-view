import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {apiRequest} from "../../../api/client";
import {YtdlPopup} from "./YtdlPlugin";
import {ytdl,type YtdlSettings,type YtdlJob} from "./client";
import {nativeLibraries,defaultNativeOptions} from "../../../api/nativeLibraries";
vi.mock("../../../api/client",async original=>({...await original<typeof import("../../../api/client")>(),apiRequest:vi.fn()}));
vi.mock("./client",async original=>({...await original<typeof import("./client")>(),ytdlCookies:{status:vi.fn().mockResolvedValue({configured:false,updated_at:null})},ytdl:{configuration:vi.fn(),save:vi.fn(),inspect:vi.fn(),jobs:vi.fn(),submit:vi.fn(),action:vi.fn(),remove:vi.fn()}}));
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
function mount(){render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><YtdlPopup initialTab="Settings" onClose={()=>{}}/></QueryClientProvider>);}
it("shows current-video encoding progress in the queue",async()=>{
 vi.mocked(ytdl.jobs).mockResolvedValue([{id:"encoding",title:"Encoding video",status:"processing",progress:40,encoding_progress:32.1,settings}] as YtdlJob[]);
 mount();
 expect(await screen.findByText("Encoding · 32.1%")).toBeTruthy();
 expect(screen.getByRole("progressbar",{name:"Encoding progress for Encoding video"}).getAttribute("value")).toBe("32.1");
});
it("removes a queue card and refreshes the shared persisted queue",async()=>{
 vi.mocked(ytdl.jobs).mockResolvedValueOnce([{id:"existing",title:"Playlist to remove",status:"downloading",progress:20,settings}] as YtdlJob[]).mockResolvedValue([]);
 vi.mocked(ytdl.remove).mockResolvedValue(undefined);
 mount();
 fireEvent.click(await screen.findByRole("button",{name:"Remove Playlist to remove"}));
 await waitFor(()=>expect(ytdl.remove).toHaveBeenCalledWith("existing",expect.anything()));
 await waitFor(()=>expect(screen.queryByText("Playlist to remove")).toBeNull());
 expect(screen.getByText(/Finished history is cleaned after seven days/)).toBeTruthy();
});
it("restores the active queue when reopened and minimizes without cancelling",async()=>{
 vi.mocked(ytdl.jobs).mockResolvedValue([{id:"existing",title:"Active playlist",status:"downloading",progress:42,total_videos:7,completed_videos:1,current_video_title:"Second video",settings}] as YtdlJob[]);
 const onClose=vi.fn();
 render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><YtdlPopup onClose={onClose}/></QueryClientProvider>);
 expect(await screen.findByText("Active playlist")).toBeTruthy();
 expect(screen.getByText("1 of 7 videos processed · Second video")).toBeTruthy();
 expect(screen.getByRole("button",{name:"Activity"}).getAttribute("aria-pressed")).toBe("true");
 fireEvent.click(screen.getByRole("button",{name:"Close YTDL"}));
 expect(onClose).toHaveBeenCalledOnce();expect(ytdl.submit).not.toHaveBeenCalled();expect(ytdl.action).not.toHaveBeenCalled();
});
it("saves codec and fallback settings through the plugin popup",async()=>{
 mount();await screen.findByLabelText("Video codec");
 fireEvent.change(screen.getByLabelText("Video codec"),{target:{value:"av1"}});
 fireEvent.change(screen.getByLabelText("If quality is unavailable"),{target:{value:"skip"}});

 await waitFor(()=>expect(ytdl.save).toHaveBeenCalledWith({...settings,video_codec:"av1",quality:1080,fallback:"skip"}));
 expect((await screen.findByRole("status")).textContent).toBe("Changes saved automatically");
});
it("inspects a playlist and queues only selected videos with its settings snapshot",async()=>{
 vi.mocked(ytdl.inspect).mockResolvedValue({id:"pl",title:"Playlist",description:"Playlist description",channel:"Channel",channel_id:"ch",kind:"playlist",formats:[],entries:["a","b"].map(id=>({id,url:`https://www.youtube.com/watch?v=${id}`,title:`Video ${id}`,description:"A description",channel:"Channel",channel_id:"ch",duration:120,upload_date:"20260101",thumbnail:null,playlist_id:"pl",playlist_title:"Playlist",playlist_index:1}))});
 mount();await screen.findByLabelText("Video codec");
 fireEvent.click(screen.getByRole("button",{name:"Download"}));
 fireEvent.change(screen.getByLabelText("YouTube URL"),{target:{value:"https://www.youtube.com/playlist?list=pl"}});
 fireEvent.click(screen.getByRole("button",{name:"Fetch Info"}));
 fireEvent.click(await screen.findByRole("checkbox",{name:"Select Video b"}));
 fireEvent.click(screen.getByRole("button",{name:"Download 1 selected"}));
 await waitFor(()=>expect(ytdl.submit).toHaveBeenCalledWith("https://www.youtube.com/playlist?list=pl",["a"],settings,false));
 expect(screen.getByRole("button",{name:"Activity"}).getAttribute("aria-pressed")).toBe("true");
});
it("shows job failure and retries the saved job",async()=>{
 const job={id:"job",url:"https://youtube.com/watch?v=a",title:"Video a",status:"failed",progress:null,speed:null,eta:null,error:"Format unavailable",created_at:"",settings};
 vi.mocked(ytdl.jobs).mockResolvedValue([job]);vi.mocked(ytdl.action).mockResolvedValue({...job,status:"queued"});
 mount();fireEvent.click(screen.getByRole("button",{name:"Activity"}));
 expect(await screen.findByText("Format unavailable")).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Retry job"}));
 await waitFor(()=>expect(ytdl.action).toHaveBeenCalledWith("job","retry"));
});

it("drills from a channel into its playlist before allowing downloads",async()=>{
 const entry={id:"pl",url:"https://www.youtube.com/playlist?list=pl",title:"Channel playlist",description:"",channel:"Channel",channel_id:"ch",duration:null,upload_date:"",thumbnail:null,playlist_id:"pl",playlist_title:"Channel playlist",playlist_index:null,kind:"playlist" as const};
 vi.mocked(ytdl.inspect).mockResolvedValueOnce({id:"ch",title:"Channel",description:"",channel:"Channel",channel_id:"ch",kind:"channel",formats:[],entries:[entry]}).mockResolvedValueOnce({id:"pl",title:"Playlist",description:"",channel:"Channel",channel_id:"ch",kind:"playlist",formats:[],entries:[]});
 mount();await screen.findByLabelText("Video codec");fireEvent.click(screen.getByRole("button",{name:"Download"}));
 fireEvent.change(screen.getByLabelText("YouTube URL"),{target:{value:"https://www.youtube.com/@channel"}});fireEvent.click(screen.getByRole("button",{name:"Fetch Info"}));
 fireEvent.click(await screen.findByRole("button",{name:"Open playlist Channel playlist"}));
 await waitFor(()=>expect(ytdl.inspect).toHaveBeenLastCalledWith(entry.url));
 expect((screen.getByLabelText("YouTube URL") as HTMLInputElement).value).toBe(entry.url);
});
it("permits the library media root and retries interrupted downloads",async()=>{
 const rootSettings={...settings,directory:""};vi.mocked(ytdl.configuration).mockResolvedValue({settings:rootSettings,dependencies:{yt_dlp:"1",ffmpeg:"7",js_runtime:"1"}});
 vi.mocked(nativeLibraries.list).mockResolvedValue([{id:"yt",name:"YouTube",library_type:"youtube",anime_content:"both",paths:[""],options:defaultNativeOptions,revision:1,created_at:"",updated_at:""}]);
 const job={id:"interrupted",url:"https://youtube.com/watch?v=a",title:"Interrupted video",status:"interrupted",progress:null,speed:null,eta:null,error:null,created_at:"",settings:rootSettings};vi.mocked(ytdl.jobs).mockResolvedValue([job]);vi.mocked(ytdl.action).mockResolvedValue({...job,status:"queued"});
 mount();await screen.findByLabelText("Video codec");expect(screen.queryByRole("button",{name:"Save defaults"})).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"Activity"}));fireEvent.click(await screen.findByRole("button",{name:"Retry job"}));await waitFor(()=>expect(ytdl.action).toHaveBeenCalledWith("interrupted","retry"));
});


it("uses library settings for setup and browses download folders in a dropdown",async()=>{
 vi.mocked(nativeLibraries.folders).mockImplementation(async path=>({root:"/media",path,folders:path==="YouTube"?[{name:"Downloads",path:"YouTube/Downloads",has_nfo:false}]:[]}));
 mount();await screen.findByLabelText("Video codec");
 expect(screen.queryByLabelText("YouTube library")).toBeNull();
 expect(screen.queryByRole("button",{name:"Create YouTube library"})).toBeNull();
 expect(screen.queryByRole("button",{name:"Edit channels and library"})).toBeNull();
 fireEvent.click(screen.getByLabelText("Download directory"));
 fireEvent.doubleClick(await screen.findByRole("button",{name:"Open folder Downloads"}));
 await waitFor(()=>expect(nativeLibraries.folders).toHaveBeenCalledWith("YouTube/Downloads"));
 await waitFor(()=>expect((screen.getByRole("button",{name:"Select This Folder"}) as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(screen.getByRole("button",{name:"Select This Folder"}));

 await waitFor(()=>expect(ytdl.save).toHaveBeenCalledWith({...settings,directory:"YouTube/Downloads"}));
});
it("saves a filename convention and previews the selected container",async()=>{
 mount();const convention=await screen.findByLabelText("Filename convention");
 expect((convention as HTMLSelectElement).value).toBe("id");
 fireEvent.change(convention,{target:{value:"date_title_id"}});
 fireEvent.change(screen.getByLabelText("Container"),{target:{value:"mkv"}});
 expect(screen.getByText("Example: 2026-01-02 - Example video [abc123].mkv")).toBeTruthy();

 await waitFor(()=>expect(ytdl.save).toHaveBeenCalledWith({...settings,filename_convention:"date_title_id",container:"mkv"}));
});

it.each([["title","Example video"],["date_title","2026-01-02 - Example video"]])("saves ID-free filename option %s",async(value,example)=>{
 mount();const convention=await screen.findByLabelText("Filename convention");
 fireEvent.change(convention,{target:{value}});
 expect(screen.getByText(`Example: ${example}.mp4`)).toBeTruthy();

 await waitFor(()=>expect(ytdl.save).toHaveBeenCalledWith({...settings,filename_convention:value}));
});

it("saves HEVC conversion settings",async()=>{
 mount();await screen.findByLabelText("Video codec");
 fireEvent.change(screen.getByLabelText("Video codec"),{target:{value:"hevc"}});
 fireEvent.click(screen.getByLabelText("Convert to selected codecs"));

 await waitFor(()=>expect(ytdl.save).toHaveBeenCalledWith({...settings,video_codec:"hevc",convert:true}));
});

it("shows default CRF only during conversion and saves a custom value",async()=>{
 mount();await screen.findByLabelText("Convert to selected codecs");
 expect(screen.queryByLabelText("CRF")).toBeNull();
 fireEvent.click(screen.getByLabelText("Convert to selected codecs"));
 expect((screen.getByLabelText("CRF") as HTMLInputElement).value).toBe("23");
 fireEvent.change(screen.getByLabelText("CRF"),{target:{value:"19"}});

 await waitFor(()=>expect(ytdl.save).toHaveBeenCalledWith({...settings,convert:true,crf:19}));
 fireEvent.click(screen.getByLabelText("Convert to selected codecs"));
 expect(screen.queryByLabelText("CRF")).toBeNull();
});

it.each([720,1440])("saves %s quality and nearest higher fallback",async(quality)=>{
 mount();await screen.findByLabelText("Quality");
 fireEvent.change(screen.getByLabelText("Quality"),{target:{value:String(quality)}});
 fireEvent.change(screen.getByLabelText("If quality is unavailable"),{target:{value:"next_highest"}});

 await waitFor(()=>expect(ytdl.save).toHaveBeenCalledWith({...settings,quality,fallback:"next_highest"}));
});

it("saves a download destination without any media library",async()=>{
 vi.mocked(nativeLibraries.list).mockResolvedValue([]);
 mount();await screen.findByLabelText("Video codec");

 expect(ytdl.save).not.toHaveBeenCalled();
 expect(nativeLibraries.list).not.toHaveBeenCalled();
});

it("shows GPU controls only for conversion and saves backend and quality",async()=>{
 mount();await screen.findByLabelText("Video codec");
 expect(screen.queryByLabelText("Encoding device")).toBeNull();
 expect(apiRequest).not.toHaveBeenCalled();
 fireEvent.change(screen.getByLabelText("Video codec"),{target:{value:"hevc"}});
 fireEvent.click(screen.getByLabelText("Convert to selected codecs"));
 fireEvent.change(screen.getByLabelText("Encoding device"),{target:{value:"nvenc"}});
 expect(screen.queryByLabelText("CRF")).toBeNull();
 expect((screen.getByLabelText("Encoding quality") as HTMLInputElement).value).toBe("23");
 fireEvent.change(screen.getByLabelText("Encoding quality"),{target:{value:"25"}});

 await waitFor(()=>expect(ytdl.save).toHaveBeenCalledWith({...settings,convert:true,video_codec:"hevc",hardware_backend:"nvenc",crf:25}));
});
it("requires an explicit supported codec for GPU encoding",async()=>{
 mount();await screen.findByLabelText("Video codec");
 fireEvent.click(screen.getByLabelText("Convert to selected codecs"));
 fireEvent.change(screen.getByLabelText("Encoding device"),{target:{value:"qsv"}});
 expect(screen.getByRole("alert").textContent).toContain("GPU encoding requires");
 expect(screen.queryByRole("button",{name:"Save defaults"})).toBeNull();
 expect((screen.getByLabelText("Video codec") as HTMLSelectElement).value).toBe("auto");
 fireEvent.change(screen.getByLabelText("Video codec"),{target:{value:"vp9"}});
 expect(screen.queryByRole("button",{name:"Save defaults"})).toBeNull();
 fireEvent.change(screen.getByLabelText("Video codec"),{target:{value:"h264"}});
 expect(screen.queryByRole("button",{name:"Save defaults"})).toBeNull();
});
it("tests hardware on request and displays availability and setup help",async()=>{
 vi.mocked(apiRequest).mockResolvedValue({encoders:[{name:"hevc_nvenc",backend:"nvenc",codec:"hevc",available:false,detail:"GPU test failed."}],hardware_help:{nvenc:"Configure NVIDIA GPU access."}});
 mount();await screen.findByLabelText("Video codec");
 fireEvent.click(screen.getByLabelText("Convert to selected codecs"));
 fireEvent.change(screen.getByLabelText("Encoding device"),{target:{value:"nvenc"}});
 fireEvent.change(screen.getByLabelText("Video codec"),{target:{value:"hevc"}});
 expect(apiRequest).not.toHaveBeenCalled();
 fireEvent.click(screen.getByText("Diagnostics"));fireEvent.click(screen.getByRole("button",{name:"Test hardware encoders"}));
 expect(await screen.findByText("hevc_nvenc: Unavailable. GPU test failed.")).toBeTruthy();
 expect(screen.getByText("Configure NVIDIA GPU access.")).toBeTruthy();
 expect(apiRequest).toHaveBeenCalledWith("/playback/capabilities");
});


it("switches direct mode without discarding custom encoding preferences",async()=>{
 const custom:YtdlSettings={...settings,video_codec:"hevc",audio_codec:"opus",container:"webm",convert:true,hardware_backend:"nvenc",crf:19};
 vi.mocked(ytdl.configuration).mockResolvedValue({settings:custom,dependencies:{yt_dlp:null,ffmpeg:null,js_runtime:null}});
 mount();await screen.findByLabelText("Download mode");
 expect((screen.getByLabelText("Download mode") as HTMLSelectElement).value).toBe("custom");
 fireEvent.change(screen.getByLabelText("Download mode"),{target:{value:"direct"}});
 for(const label of ["Video codec","Audio codec","Container","Maximum frame rate","Convert to selected codecs","Encoding device","Encoding quality"])expect(screen.queryByLabelText(label)).toBeNull();
 for(const label of ["Quality","If quality is unavailable","Download subtitles","Include chapters","Download thumbnail","Subtitle languages"])expect(screen.getByLabelText(label)).toBeTruthy();
 expect(screen.getByText("Example: abc123.mkv")).toBeTruthy();

 await waitFor(()=>expect(ytdl.save).toHaveBeenCalledWith({...custom,download_mode:"direct"}));
 await screen.findByText("Changes saved automatically");
 fireEvent.change(screen.getByLabelText("Download mode"),{target:{value:"custom"}});
 expect((screen.getByLabelText("Video codec") as HTMLSelectElement).value).toBe("hevc");
 expect((screen.getByLabelText("Audio codec") as HTMLSelectElement).value).toBe("opus");
 expect((screen.getByLabelText("Container") as HTMLSelectElement).value).toBe("webm");
 expect((screen.getByLabelText("Encoding device") as HTMLSelectElement).value).toBe("nvenc");
 expect((screen.getByLabelText("Encoding quality") as HTMLInputElement).value).toBe("19");
});

it("queues direct mode even with incompatible retained custom GPU settings",async()=>{
 const custom:YtdlSettings={...settings,convert:true,hardware_backend:"nvenc"};
 vi.mocked(ytdl.configuration).mockResolvedValue({settings:custom,dependencies:{yt_dlp:null,ffmpeg:null,js_runtime:null}});
 vi.mocked(ytdl.inspect).mockResolvedValue({id:"a",title:"Video",description:"",channel:"Channel",channel_id:"ch",kind:"video",formats:[],entries:[{id:"a",url:"https://www.youtube.com/watch?v=a",title:"Video a",description:"",channel:"Channel",channel_id:"ch",duration:120,upload_date:"20260101",thumbnail:null,playlist_id:"",playlist_title:"",playlist_index:null}]});
 mount();await screen.findByLabelText("Download mode");
 expect(screen.queryByRole("button",{name:"Save defaults"})).toBeNull();
 fireEvent.change(screen.getByLabelText("Download mode"),{target:{value:"direct"}});
 expect(screen.queryByRole("alert")).toBeNull();
 expect(screen.queryByRole("button",{name:"Save defaults"})).toBeNull();
 await screen.findByText("Changes saved automatically");fireEvent.click(screen.getByRole("button",{name:"Download"}));
 fireEvent.change(screen.getByLabelText("YouTube URL"),{target:{value:"https://www.youtube.com/watch?v=a"}});
 fireEvent.click(screen.getByRole("button",{name:"Fetch Info"}));
 fireEvent.click(await screen.findByRole("button",{name:"Download 1 selected"}));
 await waitFor(()=>expect(ytdl.submit).toHaveBeenCalledWith("https://www.youtube.com/watch?v=a",["a"],{...custom,download_mode:"direct"},false));
});

it("refreshes channel NFOs without inspection or valid encoding settings",async()=>{
 const custom={...settings,convert:true,hardware_backend:"nvenc" as const};
 vi.mocked(ytdl.configuration).mockResolvedValue({settings:custom,dependencies:{yt_dlp:null,ffmpeg:null,js_runtime:null}});
 mount();await screen.findByLabelText("Video codec");fireEvent.click(screen.getByRole("button",{name:"Download"}));fireEvent.change(screen.getByLabelText("Operation"),{target:{value:"metadata"}});
 expect((screen.getByRole("button",{name:"Refresh existing NFOs"}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.change(screen.getByLabelText("YouTube URL"),{target:{value:"https://www.youtube.com/@channel"}});fireEvent.click(screen.getByRole("button",{name:"Refresh existing NFOs"}));
 await waitFor(()=>expect(ytdl.submit).toHaveBeenCalledWith("https://www.youtube.com/@channel",[],custom,true));expect(ytdl.inspect).not.toHaveBeenCalled();
});
it("prevents duplicate refresh submissions and displays failures",async()=>{
 let reject!:(error:Error)=>void;vi.mocked(ytdl.submit).mockImplementationOnce(()=>new Promise((_,fail)=>{reject=fail;}));
 mount();await screen.findByLabelText("Video codec");fireEvent.click(screen.getByRole("button",{name:"Download"}));fireEvent.change(screen.getByLabelText("Operation"),{target:{value:"metadata"}});
 fireEvent.change(screen.getByLabelText("YouTube URL"),{target:{value:"https://www.youtube.com/@channel"}});fireEvent.click(screen.getByRole("button",{name:"Refresh existing NFOs"}));
 expect((await screen.findByRole("button",{name:"Queueing…"}) as HTMLButtonElement).disabled).toBe(true);
 reject(new Error("Metadata unavailable"));expect((await screen.findByRole("alert")).textContent).toBe("Metadata unavailable");
});
it("saves skip existing videos in either download mode",async()=>{
 mount();await screen.findByLabelText("Skip existing videos");fireEvent.click(screen.getByLabelText("Skip existing videos"));fireEvent.change(screen.getByLabelText("Download mode"),{target:{value:"direct"}});
 expect((screen.getByLabelText("Skip existing videos") as HTMLInputElement).checked).toBe(true);
 await waitFor(()=>expect(ytdl.save).toHaveBeenCalledWith({...settings,skip_existing:true,download_mode:"direct"}));
});
it("serializes metadata mode and skip existing without changing normal submission defaults",async()=>{
 const actual=await vi.importActual<typeof import("./client")>("./client");vi.mocked(apiRequest).mockResolvedValue({id:"job"});
 await actual.ytdl.submit("https://youtube.com/watch?v=a",[],settings,true);
 expect(apiRequest).toHaveBeenLastCalledWith("/plugins/ytdl/jobs",{method:"POST",body:JSON.stringify({url:"https://youtube.com/watch?v=a",video_ids:[],settings,metadata_only:true})});
 await actual.ytdl.submit("https://youtube.com/watch?v=a",["a"],{...settings,skip_existing:true});
 expect(apiRequest).toHaveBeenLastCalledWith("/plugins/ytdl/jobs",{method:"POST",body:JSON.stringify({url:"https://youtube.com/watch?v=a",video_ids:["a"],settings:{...settings,skip_existing:true},metadata_only:false})});
});

it("refreshes selected playlist entries and disables an empty selection",async()=>{
 vi.mocked(ytdl.inspect).mockResolvedValue({id:"pl",title:"Playlist",description:"",channel:"Channel",channel_id:"ch",kind:"playlist",formats:[],entries:["a","b"].map(id=>({id,url:`https://www.youtube.com/watch?v=${id}`,title:`Video ${id}`,description:"",channel:"Channel",channel_id:"ch",duration:null,upload_date:"",thumbnail:null,playlist_id:"pl",playlist_title:"Playlist",playlist_index:1}))});
 mount();await screen.findByLabelText("Video codec");fireEvent.click(screen.getByRole("button",{name:"Download"}));fireEvent.change(screen.getByLabelText("Operation"),{target:{value:"metadata"}});fireEvent.change(screen.getByLabelText("YouTube URL"),{target:{value:"https://www.youtube.com/playlist?list=pl"}});fireEvent.click(screen.getByRole("button",{name:"Fetch Info"}));await screen.findByRole("checkbox",{name:"Select Video b"});
 fireEvent.click(screen.getByRole("button",{name:"Clear selection"}));expect((screen.getByRole("button",{name:"Refresh existing NFOs"}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByRole("checkbox",{name:"Select Video a"}));fireEvent.click(screen.getByRole("button",{name:"Refresh existing NFOs"}));await waitFor(()=>expect(ytdl.submit).toHaveBeenCalledWith("https://www.youtube.com/playlist?list=pl",["a"],settings,true));
});
it.each([{enabled:false,directory:"YouTube"}])("disables NFO refresh for unavailable settings %j",async overrides=>{
 vi.mocked(ytdl.configuration).mockResolvedValue({settings:{...settings,...overrides},dependencies:{yt_dlp:null,ffmpeg:null,js_runtime:null}});
 mount();await screen.findByLabelText("Video codec");fireEvent.click(screen.getByRole("button",{name:"Download"}));fireEvent.change(screen.getByLabelText("Operation"),{target:{value:"metadata"}});fireEvent.change(screen.getByLabelText("YouTube URL"),{target:{value:"https://www.youtube.com/@channel"}});
 expect((screen.getByRole("button",{name:"Refresh existing NFOs"}) as HTMLButtonElement).disabled).toBe(true);
});

it("permits the media root for NFO refresh",async()=>{
 vi.mocked(ytdl.configuration).mockResolvedValue({settings:{...settings,directory:""},dependencies:{yt_dlp:null,ffmpeg:null,js_runtime:null}});
 mount();await screen.findByLabelText("Video codec");fireEvent.click(screen.getByRole("button",{name:"Download"}));fireEvent.change(screen.getByLabelText("Operation"),{target:{value:"metadata"}});fireEvent.change(screen.getByLabelText("YouTube URL"),{target:{value:"https://www.youtube.com/@channel"}});
 fireEvent.click(screen.getByRole("button",{name:"Refresh existing NFOs"}));await waitFor(()=>expect(ytdl.submit).toHaveBeenCalledWith("https://www.youtube.com/@channel",[],{...settings,directory:""},true));
});


it("keeps unsaved defaults out of job overrides and does not persist overrides",async()=>{
 mount();await screen.findByLabelText("Quality");fireEvent.change(screen.getByLabelText("Quality"),{target:{value:"720"}});fireEvent.click(screen.getByRole("button",{name:"Download"}));
 expect(screen.getByText(/1080p/)).toBeTruthy();fireEvent.click(screen.getByLabelText("Override for this job"));expect((screen.getByLabelText("Quality") as HTMLSelectElement).value).toBe("1080");fireEvent.change(screen.getByLabelText("Quality"),{target:{value:"480"}});fireEvent.click(screen.getByRole("button",{name:"Settings"}));expect((screen.getByLabelText("Quality") as HTMLSelectElement).value).toBe("720");expect(ytdl.save).not.toHaveBeenCalled();
});
it("defaults to Download and keeps diagnostics collapsed",async()=>{
 render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><YtdlPopup onClose={()=>{}}/></QueryClientProvider>);await screen.findByLabelText("Operation");expect(screen.getByRole("button",{name:"Download"}).getAttribute("aria-pressed")).toBe("true");fireEvent.click(screen.getByRole("button",{name:"Settings"}));expect(screen.getByText("Diagnostics").parentElement?.hasAttribute("open")).toBe(false);expect(apiRequest).not.toHaveBeenCalled();
});
it("hides encoding controls and warnings in metadata-only overrides",async()=>{
 vi.mocked(ytdl.configuration).mockResolvedValue({settings:{...settings,convert:true,hardware_backend:"nvenc"},dependencies:{yt_dlp:null,ffmpeg:null,js_runtime:null}});mount();await screen.findByLabelText("Video codec");fireEvent.click(screen.getByRole("button",{name:"Download"}));fireEvent.change(screen.getByLabelText("Operation"),{target:{value:"metadata"}});fireEvent.click(screen.getByLabelText("Override for this job"));expect(screen.queryByLabelText("Quality")).toBeNull();expect(screen.queryByLabelText("Video codec")).toBeNull();expect(screen.queryByRole("alert")).toBeNull();expect(screen.getByLabelText("Download directory")).toBeTruthy();
});
it.each([["Queue","Activity"],["Configuration","Settings"],["Downloads","Download"]])("maps legacy tab %s to %s",async(initialTab,current)=>{
 render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><YtdlPopup initialTab={initialTab} onClose={()=>{}}/></QueryClientProvider>);await waitFor(()=>expect(screen.getByRole("button",{name:current}).getAttribute("aria-pressed")).toBe("true"));
});

it("preserves unsaved defaults through configuration refetch",async()=>{
 const queryClient=new QueryClient({defaultOptions:{queries:{retry:false}}});render(<QueryClientProvider client={queryClient}><YtdlPopup initialTab="Settings" onClose={()=>{}}/></QueryClientProvider>);await screen.findByLabelText("Quality");fireEvent.change(screen.getByLabelText("Quality"),{target:{value:"720"}});await queryClient.refetchQueries({queryKey:["plugin-ytdl"]});expect((screen.getByLabelText("Quality") as HTMLSelectElement).value).toBe("720");
});

it("reports failed automatic saves and retries the same defaults",async()=>{
 vi.mocked(ytdl.save).mockRejectedValueOnce(new Error("Settings unavailable"));
 mount();await screen.findByLabelText("Quality");
 expect(ytdl.save).not.toHaveBeenCalled();
 fireEvent.change(screen.getByLabelText("Quality"),{target:{value:"720"}});
 await screen.findByText("Settings unavailable");
 expect(screen.queryByText("Changes saved automatically")).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"Retry saving"}));
 await screen.findByText("Changes saved automatically");
 expect(ytdl.save).toHaveBeenLastCalledWith({...settings,quality:720});
});

it("defaults missing skip-existing metadata to enabled and automatically saves disabling it",async()=>{
 mount();
 expect((await screen.findByLabelText("Skip existing metadata") as HTMLInputElement).checked).toBe(true);
 expect(ytdl.save).not.toHaveBeenCalled();
 fireEvent.click(screen.getByLabelText("Skip existing metadata"));
 await waitFor(()=>expect(ytdl.save).toHaveBeenCalledWith({...settings,skip_existing_metadata:false}));
 await screen.findByText("Changes saved automatically");
});
it("allows metadata-only jobs to override skipping without changing defaults",async()=>{
 mount();await screen.findByLabelText("Video codec");fireEvent.click(screen.getByRole("button",{name:"Download"}));fireEvent.change(screen.getByLabelText("Operation"),{target:{value:"metadata"}});
 expect(screen.getByText("Existing metadata: Skip valid NFOs")).toBeTruthy();
 fireEvent.click(screen.getByLabelText("Override for this job"));
 expect((screen.getByLabelText("Skip existing metadata") as HTMLInputElement).checked).toBe(true);
 fireEvent.click(screen.getByLabelText("Skip existing metadata"));
 expect(screen.getByText("Existing metadata: Refresh and overwrite NFOs")).toBeTruthy();
 fireEvent.change(screen.getByLabelText("YouTube URL"),{target:{value:"https://www.youtube.com/@channel"}});fireEvent.click(screen.getByRole("button",{name:"Refresh existing NFOs"}));
 await waitFor(()=>expect(ytdl.submit).toHaveBeenCalledWith("https://www.youtube.com/@channel",[],{...settings,skip_existing_metadata:false},true));
 expect(ytdl.save).not.toHaveBeenCalled();
});
it("shows captured metadata skip policy in job settings",async()=>{
 vi.mocked(ytdl.jobs).mockResolvedValue([{id:"metadata",title:"Metadata",status:"downloading",metadata_only:true,settings:{...settings,skip_existing_metadata:false}}] as YtdlJob[]);
 mount();expect(await screen.findByText("Skip existing metadata: Off")).toBeTruthy();
});
