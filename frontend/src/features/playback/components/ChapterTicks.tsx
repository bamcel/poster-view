import {playbackTime} from "../lib/playback";
import {currentChapter,normalizeChapters} from "../lib/chapters";

type Props={chapters:{title:string;start_seconds:number}[];duration:number;position?:number;disabled:boolean;onSeek:(seconds:number)=>void};
export default function ChapterTicks({chapters,duration,position,disabled,onSeek}:Props){
  if(!Number.isFinite(duration)||duration<=0)return null;
  const active=position===undefined?null:currentChapter(chapters,position,duration);
  return <div className="pv-chapter-ticks">{normalizeChapters(chapters,duration).filter(chapter=>chapter.start_seconds>0).map(({start_seconds:time,title})=><button key={time} type="button"
    className={`pv-chapter-tick${active?.start_seconds===time?" pv-chapter-current":""}`} aria-current={active?.start_seconds===time?"true":undefined} style={{left:`${time/duration*100}%`}} disabled={disabled}
    aria-label={`Seek to chapter ${title} at ${playbackTime(time)}`} title={`${title} · ${playbackTime(time)}`}
    onPointerDown={event=>event.stopPropagation()} onClick={()=>onSeek(time)}><span aria-hidden="true"/></button>)}</div>;
}
