import {useEffect} from "react";
const drafts=new Set<symbol>();
export const confirmUnsavedSettings=()=>drafts.size===0||window.confirm("Discard unsaved settings and leave this page?");
/** Protect explicit drafts on document exit and ordinary in-app link navigation. */
export function useUnsavedSettings(dirty:boolean){
 useEffect(()=>{
  if(!dirty)return;
  const token=Symbol();drafts.add(token);
  const unload=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue="";};
  const click=(event:MouseEvent)=>{if((event as MouseEvent&{settingsChecked?:boolean}).settingsChecked)return;const link=(event.target as Element)?.closest?.("a[href]");if(!link||event.defaultPrevented||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;const href=link.getAttribute("href");if(!href||href.startsWith("#")||new URL(href,location.href).href===location.href)return;(event as MouseEvent&{settingsChecked?:boolean}).settingsChecked=true;if(!confirmUnsavedSettings()){event.preventDefault();event.stopPropagation();}};
  window.addEventListener("beforeunload",unload);document.addEventListener("click",click,true);
  return()=>{drafts.delete(token);window.removeEventListener("beforeunload",unload);document.removeEventListener("click",click,true);};
 },[dirty]);
}
