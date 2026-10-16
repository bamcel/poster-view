import { useCallback, useContext, useSyncExternalStore } from "react";
import { AuthSessionContext } from "./authContext";

export type HeadlineArtwork = "backdrop" | "banner";
const changedEvent = "posterview:homepage-headline-changed";

// Homepage appearance is browser-local and isolated between signed-in users.
export function useHomepageHeadline(): [HeadlineArtwork, (value: HeadlineArtwork) => void] {
  const session = useContext(AuthSessionContext);
  const key = `posterview:homepage-headline:${session?.user?.id ?? "local"}`;
  const read = useCallback((): HeadlineArtwork => {
    try { return localStorage.getItem(key) === "banner" ? "banner" : "backdrop"; }
    catch { return "backdrop"; }
  }, [key]);
  const subscribe = useCallback((notify: () => void) => {
    const onStorage = (event: StorageEvent) => { if (event.key === null || event.key === key) notify(); };
    window.addEventListener("storage", onStorage);
    window.addEventListener(changedEvent, notify);
    window.addEventListener("posterview:account-changed", notify);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(changedEvent, notify);
      window.removeEventListener("posterview:account-changed", notify);
    };
  }, [key]);
  const value = useSyncExternalStore(subscribe, read, () => "backdrop" as HeadlineArtwork);
  const setValue = useCallback((next: HeadlineArtwork) => {
    try { localStorage.setItem(key, next === "banner" ? "banner" : "backdrop"); }
    catch { return; }
    window.dispatchEvent(new Event(changedEvent));
  }, [key]);
  return [value, setValue];
}

const navigationMemory=new Map<string,boolean>();
export function useHomepageNavigation():[boolean,(open:boolean)=>void]{
  const session=useContext(AuthSessionContext);
  const key=`posterview:homepage-navigation:${session?.user?.id??"local"}`;
  const read=useCallback(()=>{
    try {const saved=localStorage.getItem(key);return saved===null?(navigationMemory.get(key)??false):saved==="expanded";}
    catch{return navigationMemory.get(key)??false;}
  },[key]);
  const subscribe=useCallback((notify:()=>void)=>{
    const storage=(event:StorageEvent)=>{if(event.key===null||event.key===key)notify();};
    window.addEventListener("storage",storage);window.addEventListener("posterview:homepage-navigation-changed",notify);window.addEventListener("posterview:account-changed",notify);
    return()=>{window.removeEventListener("storage",storage);window.removeEventListener("posterview:homepage-navigation-changed",notify);window.removeEventListener("posterview:account-changed",notify);};
  },[key]);
  const open=useSyncExternalStore(subscribe,read,()=>false);
  const setOpen=useCallback((next:boolean)=>{
    try{localStorage.setItem(key,next?"expanded":"collapsed");}catch{navigationMemory.set(key,next);}
    window.dispatchEvent(new Event("posterview:homepage-navigation-changed"));
  },[key]);
  return [open,setOpen];
}
