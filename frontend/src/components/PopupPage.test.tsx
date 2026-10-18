import {cleanup,fireEvent,render,screen} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import PopupPage from "./PopupPage";

afterEach(cleanup);
it("shares an accessible header, navigation, body and footer and restores focus",()=>{
 const opener=document.createElement("button");document.body.appendChild(opener);opener.focus();
 const close=vi.fn();const view=render(<PopupPage title="Preferences" description="Saved automatically" onClose={close} navigation={<button>General</button>} footer={<button>Done</button>}><label>Name<input/></label></PopupPage>);
 const dialog=screen.getByRole("dialog",{name:"Preferences"});
 expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
 expect(screen.getByRole("navigation",{name:"Preferences sections"})).toBeTruthy();
 expect(document.activeElement).toBe(screen.getByRole("textbox",{name:"Name"}));
 const done=screen.getByRole("button",{name:"Done"});done.focus();fireEvent.keyDown(done,{key:"Tab"});
 expect(document.activeElement).toBe(screen.getByRole("button",{name:"Close Preferences"}));
 fireEvent.keyDown(dialog,{key:"Escape"});expect(close).toHaveBeenCalledOnce();
 expect(document.body.style.overflow).toBe("hidden");view.unmount();expect(document.activeElement).toBe(opener);opener.remove();
});
it("keeps busy popups open for close buttons and keyboard cancellation",()=>{
 const close=vi.fn();render(<PopupPage title="Saving" onClose={close} closeDisabled><p>Working</p></PopupPage>);
 const dialog=screen.getByRole("dialog");
 expect((screen.getByRole("button",{name:"Close Saving"}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.keyDown(dialog,{key:"Escape"});fireEvent(dialog,new Event("cancel",{bubbles:false,cancelable:true}));expect(close).not.toHaveBeenCalled();
});
it("keeps body scrolling locked until nested popup pages have closed",()=>{
 const first=render(<PopupPage title="Parent" onClose={()=>{}}>Parent</PopupPage>);
 const second=render(<PopupPage title="Child" layout="compact" onClose={()=>{}}>Child</PopupPage>);
 second.unmount();expect(document.body.style.overflow).toBe("hidden");first.unmount();expect(document.body.style.overflow).not.toBe("hidden");
});
