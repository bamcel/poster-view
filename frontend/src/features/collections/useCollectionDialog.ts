import {useEffect,useRef} from "react";

export function useCollectionDialog(onClose:()=>void,busy=false){
 const ref=useRef<HTMLElement>(null),close=useRef(onClose),pending=useRef(busy);close.current=onClose;pending.current=busy;
 useEffect(()=>{const previous=document.activeElement as HTMLElement|null;const dialog=ref.current;if(!dialog)return;const focusable=()=>Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href]')).filter(item=>item.tabIndex!==-1);focusable()[0]?.focus();const key=(event:KeyboardEvent)=>{if(event.key==="Escape"){event.preventDefault();event.stopPropagation();if(!pending.current)close.current();}if(event.key==="Tab"){const items=focusable(),first=items[0],last=items.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}};dialog.addEventListener("keydown",key);return()=>{dialog.removeEventListener("keydown",key);if(previous?.isConnected)previous.focus();};},[]);
 return ref;
}
