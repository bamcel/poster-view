export type Chapter={title:string;start_seconds:number};

export function normalizeChapters(chapters:readonly Chapter[],duration:number):Chapter[]{
  if(!Number.isFinite(duration)||duration<=0)return [];
  const seen=new Set<number>();
  return chapters.map((chapter,index)=>({start_seconds:chapter.start_seconds,title:chapter.title.trim()||`Chapter ${index+1}`}))
    .filter(chapter=>{
      const time=chapter.start_seconds;
      if(!Number.isFinite(time)||time<0||time>=duration||seen.has(time))return false;
      seen.add(time);return true;
    }).sort((a,b)=>a.start_seconds-b.start_seconds);
}

export function currentChapter(chapters:readonly Chapter[],position:number,duration:number):Chapter|null{
  if(!Number.isFinite(position)||position<0)return null;
  const ordered=normalizeChapters(chapters,duration);
  for(let index=ordered.length-1;index>=0;index--)if(ordered[index].start_seconds<=position)return ordered[index];
  return null;
}

export function previousChapterTarget(chapters:readonly Chapter[],position:number,duration:number):number|null{
  if(!Number.isFinite(position)||position<0)return null;
  const ordered=normalizeChapters(chapters,duration);
  let index=ordered.length-1;
  while(index>=0&&ordered[index].start_seconds>position)index--;
  if(index<0)return null;
  if(position-ordered[index].start_seconds>3)return ordered[index].start_seconds;
  return ordered[index-1]?.start_seconds??null;
}

export function nextChapterTarget(chapters:readonly Chapter[],position:number,duration:number):number|null{
  if(!Number.isFinite(position)||position<0)return null;
  return normalizeChapters(chapters,duration).find(chapter=>chapter.start_seconds>position)?.start_seconds??null;
}
