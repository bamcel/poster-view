import {useCallback,useEffect,useRef,useState} from "react";
import {Link,useParams} from "react-router-dom";
import {apiRequest} from "../../api/client";
import PlayerPage from "../playback/PlayerPage";
import {waitForPreviousPlayback} from "../playback/lib/previousPlayback";
import {stopLivePreviews} from "./LiveChannelPreview";

interface Tune {library_id:string;item_id:string;position_seconds:number;ends_at:string;program_id:string;channel_name?:string;title?:string}
interface TunedProgram extends Tune {revision:number}

/** The shared player owns media sessions; this wrapper owns the live schedule. */
export default function VirtualTvPlayer(){
 const {channelId=""}=useParams();
 const [current,setCurrent]=useState<TunedProgram|null>(null),[error,setError]=useState("");
 const actions=useRef({tune:(_force=false)=>{}});
 const returnLive=useCallback(()=>actions.current.tune(true),[]);
 useEffect(()=>{
  let active=true,busy=false,program:TunedProgram|null=null,revision=0;
  let boundary:ReturnType<typeof setTimeout>|undefined;
  const controller=new AbortController();
  setCurrent(null);setError("");
  const schedule=(end:string)=>{
   clearTimeout(boundary);
   const transition=()=>{if(!active)return;if(busy){boundary=setTimeout(transition,250);return;}void tune();};
   boundary=setTimeout(transition,Math.min(2_147_483_647,Math.max(1000,Date.parse(end)-Date.now()+250)));
  };
  const tune=async(force=false)=>{
   if(!active||busy)return;
   busy=true;
   try{
    await waitForPreviousPlayback(stopLivePreviews(),"The live preview");
    if(!active)return;
    const next=await apiRequest<Tune>(`/virtual-tv/channels/${encodeURIComponent(channelId)}/tune`,{method:"POST",signal:controller.signal});
    if(!active)return;
    schedule(next.ends_at);
    if(!force&&program?.program_id===next.program_id&&program.library_id===next.library_id&&program.item_id===next.item_id)return;
    program={...next,revision:++revision};setError("");setCurrent(program);
   }catch(reason){
    if(active){clearTimeout(boundary);program=null;setCurrent(null);setError(reason instanceof Error?reason.message:String(reason));}
   }finally{busy=false;}
  };
  actions.current={tune:force=>void tune(force)};
  const permissions=setInterval(()=>void tune(),15_000);
  void tune();
  return()=>{active=false;controller.abort();clearInterval(permissions);clearTimeout(boundary);};
 },[channelId]);
 if(error)return <main className="virtual-tv-player p-6"><Link to="/virtual-tv">Back to guide</Link><div role="alert" className="mt-4">{error} <button onClick={returnLive}>Retry</button></div></main>;
 if(!current)return <main className="virtual-tv-player p-6"><Link to="/virtual-tv">Back to guide</Link><p role="status">Tuning channel…</p></main>;
 return <PlayerPage virtualTv={{channelId,libraryId:current.library_id,itemId:current.item_id,programId:`${current.program_id}:${current.revision}`,positionSeconds:current.position_seconds,channelName:current.channel_name,onEnded:returnLive,onReturnLive:returnLive}}/>;
}
