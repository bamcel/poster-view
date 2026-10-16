import {act,cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {MemoryRouter,Route,Routes} from "react-router-dom";
import {apiRequest} from "../../api/client";
import {playbackApi} from "../playback/api/playback";
import VirtualTvPlayer from "./VirtualTvPlayer";

vi.mock("../../api/client",()=>({apiRequest:vi.fn()}));
vi.mock("../playback/api/playback",async original=>({...await original<typeof import("../playback/api/playback")>(),playbackApi:{info:vi.fn(),create:vi.fn(),stop:vi.fn(),heartbeat:vi.fn()}}));
vi.mock("../playback/lib/playback",()=>({playbackCapabilities:vi.fn(async()=>({video_codecs:["h264"],audio_codecs:["aac"],containers:["mp4"]})),selectTracks:vi.fn(()=>({audio:1,subtitle:-1}))}));
const tune={library_id:"library",item_id:"episode",position_seconds:120,ends_at:"2099-01-01T00:00:00Z",program_id:"program",channel_name:"Comedy",title:"Pilot"};
const session={id:"session",method:"direct" as const,reason:"Original",url:"/media",mime:"video/mp4",offset_seconds:0,duration_seconds:1200,generation:1};
function player(){return render(<MemoryRouter initialEntries={["/play/virtual-tv/channel"]}><Routes><Route path="/play/virtual-tv/:channelId" element={<VirtualTvPlayer/>}/></Routes></MemoryRouter>);}
beforeEach(()=>{
  vi.clearAllMocks();
  vi.spyOn(HTMLMediaElement.prototype,"pause").mockImplementation(()=>{});
  vi.spyOn(HTMLMediaElement.prototype,"load").mockImplementation(()=>{});
  vi.spyOn(HTMLMediaElement.prototype,"play").mockResolvedValue();
  vi.mocked(apiRequest).mockResolvedValue(tune);
  vi.mocked(playbackApi.info).mockResolvedValue({title:"Pilot",duration_seconds:1200,tracks:[],chapters:[]});
  vi.mocked(playbackApi.create).mockResolvedValue(session);
  vi.mocked(playbackApi.stop).mockResolvedValue();vi.mocked(playbackApi.heartbeat).mockResolvedValue();
});
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();});
describe("Virtual TV playback",()=>{
 it("joins at the live source position and releases its session on unmount",async()=>{
   const view=player();await screen.findByRole("heading",{name:"Comedy · Pilot"});
   expect(playbackApi.create).toHaveBeenCalledWith("library","episode",expect.objectContaining({position_seconds:120,virtual_channel_id:"channel"}));
   const video=screen.getByLabelText("Virtual TV player") as HTMLVideoElement;
   fireEvent.loadedMetadata(video);expect(video.currentTime).toBe(120);
   view.unmount();await waitFor(()=>expect(playbackApi.stop).toHaveBeenCalledWith("session",true));expect(video.getAttribute("src")).toBeNull();
 });
 it("revalidates permissions without recreating the current program, then stops on denied access",async()=>{
   vi.useFakeTimers({shouldAdvanceTime:true});player();await screen.findByRole("heading",{name:"Comedy · Pilot"});
   await act(async()=>{await vi.advanceTimersByTimeAsync(15_000);});
   expect(apiRequest).toHaveBeenCalledTimes(2);expect(playbackApi.create).toHaveBeenCalledTimes(1);
   vi.mocked(apiRequest).mockRejectedValueOnce(new Error("Channel access denied"));
   await act(async()=>{await vi.advanceTimersByTimeAsync(15_000);});
   expect(screen.getByRole("alert").textContent).toContain("Channel access denied");expect(playbackApi.stop).toHaveBeenCalledWith("session",true);
 });
 it("changes sessions when the current scheduled program changes",async()=>{
   player();await screen.findByRole("heading",{name:"Comedy · Pilot"});
   vi.mocked(apiRequest).mockResolvedValue({...tune,item_id:"second",program_id:"second-program",title:"Second episode",position_seconds:0});
   fireEvent.ended(screen.getByLabelText("Virtual TV player"));
   await screen.findByRole("heading",{name:"Comedy · Second episode"});
   expect(playbackApi.stop).toHaveBeenCalledWith("session",true);expect(playbackApi.create).toHaveBeenCalledWith("library","second",expect.objectContaining({position_seconds:0}));
 });
 it("cleans up a session created after the player unmounts",async()=>{
   let resolve!:(value:typeof session)=>void;
   vi.mocked(playbackApi.create).mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
   const view=player();await waitFor(()=>expect(playbackApi.create).toHaveBeenCalled());view.unmount();
   await act(async()=>resolve(session));expect(playbackApi.stop).toHaveBeenCalledWith("session",true);
 });
 it("waits for the previous session slot before allocating a replacement",async()=>{
   let finishStop!:()=>void;
   player();await screen.findByRole("heading",{name:"Comedy · Pilot"});
   vi.mocked(playbackApi.stop).mockImplementationOnce(()=>new Promise(done=>{finishStop=done;}));
   fireEvent.click(screen.getByRole("button",{name:"Return to live"}));
   await waitFor(()=>expect(playbackApi.stop).toHaveBeenCalled());
   expect(playbackApi.create).toHaveBeenCalledTimes(1);
   await act(async()=>finishStop());
   await waitFor(()=>expect(playbackApi.create).toHaveBeenCalledTimes(2));
 });
 it("uses the server session's authoritative live position",async()=>{
   vi.mocked(playbackApi.create).mockResolvedValue({...session,position_seconds:125});
   player();await screen.findByRole("heading",{name:"Comedy · Pilot"});
   const video=screen.getByLabelText("Virtual TV player") as HTMLVideoElement;
   fireEvent.loadedMetadata(video);expect(video.currentTime).toBe(125);
 });
 it("retries a scheduled boundary that fires while the previous tune is preparing",async()=>{
   vi.useFakeTimers({shouldAdvanceTime:true});
   vi.mocked(apiRequest).mockResolvedValueOnce({...tune,ends_at:new Date(Date.now()+1000).toISOString()}).mockResolvedValue({...tune,program_id:"second",title:"Second episode",item_id:"second"});
   let finishCreate!:(value:typeof session)=>void;
   vi.mocked(playbackApi.create).mockImplementationOnce(()=>new Promise(done=>{finishCreate=done;}));
   player();await waitFor(()=>expect(playbackApi.create).toHaveBeenCalled());
   await act(async()=>{await vi.advanceTimersByTimeAsync(1500);});
   expect(apiRequest).toHaveBeenCalledTimes(1);
   await act(async()=>finishCreate(session));
   await act(async()=>{await vi.advanceTimersByTimeAsync(300);});
   await screen.findByRole("heading",{name:"Comedy · Second episode"});
   expect(apiRequest).toHaveBeenCalledTimes(2);
 });
});
