import {act,cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {MemoryRouter} from "react-router-dom";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {ApiError} from "../../api/client";
import PairwisePage from "./PairwisePage";
import PairwisePlugin from "./PairwisePlugin";
import {pairwise,type RankingTitle,type RankingView} from "./client";

vi.mock("./client",()=>({pairwise:{settings:vi.fn(),saveSettings:vi.fn(),libraries:vi.fn(),ranking:vi.fn(),action:vi.fn()}}));
const clients:QueryClient[]=[];
function title(id:string,name:string):RankingTitle{return {entry:{id,title:name,path:`/${name}`,kind:"movie",parent_path:null,metadata:{overview:`About ${name}`},artwork:[],files:[],nfo_path:null,available:true,revision:1},score:null,rank:null,comparisons:0,excluded:false,provisional:true};}
const initial:RankingView={library_id:"movies",revision:1,decision_count:0,ranked_count:0,excluded_count:0,titles:[title("a","Alpha"),title("b","Beta"),title("c","Gamma")],pair:null,can_undo:false};
const started:RankingView={...initial,revision:2,pair:{token:"pair-one",left_id:"a",right_id:"b"}};
function mount(path="/rankings?library=movies",plugin=false){const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});clients.push(client);return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}>{plugin?<PairwisePlugin/>:<PairwisePage/>}</MemoryRouter></QueryClientProvider>);}
beforeEach(()=>{vi.resetAllMocks();vi.mocked(pairwise.settings).mockResolvedValue({enabled:true});vi.mocked(pairwise.libraries).mockResolvedValue([{id:"movies",name:"Movies",title_count:3}]);vi.mocked(pairwise.ranking).mockResolvedValue(initial);vi.mocked(pairwise.action).mockResolvedValue(started);});
afterEach(()=>{cleanup();clients.splice(0).forEach(client=>client.clear());});

it("includes the complete library without a candidate selection step",async()=>{
 mount("/rankings");await screen.findByRole("option",{name:"Movies (3 titles)"});fireEvent.change(screen.getByRole("combobox",{name:"Library"}),{target:{value:"movies"}});
 expect(await screen.findByRole("button",{name:"Start ranking"})).toBeTruthy();
 expect(screen.getByText("Not ranked yet (3)")).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Start ranking"}));
 expect(await screen.findByRole("heading",{name:"Which do you prefer?"})).toBeTruthy();
 expect(pairwise.action).toHaveBeenCalledWith("movies",{revision:1,action:"start"});
});

it("saves choices with the current revision and pair token",async()=>{
 mount();fireEvent.click(await screen.findByRole("button",{name:"Start ranking"}));
 fireEvent.click(await screen.findByRole("button",{name:"Choose Alpha"}));
 await waitFor(()=>expect(pairwise.action).toHaveBeenLastCalledWith("movies",{revision:2,action:"left",token:"pair-one"}));
});

