import {Film, AudioLines, Captions, Paperclip} from "lucide-react";
import type {NativeCatalogEntry} from "../api/nativeLibraries";

function rate(value:unknown) {
 const n=Number(value);return Number.isFinite(n)&&n>0 ? n>=1_000_000?`${(n/1_000_000).toFixed(1)} mbps`:`${Math.round(n/1000)} kbps`:undefined;
}
function frameRate(value:unknown) {
 if(typeof value!=="string")return value;
 const [a,b]=value.split("/").map(Number);return b ? (a/b).toFixed(3).replace(/\.?0+$/,"") : value==="0/0"?undefined:value;
}
function StreamCard({stream}:{stream:Record<string,unknown>}) {
 const type=String(stream.codec_type??"Track"),tags=stream.tags as Record<string,unknown>|undefined,flags=stream.disposition as Record<string,unknown>|undefined;
 const Icon=type==="video"?Film:type==="audio"?AudioLines:type==="subtitle"?Captions:Paperclip;
 const rows:[string,unknown][]=[
  ["Embedded Title",tags?.title],["Language",tags?.language],["Codec",stream.codec_name?String(stream.codec_name).toUpperCase():undefined],
  ["Profile",stream.profile],["Level",stream.level],["Resolution",stream.width&&stream.height?`${stream.width}×${stream.height}`:undefined],
  ["Aspect Ratio",stream.display_aspect_ratio],["Interlaced",stream.field_order?stream.field_order==="progressive"?"No":String(stream.field_order):undefined],
  ["Framerate",frameRate(stream.avg_frame_rate??stream.r_frame_rate)],["Layout",stream.channel_layout],["Channels",stream.channels?`${stream.channels} ch`:undefined],
  ["Bitrate",rate(stream.bit_rate)],["Sample Rate",stream.sample_rate?`${Number(stream.sample_rate).toLocaleString()} Hz`:undefined],
  ["Color Primaries",stream.color_primaries],["Color Space",stream.color_space],["Color Transfer",stream.color_transfer],
  ["Bit Depth",stream.bits_per_raw_sample&&Number(stream.bits_per_raw_sample)>0?`${stream.bits_per_raw_sample} bit`:undefined],["Pixel Format",stream.pix_fmt],["Reference Frames",stream.refs],
  ["Default",flags&&["audio","subtitle"].includes(type)?flags.default?"Yes":"No":undefined],
  ["Forced",flags&&type==="subtitle"?flags.forced?"Yes":"No":undefined],["Hearing Impaired",flags&&type==="subtitle"?flags.hearing_impaired?"Yes":"No":undefined],
  ["File",tags?.filename],
 ];
 return <article className="w-[285px] shrink-0 rounded-md bg-white/[0.09] p-4 sm:w-[300px]">
  <h3 className="mb-4 flex items-center gap-2 text-[15px] font-semibold capitalize"><Icon className="size-4"/>{type}</h3>
  <dl className="space-y-1.5 text-[13px] leading-[1.4]">{rows.filter(([,value])=>value!=null&&value!==""&&value!=="unknown").map(([label,value])=><div key={label} className="flex items-baseline gap-3"><dt className="shrink-0 font-medium">{label}</dt><dd className="min-w-0 break-words text-white/70">{String(value)}</dd></div>)}</dl>
 </article>;
}
export default function EpisodeMediaInfo({files}:{files:NativeCatalogEntry["files"]}) {
 return <section className="mt-8" aria-label="Media information"><h2 className="mb-4 text-xl font-semibold">Media Info</h2>
 {files.map(file=><div key={file.path} className="mb-6">
  <p className="break-all text-sm">{file.path}</p><p className="mb-4 mt-1 text-[13px] text-muted">{file.extension.toUpperCase()} · {(file.size/1024/1024).toFixed(1)} MB</p>
  <div className="flex items-stretch gap-3 overflow-x-auto pb-3">{file.media_info?.streams?.map((stream,index)=><StreamCard key={index} stream={stream}/>)}</div>
  {!file.media_info?.streams?.length&&<p className="text-sm text-muted">Track information is not available. Scan library files to collect media information.</p>}
 </div>)}
 </section>;
}
