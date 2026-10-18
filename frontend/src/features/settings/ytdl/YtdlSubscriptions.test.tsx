import {cleanup,fireEvent,render,screen,waitFor,within} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import YtdlSubscriptions from "./YtdlSubscriptions";
import {ytdl,type YtdlSubscription} from "./client";
vi.mock("./client",()=>({ytdl:{subscriptions:vi.fn(),saveSubscription:vi.fn(),deleteSubscription:vi.fn(),checkSubscription:vi.fn()}}));
const saved:YtdlSubscription={id:"subscription",name:"Channel",url:"https://www.youtube.com/@channel",enabled:true,weekdays:[2],time:"09:00",timezone:"America/Los_Angeles",last_checked:null,next_check:"2026-10-14T16:00:00Z",error:null};
beforeEach(()=>{vi.mocked(ytdl.subscriptions).mockResolvedValue([]);vi.mocked(ytdl.saveSubscription).mockResolvedValue(saved);vi.mocked(ytdl.deleteSubscription).mockResolvedValue();vi.mocked(ytdl.checkSubscription).mockResolvedValue(saved);});
afterEach(()=>{cleanup();vi.clearAllMocks();});
function mount(){render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><YtdlSubscriptions/></QueryClientProvider>);}
it("creates a Mon/Wed/Fri afternoon subscription with an explicit IANA time zone",async()=>{
 mount();fireEvent.click(screen.getByRole("button",{name:"Add subscription"}));
 fireEvent.change(screen.getByLabelText("Subscription name"),{target:{value:"My channel"}});
 fireEvent.change(screen.getByLabelText("Channel or playlist URL"),{target:{value:saved.url}});
 fireEvent.click(screen.getByRole("checkbox",{name:"Monday"}));fireEvent.click(screen.getByRole("checkbox",{name:"Friday"}));
 fireEvent.change(screen.getByLabelText("Check time"),{target:{value:"16:00"}});fireEvent.change(screen.getByLabelText("Time zone"),{target:{value:"America/Los_Angeles"}});
 fireEvent.click(screen.getByRole("button",{name:"Create subscription"}));
 await waitFor(()=>expect(ytdl.saveSubscription).toHaveBeenCalledWith({name:"My channel",url:saved.url,enabled:true,weekdays:[0,2,4],time:"16:00",timezone:"America/Los_Angeles"},undefined));
});
it("edits a saved Wednesday subscription without changing its identity",async()=>{
 vi.mocked(ytdl.subscriptions).mockResolvedValue([saved]);mount();fireEvent.click(await screen.findByRole("button",{name:"Edit Channel"}));
 expect(ytdl.saveSubscription).not.toHaveBeenCalled();
 expect(screen.queryByRole("button",{name:"Create subscription"})).toBeNull();
 expect((screen.getByRole("checkbox",{name:"Wednesday"}) as HTMLInputElement).checked).toBe(true);
 expect((screen.getByLabelText("Check time") as HTMLInputElement).value).toBe("09:00");
 fireEvent.change(screen.getByLabelText("Subscription name"),{target:{value:"Renamed"}});
 await waitFor(()=>expect(ytdl.saveSubscription).toHaveBeenCalledWith({name:"Renamed",url:saved.url,enabled:true,weekdays:[2],time:"09:00",timezone:saved.timezone},saved.id));
 await screen.findByText("Changes saved automatically");
});
it("checks, pauses, and deletes subscriptions and displays check failures",async()=>{
 vi.mocked(ytdl.subscriptions).mockResolvedValue([{...saved,error:"Channel unavailable"}]);mount();const card=await screen.findByRole("article",{name:"Channel"});
 expect(within(card).getByRole("alert").textContent).toBe("Channel unavailable");fireEvent.click(within(card).getByRole("button",{name:"Check now"}));await waitFor(()=>expect(ytdl.checkSubscription).toHaveBeenCalledWith(saved.id));
 await waitFor(()=>expect((within(card).getByRole("button",{name:"Pause"}) as HTMLButtonElement).disabled).toBe(false));fireEvent.click(within(card).getByRole("button",{name:"Pause"}));await waitFor(()=>expect(ytdl.saveSubscription).toHaveBeenCalledWith({name:saved.name,url:saved.url,enabled:false,weekdays:[2],time:saved.time,timezone:saved.timezone},saved.id));
 await waitFor(()=>expect((within(card).getByRole("button",{name:"Delete Channel"}) as HTMLButtonElement).disabled).toBe(false));fireEvent.click(within(card).getByRole("button",{name:"Delete Channel"}));await waitFor(()=>expect(ytdl.deleteSubscription).toHaveBeenCalledWith(saved.id));
});
it("requires at least one weekday",()=>{
 mount();fireEvent.click(screen.getByRole("button",{name:"Add subscription"}));fireEvent.change(screen.getByLabelText("Subscription name"),{target:{value:"Channel"}});fireEvent.change(screen.getByLabelText("Channel or playlist URL"),{target:{value:saved.url}});fireEvent.click(screen.getByRole("checkbox",{name:"Wednesday"}));
 expect((screen.getByRole("button",{name:"Create subscription"}) as HTMLButtonElement).disabled).toBe(true);
});

it("does not send incomplete existing settings and retries failed changes",async()=>{
 vi.mocked(ytdl.subscriptions).mockResolvedValue([saved]);mount();
 fireEvent.click(await screen.findByRole("button",{name:"Edit Channel"}));
 fireEvent.change(screen.getByLabelText("Subscription name"),{target:{value:""}});
 expect((await screen.findByRole("alert")).textContent).toContain("Complete the subscription fields");
 expect(ytdl.saveSubscription).not.toHaveBeenCalled();
 vi.mocked(ytdl.saveSubscription).mockRejectedValueOnce(new Error("Offline"));
 fireEvent.change(screen.getByLabelText("Subscription name"),{target:{value:"Updated"}});
 await screen.findByText(/Offline/);
 fireEvent.click(screen.getByRole("button",{name:"Retry"}));
 await screen.findByText("Changes saved automatically");
 expect(ytdl.saveSubscription).toHaveBeenLastCalledWith({...savedInput(),name:"Updated"},saved.id);
});
function savedInput(){return {name:saved.name,url:saved.url,enabled:saved.enabled,weekdays:saved.weekdays,time:saved.time,timezone:saved.timezone};}
