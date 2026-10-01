import {cleanup,fireEvent,render,screen} from "@testing-library/react";
import {afterEach,expect,it} from "vitest";
import AnimePreferences from "./AnimePreferences";
afterEach(()=>{cleanup();localStorage.clear();});
it("defaults all toggles on and persists independent cast choices per library",()=>{
 const view=render(<AnimePreferences library="anime"/>);
 for(const name of ["Display Characters","Display Casts","Display Original Cast","Display Dub Cast"])expect(screen.getByRole("switch",{name}).getAttribute("aria-checked")).toBe("true");
 fireEvent.click(screen.getByRole("switch",{name:"Display Original Cast"}));
 expect(screen.getByRole("switch",{name:"Display Dub Cast"}).getAttribute("aria-checked")).toBe("true");
 view.unmount();render(<AnimePreferences library="anime"/>);expect(screen.getByRole("switch",{name:"Display Original Cast"}).getAttribute("aria-checked")).toBe("false");
 cleanup();render(<AnimePreferences library="other"/>);expect(screen.getByRole("switch",{name:"Display Original Cast"}).getAttribute("aria-checked")).toBe("true");
});
