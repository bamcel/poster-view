import CardActionMenu from "../../../components/CardActionMenu";
import HomeMediaRow from "../../../components/HomeMediaRow";
import {sizedArtwork} from "../../../lib/artworkSizes";
import {nativeArtworkVersion} from "../../../lib/nativeArtworkCache";
import {useQuery,useQueryClient} from "@tanstack/react-query";
import {Link,useNavigate} from "react-router-dom";
import {Play} from "lucide-react";
import {watchApi} from "../api/watch";
import {nativeLibraries,type NativeCatalogEntry} from "../../../api/nativeLibraries";
import {startupArtworkState} from "../lib/startupArtwork";

export default function ContinueWatching() {
  const client=useQueryClient(),navigate=useNavigate();
  const updated=async(library:string,item:string)=>{
    await Promise.all([client.invalidateQueries({queryKey:["continue-watching"]}),client.invalidateQueries({queryKey:["watch-state",library,item]}),client.invalidateQueries({queryKey:["watch-library-states",library]}),client.invalidateQueries({queryKey:["watch-history"]})]);
    window.dispatchEvent(new Event("posterview-watch-updated"));
  };
  const query=useQuery({queryKey:["continue-watching"],queryFn:watchApi.continue,retry:false,staleTime:0});
  if(!query.data?.length)return null;
  return <div className="pv-home-continue-section"><HomeMediaRow label="Continue Watching" ariaLabel="Continue watching">{query.data.map(item=>{
    const kind=item.entry.artwork.some(a=>a.kind==="thumb")?"thumb":item.entry.artwork.some(a=>a.kind==="poster")?"poster":null;
    const progress=Math.min(100,100*item.state.position_seconds/Math.max(1,item.state.duration_seconds));
    const target=item.series_item_id??item.item_id;
    const series=item.series_item_id?client.getQueriesData<NativeCatalogEntry[]>({queryKey:["native-catalog",item.library_id]}).flatMap(([,entries])=>Array.isArray(entries)?entries:[]).find(entry=>entry.id===item.series_item_id):undefined;
    const artworkState=startupArtworkState(item.library_id,series??item.entry,item.item_id);
    const goLabel=item.series_item_id?"Go to series":item.kind==="movie"?"Go to movie":"Go to episode";
    const actions=[
      {label:goLabel,onSelect:()=>navigate(`/media/${encodeURIComponent(item.library_id)}?native_library=${encodeURIComponent(item.library_id)}&native_item=${encodeURIComponent(target)}&from=home`)},
      {label:"Mark played",onSelect:async()=>{await watchApi.mark(item.library_id,item.item_id,true);await updated(item.library_id,item.item_id);}},
      {label:"Remove from Continue Watching",onSelect:async()=>{await watchApi.dismissContinue(item.library_id,item.item_id);await updated(item.library_id,item.item_id);}},
    ];
    return <CardActionMenu key={`${item.library_id}:${item.item_id}`} label={`Continue Watching actions for ${item.title}`} actions={actions}><Link state={artworkState} to={`/play/native/${encodeURIComponent(item.library_id)}/${encodeURIComponent(item.item_id)}?return=%2F`} className="pv-home-landscape-card group rounded-lg focus-visible:outline-2 focus-visible:outline-accent" aria-label={`Resume ${item.title}`}><div className="relative aspect-video overflow-hidden rounded-lg bg-elevated">{kind?<img alt="" src={sizedArtwork(`${nativeLibraries.artworkUrl(item.library_id,item.item_id,kind)}?v=${encodeURIComponent(nativeArtworkVersion(item.entry,kind))}`,640)} className="h-full w-full object-cover" loading="lazy"/>:<div className="grid h-full place-items-center"><Play className="size-8"/></div>}<div className="absolute inset-x-0 bottom-0 h-1 bg-black/60"><div className="h-full bg-accent" style={{width:`${progress}%`}}/></div></div><p className="mt-2 truncate text-sm font-medium group-hover:text-accent">{item.title}</p><p className="text-xs text-muted">{item.library_name}</p></Link></CardActionMenu>;
  })}</HomeMediaRow></div>;
}
