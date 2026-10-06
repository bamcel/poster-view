import {expect,it,vi} from "vitest";
import {applyArtworkBatch} from "./artworkBatch";
it("retries timeouts, continues after failures, and returns only unfinished covers",async()=>{
 const attempts:Record<number,number>={};const progress=vi.fn();
 const apply=vi.fn(async (item:number)=>{attempts[item]=(attempts[item]??0)+1;if(item===2&&attempts[item]===1||item===3)throw new Error("Artwork provider request timed out.");});
 const result=await applyArtworkBatch([1,2,3,4],apply,progress);
 expect(result.completed).toBe(3);expect(result.failed).toEqual([3]);expect(attempts).toEqual({1:1,2:2,3:3,4:1});expect(progress).toHaveBeenLastCalledWith(4);
 const retry=await applyArtworkBatch(result.failed,async()=>{},progress);expect(retry.completed).toBe(1);expect(retry.failed).toEqual([]);
});
it("does not retry permanent failures",async()=>{
 const apply=vi.fn(async()=>{throw new Error("Not found");});
 expect((await applyArtworkBatch([1],apply,()=>{})).failed).toEqual([1]);expect(apply).toHaveBeenCalledTimes(1);
});
