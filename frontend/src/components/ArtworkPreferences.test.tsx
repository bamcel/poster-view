import {cleanup,fireEvent,render,screen} from "@testing-library/react";
import {afterEach,expect,it} from "vitest";
import ArtworkPreferences,{animatedArtworkEnabled} from "./ArtworkPreferences";
afterEach(()=>{cleanup();localStorage.clear();});
it("uses one persistent per-library choice for every animated artwork type",()=>{
 const view=render(<ArtworkPreferences library="anime"/>);
 expect(animatedArtworkEnabled("anime")).toBe(true);
 fireEvent.click(screen.getByRole("switch",{name:"Display animated artwork"}));
 expect(animatedArtworkEnabled("anime")).toBe(false);
 expect(animatedArtworkEnabled("movies")).toBe(true);
 view.unmount();render(<ArtworkPreferences library="anime"/>);
 expect(screen.getByRole("switch",{name:"Display animated artwork"}).getAttribute("aria-checked")).toBe("false");
});
