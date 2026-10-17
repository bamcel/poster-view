import {cleanup,fireEvent,render} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import {useUnsavedSettings} from "./useUnsavedSettings";
afterEach(()=>{cleanup();vi.restoreAllMocks();});
function Draft({dirty}:{dirty:boolean}){useUnsavedSettings(dirty);return <a href="/settings/libraries">Libraries</a>;}
it("protects explicit drafts on exit and removes protection when saved",()=>{
 const confirm=vi.spyOn(window,"confirm").mockReturnValue(false),view=render(<Draft dirty/>);
 const exit=new Event("beforeunload",{cancelable:true});window.dispatchEvent(exit);expect(exit.defaultPrevented).toBe(true);
 fireEvent.click(view.getByRole("link"));expect(confirm).toHaveBeenCalledOnce();
 view.rerender(<Draft dirty={false}/>);const savedExit=new Event("beforeunload",{cancelable:true});window.dispatchEvent(savedExit);expect(savedExit.defaultPrevented).toBe(false);
});
