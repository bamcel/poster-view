import type {PlaybackInfo,PlaybackSession} from "../types";

const byteBudget=60_000_000;
export function hlsBufferOptions(info:PlaybackInfo,method:PlaybackSession["method"],audioIndex:number|null) {
  const fallback={maxBufferLength:30,maxMaxBufferLength:30,backBufferLength:20,maxBufferSize:byteBudget};
  if(method!=="remux"&&method!=="audio_transcode")return fallback;
  const video=info.tracks.find(track=>track.kind==="video"),audio=info.tracks.find(track=>track.kind==="audio"&&track.index===audioIndex);
  if(!video?.bitrate||!Number.isFinite(video.bitrate)||video.bitrate<=0)return fallback;
  const audioRate=audio?.bitrate&&Number.isFinite(audio.bitrate)&&audio.bitrate>0?audio.bitrate:(audio?.channels??2)>2?768_000:256_000;
  const bitrate=video.bitrate+audioRate;
  // Reserve space for back-buffer data and bitrate variation. maxBufferSize is
  // a loading heuristic, so also cap the time target for high-bitrate sources.
  const totalSeconds=byteBudget*0.8*8/bitrate;
  const backBufferLength=Math.min(20,totalSeconds*0.25);
  const maxBufferLength=Math.max(1,Math.min(60,Math.floor(totalSeconds-backBufferLength)));
  return {maxBufferLength,maxMaxBufferLength:maxBufferLength,backBufferLength,maxBufferSize:byteBudget};
}