it("supports ties, skips and undo without switching to results",async()=>{
 vi.mocked(pairwise.ranking).mockResolvedValue({...started,can_undo:true});mount();
 fireEvent.click(await screen.findByRole("button",{name:"Start ranking"}));
 fireEvent.click(await screen.findByRole("button",{name:"About equal"}));
 await waitFor(()=>expect(pairwise.action).toHaveBeenLastCalledWith("movies",{revision:2,action:"tie",token:"pair-one"}));
 await waitFor(()=>expect((screen.getByRole("button",{name:"Skip pair"}) as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(screen.getByRole("button",{name:"Skip pair"}));
 await waitFor(()=>expect(pairwise.action).toHaveBeenLastCalledWith("movies",{revision:2,action:"skip",token:"pair-one"}));
});

it("excludes a comparison title and allows it back from Not ranked",async()=>{
 mount();fireEvent.click(await screen.findByRole("button",{name:"Start ranking"}));
 const excluded={...started,revision:3,excluded_count:1,titles:started.titles.map(item=>item.entry.id==="a"?{...item,excluded:true}:item),pair:{token:"pair-two",left_id:"b",right_id:"c"}};
 vi.mocked(pairwise.action).mockResolvedValue(excluded);
 fireEvent.click(await screen.findByRole("button",{name:"Don’t rank this title: Alpha"}));
 await waitFor(()=>expect(pairwise.action).toHaveBeenLastCalledWith("movies",{revision:2,action:"exclude",item_id:"a",token:"pair-one"}));
 await waitFor(()=>expect((screen.getByRole("button",{name:"Pause / View rankings"}) as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(screen.getByRole("button",{name:"Pause / View rankings"}));
 expect(screen.getByText("Not ranked — excluded by you (1)")).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Allow ranking: Alpha"}));
 await waitFor(()=>expect(pairwise.action).toHaveBeenLastCalledWith("movies",{revision:3,action:"allow",item_id:"a",token:"pair-two"}));
});

it("permits optional exclusions before the first comparison",async()=>{
 mount();fireEvent.click(await screen.findByRole("button",{name:"Don’t rank title: Alpha"}));
 await waitFor(()=>expect(pairwise.action).toHaveBeenCalledWith("movies",{revision:1,action:"exclude",item_id:"a"}));
});

it("reloads conflicting rankings rather than repeating a vote",async()=>{
 vi.mocked(pairwise.ranking).mockResolvedValue(started);mount();fireEvent.click(await screen.findByRole("button",{name:"Start ranking"}));
 vi.mocked(pairwise.action).mockRejectedValue(new ApiError(409,"Conflict"));
 fireEvent.click(await screen.findByRole("button",{name:"Choose Alpha"}));
 expect(await screen.findByRole("alert")).toHaveProperty("textContent",expect.stringContaining("another tab"));
 await waitFor(()=>expect(pairwise.ranking).toHaveBeenCalledTimes(2));expect(pairwise.action).toHaveBeenCalledTimes(2);
});

it("prevents duplicate requests and disables controls while saving",async()=>{
 mount();fireEvent.click(await screen.findByRole("button",{name:"Start ranking"}));await screen.findByRole("button",{name:"Choose Alpha"});
 let finish!:(value:RankingView)=>void;vi.mocked(pairwise.action).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 const choose=screen.getByRole("button",{name:"Choose Alpha"});fireEvent.click(choose);fireEvent.click(choose);
 expect(pairwise.action).toHaveBeenCalledTimes(2);expect((choose as HTMLButtonElement).disabled).toBe(true);
 await act(async()=>finish(started));
});

it("retains the comparison after a recoverable save failure",async()=>{
 mount();fireEvent.click(await screen.findByRole("button",{name:"Start ranking"}));vi.mocked(pairwise.action).mockRejectedValue(new Error("Network unavailable"));
 fireEvent.click(await screen.findByRole("button",{name:"Choose Alpha"}));expect(await screen.findByRole("alert")).toHaveProperty("textContent","Network unavailable");
 expect(screen.getByRole("heading",{name:"Which do you prefer?"})).toBeTruthy();
});

it("shows rank before relative score and marks provisional results",async()=>{
 vi.mocked(pairwise.ranking).mockResolvedValue({...initial,decision_count:1,can_undo:true,ranked_count:2,titles:initial.titles.map((item,index)=>index<2?{...item,rank:index+1,score:index===0?70:30,comparisons:1}:item)});
 mount();expect(await screen.findByText("#1")).toBeTruthy();expect(screen.getAllByText(/Provisional/)).toHaveLength(2);
 fireEvent.click(screen.getByRole("button",{name:"Undo last decision"}));await waitFor(()=>expect(pairwise.action).toHaveBeenCalledWith("movies",{revision:1,action:"undo"}));
});

it("opens title details in the standard popup",async()=>{
 mount();fireEvent.click((await screen.findAllByRole("button",{name:"Details"}))[0]);
 expect(screen.getByRole("dialog",{name:"Alpha"})).toBeTruthy();expect(screen.getByText("About Alpha")).toBeTruthy();
});

it("does not load private library rankings when the plugin is disabled",async()=>{
 vi.mocked(pairwise.settings).mockResolvedValue({enabled:false});mount();
 expect(await screen.findByText("PairWise Ranking is disabled")).toBeTruthy();expect(pairwise.libraries).not.toHaveBeenCalled();expect(pairwise.ranking).not.toHaveBeenCalled();
});

it("uses a pill switch and saves plugin configuration",async()=>{
 vi.mocked(pairwise.saveSettings).mockResolvedValue({enabled:false});mount("/settings/plugins",true);
 fireEvent.click(await screen.findByRole("button",{name:/PairWise Ranking/}));
 fireEvent.click(await screen.findByRole("switch",{name:"Enable PairWise Ranking"}));
 await waitFor(()=>expect(pairwise.saveSettings).toHaveBeenCalledWith({enabled:false},expect.anything()));
 expect(await screen.findByText("Changes saved automatically")).toBeTruthy();
});

it("does not reuse another library's comparison or results",async()=>{
 vi.mocked(pairwise.libraries).mockResolvedValue([{id:"movies",name:"Movies",title_count:3},{id:"anime",name:"Anime",title_count:0}]);
 vi.mocked(pairwise.ranking).mockImplementation(async library=>library==="movies"?initial:{...initial,library_id:"anime",titles:[]});
 mount();fireEvent.click(await screen.findByRole("button",{name:"Start ranking"}));await screen.findByRole("heading",{name:"Which do you prefer?"});
 fireEvent.click(screen.getByRole("button",{name:"Pause / View rankings"}));
 fireEvent.change(screen.getByRole("combobox",{name:"Library"}),{target:{value:"anime"}});
 expect(await screen.findByRole("heading",{name:"Anime rankings"})).toBeTruthy();expect(screen.queryByText("Alpha")).toBeNull();
 expect((screen.getByRole("button",{name:"Start ranking"}) as HTMLButtonElement).disabled).toBe(true);
});

it("disables the plugin switch until its automatic save completes",async()=>{
 let finish!:(value:{enabled:boolean})=>void;
 vi.mocked(pairwise.saveSettings).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 mount("/settings/plugins",true);fireEvent.click(await screen.findByRole("button",{name:/PairWise Ranking/}));
 const toggle=await screen.findByRole("switch",{name:"Enable PairWise Ranking"});fireEvent.click(toggle);fireEvent.click(toggle);
 await waitFor(()=>expect((toggle as HTMLButtonElement).disabled).toBe(true));expect(pairwise.saveSettings).toHaveBeenCalledTimes(1);
 await act(async()=>finish({enabled:false}));await waitFor(()=>expect(toggle.getAttribute("aria-checked")).toBe("false"));
});

it("surfaces plugin save errors without closing its standard popup",async()=>{
 vi.mocked(pairwise.saveSettings).mockRejectedValue(new Error("Could not save configuration"));
 mount("/settings/plugins",true);fireEvent.click(await screen.findByRole("button",{name:/PairWise Ranking/}));
 fireEvent.click(await screen.findByRole("switch",{name:"Enable PairWise Ranking"}));
 expect(await screen.findByRole("alert")).toHaveProperty("textContent",expect.stringContaining("Could not save configuration"));
 expect(screen.getByRole("dialog",{name:"PairWise Ranking configuration"})).toBeTruthy();
});
