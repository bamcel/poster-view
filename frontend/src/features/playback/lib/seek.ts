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
  if(direct||containsMediaTime(video.buffered,relative))return true;
  // A completed/stale playlist can still list files already pruned by the
  // server. Browser-buffered data remains safe even before this retention floor.
  if(sourceTime<retainedFromSource)return false;
  // hls.js publishes the fragments the server still retains. Native HLS exposes
  // that range through seekable; neither path assumes gaps are buffered.
  return fragments===null?containsMediaTime(video.seekable,relative):fragments.some(fragment=>!fragment.gap&&Number.isFinite(fragment.start)&&Number.isFinite(fragment.end)&&relative>=fragment.start&&relative<fragment.end);
}
