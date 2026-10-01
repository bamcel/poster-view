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
  const format=override ?? artworkFormat(src);
  const animated=format === "webm" || format === "gif";
  const element=useRef<HTMLDivElement>(null);
  const video=useRef<HTMLVideoElement>(null);
  const [visible,setVisible]=useState(false);
  const [motion,setMotion]=useState(false);
  const [foreground,setForeground]=useState(!document.hidden);
  const [failed,setFailed]=useState(false);
  useEffect(()=>setFailed(false),[src]);
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
  },[play,src]);
  if (!animated) return <img src={src} alt={alt} className={className} loading="lazy" draggable={false} onError={onError}/>;
  const fallback=stillArtwork(src);
  const mediaClass = fill ? "absolute inset-0 h-full w-full object-cover object-top" : "h-full w-full max-h-[inherit] max-w-[inherit] [object-fit:inherit] [object-position:inherit]";
  return <div ref={element} className={className} style={fill ? {position: "absolute", inset: 0, overflow: "hidden"} : undefined}>
    {!play && fallback === src ? <span className="sr-only">{alt}: animated preview paused</span> : format === "webm" && play ? <video ref={video} src={src} poster={fallback} aria-label={alt} className={mediaClass} autoPlay loop muted playsInline preload="none" onError={()=>setFailed(true)}/> : <img src={format === "gif" && play ? src : fallback} alt={alt} className={mediaClass} loading="lazy" draggable={false} onError={onError}/>}
  </div>;
}
