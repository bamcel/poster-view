// Positive delay displays subtitles later; renderers add their source offset.
export function subtitleDelay(value:number|undefined):number {
  return Number.isFinite(value)?Math.round(Math.max(-60,Math.min(60,value!))*100)/100:0;
}
export function subtitleOffset(sourceOffset:number,delay:number):number {
  return sourceOffset-subtitleDelay(delay);
}
