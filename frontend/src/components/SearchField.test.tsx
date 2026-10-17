import {createRef} from "react";
import {act,cleanup,fireEvent,render,screen} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import SearchField from "./SearchField";
import {setPanelSolidity,setBackdropBlur} from "../lib/dashboardSettings";

afterEach(()=>{cleanup();localStorage.clear();});
it("updates translucency and blur when appearance settings change",()=>{
 render(<SearchField aria-label="Search titles"/>);
 const field=screen.getByRole("textbox",{name:"Search titles"}) as HTMLInputElement;
 const initial=field.style.backgroundColor;
 act(()=>{setPanelSolidity(90);setBackdropBlur(23);});
 expect(field.style.backgroundColor).not.toBe(initial);
 expect(field.style.backdropFilter).toBe("blur(23px)");
});
it("preserves input refs, form submission, and trailing actions",()=>{
 const submit=vi.fn(),clear=vi.fn(),ref=createRef<HTMLInputElement>();
 render(<form onSubmit={event=>{event.preventDefault();submit();}}><SearchField ref={ref} aria-label="Find collection" defaultValue="Drama" trailing={<button type="button" onClick={clear}>Clear</button>}/><button>Find</button></form>);
 expect(ref.current).toBe(screen.getByRole("textbox",{name:"Find collection"}));
 fireEvent.click(screen.getByRole("button",{name:"Clear"}));expect(clear).toHaveBeenCalledOnce();expect(submit).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole("button",{name:"Find"}));expect(submit).toHaveBeenCalledOnce();
});
