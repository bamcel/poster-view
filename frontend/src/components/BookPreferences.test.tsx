import {render,screen,fireEvent,cleanup} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import BookPreferences from "./BookPreferences";
const actions=vi.hoisted(()=>({tracking:vi.fn(),effect:vi.fn(),title:vi.fn()}));
vi.mock("../lib/libraryDisplay",()=>({useTrackingOverlays:()=>[true,actions.tracking,{busy:false,coloredEffect:"both",coloredTitle:false,toggleColoredEffect:actions.effect,setColoredTitle:actions.title}]}));
afterEach(cleanup);
it("exposes book display preferences and saves changes through existing settings",()=>{
 render(<BookPreferences/>);
 fireEvent.click(screen.getByRole("switch",{name:"Display reading status"}));expect(actions.tracking).toHaveBeenCalledWith(false);
 fireEvent.click(screen.getByRole("switch",{name:"Colored edition badge"}));expect(actions.effect).toHaveBeenCalledWith("badge");
 fireEvent.click(screen.getByRole("switch",{name:"Colored edition title"}));expect(actions.title).toHaveBeenCalledWith(true);
});
