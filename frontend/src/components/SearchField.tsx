import {useEffect,useState,type InputHTMLAttributes,type ReactNode,type Ref} from "react";
import {Search} from "lucide-react";
import {PANEL_SOLIDITY_EVENT,PANEL_OVERLAY_EVENT,BACKDROP_BLUR_EVENT,panelSolidity,panelOverlay,backdropBlur,translucentPanelColor} from "../lib/dashboardSettings";

type Props=InputHTMLAttributes<HTMLInputElement>&{ref?:Ref<HTMLInputElement>;containerClassName?:string;trailing?:ReactNode};
export default function SearchField({containerClassName="",trailing,className="",style,...props}:Props){
 const [,refresh]=useState(0);
 useEffect(()=>{
  const update=()=>refresh(value=>value+1);
  const events=[PANEL_SOLIDITY_EVENT,PANEL_OVERLAY_EVENT,BACKDROP_BLUR_EVENT];
  events.forEach(event=>window.addEventListener(event,update));
  return()=>events.forEach(event=>window.removeEventListener(event,update));
 },[]);
 return <span className={`relative block min-w-0 ${containerClassName}`}>
  <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-faint"/>
  <input {...props} placeholder={props.placeholder??"Search"} className={`h-11 w-full min-w-0 rounded-full border border-border py-2 pl-9 ${trailing?"pr-10":"pr-3"} text-[16px] font-medium text-muted outline-none placeholder:text-muted focus:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent md:text-sm ${className}`} style={{...style,backgroundColor:translucentPanelColor("--color-surface-2",panelSolidity(),panelOverlay()),backdropFilter:`blur(${backdropBlur()}px)`,WebkitBackdropFilter:`blur(${backdropBlur()}px)`}}/>
  {trailing&&<span className="absolute right-3 top-1/2 z-10 flex -translate-y-1/2 items-center">{trailing}</span>}
 </span>;
}
