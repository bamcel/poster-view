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
