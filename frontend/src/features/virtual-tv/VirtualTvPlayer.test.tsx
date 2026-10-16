import {act,cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {MemoryRouter,Route,Routes} from "react-router-dom";
import {apiRequest} from "../../api/client";
import PlayerPage from "../playback/PlayerPage";
import VirtualTvPlayer from "./VirtualTvPlayer";
vi.mock("../../api/client",()=>({apiRequest:vi.fn()}));
vi.mock("../playback/PlayerPage",()=>({default:vi.fn(({virtualTv}:{virtualTv:{itemId:string;onEnded:()=>void;onReturnLive:()=>void}})=><section aria-label="Shared media player"><h1>{virtualTv.itemId}</h1><button onClick={virtualTv.onReturnLive}>Return to live</button><button onClick={virtualTv.onEnded}>Program ended</button></section>)}));
const tune={library_id:"library",item_id:"episode",position_seconds:120,ends_at:"2099-01-01T00:00:00Z",program_id:"program",channel_name:"Comedy"};
function player(){return render(<MemoryRouter initialEntries={["/play/virtual-tv/channel"]}><Routes><Route path="/play/virtual-tv/:channelId" element={<VirtualTvPlayer/>}/></Routes></MemoryRouter>);}
beforeEach(()=>{vi.clearAllMocks();vi.mocked(apiRequest).mockResolvedValue(tune);});
afterEach(()=>{cleanup();vi.useRealTimers();});
it("uses the original shared player with live source identity and position",async()=>{
 player();await screen.findByRole("heading",{name:"episode"});
 expect(vi.mocked(PlayerPage).mock.calls.at(-1)?.[0]?.virtualTv).toEqual(expect.objectContaining({channelId:"channel",libraryId:"library",itemId:"episode",positionSeconds:120,channelName:"Comedy"}));
});
it("revalidates access without reinitializing the program and removes playback on denial",async()=>{
 vi.useFakeTimers({shouldAdvanceTime:true});player();await screen.findByRole("heading",{name:"episode"});
 const previous=vi.mocked(PlayerPage).mock.calls.at(-1)?.[0]?.virtualTv?.programId;
 await act(async()=>{await vi.advanceTimersByTimeAsync(15_000);});
 expect(apiRequest).toHaveBeenCalledTimes(2);
 expect(vi.mocked(PlayerPage).mock.calls.at(-1)?.[0]?.virtualTv?.programId).toBe(previous);
 vi.mocked(apiRequest).mockRejectedValueOnce(new Error("Channel access denied"));
 await act(async()=>{await vi.advanceTimersByTimeAsync(15_000);});
 expect(screen.getByRole("alert").textContent).toContain("Channel access denied");
 expect(screen.queryByLabelText("Shared media player")).toBeNull();
});
it("returns to the current live point without changing the player component type",async()=>{
 player();await screen.findByRole("heading",{name:"episode"});
 const previous=vi.mocked(PlayerPage).mock.calls.at(-1)?.[0]?.virtualTv?.programId;
 vi.mocked(apiRequest).mockResolvedValue({...tune,position_seconds:200});
 fireEvent.click(screen.getByRole("button",{name:"Return to live"}));
 await waitFor(()=>expect(vi.mocked(PlayerPage).mock.calls.at(-1)?.[0]?.virtualTv?.positionSeconds).toBe(200));
 expect(vi.mocked(PlayerPage).mock.calls.at(-1)?.[0]?.virtualTv?.programId).not.toBe(previous);
});
it("tunes the next scheduled item at the program boundary",async()=>{
 vi.useFakeTimers({shouldAdvanceTime:true});
 vi.mocked(apiRequest).mockResolvedValueOnce({...tune,ends_at:new Date(Date.now()+1000).toISOString()}).mockResolvedValue({...tune,item_id:"second",program_id:"second-program",position_seconds:0});
 player();await screen.findByRole("heading",{name:"episode"});
 await act(async()=>{await vi.advanceTimersByTimeAsync(1500);});
 expect(screen.getByRole("heading",{name:"second"})).toBeTruthy();
});
it("retunes on media end and ignores a tune result after unmount",async()=>{
 const view=player();await screen.findByRole("heading",{name:"episode"});
 let resolve!:(value:typeof tune)=>void;
 vi.mocked(apiRequest).mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
 fireEvent.click(screen.getByRole("button",{name:"Program ended"}));
 await waitFor(()=>expect(apiRequest).toHaveBeenCalledTimes(2));
 const count=vi.mocked(PlayerPage).mock.calls.length;view.unmount();
 await act(async()=>resolve({...tune,item_id:"late"}));
 expect(vi.mocked(PlayerPage).mock.calls).toHaveLength(count);
});
