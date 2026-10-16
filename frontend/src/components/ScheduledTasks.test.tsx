import {render,screen,fireEvent,waitFor,cleanup} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {it,expect,vi,afterEach} from "vitest";
import ScheduledTasks,{type MaintenanceTask} from "./ScheduledTasks";
import {apiRequest} from "../api/client";
vi.mock("../api/client",()=>({apiRequest:vi.fn()}));
afterEach(()=>{cleanup();vi.resetAllMocks();});
const task:MaintenanceTask={id:"cleanup",title:"Data Cleanup",description:"Clean unused files",enabled:false,interval_days:7,retention_days:30,cleanup_artwork:true,cleanup_cache:true,cleanup_temporary:true,last_run:0,last_result:""};
it("previews cleanup before allowing removal and preserves disabled schedules",async()=>{
 vi.mocked(apiRequest).mockImplementation(async url=>url.endsWith("preview")?{files:2,bytes:1048576,result:"Eligible"}:url.endsWith("run")?{files:2,bytes:1048576,result:"Removed 2 files"}:[task]);
 render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><ScheduledTasks/></QueryClientProvider>);
 const review=await screen.findByRole("button",{name:"Review cleanup"});expect(screen.queryByRole("button",{name:"Clean selected"})).toBeNull();
 expect((screen.getByRole("checkbox",{name:"Enable schedule for Data Cleanup"}) as HTMLInputElement).checked).toBe(false);
 fireEvent.click(review);fireEvent.click(await screen.findByRole("button",{name:"Clean selected"}));
 await waitFor(()=>expect(apiRequest).toHaveBeenCalledWith("/tasks/cleanup/run",{method:"POST"}));
});
it("requires saving changed categories before reviewing cleanup",async()=>{
 vi.mocked(apiRequest).mockResolvedValue([task]);render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><ScheduledTasks/></QueryClientProvider>);
 fireEvent.click(await screen.findByRole("checkbox",{name:"Unused managed artwork"}));
 expect((screen.getByRole("button",{name:"Review cleanup"}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByRole("button",{name:"Save task"}));await waitFor(()=>expect(apiRequest).toHaveBeenCalledWith("/tasks/cleanup",expect.objectContaining({method:"PUT"})));
});

it("allows cleanup when only obsolete records are eligible",async()=>{
 vi.mocked(apiRequest).mockImplementation(async url=>url.endsWith("preview")?{records:3,files:0,bytes:0,result:"Eligible"}:[task]);
 render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><ScheduledTasks/></QueryClientProvider>);
 fireEvent.click(await screen.findByRole("button",{name:"Review cleanup"}));
 const clean=await screen.findByRole("button",{name:"Clean selected"});
 expect((clean as HTMLButtonElement).disabled).toBe(false);
 expect(screen.getByText(/3 obsolete records/)).toBeTruthy();
});

it("runs artwork backfill and allows changing its daily schedule without cleanup controls",async()=>{
 const artwork:MaintenanceTask={...task,id:"artwork",title:"Optimize Artwork",description:"Generate display sizes",enabled:true,interval_days:1};
 vi.mocked(apiRequest).mockImplementation(async (url,options)=>{
  if(url.endsWith("run"))return {files:4,bytes:0,result:"Generated 4 optimized artwork images. Original artwork was preserved."};
  if(options?.method==="PUT")return [{...artwork,enabled:false,interval_days:3}];
  return [artwork];
 });
 render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><ScheduledTasks/></QueryClientProvider>);
 fireEvent.click(await screen.findByRole("button",{name:"Run now"}));
 await waitFor(()=>expect(apiRequest).toHaveBeenCalledWith("/tasks/artwork/run",{method:"POST"}));
 expect(await screen.findByText(/Generated 4 optimized artwork images/)).toBeTruthy();
 expect(screen.queryByLabelText("Optimize Artwork retention days")).toBeNull();
 expect(screen.queryByRole("button",{name:"Review cleanup"})).toBeNull();
 fireEvent.click(screen.getByRole("checkbox",{name:"Enable schedule for Optimize Artwork"}));
 fireEvent.change(screen.getByLabelText("Optimize Artwork interval days"),{target:{value:"3"}});
 fireEvent.click(screen.getByRole("button",{name:"Save task"}));
 await waitFor(()=>expect(apiRequest).toHaveBeenCalledWith("/tasks/artwork",expect.objectContaining({method:"PUT",body:expect.any(String)})));
 const saved=vi.mocked(apiRequest).mock.calls.find(([url,options])=>url==="/tasks/artwork"&&options?.method==="PUT");
 expect(JSON.parse(String(saved?.[1]?.body))).toMatchObject({enabled:false,interval_days:3});
});

it("clears automatic provider caches only after confirmation",async()=>{
 vi.mocked(apiRequest).mockImplementation(async url=>url.endsWith("provider-cache")?{files:0,bytes:0,result:"Provider cache cleared."}:[task]);
 const confirm=vi.spyOn(window,"confirm").mockReturnValue(false);
 render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><ScheduledTasks/></QueryClientProvider>);
 const clear=await screen.findByRole("button",{name:"Clear provider cache"});fireEvent.click(clear);
 expect(apiRequest).not.toHaveBeenCalledWith("/tasks/provider-cache",{method:"DELETE"});
 confirm.mockReturnValue(true);fireEvent.click(clear);
 await waitFor(()=>expect(apiRequest).toHaveBeenCalledWith("/tasks/provider-cache",{method:"DELETE"}));confirm.mockRestore();
});
