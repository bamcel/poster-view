import {cleanup,fireEvent,render,screen} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {afterEach,expect,it,vi} from "vitest";
import DownloadStatus,{openDownloadsEvent} from "./DownloadStatus";
import {ytdl,type YtdlJob} from "./client";
vi.mock("./client",()=>({ytdl:{jobs:vi.fn()}}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
function mount(){const client=new QueryClient({defaultOptions:{queries:{retry:false}}});const view=render(<QueryClientProvider client={client}><DownloadStatus compact/></QueryClientProvider>);return {client,...view};}
it("restores the persisted playlist progress with a new query client after refresh",async()=>{
 const job={id:"persisted",title:"Playlist",status:"downloading",progress:42,total_videos:10,completed_videos:4,current_video_title:"Next video",speed:"1 MiB/s",eta:"19s",settings:{directory:"youtube"}} as YtdlJob;
 vi.mocked(ytdl.jobs).mockResolvedValue([job]);
 const first=mount();
 expect(await screen.findByText("Playlist")).toBeTruthy();
 expect(screen.getByText("4 of 10 videos complete · Next video")).toBeTruthy();
 expect(screen.getByRole("progressbar").getAttribute("value")).toBe("42");
 first.unmount();first.client.clear();
 const second=mount();
 expect(await screen.findByText("Playlist")).toBeTruthy();
 expect(screen.getByRole("progressbar").getAttribute("value")).toBe("42");
 const open=vi.fn();window.addEventListener(openDownloadsEvent,open);
 fireEvent.click(screen.getByRole("button",{name:"Open queue"}));expect(open).toHaveBeenCalledOnce();
 window.removeEventListener(openDownloadsEvent,open);second.client.clear();
});
