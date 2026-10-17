import {useEffect,useId,useRef,useState,type ReactNode} from "react";
import {ChevronLeft,ChevronRight} from "lucide-react";
import "./HomeExperience.css";

export default function HomeMediaRow({label,ariaLabel,children,wrap=false}:{label:string;ariaLabel?:string;children:ReactNode;wrap?:boolean}){
  const heading=useId(),row=useRef<HTMLDivElement>(null);
  const [edges,setEdges]=useState({left:false,right:false});
  useEffect(()=>{
    const element=row.current;if(!element||wrap)return;
    const update=()=>setEdges({left:element.scrollLeft>1,right:element.scrollLeft+element.clientWidth<element.scrollWidth-1});
    update();element.addEventListener("scroll",update);window.addEventListener("resize",update);
    const observer=typeof ResizeObserver!=="undefined"?new ResizeObserver(update):undefined;observer?.observe(element);
    return()=>{element.removeEventListener("scroll",update);window.removeEventListener("resize",update);observer?.disconnect();};
  },[children,wrap]);
  const scroll=(direction:number)=>row.current?.scrollBy({left:row.current.clientWidth*.85*direction,behavior:window.matchMedia?.("(prefers-reduced-motion: reduce)").matches?"instant":"smooth"});
  return <section className="pv-home-row" aria-label={ariaLabel} aria-labelledby={ariaLabel?undefined:heading}>
    <div className="pv-home-row-heading"><h2 id={heading}>{label}</h2>{!wrap&&(edges.left||edges.right)&&<div className="pv-home-row-arrows">
      <button aria-label={`Scroll ${label} left`} disabled={!edges.left} onClick={()=>scroll(-1)}><ChevronLeft aria-hidden="true"/></button>
      <button aria-label={`Scroll ${label} right`} disabled={!edges.right} onClick={()=>scroll(1)}><ChevronRight aria-hidden="true"/></button>
    </div>}</div>
    <div className={wrap?"pv-home-library-grid":"pv-home-landscape-track scrollbar-hidden"} ref={row}>{children}</div>
  </section>;
}
