import {afterEach,expect,it,vi} from "vitest";
import {nativeLibraries} from "../api/nativeLibraries";
import {catalogQueryOptions,catalogView} from "./nativeCatalogQueries";
vi.mock("../api/nativeLibraries",()=>({nativeLibraries:{catalog:vi.fn(async()=>[]),summaries:vi.fn(async()=>[])}}));
afterEach(()=>vi.clearAllMocks());
it("uses summaries for video libraries and keeps the legacy catalog for books and YouTube",async()=>{
 for(const library_type of ["anime","shows","movies"] as const){
  const options=catalogQueryOptions({id:library_type,library_type});
  expect(options.queryKey).toEqual(["native-catalog",library_type,"summary"]);
  await options.queryFn();
 }
 expect(nativeLibraries.catalog).not.toHaveBeenCalled();
 expect(nativeLibraries.summaries).toHaveBeenCalledTimes(3);
 for(const library_type of ["books","youtube"] as const){
  const options=catalogQueryOptions({id:library_type,library_type});
  expect(options.queryKey).toEqual(["native-catalog",library_type]);
  await options.queryFn();
 }
 expect(nativeLibraries.catalog).toHaveBeenCalledTimes(2);
});
it("shares one transformed view for a cached summary response",()=>{
 const entries:Awaited<ReturnType<typeof nativeLibraries.summaries>>=[];
 expect(catalogView(entries)).toBe(catalogView(entries));
 expect(catalogView([])).not.toBe(catalogView(entries));
});
