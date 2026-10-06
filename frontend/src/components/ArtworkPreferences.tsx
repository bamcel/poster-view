import {useEffect,useState} from "react";
import {Switch} from "./ui";
const event="posterview-artwork-preferences";
export function animatedArtworkEnabled(library:string){try{return localStorage.getItem(`posterview.animatedArtwork.${library}`)!=="false";}catch{return true;}}
export function animationHoverOnly(library:string){return localStorage.getItem(`posterview.animationHoverOnly.${library}`)==="true";}
export function useAnimatedArtworkPreference(library:string){
 const [hoverOnly,setHoverOnly]=useState(()=>animationHoverOnly(library));
 const toggleHoverOnly=()=>{const next=!animationHoverOnly(library);localStorage.setItem(`posterview.animationHoverOnly.${library}`,String(next));setHoverOnly(next);window.dispatchEvent(new Event(event));};
 const [enabled,setEnabled]=useState(()=>animatedArtworkEnabled(library));
 useEffect(()=>{const refresh=()=>{setEnabled(animatedArtworkEnabled(library));setHoverOnly(animationHoverOnly(library));};refresh();window.addEventListener(event,refresh);window.addEventListener("storage",refresh);return()=>{window.removeEventListener(event,refresh);window.removeEventListener("storage",refresh);};},[library]);
 const toggle=()=>{const next=!animatedArtworkEnabled(library);localStorage.setItem(`posterview.animatedArtwork.${library}`,String(next));setEnabled(next);window.dispatchEvent(new Event(event));};
 return {enabled,toggle,hoverOnly,toggleHoverOnly};
}
export default function ArtworkPreferences({library}:{library:string}){
 const {enabled,toggle,hoverOnly,toggleHoverOnly}=useAnimatedArtworkPreference(library);
 return <section className="space-y-3"><h3 className="text-xl font-semibold">Artwork</h3><div className="flex items-center justify-between gap-4"><span className="text-sm text-muted">Display animated artwork</span><Switch label="Display animated artwork" checked={enabled} onChange={toggle}/></div><div className="ml-4 flex items-center justify-between gap-4"><span className="text-sm text-muted">Animate only on hover</span><Switch label="Animate only on hover" checked={hoverOnly} disabled={!enabled} onChange={toggleHoverOnly}/></div><p className="text-xs text-faint">Hover or focus a library card to animate it. Static previews stay visible otherwise.</p><p className="text-xs text-faint">Applies to all artwork types. Disable to show the saved static artwork synchronized from the source server. Unlinked items use their local static selection.</p></section>;
}
