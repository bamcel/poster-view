// @vitest-environment jsdom
import {render,screen,fireEvent,cleanup,waitFor} from "@testing-library/react";
import {MemoryRouter,useLocation} from "react-router-dom";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {afterEach,expect,it,vi} from "vitest";
import NativePlaybackActions from "./NativePlaybackActions";
import {watchApi} from "../api/watch";
vi.mock("../api/watch",()=>({watchApi:{state:vi.fn(),mark:vi.fn()}}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
const state={position_seconds:125,duration_seconds:1200,watched:false,play_count:0,last_played_at:null,audio_index:null,subtitle_index:null,session_id:null,version:1};
function Location(){const location=useLocation();return <><output>{location.pathname}</output><output data-testid="query">{location.search}</output></>;}
function mount(versionId?:string){return render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MemoryRouter initialEntries={["/media/Anime/Show/Season-01/Episode-01"]}><NativePlaybackActions library="lib" item="episode" versionId={versionId}/><Location/></MemoryRouter></QueryClientProvider>);}
it("opens the full player from a resume action",async()=>{
 vi.mocked(watchApi.state).mockResolvedValue(state);mount();
 fireEvent.click(await screen.findByRole("button",{name:"Resume"}));
 expect(screen.getByText("/play/native/lib/episode")).toBeTruthy();
});
it("updates watched status without changing media metadata",async()=>{
 vi.mocked(watchApi.state).mockResolvedValue(state);vi.mocked(watchApi.mark).mockResolvedValue({...state,watched:true,position_seconds:0});mount();
 await screen.findByRole("button",{name:"Resume"});
 fireEvent.click(screen.getByRole("button",{name:"Mark played"}));
 await waitFor(()=>expect(watchApi.mark).toHaveBeenCalledWith("lib","episode",true));
 expect(await screen.findByRole("button",{name:"Mark unplayed"})).toBeTruthy();
});

it("starts the explicitly selected version while leaving Resume on the remembered version",async()=>{
 vi.mocked(watchApi.state).mockResolvedValue({...state,version_id:"original"});mount("uhd");
 fireEvent.click(await screen.findByRole("button",{name:"Play selected version from beginning"}));
 const query=new URLSearchParams(screen.getByTestId("query").textContent!);
 expect(query.get("version_id")).toBe("uhd");expect(query.get("start")).toBe("0");
});
it("lets the player resolve the saved version on Resume",async()=>{
 vi.mocked(watchApi.state).mockResolvedValue({...state,version_id:"original"});mount("uhd");
 fireEvent.click(await screen.findByRole("button",{name:"Resume"}));
 expect(new URLSearchParams(screen.getByTestId("query").textContent!).has("version_id")).toBe(false);
});
