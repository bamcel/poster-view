import {cleanup,fireEvent,render,screen} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import CardActionMenu from "./CardActionMenu";

afterEach(cleanup);
it("moves menu focus to the hovered action and retains keyboard navigation",()=>{
 const scan=vi.fn(),refresh=vi.fn();
 render(<CardActionMenu label="Library actions" actions={[{label:"Scan Library Files",onSelect:scan},{label:"Refresh Metadata",onSelect:refresh}]}><button>Library</button></CardActionMenu>);
 fireEvent.contextMenu(screen.getByRole("button",{name:"Library"}));
 const first=screen.getByRole("menuitem",{name:"Scan Library Files"}),second=screen.getByRole("menuitem",{name:"Refresh Metadata"});
 expect(document.activeElement).toBe(first);
 fireEvent.pointerEnter(second);
 expect(document.activeElement).toBe(second);
 expect(scan).not.toHaveBeenCalled();expect(refresh).not.toHaveBeenCalled();
 fireEvent.keyDown(second,{key:"ArrowUp"});expect(document.activeElement).toBe(first);
 fireEvent.keyDown(first,{key:"Escape"});
 expect(screen.queryByRole("menu")).toBeNull();expect(document.activeElement).toBe(screen.getByRole("button",{name:"Library"}));
});
