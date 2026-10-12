import type {PlaybackSeek,PlaybackSession} from "../types";

type Pending={position:number;audio?:number;resolve:(value:PlaybackSession|null)=>void;reject:(error:unknown)=>void};
// Keep the backend's generation monotonic even when a later user seek replaces
// the response currently being produced. Only the latest source is attached.
export function createPlaybackSeekQueue(send:(id:string,body:PlaybackSeek)=>Promise<PlaybackSession>) {
  let owner=0,id="",generation=0,running=false,pending:Pending|null=null;
  const pump=async()=>{
    if(running)return;running=true;const operation=owner;
    try{
      while(pending&&owner===operation){
        const request=pending;pending=null;
        try{
          const result=await send(id,{position_seconds:request.position,generation,...(request.audio===undefined?{}:{audio_index:request.audio})});
          if(owner!==operation){request.resolve(null);return;}
          if(result.id!==id||!Number.isInteger(result.generation)||result.generation!<generation)throw new Error("The server returned an invalid playback generation.");
          generation=result.generation!;request.resolve(pending?null:result);
        }catch(error){if(owner===operation&&!pending)request.reject(error);else request.resolve(null);}
      }
    }finally{if(owner===operation){running=false;if(pending)void pump();}}
  };
  return {
    reset(session?:PlaybackSession){owner++;pending?.resolve(null);pending=null;running=false;id=session?.id??"";generation=session?.generation??0;},
    request(position:number,audio?:number):Promise<PlaybackSession|null>{
      if(!id)return Promise.reject(new Error("Playback is no longer available."));
      pending?.resolve(null);
      const result=new Promise<PlaybackSession|null>((resolve,reject)=>{pending={position,audio,resolve,reject};});void pump();return result;
    },
  };
}
