import {afterEach,expect,it,vi} from "vitest";
import {stopAfterWatchReports} from "./sessionTeardown";
afterEach(()=>vi.useRealTimers());
it("saves watch progress before retiring delivery",async()=>{
  let finish!:()=>void;
  const stop=vi.fn().mockResolvedValue(undefined);
  const retiring=stopAfterWatchReports(new Promise<void>(resolve=>{finish=resolve;}),stop);
  expect(stop).not.toHaveBeenCalled();finish();await retiring;expect(stop).toHaveBeenCalledOnce();
});
it("releases delivery after three seconds even when progress never settles",async()=>{
  vi.useFakeTimers();const stop=vi.fn().mockResolvedValue(undefined);
  const retiring=stopAfterWatchReports(new Promise(()=>{}),stop);
  await vi.advanceTimersByTimeAsync(2999);expect(stop).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);await retiring;expect(stop).toHaveBeenCalledOnce();
});
it("retires delivery after a failed save",async()=>{
  const stop=vi.fn().mockResolvedValue(undefined);
  await stopAfterWatchReports(Promise.reject(new Error("offline")),stop);expect(stop).toHaveBeenCalledOnce();
});
