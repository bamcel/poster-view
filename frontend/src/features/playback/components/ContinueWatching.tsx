import {sizedArtwork} from "../../../lib/artworkSizes";
import {nativeArtworkVersion} from "../../../lib/nativeArtworkCache";
import {useQuery} from "@tanstack/react-query";
import {Link} from "react-router-dom";
import {Play} from "lucide-react";
import {watchApi} from "../api/watch";
import {nativeLibraries} from "../../../api/nativeLibraries";

export default function ContinueWatching() {
  const query=useQuery({queryKey:["continue-watching"],queryFn:watchApi.continue,retry:false,staleTime:0});
  if(!query.data?.length)return null;
  return <section aria-label="Continue watching" className="mt-10"><h2 className="mb-4 text-xl font-semibold">Continue Watching</h2><div className="flex gap-5 overflow-x-auto pb-3">{query.data.map(item=>{
    const kind=item.entry.artwork.some(a=>a.kind==="thumb")?"thumb":item.entry.artwork.some(a=>a.kind==="poster")?"poster":null;
    const progress=Math.min(100,100*item.state.position_seconds/Math.max(1,item.state.duration_seconds));
    return <Link key={`${item.library_id}:${item.item_id}`} to={`/play/native/${encodeURIComponent(item.library_id)}/${encodeURIComponent(item.item_id)}?return=%2F`} className="group w-64 shrink-0 rounded-lg focus-visible:outline-2 focus-visible:outline-accent" aria-label={`Resume ${item.title}`}><div className="relative aspect-video overflow-hidden rounded-lg bg-elevated">{kind?<img alt="" src={sizedArtwork(`${nativeLibraries.artworkUrl(item.library_id,item.item_id,kind)}?v=${encodeURIComponent(nativeArtworkVersion(item.entry,kind))}`,640)} className="h-full w-full object-cover" loading="lazy"/>:<div className="grid h-full place-items-center"><Play className="size-8"/></div>}<div className="absolute inset-x-0 bottom-0 h-1 bg-black/60"><div className="h-full bg-accent" style={{width:`${progress}%`}}/></div></div><p className="mt-2 truncate text-sm font-medium group-hover:text-accent">{item.title}</p><p className="text-xs text-muted">{item.library_name}</p></Link>;
  })}</div></section>;
}
