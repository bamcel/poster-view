import {act,cleanup,render,screen} from "@testing-library/react";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import TimelinePreview from "./TimelinePreview";

beforeEach(()=>{
  vi.useFakeTimers();vi.stubGlobal("fetch",vi.fn().mockResolvedValue({ok:true,blob:async()=>new Blob(["jpeg"])}));
  vi.spyOn(URL,"createObjectURL").mockReturnValue("blob:preview");vi.spyOn(URL,"revokeObjectURL").mockImplementation(()=>{});
});
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
it("does not request previews until deliberate timeline inspection and quantizes requests",async()=>{
  const view=render(<TimelinePreview library="a/b" item="one" seconds={null} duration={100}/>);
  await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});expect(fetch).not.toHaveBeenCalled();
  view.rerender(<TimelinePreview library="a/b" item="one" seconds={29} duration={100}/>);
  await act(async()=>{await vi.advanceTimersByTimeAsync(349);});expect(fetch).not.toHaveBeenCalled();
  await act(async()=>{await vi.advanceTimersByTimeAsync(1);});
  expect(fetch).toHaveBeenCalledWith("/api/playback/native/a%2Fb/one/preview?seconds=20",expect.objectContaining({signal:expect.any(AbortSignal)}));
  expect(screen.getByRole("img",{name:"Preview near 0:20"}).getAttribute("src")).toBe("blob:preview");
  view.rerender(<TimelinePreview library="a/b" item="one" seconds={28} duration={100}/>);
  await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});expect(fetch).toHaveBeenCalledTimes(1);
});
it("cancels superseded requests and releases images on exit",async()=>{
  const view=render(<TimelinePreview library="a" item="one" seconds={10} duration={100}/>);
  await act(async()=>{await vi.advanceTimersByTimeAsync(350);});
  const signal=vi.mocked(fetch).mock.calls[0][1]!.signal!;
  view.rerender(<TimelinePreview library="a" item="one" seconds={80} duration={100}/>);
  expect(signal.aborted).toBe(true);expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");expect(screen.queryByRole("img")).toBeNull();
  view.rerender(<TimelinePreview library="a" item="one" seconds={null} duration={100}/>);
  await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});expect(fetch).toHaveBeenCalledTimes(1);
});
it("quietly falls back to the timestamp when the preview worker is busy",async()=>{
  vi.mocked(fetch).mockResolvedValue({ok:false} as Response);
  render(<TimelinePreview library="a" item="one" seconds={15} duration={100}/>);
  await act(async()=>{await vi.advanceTimersByTimeAsync(350);});
  expect(screen.getByText("0:15")).toBeTruthy();expect(screen.queryByRole("img")).toBeNull();expect(screen.queryByRole("alert")).toBeNull();
});
it("does not reuse a revoked image when reentering the same timeline bucket",async()=>{
  const view=render(<TimelinePreview library="a" item="one" seconds={15} duration={100}/>);
  await act(async()=>{await vi.advanceTimersByTimeAsync(350);});expect(screen.getByRole("img")).toBeTruthy();
  view.rerender(<TimelinePreview library="a" item="one" seconds={null} duration={100}/>);
  vi.mocked(fetch).mockResolvedValue({ok:false} as Response);
  view.rerender(<TimelinePreview library="a" item="one" seconds={15} duration={100}/>);
  expect(screen.queryByRole("img")).toBeNull();
  await act(async()=>{await vi.advanceTimersByTimeAsync(350);});expect(screen.queryByRole("img")).toBeNull();
});
