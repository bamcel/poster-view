import {cleanup,fireEvent,render,screen} from "@testing-library/react";
import {afterEach,expect,it} from "vitest";
import VideoPreferences from "./VideoPreferences";
afterEach(()=>{cleanup();localStorage.clear();});
it("persists independent cast and crew display choices per library",()=>{
 const view=render(<VideoPreferences library="tv"/>);
 fireEvent.click(screen.getByRole("switch",{name:"Display Cast"}));
 expect(screen.getByRole("switch",{name:"Display Cast"}).getAttribute("aria-checked")).toBe("false");
 expect(screen.getByRole("switch",{name:"Display Crew"}).getAttribute("aria-checked")).toBe("true");
 view.unmount();
 const movies=render(<VideoPreferences library="movies"/>);
 expect(screen.getByRole("switch",{name:"Display Cast"}).getAttribute("aria-checked")).toBe("true");
 movies.unmount();render(<VideoPreferences library="tv"/>);
 expect(screen.getByRole("switch",{name:"Display Cast"}).getAttribute("aria-checked")).toBe("false");
});
