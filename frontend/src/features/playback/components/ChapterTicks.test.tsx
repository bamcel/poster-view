import {cleanup,fireEvent,render,screen} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import ChapterTicks from "./ChapterTicks";
afterEach(cleanup);
it("positions chapter ticks on the source timeline and seeks to their original timestamp",()=>{
  const seek=vi.fn();
  render(<ChapterTicks chapters={[{title:"Opening",start_seconds:90}]} duration={1200} disabled={false} onSeek={seek}/>);
  const marker=screen.getByRole("button",{name:"Seek to chapter Opening at 1:30"});
  expect(marker.style.left).toBe("7.5%");expect(marker.title).toBe("Opening · 1:30");
  fireEvent.click(marker);expect(seek).toHaveBeenCalledWith(90);
});
it("ignores invalid, duplicate and endpoint chapters and provides a title fallback",()=>{
  const starts=[0,-1,NaN,Infinity,1200,1400,90,90];
  render(<ChapterTicks chapters={starts.map(start_seconds=>({title:"",start_seconds}))} duration={1200} disabled onSeek={vi.fn()}/>);
  expect(screen.getAllByRole("button")).toHaveLength(1);
  expect((screen.getByRole("button",{name:"Seek to chapter Chapter 7 at 1:30"}) as HTMLButtonElement).disabled).toBe(true);
});
it("does not show markers for unknown duration or missing chapters",()=>{
  const props={chapters:[{title:"Opening",start_seconds:90}],duration:0,disabled:false,onSeek:vi.fn()};
  const view=render(<ChapterTicks {...props}/>);expect(screen.queryByRole("button")).toBeNull();
  view.rerender(<ChapterTicks {...props} duration={1200} chapters={[]}/>);expect(screen.queryByRole("button")).toBeNull();
});
