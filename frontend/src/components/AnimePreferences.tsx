import {useEffect,useState} from "react";
import {Switch} from "./ui";
type Preferences={characters:boolean;casts:boolean;original:boolean;dub:boolean};
const defaults:Preferences={characters:true,casts:true,original:true,dub:true};
const event="posterview-anime-preferences";
function read(key:string):Preferences{try{const value=JSON.parse(localStorage.getItem(key)??"{}");return {characters:value.characters!==false,casts:value.casts!==false,original:value.original!==false,dub:value.dub!==false};}catch{return {...defaults};}}
export function useAnimePreferences(library:string){
 const key=`posterview.animePreferences.${library}`;
 const [value,setValue]=useState(()=>read(key));
 useEffect(()=>{const refresh=()=>setValue(read(key));refresh();window.addEventListener(event,refresh);window.addEventListener("storage",refresh);return()=>{window.removeEventListener(event,refresh);window.removeEventListener("storage",refresh);};},[key]);
 const toggle=(field:keyof Preferences)=>{const next={...read(key),[field]:!read(key)[field]};localStorage.setItem(key,JSON.stringify(next));setValue(next);window.dispatchEvent(new Event(event));};
 return {value,toggle};
}
export default function AnimePreferences({library}:{library:string}){
 const {value,toggle}=useAnimePreferences(library);
 return <div className="space-y-7"><section className="space-y-5"><h3 className="text-xl font-semibold">Characters</h3><div className="flex items-center justify-between gap-4"><span className="text-sm text-muted">Display Characters</span><Switch label="Display Characters" checked={value.characters} onChange={()=>toggle("characters")}/></div></section><section className="space-y-5"><h3 className="text-xl font-semibold">Casts</h3><div className="flex items-center justify-between gap-4"><span className="text-sm text-muted">Display Cast</span><Switch label="Display Cast" checked={value.casts} onChange={()=>toggle("casts")}/></div><fieldset disabled={!value.casts} className="space-y-4 rounded-xl border border-border p-4 disabled:opacity-50"><legend className="px-2 text-sm text-muted">Cast languages</legend><div className="flex items-center justify-between gap-4"><span className="text-sm text-muted">Display Original Cast</span><Switch label="Display Original Cast" disabled={!value.casts} checked={value.casts && value.original} onChange={()=>toggle("original")}/></div><div className="flex items-center justify-between gap-4"><span className="text-sm text-muted">Display Dub Cast</span><Switch label="Display Dub Cast" disabled={!value.casts} checked={value.casts && value.dub} onChange={()=>toggle("dub")}/></div><p className="text-xs text-faint">Dub cast uses the preferred metadata language. Both casts can be displayed together.</p></fieldset></section><p className="text-xs text-faint">Changes save automatically for this library in this browser.</p></div>;
}
