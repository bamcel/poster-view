import {useState} from "react";
import {cleanup,fireEvent,render,screen} from "@testing-library/react";
import {afterEach,expect,it} from "vitest";
import HexColorPicker from "./HexColorPicker";
afterEach(cleanup);
it("opens in HEX, previews valid values, and keeps incomplete edits from changing the color",()=>{
 function Example(){const [color,setColor]=useState("#ECEFF4");return <HexColorPicker label="Title" value={color} onChange={setColor}/>;}
 render(<Example/>);fireEvent.click(screen.getByRole("button",{name:"Choose Title color"}));
 const field=screen.getByLabelText("Title HEX color") as HTMLInputElement;
 expect(field.value).toBe("#ECEFF4");
 fireEvent.change(field,{target:{value:"#123"}});
 expect(screen.getByText("#ECEFF4")).toBeTruthy();
 fireEvent.change(field,{target:{value:"#aabbcc"}});
 expect(screen.getByText("#AABBCC")).toBeTruthy();
 fireEvent.keyDown(field,{key:"Escape"});expect(screen.queryByRole("dialog")).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"Choose Title color"}));
 expect((screen.getByLabelText("Title HEX color") as HTMLInputElement).value).toBe("#AABBCC");
});
