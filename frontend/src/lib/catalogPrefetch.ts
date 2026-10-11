import {useEffect} from "react";
import {useQueryClient} from "@tanstack/react-query";
import {nativeLibraries,type NativeLibrary} from "../api/nativeLibraries";
// Warm catalogs without flooding the server when many libraries are configured.
export function useCatalogPrefetch(libraries:NativeLibrary[]|undefined){
 const client=useQueryClient();
 const ids=libraries?.map(library=>library.id).join("|")??"";
 useEffect(()=>{
  if(!ids)return;
  let stopped=false,index=0;
  const queue=ids.split("|");
  async function worker(){while(!stopped&&index<queue.length){const id=queue[index++];await client.prefetchQuery({queryKey:["native-catalog",id],queryFn:()=>nativeLibraries.catalog(id),staleTime:60_000,gcTime:30*60_000});}}
  void worker();void worker();
  return()=>{stopped=true;};
 },[client,ids]);
}
