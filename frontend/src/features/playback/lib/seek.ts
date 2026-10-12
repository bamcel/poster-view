type MediaRanges = Pick<TimeRanges, "length" | "start" | "end">;
type RetainedFragment = {start:number;end:number;gap?:boolean};

export function containsMediaTime(ranges:MediaRanges,time:number):boolean {
  if(!Number.isFinite(time)||time<0)return false;
  for(let index=0;index<ranges.length;index++) {
    try {
      const start=ranges.start(index),end=ranges.end(index);
      if(Number.isFinite(start)&&Number.isFinite(end)&&time>=start&&time<end)return true;
    } catch { /* A live media range may disappear during this read. */ }
  }
  return false;
}

export function canSeekInCurrentSource(video:Pick<HTMLVideoElement,"buffered"|"seekable">,sourceTime:number,offset:number,direct:boolean,fragments:readonly RetainedFragment[]|null,retainedFromSource=0):boolean {
  const relative=sourceTime-offset;
  if(!Number.isFinite(relative)||relative<0)return false;
  if(direct)return true;
  for(let index=0;index<video.buffered.length;index++){
    try {
      const start=video.buffered.start(index),end=video.buffered.end(index);
      if(Number.isFinite(start)&&Number.isFinite(end)&&relative>=start&&relative<end&&end+offset>=retainedFromSource)return true;
    } catch { /* A buffer range can be removed while the seek is classified. */ }
  }
  // A completed/stale playlist can still list files already pruned by the
  // server. Cached data is reusable only when it reaches the retained range, so
  // playback will not run into an already deleted gap after a short rewind.
  if(sourceTime<retainedFromSource)return false;
  // hls.js publishes the fragments the server still retains. Native HLS exposes
  // that range through seekable; neither path assumes gaps are buffered.
  return fragments===null?containsMediaTime(video.seekable,relative):fragments.some(fragment=>!fragment.gap&&Number.isFinite(fragment.start)&&Number.isFinite(fragment.end)&&relative>=fragment.start&&relative<fragment.end);
}
