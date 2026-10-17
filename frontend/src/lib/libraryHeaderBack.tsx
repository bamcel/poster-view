import {createContext,useContext,type ReactNode} from "react";

export const LibraryHeaderBackContext=createContext(false);
// Standalone pages retain navigation; app chrome supplies the single top-left link.
export function LibraryPageBack({children}:{children:ReactNode}){
  return useContext(LibraryHeaderBackContext)?null:children;
}
