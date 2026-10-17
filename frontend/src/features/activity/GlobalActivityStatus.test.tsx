import {act, cleanup, fireEvent, render, screen,waitFor} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {MemoryRouter} from "react-router-dom";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {useActivity, type ActivityItem} from "./ActivityContext";
import GlobalActivityStatus from "./GlobalActivityStatus";
import {durableJobs} from "../jobs/client";
vi.mock("../jobs/client",()=>({durableJobs:{cancel:vi.fn(),retry:vi.fn()}}));

vi.mock("./ActivityContext", ()=>({useActivity:vi.fn()}));
const dismiss=vi.fn(), clearFinished=vi.fn();
function mount(items:ActivityItem[]=[]) {
  vi.mocked(useActivity).mockReturnValue({items,dismiss,clearFinished,publish:vi.fn()});
  return render(<MemoryRouter><GlobalActivityStatus/></MemoryRouter>);
}
const running:ActivityItem={id:"test:running",title:"Preparing library",detail:"Inspecting media",state:"running",progress:42};
beforeEach(()=>vi.clearAllMocks());
afterEach(cleanup);

it("keeps an idle status available", ()=>{
  mount();
  expect(screen.getByRole("region",{name:"Activity status"})).toBeTruthy();
  expect(screen.getByText("No current activity")).toBeTruthy();
  expect(screen.queryByRole("progressbar")).toBeNull();
});

it("shows running progress without offering cancellation or dismissal", ()=>{
  mount([running]);
  expect(screen.getByRole("progressbar",{name:running.title}).getAttribute("aria-valuenow")).toBe("42");
  expect(screen.getByText(running.detail)).toBeTruthy();
  expect(screen.queryByRole("button",{name:/Dismiss|Cancel|Clear/})).toBeNull();
});

it("does not invent a percentage for unknown progress", ()=>{
  mount([{...running,progress:null}]);
  expect(screen.getByRole("progressbar").hasAttribute("aria-valuenow")).toBe(false);
  expect(screen.queryByText(/\d+%/)).toBeNull();
  expect(screen.getByText("In progress")).toBeTruthy();
});

it("slides between activities, wraps, and dismisses only finished entries", ()=>{
  mount([running,{id:"test:done",title:"Finished task",detail:"Ready",state:"completed"},{id:"test:failed",title:"Failed task",detail:"Try again",state:"failed"}]);
  expect(screen.getByText("1 / 3")).toBeTruthy();
  expect(screen.queryByRole("button",{name:"Dismiss Finished task"})).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"Next activity"}));
  expect(screen.getByText("2 / 3")).toBeTruthy();
  expect(screen.queryByRole("progressbar",{name:running.title})).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"Dismiss Finished task"}));
  expect(dismiss).toHaveBeenCalledWith("test:done");
  fireEvent.click(screen.getByRole("button",{name:"Next activity"}));
  fireEvent.click(screen.getByRole("button",{name:"Dismiss Failed task"}));
  expect(dismiss).toHaveBeenCalledWith("test:failed");
  fireEvent.click(screen.getByRole("button",{name:"Next activity"}));
  expect(screen.getByText("1 / 3")).toBeTruthy();
  fireEvent.click(screen.getByRole("button",{name:"Previous activity"}));
  expect(screen.getByText("3 / 3")).toBeTruthy();
  fireEvent.click(screen.getByRole("button",{name:"Clear finished"}));
  expect(clearFinished).toHaveBeenCalledOnce();
});

it("keeps the selected activity through reordering and recovers when it disappears",()=>{
 const done:ActivityItem={id:"done",title:"Completed",detail:"Ready",state:"completed"};
 const view=mount([running,done]);
 fireEvent.keyDown(screen.getByRole("region",{name:"Activity status"}),{key:"ArrowRight"});
 expect(screen.getByRole("button",{name:"Dismiss Completed"})).toBeTruthy();
 vi.mocked(useActivity).mockReturnValue({items:[done,running],dismiss,clearFinished,publish:vi.fn()});
 view.rerender(<MemoryRouter><GlobalActivityStatus/></MemoryRouter>);
 expect(screen.getByText("1 / 2")).toBeTruthy();
 expect(screen.getByRole("button",{name:"Dismiss Completed"})).toBeTruthy();
 vi.mocked(useActivity).mockReturnValue({items:[running],dismiss,clearFinished,publish:vi.fn()});
 view.rerender(<MemoryRouter><GlobalActivityStatus/></MemoryRouter>);
 expect(screen.getByRole("progressbar",{name:running.title})).toBeTruthy();
 expect(screen.queryByRole("button",{name:"Next activity"})).toBeNull();
});

it("activates internal links and allowed activity events", ()=>{
  const listener=vi.fn();
  window.addEventListener("posterview:open-test",listener);
  const view=mount([{...running,event:"posterview:open-test"}]);
  fireEvent.click(screen.getByRole("button",{name:/Preparing library/}));
  expect(listener).toHaveBeenCalledOnce();
  window.removeEventListener("posterview:open-test",listener);
  view.unmount();
  mount([{...running,href:"/settings/tasks"}]);
  expect(screen.getByRole("link",{name:/Preparing library/}).getAttribute("href")).toBe("/settings/tasks");
});

it("does not activate external links or unrelated events", ()=>{
  mount([{...running,event:"unrelated:event",href:"//other.example/"}]);
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.queryByRole("button")).toBeNull();
});

it("disables pending cancellation and reports safe errors before allowing retry",async()=>{
 let reject!:(error:Error)=>void;
 vi.mocked(durableJobs.cancel).mockReturnValue(new Promise((_,r)=>{reject=r;}));
 vi.mocked(useActivity).mockReturnValue({items:[{...running,jobId:"job",canCancel:true}],dismiss,clearFinished,publish:vi.fn()});
 const client=new QueryClient();
 render(<QueryClientProvider client={client}><MemoryRouter><GlobalActivityStatus/></MemoryRouter></QueryClientProvider>);
 fireEvent.click(screen.getByRole("button",{name:"Cancel"}));
 expect(screen.getByRole("button",{name:"Updating…"}).hasAttribute("disabled")).toBe(true);
 await act(async()=>reject(new Error("secret server path")));
 expect(screen.getByRole("alert").textContent).toBe("Unable to update. Try again.");
 expect(screen.queryByText(/secret/)).toBeNull();
 expect(screen.getByRole("button",{name:"Cancel"}).hasAttribute("disabled")).toBe(false);
 client.clear();
});
it("retries terminal jobs and invalidates the durable job query",async()=>{
 vi.mocked(durableJobs.retry).mockResolvedValue({} as never);
 vi.mocked(useActivity).mockReturnValue({items:[{...running,state:"failed",jobId:"failed",canRetry:true}],dismiss,clearFinished,publish:vi.fn()});
 const client=new QueryClient(),invalidate=vi.spyOn(client,"invalidateQueries");
 render(<QueryClientProvider client={client}><MemoryRouter><GlobalActivityStatus/></MemoryRouter></QueryClientProvider>);
 fireEvent.click(screen.getByRole("button",{name:"Retry"}));
 await waitFor(()=>expect(invalidate).toHaveBeenCalledWith({queryKey:["durable-jobs"]}));
 expect(durableJobs.retry).toHaveBeenCalledWith("failed");client.clear();
});
