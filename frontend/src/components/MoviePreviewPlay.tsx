import {startupArtworkState} from "../features/playback/lib/startupArtwork";
import {useEffect,useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {Play} from "lucide-react";
import {watchApi} from "../features/playback/api/watch";
import {useNavigate} from "../lib/libraryNavigation";
import ResumePlaybackDialog from "./ResumePlaybackDialog";
import type {HomeTitle} from "./HomeDiscovery";

export default function MoviePreviewPlay({title,onChoosingChange}:{title:HomeTitle;onChoosingChange?:(choosing:boolean)=>void}){
 const {entry,library}=title;
 const navigate=useNavigate();
 const [prompt,setPrompt]=useState(false);
 useEffect(()=>{setPrompt(false);return()=>onChoosingChange?.(false);},[entry.id,library.id]);
 const playable=entry.kind==="movie"&&entry.available&&entry.metadata.missing!==true&&(entry.files.length>0||entry.metadata._has_files===true);
 const state=useQuery({queryKey:["watch-state",library.id,entry.id],queryFn:()=>watchApi.state(library.id,entry.id),enabled:playable,retry:false,staleTime:0});
 if(!playable)return null;
 const started=!!state.data&&(state.data.watched||state.data.play_count>0||state.data.position_seconds>0||!!state.data.last_played_at);
 const url=`/play/native/${encodeURIComponent(library.id)}/${encodeURIComponent(entry.id)}?return=%2F`;
 const choose=(resume:boolean)=>{setPrompt(false);onChoosingChange?.(false);navigate(`${url}${resume?"":"&start=0"}`,{state:startupArtworkState(library.id,entry)});};
 return <><button type="button" className="pv-discovery-hover-play" disabled={state.isPending} aria-label={`Play ${entry.title}`} onClick={()=>{if(started){setPrompt(true);onChoosingChange?.(true);}else choose(false);}}><Play size={16} aria-hidden="true"/>Play</button>{prompt&&<ResumePlaybackDialog title={entry.title} onChoose={choose} onClose={()=>{setPrompt(false);onChoosingChange?.(false);}}/>}</>;
}