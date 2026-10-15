import {cleanup,fireEvent,render,screen} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import PlaybackTimeline from "./PlaybackTimeline";
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
it("isolates hover updates from playback controls and clears previews on leave",()=>{
  vi.useFakeTimers();vi.stubGlobal("PointerEvent",MouseEvent);
  const renders=vi.fn();function Control(){renders();return <input aria-label="Seek"/>;}
  const view=render(<PlaybackTimeline library="a" item="one" duration={100} position={10} buffered={20} scrubbing={null} disabled={false}><Control/></PlaybackTimeline>);
  const timeline=view.container.firstElementChild as HTMLDivElement;
  vi.spyOn(timeline,"getBoundingClientRect").mockReturnValue({left:0,width:100} as DOMRect);
  fireEvent.pointerMove(timeline,{clientX:50});expect(screen.getByText("0:50")).toBeTruthy();
  fireEvent.pointerMove(timeline,{clientX:60});expect(screen.getByText("1:00")).toBeTruthy();expect(renders).toHaveBeenCalledTimes(1);
  fireEvent.pointerLeave(timeline);expect(screen.queryByLabelText("Timeline preview")).toBeNull();
});
it("passes chapter names to the timeline preview while scrubbing",()=>{
  vi.useFakeTimers();
  render(<PlaybackTimeline library="a" item="one" duration={100} position={10} buffered={20} scrubbing={60} disabled={false} chapters={[{title:"Second act",start_seconds:50}]}><input aria-label="Seek"/></PlaybackTimeline>);
  expect(screen.getByText("Second act")).toBeTruthy();expect(screen.getByText("1:00")).toBeTruthy();
});
