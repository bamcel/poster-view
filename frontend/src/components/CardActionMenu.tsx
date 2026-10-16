import {useEffect,useLayoutEffect,useRef,useState,type ReactNode,type MouseEvent,type KeyboardEvent} from "react";
import {createPortal} from "react-dom";

type Action={label:string;onSelect:()=>void|Promise<unknown>;success?:string};
export default function CardActionMenu({label,actions,children}:{label:string;actions:Action[];children:ReactNode}) {
 const [point,setPoint]=useState<{x:number;y:number}|null>(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState<{text:string;error:boolean}|null>(null);
 const menu=useRef<HTMLDivElement>(null),trigger=useRef<HTMLElement|null>(null),pending=useRef(false);
 const close=(restore=false)=>{setPoint(null);if(restore)trigger.current?.focus();};
 const open=(event:MouseEvent<HTMLDivElement>|KeyboardEvent<HTMLDivElement>)=>{
  if(!actions.length)return;
  event.preventDefault();event.stopPropagation();
  trigger.current=(event.target as HTMLElement).closest<HTMLElement>("a,button")??event.target as HTMLElement;
  const rect=trigger.current.getBoundingClientRect();
  setPoint("clientX" in event?{x:event.clientX,y:event.clientY}:{x:rect.left,y:rect.bottom});setNotice(null);
 };
 useLayoutEffect(()=>{
  if(!point||!menu.current)return;
  const rect=menu.current.getBoundingClientRect();
  const x=Math.max(8,Math.min(point.x,window.innerWidth-rect.width-8)),y=Math.max(8,Math.min(point.y,window.innerHeight-rect.height-8));
  if(x!==point.x||y!==point.y)setPoint({x,y});
  menu.current.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
 },[point]);
 useEffect(()=>{
  if(!point)return;
  const outside=(event:Event)=>{if(!menu.current?.contains(event.target as Node))setPoint(null);};
  const changed=()=>{setPoint(null);setNotice(null);};
  window.addEventListener("pointerdown",outside,true);window.addEventListener("scroll",outside,true);window.addEventListener("resize",changed);window.addEventListener("posterview:account-changed",changed);
  return()=>{window.removeEventListener("pointerdown",outside,true);window.removeEventListener("scroll",outside,true);window.removeEventListener("resize",changed);window.removeEventListener("posterview:account-changed",changed);};
 },[point]);
 useEffect(()=>{const changed=()=>{setPoint(null);setNotice(null);};window.addEventListener("posterview:account-changed",changed);return()=>window.removeEventListener("posterview:account-changed",changed);},[]);
 const keys=(event:KeyboardEvent<HTMLDivElement>)=>{
  if(event.key==="Escape"||event.key==="Tab"){if(event.key==="Escape")event.preventDefault();event.stopPropagation();close(true);return;}
  if(!["ArrowDown","ArrowUp","Home","End"].includes(event.key))return;
  event.preventDefault();const buttons=[...menu.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];if(!buttons.length)return;
  const index=buttons.indexOf(document.activeElement as HTMLButtonElement);
  buttons[event.key==="Home"?0:event.key==="End"?buttons.length-1:(index+(event.key==="ArrowUp"?-1:1)+buttons.length)%buttons.length].focus();
 };
 return <><div className="contents" onContextMenu={open} onKeyDown={event=>{if(event.key==="ContextMenu"||event.shiftKey&&event.key==="F10")open(event);}}>{children}</div>
 {point&&createPortal(<div ref={menu} tabIndex={-1} role="menu" aria-label={label} onKeyDown={keys} className="fixed z-[100] min-w-56 max-w-[calc(100vw-16px)] max-h-[calc(100dvh-16px)] overflow-y-auto rounded-xl border border-white/15 bg-[rgba(18,22,29,0.78)] p-1 text-sm text-white shadow-[0_16px_48px_#0007,inset_0_1px_0_#ffffff10] backdrop-blur-xl backdrop-saturate-150" style={{left:point.x,top:point.y}}>{actions.map(action=><button key={action.label} role="menuitem" type="button" disabled={busy} className="block w-full rounded-lg px-4 py-2.5 text-left transition-colors hover:bg-white/10 focus:bg-white/10 focus:outline-none disabled:opacity-50" onPointerEnter={event=>{if(!event.currentTarget.disabled)event.currentTarget.focus({preventScroll:true});}} onClick={async()=>{
  if(pending.current)return;pending.current=true;setBusy(true);
  try{await action.onSelect();close(true);if(action.success)setNotice({text:action.success,error:false});}
  catch(error){setNotice({text:error instanceof Error?error.message:"The action could not be completed.",error:true});}
  finally{pending.current=false;setBusy(false);}
 }}>{action.label}</button>)}</div>,document.body)}
 {notice&&createPortal(<div role={notice.error?"alert":"status"} className="fixed bottom-5 right-5 z-[110] flex max-w-sm items-center gap-3 rounded-xl border border-border bg-sidebar px-4 py-3 text-sm text-white shadow-xl"><span>{notice.text}</span><button type="button" aria-label="Dismiss action message" onClick={()=>setNotice(null)}>×</button></div>,document.body)}</>;
}
