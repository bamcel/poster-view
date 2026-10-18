// @vitest-environment jsdom
import {useState} from "react";
import {cleanup,fireEvent,render,screen} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {afterEach,expect,it,vi} from "vitest";
import LibraryWatchRules,{defaultWatchRules,validWatchRules} from "./LibraryWatchRules";
import {watchApi} from "../api/watch";
vi.mock("../api/watch",()=>({watchApi:{rules:vi.fn(),saveRules:vi.fn()}}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
it("edits unsaved playback rules without a query provider or API calls",()=>{
  function Draft(){const [rules,setRules]=useState(defaultWatchRules);return <LibraryWatchRules draft={rules} onDraftChange={setRules}/>;}
  render(<Draft/>);
  const minimum=screen.getByLabelText("Minimum resume percentage") as HTMLInputElement;
  expect(minimum.value).toBe("2");
  fireEvent.change(minimum,{target:{value:"6"}});
  expect(minimum.value).toBe("6");
  expect(screen.getByText("Playback rules are saved with the library.")).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
  expect(watchApi.rules).not.toHaveBeenCalled();expect(watchApi.saveRules).not.toHaveBeenCalled();
});
it("preserves standalone saved-library loading and saving",async()=>{
  vi.mocked(watchApi.rules).mockResolvedValue(defaultWatchRules);
  vi.mocked(watchApi.saveRules).mockImplementation(async(_library,rules)=>rules);
  render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><LibraryWatchRules library="youtube"/></QueryClientProvider>);
  fireEvent.change(await screen.findByLabelText("Maximum resume percentage"),{target:{value:"95"}});

  await screen.findByText("Changes saved automatically");
  expect(watchApi.saveRules).toHaveBeenCalledWith("youtube",{...defaultWatchRules,maximum_percentage:95});
});
it("validates finite ordered percentages and duration using the server limits",()=>{
  expect(validWatchRules(defaultWatchRules)).toBe(true);
  expect(validWatchRules({minimum_percentage:0,maximum_percentage:100,minimum_duration_seconds:86400})).toBe(true);
  for(const rules of [
    {...defaultWatchRules,minimum_percentage:90},
    {...defaultWatchRules,minimum_percentage:-1},
    {...defaultWatchRules,maximum_percentage:101},
    {...defaultWatchRules,maximum_percentage:NaN},
    {...defaultWatchRules,minimum_duration_seconds:Infinity},
    {...defaultWatchRules,minimum_duration_seconds:86401},
  ])expect(validWatchRules(rules)).toBe(false);
});
