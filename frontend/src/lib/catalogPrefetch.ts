import {useCallback} from "react";
import {useQueryClient} from "@tanstack/react-query";
import {nativeLibraries} from "../api/nativeLibraries";
export function useCatalogPrefetch(){
 const client=useQueryClient();
 return useCallback((id:string)=>{
  void client.prefetchQuery({queryKey:["native-catalog",id],queryFn:()=>nativeLibraries.catalog(id),staleTime:5*60_000,gcTime:30*60_000});
 },[client]);
}
