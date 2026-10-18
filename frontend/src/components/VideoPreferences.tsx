import {useEffect,useState} from "react";
import {Switch} from "./ui";
type Preferences={casts:boolean;crew:boolean};
const event="posterview-video-preferences";
function read(library:string):Preferences{try{const value=JSON.parse(localStorage.getItem(`posterview.videoPreferences.${library}`)??"{}");return {casts:value.casts!==false,crew:value.crew!==false};}catch{return {casts:true,crew:true};}}
export function useVideoPreferences(library:string){
 const [value,setValue]=useState(()=>read(library));
 useEffect(()=>{const refresh=()=>setValue(read(library));refresh();window.addEventListener(event,refresh);window.addEventListener("storage",refresh);return()=>{window.removeEventListener(event,refresh);window.removeEventListener("storage",refresh);};},[library]);
 const toggle=(field:keyof Preferences)=>{const current=read(library);const next={...current,[field]:!current[field]};localStorage.setItem(`posterview.videoPreferences.${library}`,JSON.stringify(next));setValue(next);window.dispatchEvent(new Event(event));};
 return {value,toggle};
}
export default function VideoPreferences({library}:{library:string}){
 const {value,toggle}=useVideoPreferences(library);
 const [saved,setSaved]=useState(false);
 return <div className="space-y-7"><section className="space-y-5"><h3 className="text-xl font-semibold">Cast and crew</h3>{([['casts','Display Cast'],['crew','Display Crew']] as const).map(([field,label])=><div key={field} className="flex items-center justify-between gap-4"><span className="text-sm text-muted">{label}</span><Switch label={label} checked={value[field]} onChange={()=>{toggle(field);setSaved(true);}}/></div>)}</section><p className="text-xs text-faint">Changes save automatically for this library in this browser.</p>{saved&&<p role="status" className="text-xs text-muted">Changes saved automatically</p>}</div>;
}
