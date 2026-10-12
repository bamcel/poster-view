import {afterEach,describe,it,expect,vi} from "vitest";
import {apiRequest} from "../../../api/client";
import {playbackApi} from "./playback";
vi.mock("../../../api/client",()=>({apiRequest:vi.fn().mockResolvedValue(undefined)}));
afterEach(()=>vi.clearAllMocks());
describe("playback heartbeat transport",()=>{
 it("preserves generation-free callers and optional speed",async()=>{
  await playbackApi.heartbeat("one",50,true);expect(apiRequest).toHaveBeenLastCalledWith("/playback/sessions/one/heartbeat",{method:"POST",body:JSON.stringify({position_seconds:50,paused:true})});
 });
 it("sends the queued source generation and playback speed without deriving another epoch",async()=>{
  await playbackApi.heartbeat("one",800,false,1,1.25);expect(apiRequest).toHaveBeenLastCalledWith("/playback/sessions/one/heartbeat",{method:"POST",body:JSON.stringify({position_seconds:800,paused:false,generation:1,speed:1.25})});
 });
});
