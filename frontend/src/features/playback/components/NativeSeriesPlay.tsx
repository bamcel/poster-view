import {startupArtworkState} from "../lib/startupArtwork";
import {useQuery} from "@tanstack/react-query";
import {useLocation,useNavigate} from "react-router-dom";
import {Play} from "lucide-react";
import type {NativeCatalogEntry} from "../../../api/nativeLibraries";
import {watchApi} from "../api/watch";
import {compareEpisodeOrder} from "../../../lib/episodeOrder";
export default function NativeSeriesPlay({library,path,entries,includeIds=[],specialsInSeasons=false}:{library:string;path:string;entries:NativeCatalogEntry[];includeIds?:string[];specialsInSeasons?:boolean}) {
  const navigate=useNavigate(),location=useLocation();
  const query=useQuery({queryKey:["continue-watching"],queryFn:watchApi.continue,retry:false,staleTime:0});
  const states=useQuery({queryKey:["watch-library-states",library],queryFn:()=>watchApi.states(library),retry:false,staleTime:0});
  const episodes=entries.filter(e=>e.kind==="episode"&&e.available&&e.metadata.missing!==true&&(e.files.length>0||e.metadata._has_files===true)&&(e.path.startsWith(path+"/")||includeIds.includes(e.id))).sort((a,b)=>compareEpisodeOrder(a,b,specialsInSeasons));
  const continued=query.data?.find(item=>item.library_id===library&&episodes.some(e=>e.id===item.item_id));
  const episode=episodes.find(e=>e.id===continued?.item_id)??episodes.find(e=>!states.data?.[e.id]?.watched)??episodes[0];
  if(!episode)return null;
  return <button disabled={query.isPending||states.isPending} className="mt-4 inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-black focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50" onClick={()=>navigate(`/play/native/${encodeURIComponent(library)}/${encodeURIComponent(episode.id)}?return=${encodeURIComponent(location.pathname+location.search)}`,{state:startupArtworkState(library,entries.find(entry=>entry.kind==="series"&&entry.path===path)??episode,episode.id)})}><Play className="size-5 fill-current"/>{query.isPending||states.isPending?"Loading playback…":continued?"Resume":"Play"}</button>;
}
