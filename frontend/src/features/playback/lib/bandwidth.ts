const sampleWindow=45_000;
const probeBytes=512*1024;

export interface FragmentTransferStats {loaded:number;aborted:boolean;loading:{first:number;end:number}}
type TransferWindow={at:number;loaded:number};
type TransferMeasurement={window:TransferWindow|null;partial:boolean;wholeAllowed:boolean};
// Public Hls.js FRAG_LOADING/FRAG_LOADED frag.stats counters. Each progress
// window covers new bytes only, so large fragments provide evidence before EOF.
export function createFragmentTransferSampler() {
  let active:FragmentTransferStats|undefined,measurements=new WeakMap<FragmentTransferStats,TransferMeasurement>(),finished=new WeakSet<FragmentTransferStats>();
  return {
    reset(){active=undefined;measurements=new WeakMap();finished=new WeakSet();},
    clearWindow(){if(active){const state=measurements.get(active);if(state){state.window=null;state.partial=false;state.wholeAllowed=false;}}},
    start(stats:FragmentTransferStats){active=stats;finished.delete(stats);measurements.set(stats,{window:null,partial:false,wholeAllowed:true});},
    hasBody(){return !!active&&!active.aborted&&active.loading.first>0&&active.loading.end===0&&active.loaded>0;},
    poll(now:number):{bytes:number;bodyMilliseconds:number}|null {
      if(!active)return null;
      const state=measurements.get(active)!;
      if(active.aborted||active.loading.first<=0||active.loading.end>0||!Number.isFinite(active.loaded)){state.window=null;return null;}
      const prior=state.window;
      if(!prior||active.loaded<prior.loaded){state.window={at:now,loaded:active.loaded};return null;}
      // After body delivery starts, gaps between bursts are part of network
      // throughput. Do not discard that elapsed time while waiting for growth.
      if(active.loaded===prior.loaded)return null;
      const bytes=active.loaded-prior.loaded,milliseconds=now-prior.at;
      if(bytes<16*1024||milliseconds<100)return null;
      state.window={at:now,loaded:active.loaded};state.partial=true;return {bytes,bodyMilliseconds:milliseconds};
    },
    finish(stats:FragmentTransferStats):{bytes:number;bodyMilliseconds:number}|null {
      if(finished.has(stats))return null;finished.add(stats);if(active===stats)active=undefined;
      const state=measurements.get(stats);measurements.delete(stats);
      if(stats.aborted||stats.loading.first<=0||stats.loading.end<=stats.loading.first)return null;
      if(state?.partial){const bytes=stats.loaded-(state.window?.loaded??stats.loaded),milliseconds=stats.loading.end-(state.window?.at??stats.loading.end);return bytes>=16*1024&&milliseconds>=100?{bytes,bodyMilliseconds:milliseconds}:null;}
      return state&&!state.wholeAllowed?null:{bytes:stats.loaded,bodyMilliseconds:stats.loading.end-stats.loading.first};
    },
  };
}

export function measuredBodyBitsPerSecond(bytes:number,milliseconds:number):number|null {
  if(!Number.isFinite(bytes)||!Number.isFinite(milliseconds)||bytes<16*1024||milliseconds<100)return null;
  return bytes*8_000/milliseconds;
}

export function createBandwidthDetector() {
  let samples:{at:number;rate:number}[]=[],stalls:number[]=[],readyAt=0,lastAdaptation=-Infinity,count=0;
  return {
    reset(now=Date.now()){samples=[];stalls=[];readyAt=now+8_000;lastAdaptation=-Infinity;count=0;},
    suppressUntil(now:number){samples=[];stalls=[];readyAt=now;},
    observe(bytes:number,bodyMilliseconds:number,now:number){
      const rate=measuredBodyBitsPerSecond(bytes,bodyMilliseconds);
      if(rate==null||now<readyAt)return false;
      samples=samples.filter(sample=>now-sample.at<=sampleWindow).concat({at:now,rate}).slice(-5);return true;
    },
    underflow(now:number){if(now>=readyAt)stalls=stalls.filter(at=>now-at<=sampleWindow).concat(now);},
    recommend({now,requiredBitrate,bufferSeconds,stallMilliseconds}:{now:number;requiredBitrate:number;bufferSeconds:number;stallMilliseconds:number}):number|null {
      if(now<readyAt||count>=3||now-lastAdaptation<45_000||!Number.isFinite(requiredBitrate)||requiredBitrate<=0||bufferSeconds>3)return null;
      samples=samples.filter(sample=>now-sample.at<=sampleWindow);stalls=stalls.filter(at=>now-at<=sampleWindow);
      if(samples.length<2||stallMilliseconds<3_000&&stalls.length<2)return null;
      const recent=samples.slice(-2);
      if(recent.some(sample=>sample.rate>=requiredBitrate*0.8))return null;
      const budget=Math.floor(Math.min(...recent.map(sample=>sample.rate))*0.8);
      return budget>=500_000&&budget<requiredBitrate?budget:null;
    },
    accepted(now:number){lastAdaptation=now;count++;samples=[];stalls=[];readyAt=now+8_000;},
  };
}

// A stalled original stream has no HLS transfer statistics. Probe only one
// small authenticated range, excluding time spent waiting for response headers.
export async function probeDirectBandwidth(url:string,byteStart:number,signal:AbortSignal,now=()=>performance.now()):Promise<{bytes:number;bodyMilliseconds:number}|null> {
  let target:URL;try{target=new URL(url,window.location.href);}catch{return null;}
  if(target.origin!==window.location.origin||signal.aborted||!Number.isFinite(byteStart)||byteStart<0)return null;
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  const controller=new AbortController(),abort=()=>{controller.abort();if(reader)void reader.cancel().catch(()=>{});};signal.addEventListener("abort",abort,{once:true});
  const timer=window.setTimeout(abort,8_000);
  try{
    const start=Math.floor(byteStart),response=await fetch(target.href,{headers:{Range:`bytes=${start}-${start+probeBytes-1}`},credentials:"same-origin",cache:"no-store",signal:controller.signal});
    const contentRange=/^bytes (\d+)-(\d+)\/(?:\d+|\*)$/.exec(response.headers.get("Content-Range")??"");
    const length=Number(response.headers.get("Content-Length"));
    if(response.status!==206||!contentRange||Number(contentRange[1])!==start||Number(contentRange[2])-start+1>probeBytes||Number(contentRange[2])<start||length>probeBytes){await response.body?.cancel();return null;}
    if(!response.body)return null;
    reader=response.body.getReader();const began=now();let bytes=0;
    while(bytes<probeBytes&&!controller.signal.aborted){const chunk=await reader.read();if(chunk.done)break;bytes+=Math.min(chunk.value.byteLength,probeBytes-bytes);}
    const milliseconds=now()-began;await reader.cancel();
    return !controller.signal.aborted&&measuredBodyBitsPerSecond(bytes,milliseconds)!=null?{bytes,bodyMilliseconds:milliseconds}:null;
  }catch{return null;}
  finally{if(reader)void reader.cancel().catch(()=>{});window.clearTimeout(timer);signal.removeEventListener("abort",abort);}
}
