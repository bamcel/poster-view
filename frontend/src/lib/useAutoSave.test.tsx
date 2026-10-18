import {act,cleanup,renderHook} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import {useAutoSave} from "./useAutoSave";
afterEach(()=>{cleanup();vi.useRealTimers();});
it("skips hydration, debounces typing and confirms only after persistence",async()=>{
 vi.useFakeTimers();const save=vi.fn().mockResolvedValue(undefined);
 const {result,rerender}=renderHook(({value})=>useAutoSave({value,save}),{initialProps:{value:"initial"}});
 expect(save).not.toHaveBeenCalled();rerender({value:"one"});rerender({value:"two"});
 expect(result.current.status).toBe("pending");
 await act(async()=>{await vi.advanceTimersByTimeAsync(600);});
 expect(save).toHaveBeenCalledTimes(1);expect(save).toHaveBeenCalledWith("two");expect(result.current.status).toBe("saved");
});
it("serializes edits while a previous save is pending",async()=>{
 vi.useFakeTimers();let finish!:()=>void;const save=vi.fn().mockImplementationOnce(()=>new Promise<void>(resolve=>{finish=resolve;})).mockResolvedValue(undefined);
 const {result,rerender}=renderHook(({value})=>useAutoSave({value,save}),{initialProps:{value:"initial"}});
 rerender({value:"one"});await act(async()=>{await vi.advanceTimersByTimeAsync(600);});rerender({value:"two"});
 expect(save).toHaveBeenCalledTimes(1);await act(async()=>{finish();});
 expect(save.mock.calls.map(call=>call[0])).toEqual(["one","two"]);expect(result.current.status).toBe("saved");
});
it("retains failed drafts for retry and never reports success",async()=>{
 vi.useFakeTimers();const save=vi.fn().mockRejectedValueOnce(new Error("Offline")).mockResolvedValue(undefined);
 const {result,rerender}=renderHook(({value})=>useAutoSave({value,save}),{initialProps:{value:"initial"}});
 rerender({value:"edited"});await act(async()=>{await vi.advanceTimersByTimeAsync(600);});
 expect(result.current.status).toBe("error");expect(result.current.error?.message).toBe("Offline");
 await act(async()=>{result.current.retry();});expect(result.current.status).toBe("saved");expect(save).toHaveBeenCalledTimes(2);
});
it("flushes a pending valid edit on navigation",async()=>{
 vi.useFakeTimers();const save=vi.fn().mockResolvedValue(undefined);
 const {rerender,unmount}=renderHook(({value})=>useAutoSave({value,save}),{initialProps:{value:"initial"}});
 rerender({value:"edited"});unmount();await act(async()=>{});expect(save).toHaveBeenCalledWith("edited");
});

it("saves the newer draft after an earlier in-flight request fails",async()=>{
 vi.useFakeTimers();let fail!:(error:Error)=>void;
 const save=vi.fn().mockImplementationOnce(()=>new Promise<void>((_,reject)=>{fail=reject;})).mockResolvedValue(undefined);
 const {result,rerender}=renderHook(({value})=>useAutoSave({value,save}),{initialProps:{value:"initial"}});
 rerender({value:"one"});await act(async()=>{await vi.advanceTimersByTimeAsync(600);});rerender({value:"two"});
 await act(async()=>{fail(new Error("Old request failed"));});expect(result.current.status).toBe("pending");
 await act(async()=>{await vi.advanceTimersByTimeAsync(600);});
 expect(save.mock.calls.map(call=>call[0])).toEqual(["one","two"]);expect(result.current.status).toBe("saved");
});
