import {cleanup, fireEvent, render, screen} from "@testing-library/react";
import {MemoryRouter} from "react-router-dom";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {useActivity, type ActivityItem} from "./ActivityContext";
import GlobalActivityStatus from "./GlobalActivityStatus";

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

it("expands other activity and dismisses only finished entries", ()=>{
  mount([running,{id:"test:done",title:"Finished task",detail:"Ready",state:"completed"},{id:"test:failed",title:"Failed task",detail:"Try again",state:"failed"}]);
  const expand=screen.getByRole("button",{name:"2 more activities"});
  expect(expand.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByText("Finished task")).toBeNull();
  fireEvent.click(expand);
  expect(expand.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(screen.getByRole("button",{name:"Dismiss Finished task"}));
  expect(dismiss).toHaveBeenCalledWith("test:done");
  fireEvent.click(screen.getByRole("button",{name:"Dismiss Failed task"}));
  expect(dismiss).toHaveBeenCalledWith("test:failed");
  fireEvent.click(screen.getByRole("button",{name:"Clear finished"}));
  expect(clearFinished).toHaveBeenCalledOnce();
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
