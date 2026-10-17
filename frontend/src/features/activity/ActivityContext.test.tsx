import {act,cleanup,renderHook} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import {ActivityProvider,useActivity} from "./ActivityContext";

afterEach(()=>{cleanup();localStorage.clear();vi.useRealTimers();});
it("auto-dismisses completions independently without restarting timers on polling and persists them",()=>{
 vi.useFakeTimers();
 const first=renderHook(useActivity,{wrapper:ActivityProvider});
 const done={id:"one",title:"One",detail:"Ready",state:"completed" as const,updatedAt:Date.now()};
 const second={...done,id:"two",title:"Two"};
 const failure={...done,id:"failed",state:"failed" as const};
 act(()=>first.result.current.publish("tasks",[done,failure]));
 act(()=>vi.advanceTimersByTime(5000));
 act(()=>first.result.current.publish("tasks",[done,second,failure]));
 act(()=>vi.advanceTimersByTime(4999));
 expect(first.result.current.items).toHaveLength(3);
 act(()=>vi.advanceTimersByTime(1));
 expect(first.result.current.items.map(item=>item.id)).toEqual(["tasks:failed","tasks:two"]);
 act(()=>vi.advanceTimersByTime(5000));
 expect(first.result.current.items.map(item=>item.id)).toEqual(["tasks:failed"]);
 first.unmount();
 const next=renderHook(useActivity,{wrapper:ActivityProvider});
 act(()=>next.result.current.publish("tasks",[done,second,failure]));
 expect(next.result.current.items.map(item=>item.id)).toEqual(["tasks:failed"]);
});

it("does not auto-dismiss a task that restarts before its completion timer expires",()=>{
 vi.useFakeTimers();
 const {result}=renderHook(useActivity,{wrapper:ActivityProvider});
 const task={id:"one",title:"One",detail:"Ready",state:"completed" as const,updatedAt:Date.now()};
 act(()=>result.current.publish("tasks",[task]));
 act(()=>vi.advanceTimersByTime(5000));
 act(()=>result.current.publish("tasks",[{...task,state:"running"}]));
 act(()=>vi.advanceTimersByTime(10000));
 expect(result.current.items[0].state).toBe("running");
});
it("namespaces sources, prioritizes work, clamps progress and removes sources",()=>{
 const {result}=renderHook(useActivity,{wrapper:ActivityProvider});
 act(()=>result.current.publish("plugin",[
  {id:"done",title:"Done",detail:"",state:"completed",updatedAt:Date.now()},
  {id:"work",title:"Work",detail:"",state:"running",progress:120},
 ]));
 expect(result.current.items.map(item=>item.id)).toEqual(["plugin:work","plugin:done"]);
 expect(result.current.items[0].progress).toBe(100);
 act(()=>result.current.dismiss("plugin:work"));
 expect(result.current.items).toHaveLength(2);
 act(()=>result.current.clearFinished());
 expect(result.current.items).toHaveLength(1);
 act(()=>result.current.publish("plugin",[]));
 expect(result.current.items).toHaveLength(0);
});
it("expires completed activities and allows changed failures to reappear",()=>{
 vi.useFakeTimers();
 const {result}=renderHook(useActivity,{wrapper:ActivityProvider});
 const failure={id:"task",title:"Task",detail:"Failed",state:"failed" as const};
 act(()=>result.current.publish("test",[failure]));
 act(()=>result.current.dismiss("test:task"));
 expect(result.current.items).toHaveLength(0);
 act(()=>result.current.publish("test",[{...failure,detail:"New failure"}]));
 expect(result.current.items).toHaveLength(1);
 act(()=>result.current.publish("test",[{...failure,state:"completed",updatedAt:Date.now()}]));
 expect(result.current.items).toHaveLength(1);
 act(()=>vi.advanceTimersByTime(30*60_000));
 expect(result.current.items).toHaveLength(0);
});

it.each(["dismiss","clearFinished"] as const)("persists %s across remounts without hiding a newer result",action=>{
 const task={id:"task",title:"Task",detail:"Completed",state:"completed" as const,updatedAt:Date.now()};
 const first=renderHook(useActivity,{wrapper:ActivityProvider});
 act(()=>first.result.current.publish("tasks",[task]));
 act(()=>action==="dismiss"?first.result.current.dismiss("tasks:task"):first.result.current.clearFinished());
 expect(first.result.current.items).toHaveLength(0);first.unmount();
 const next=renderHook(useActivity,{wrapper:ActivityProvider});
 act(()=>next.result.current.publish("tasks",[task]));expect(next.result.current.items).toHaveLength(0);
 act(()=>next.result.current.publish("tasks",[{...task,updatedAt:task.updatedAt+1000}]));expect(next.result.current.items).toHaveLength(1);
});
