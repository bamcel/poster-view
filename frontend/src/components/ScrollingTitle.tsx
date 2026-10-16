import {useEffect,useRef,useState,type CSSProperties} from "react";
import "./ScrollingTitle.css";

export default function ScrollingTitle({title,textClassName}:{title:string;textClassName?:string}){
  const viewport=useRef<HTMLSpanElement>(null),text=useRef<HTMLSpanElement>(null);
  const [distance,setDistance]=useState(0);
  useEffect(()=>{
    let active=true;
    const measure=()=>{if(active&&viewport.current&&text.current)setDistance(Math.max(0,text.current.scrollWidth-viewport.current.clientWidth));};
    measure();
    const observer=typeof ResizeObserver!=="undefined"?new ResizeObserver(measure):undefined;
    if(viewport.current)observer?.observe(viewport.current);
    if(text.current)observer?.observe(text.current);
    window.addEventListener("resize",measure);
    void document.fonts?.ready.then(measure);
    return()=>{active=false;observer?.disconnect();window.removeEventListener("resize",measure);};
  },[title]);
  return <span ref={viewport} className={`pv-scrolling-title${distance>0?" is-overflowing":""}`} style={{"--title-travel":`${-distance}px`,"--title-duration":`${Math.max(4,distance/30+2)}s`} as CSSProperties}>
    <span ref={text} className={textClassName}>{title}</span>
  </span>;
}
