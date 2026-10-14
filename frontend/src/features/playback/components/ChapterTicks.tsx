import {playbackTime} from "../lib/playback";

type Props={chapters:{title:string;start_seconds:number}[];duration:number;disabled:boolean;onSeek:(seconds:number)=>void};
export default function ChapterTicks({chapters,duration,disabled,onSeek}:Props){
  if(!Number.isFinite(duration)||duration<=0)return null;
  const seen=new Set<number>();
  return <div className="pv-chapter-ticks">{chapters.map((chapter,index)=>({
    time:chapter.start_seconds,title:chapter.title.trim()||`Chapter ${index+1}`,
  })).filter(({time})=>{
    if(!Number.isFinite(time)||time<=0||time>=duration||seen.has(time))return false;
    seen.add(time);return true;
  }).sort((a,b)=>a.time-b.time).map(({time,title})=><button key={time} type="button"
    className="pv-chapter-tick" style={{left:`${time/duration*100}%`}} disabled={disabled}
    aria-label={`Seek to chapter ${title} at ${playbackTime(time)}`} title={`${title} · ${playbackTime(time)}`}
    onPointerDown={event=>event.stopPropagation()} onClick={()=>onSeek(time)}><span aria-hidden="true"/></button>)}</div>;
}
