import {useCallback} from "react";
import {useQueryClient} from "@tanstack/react-query";
import type {NativeLibraryType} from "../api/nativeLibraries";
import {catalogQueryOptions} from "./nativeCatalogQueries";
export function useCatalogPrefetch(){
 const client=useQueryClient();
 return useCallback((id:string,library_type:NativeLibraryType="movies")=>{
  void client.prefetchQuery(catalogQueryOptions({id,library_type}));
 },[client]);
}
