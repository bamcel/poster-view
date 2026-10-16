import {act,cleanup,renderHook} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import {ActivityProvider,useActivity} from "./ActivityContext";

afterEach(()=>{cleanup();vi.useRealTimers();});
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
