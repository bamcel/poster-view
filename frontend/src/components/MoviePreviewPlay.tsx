import {useQuery} from "@tanstack/react-query";
import {Play} from "lucide-react";
import {watchApi} from "../features/playback/api/watch";
import {Link} from "../lib/libraryNavigation";
import type {HomeTitle} from "./HomeDiscovery";

export default function MoviePreviewPlay({title}:{title:HomeTitle}){
 const {entry,library}=title;
 const playable=entry.kind==="movie"&&entry.available&&entry.metadata.missing!==true&&(entry.files.length>0||entry.metadata._has_files===true);
 const state=useQuery({queryKey:["watch-state",library.id,entry.id],queryFn:()=>watchApi.state(library.id,entry.id),enabled:playable,retry:false,staleTime:0});
 if(!playable)return null;
 const started=!!state.data&&(state.data.watched||state.data.play_count>0||state.data.position_seconds>0||!!state.data.last_played_at);
 const url=`/play/native/${encodeURIComponent(library.id)}/${encodeURIComponent(entry.id)}?return=%2F`;
 return <><Link className="pv-discovery-hover-play" to={`${url}&start=0`} aria-label={`Play ${entry.title}`} title="Play from beginning"><Play size={16} aria-hidden="true"/>Play</Link>{started&&<Link className="pv-discovery-hover-play" to={url} aria-label={`Resume ${entry.title}`} title="Continue where you left off">Resume</Link>}</>;
}
