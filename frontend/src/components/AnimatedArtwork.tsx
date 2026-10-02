import {framingFromUrl,backdropFramingEvent,backdropMediaUrl} from "../lib/backdropFraming";
import {useEffect, useRef, useState} from "react";

export function artworkFormat(src?: string) {
  if (!src) return "";
  const query = src.split("?")[1] ?? "";
  return (new URLSearchParams(query).get("format") ?? src.split("?")[0].split(".").pop() ?? "").toLowerCase();
}
export function stillArtwork(src: string) {
  return src.includes("/api/native/") ? `${src}${src.includes("?") ? "&" : "?"}still=1` : src;
}

/** Silent artwork plays only when visible, active, and motion is allowed. */
export default function AnimatedArtwork({src, alt, className, onError, format: override, active = true, fill = false}: {
  src: string; alt: string; className?: string; onError?: () => void; format?: string; active?: boolean; fill?: boolean;
}) {
  const [,refreshFraming]=useState(0);
  useEffect(()=>{if(!new URLSearchParams(src.split("?")[1]??"").has("backdropKey"))return;const refresh=()=>refreshFraming(v=>v+1);window.addEventListener(backdropFramingEvent,refresh);window.addEventListener("storage",refresh);return()=>{window.removeEventListener(backdropFramingEvent,refresh);window.removeEventListener("storage",refresh);};},[src]);
  const framing=framingFromUrl(src);
  const mediaSrc=backdropMediaUrl(src);
  const mediaStyle=framing ? {objectFit:framing.fit,objectPosition:`${framing.x}% ${framing.y}%`,transform:`scale(${framing.zoom/100})`,transformOrigin:`${framing.x}% ${framing.y}%`} : undefined;
  const format=override ?? artworkFormat(src);
  const animated=format === "webm" || format === "gif";
  const element=useRef<HTMLDivElement>(null);
  const video=useRef<HTMLVideoElement>(null);
  const [visible,setVisible]=useState(false);
  const [motion,setMotion]=useState(false);
  const [foreground,setForeground]=useState(!document.hidden);
  const [failed,setFailed]=useState(false);
  useEffect(()=>setFailed(false),[mediaSrc]);
  useEffect(()=>{
    if (!animated) return;
    const preference=window.matchMedia("(prefers-reduced-motion: reduce)");
    const update=()=>setMotion(!preference.matches);
    update(); preference.addEventListener("change",update);
    const visibility=()=>setForeground(!document.hidden);
    document.addEventListener("visibilitychange",visibility);
    const observer=new IntersectionObserver(entries=>setVisible(entries.some(entry=>entry.isIntersecting)));
    if (element.current) observer.observe(element.current);
    return ()=>{preference.removeEventListener("change",update);document.removeEventListener("visibilitychange",visibility);observer.disconnect();};
  },[animated]);
  const play=active && visible && foreground && motion && !failed;
  useEffect(()=>{
    const player=video.current;
    if (!player) return;
    if (play) void player.play().catch(()=>{}); else player.pause();
  },[play,mediaSrc]);
  const fallback=animated ? stillArtwork(mediaSrc) : mediaSrc;
  let overlay: {logo:string;x:number;y:number;width:number;opacity:number} | undefined;
  try {
    const value = new URLSearchParams(src.split("?")[1] ?? "").get("logoOverlay");
    if (value) {
      const parsed = JSON.parse(value);
      if (typeof parsed.logo === "string" && parsed.logo.startsWith("/api/native/") && [parsed.x,parsed.y,parsed.width,parsed.opacity].every(v=>typeof v === "number" && Number.isFinite(v) && v>=0 && v<=100)) overlay=parsed;
    }
  } catch { /* Invalid placement leaves the original artwork visible. */ }

  if (!animated && !overlay && !framing) return <img src={mediaSrc} alt={alt} className={className} loading="lazy" draggable={false} onError={onError}/>;
  const mediaClass = fill ? "absolute inset-0 h-full w-full object-cover object-top" : "h-full w-full max-h-[inherit] max-w-[inherit] [object-fit:inherit] [object-position:inherit]";
  return <div ref={element} className={className} style={fill ? {position: "absolute", inset: 0, overflow: "hidden"} : overlay || framing ? {position:"relative",overflow:"hidden"} : undefined}>
    {animated && !play && fallback === mediaSrc ? <span className="sr-only">{alt}: animated preview paused</span> : format === "webm" && play ? <video ref={video} src={mediaSrc} poster={fallback} aria-label={alt} className={mediaClass} style={mediaStyle} autoPlay loop muted playsInline preload="auto" onError={()=>setFailed(true)}/> : <img src={format === "gif" && play ? mediaSrc : fallback} alt={alt} className={mediaClass} style={mediaStyle} loading={visible ? "eager" : "lazy"} draggable={false} onError={onError}/>}
    {overlay && <img src={overlay.logo} alt="" aria-hidden="true" className="pointer-events-none absolute" style={{left:`${overlay.x}%`,top:`${overlay.y}%`,width:`${overlay.width}%`,opacity:overlay.opacity/100}}/>}
  </div>;
}
