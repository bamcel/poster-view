import {useQuery} from "@tanstack/react-query";
import {nativeLibraries} from "../api/nativeLibraries";
import {watchApi} from "../features/playback/api/watch";
import {seriesPlaybackSelection} from "../lib/seriesPlaybackSelection";
import {mediaFormats} from "../lib/mediaFormats";
import type {HomeTitle} from "./HomeDiscovery";

/** Only mounted for an open preview; reuse playback's episode choice and cache. */
export default function DiscoveryFormats({title:{entry,library}}:{title:HomeTitle}) {
  const series=entry.kind==="series"&&entry.available&&entry.metadata.missing!==true;
  const summary=useQuery({queryKey:["native-catalog",library.id,"summary"],queryFn:()=>nativeLibraries.summaries(library.id),enabled:series,staleTime:5*60_000,retry:false});
  const states=useQuery({queryKey:["watch-library-states",library.id],queryFn:()=>watchApi.states(library.id),enabled:series,staleTime:0,retry:false});
  const continued=useQuery({queryKey:["continue-watching"],queryFn:watchApi.continue,enabled:series,staleTime:0,retry:false});
  const preferences=useQuery({queryKey:["playback-preferences"],queryFn:()=>watchApi.preferences(),retry:false});
  let selected=entry.kind==="movie"&&entry.available&&entry.metadata.missing!==true?entry:undefined;
  if(series&&summary.data&&states.data&&continued.data) {
    try {selected=seriesPlaybackSelection(summary.data,entry,library,states.data,continued.data,true).resume;} catch { /* No playable episode, so no format claims. */ }
  }
  const item=useQuery({queryKey:["native-catalog",library.id,"item",selected?.id??""],queryFn:()=>nativeLibraries.item(library.id,selected!.id),enabled:!!selected,initialData:selected?.files.some(file=>file.media_info?.streams?.length)?selected:undefined,staleTime:5*60_000,retry:false});
  const formats=item.data?mediaFormats(item.data,preferences.data):{};
  // Avoid advertising another language's audio while preferences are loading.
  const audio=preferences.data?formats.audio:undefined;
  if(!formats.source&&!formats.quality&&!formats.hdr&&!audio&&!formats.dualAudio)return null;
  return <div className="pv-discovery-formats" role="group" aria-label="Media formats" title={series?`Next episode: ${selected?.title??""}`:undefined}>
    {formats.source&&<span className="pv-discovery-format">{formats.source}</span>}
    {formats.quality&&<span className="pv-discovery-format">{formats.quality}</span>}
    {formats.hdr&&<span className="pv-discovery-format">{formats.hdr}</span>}
    {audio&&<span className="pv-discovery-format">{audio}</span>}
    {formats.dualAudio&&<span className="pv-discovery-format">Dual Audio</span>}
  </div>;
}
