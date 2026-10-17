import {useLocation,useNavigationType} from "react-router-dom";
import {createContext,useContext,useEffect,useState,type ReactNode} from "react";

export const LibraryHeaderBackContext=createContext(false);
// Standalone pages retain navigation; app chrome supplies the single top-left link.
export function LibraryPageBack({children}:{children:ReactNode}){
  return useContext(LibraryHeaderBackContext)?null:children;
}

function parentLibraryPath(pathname:string,search:string){
 const params=new URLSearchParams(search);
 for(const key of ["youtube_video","youtube_playlist","youtube_channel","item","native_item"]){
  if(params.has(key)){params.delete(key);return pathname+(params.size?`?${params}`:"");}
 }
 if(/^\/media\//.test(pathname))return pathname.split("/").length>3?pathname.slice(0,pathname.lastIndexOf("/")):"/";
 const season=pathname.match(/^\/server\/([^/]+)\/series\/([^/]+)\/season\//);
 if(season)return `/server/${season[1]}/item/${season[2]}`;
 if(pathname.startsWith("/collections/"))return "/collections";
 const library=params.get("return_library");
 return library?`/?lib=${encodeURIComponent(library)}`:"/";
}

/** Router history preserves the route and query that opened a title. A direct
 * link without app history falls back to its parent instead of leaving the app. */
export function useLibraryHeaderBack(){
 const location=useLocation(),action=useNavigationType();
 const [history,setHistory]=useState(()=>({entries:[{key:location.key,url:location.pathname+location.search+location.hash}],index:0}));
 useEffect(()=>setHistory(previous=>{
  const entry={key:location.key,url:location.pathname+location.search+location.hash};
  const known=previous.entries.findIndex(item=>item.key===entry.key);
  if(known>=0)return known===previous.index&&previous.entries[known].url===entry.url?previous:{...previous,index:known};
  if(action==="REPLACE"){const entries=[...previous.entries];entries[previous.index]=entry;return {entries,index:previous.index};}
  const entries=[...previous.entries.slice(0,previous.index+1),entry];return {entries,index:entries.length-1};
 }),[location.key,location.pathname,location.search,location.hash,action]);
 const index=history.entries.findIndex(entry=>entry.key===location.key);
 return {target:(index>0?history.entries[index-1].url:undefined)??parentLibraryPath(location.pathname,location.search),hasPrevious:index>0||(typeof window.history.state?.idx==="number"&&window.history.state.idx>0)};
}
