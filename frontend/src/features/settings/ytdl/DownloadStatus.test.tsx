import {act,cleanup,render,screen} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {afterEach,expect,it,vi} from "vitest";
import DownloadStatus from "./DownloadStatus";
import {ytdl,type YtdlJob} from "./client";
vi.mock("./client",()=>({ytdl:{jobs:vi.fn()}}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
function mount(compact=true){const client=new QueryClient({defaultOptions:{queries:{retry:false}}});const view=render(<QueryClientProvider client={client}><DownloadStatus compact={compact}/></QueryClientProvider>);return {client,...view};}
it("updates encoding progress independently from overall playlist progress",async()=>{
 const job={id:"encoding",title:"Playlist",status:"processing",progress:40,encoding_progress:12.5,speed:"0.8x",eta:"20s",settings:{directory:"youtube"}} as YtdlJob;
 vi.mocked(ytdl.jobs).mockResolvedValue([job]);
 const view=mount(false);
 expect(await screen.findByText("Encoding · 12.5%")).toBeTruthy();
 expect(screen.getByRole("progressbar",{name:"Encoding progress for Playlist"}).getAttribute("value")).toBe("12.5");
 await act(async()=>{view.client.setQueryData(["ytdl-jobs"],[{...job,encoding_progress:27.3,progress:44}]);});
 expect(await screen.findByText("Encoding · 27.3%")).toBeTruthy();
 view.client.clear();
});
it("restores the persisted playlist progress with a new query client after refresh",async()=>{
 const job={id:"persisted",title:"Playlist",status:"downloading",progress:42,total_videos:10,completed_videos:4,current_video_title:"Next video",speed:"1 MiB/s",eta:"19s",settings:{directory:"youtube"}} as YtdlJob;
 vi.mocked(ytdl.jobs).mockResolvedValue([job]);
 const first=mount();
 expect(await screen.findByText("Playlist")).toBeTruthy();
 expect(screen.getByText("downloading · 4/10 complete")).toBeTruthy();
 expect(screen.getByRole("progressbar").getAttribute("value")).toBe("42");
 first.unmount();first.client.clear();
 const second=mount();
 expect(await screen.findByText("Playlist")).toBeTruthy();
 expect(screen.getByRole("progressbar").getAttribute("value")).toBe("42");
 expect(screen.getByLabelText("Overall completion").textContent).toBe("42%");
 expect(screen.queryByRole("button",{name:"Open queue"})).toBeNull();
 second.client.clear();
});
