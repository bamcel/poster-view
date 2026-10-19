import {useState} from "react";
import {useMutation,useQuery,useQueryClient} from "@tanstack/react-query";
import PopupPage from "../../components/PopupPage";
import {ACTION_BUTTON} from "../../components/ui";
import SearchField from "../../components/SearchField";
import {invalidateArtworkItems} from "../../lib/artworkTarget";
import {artworkHistory,type HistoryEntry,type HistoryGroup} from "./historyClient";
import AnimatedArtwork from "../../components/AnimatedArtwork";
import {backdropFramingUrl} from "../../lib/backdropFraming";
import {PlayCircle} from "lucide-react";

const retention="Up to 20 changes per title, including its seasons and Specials, are kept for 7 days.";
function timestamp(value:string){const date=new Date(value);return Number.isNaN(date.getTime())?value:date.toLocaleString();}

function HistoryImage({entry,thumbnail=false}:{entry:HistoryEntry;thumbnail?:boolean}){
 if(!entry.preview_url)return <div className={`grid place-items-center rounded-lg bg-base text-sm text-muted ${thumbnail?"h-36":"h-48"}`}>{entry.has_image?"Preview unavailable":"No artwork was assigned in this version."}</div>;
 const backdrop=entry.preview_settings?.backdropedit;
 const framing=backdrop?{...backdrop,...(backdrop.logo?{logo:entry.preview_logo_url?{...backdrop.logo,src:entry.preview_logo_url}:undefined}:{})}:undefined;
 const source=backdropFramingUrl(entry.preview_url,framing)??entry.preview_url;
 const poster=entry.preview_settings?.posteredit;
 const overlay=poster?.enabled&&poster.mode!=="flattened"&&entry.preview_logo_url;
 const portrait=entry.kind==="poster"||entry.kind==="adjustments"&&!backdrop;
 const video=entry.content_type==="video/webm";
 const format=entry.content_type==="image/gif"?"gif":undefined;
 return <div className={`relative mx-auto overflow-hidden rounded-lg bg-base ${thumbnail?"h-36 w-full":portrait?"w-[min(100%,28dvh)]":"w-full max-w-lg"} ${entry.kind==="poster"||entry.kind==="adjustments"&&!backdrop?"aspect-[2/3]":"aspect-video"}`}>
  {video ? thumbnail?<div className="grid h-full place-content-center justify-items-center gap-2 text-xs text-muted"><PlayCircle className="size-7"/>Animated artwork</div>:<video src={entry.preview_url} muted controls playsInline preload="metadata" aria-label={`Previous ${entry.kind} for ${entry.item_title}`} className="h-full w-full object-contain" style={framing?{objectFit:framing.fit,objectPosition:`${framing.x}% ${framing.y}%`,transform:`scale(${framing.zoom/100})`,transformOrigin:`${framing.x}% ${framing.y}%`}:undefined}/>:<AnimatedArtwork src={source} format={format} alt={thumbnail?"":`Previous ${entry.kind} for ${entry.item_title}`} className="h-full w-full object-contain"/>}
  {overlay&&<img src={entry.preview_logo_url!} alt="" aria-hidden="true" className="pointer-events-none absolute" style={{left:`${poster.x}%`,top:`${poster.y}%`,width:`${poster.width}%`,opacity:poster.opacity/100}}/>}
  {video&&!thumbnail&&framing?.logo?.enabled&&<img src={framing.logo.src} alt="" aria-hidden="true" className="pointer-events-none absolute" style={{left:`${framing.logo.x}%`,top:`${framing.logo.y}%`,width:`${framing.logo.width}%`,opacity:framing.logo.opacity/100}}/>}
 </div>;
}

export default function ArtworkHistory({serverId,itemId,title,onClose}:{serverId:number;itemId:string;title:string;onClose:()=>void}){
 const client=useQueryClient(),[kind,setKind]=useState(""),[item,setItem]=useState(""),[selected,setSelected]=useState<HistoryEntry|null>(null),[message,setMessage]=useState("");
 const history=useQuery({queryKey:["artwork-history",serverId,itemId],queryFn:()=>artworkHistory.entries(serverId,itemId)});
 const restore=useMutation({mutationFn:(entry:HistoryEntry)=>artworkHistory.restore(entry.id),onSuccess:async(result,entry)=>{
  setMessage(result.message);if(!result.ok)return;
  await Promise.all([invalidateArtworkItems(client,serverId,entry.item_id),client.invalidateQueries({queryKey:["item-detail",serverId,entry.item_id]}),client.invalidateQueries({queryKey:["item-detail",serverId,itemId]}),client.invalidateQueries({queryKey:["artwork-history"]})]);
 }});
 const entries=history.data??[],visible=entries.filter(entry=>(!kind||entry.kind===kind)&&(!item||entry.item_id===item));
 return <PopupPage title="Artwork History" description={<>{title} · {retention}</>} onClose={onClose} closeDisabled={restore.isPending} bodyClassName="space-y-4">
  {history.isPending&&<p role="status">Loading artwork history…</p>}
  {history.error&&<div role="alert"><p>{history.error.message}</p><button className={ACTION_BUTTON} onClick={()=>void history.refetch()}>Try again</button></div>}
  {!history.isPending&&!history.error&&!entries.length&&<p className="text-sm text-muted">No artwork history yet. Previous versions will appear here when artwork changes. {retention}</p>}
  {!!entries.length&&<div className="flex flex-wrap gap-3">
   <label className="text-sm">Artwork type<select aria-label="Filter artwork type" className="ml-2 rounded-full border border-border bg-surface-2 px-3 py-2" value={kind} onChange={event=>{setKind(event.target.value);setSelected(null);}}><option value="">All artwork</option>{[...new Set(entries.map(entry=>entry.kind))].map(value=><option key={value}>{value}</option>)}</select></label>
   <label className="text-sm">Series or season<select aria-label="Filter series or season" className="ml-2 rounded-full border border-border bg-surface-2 px-3 py-2" value={item} onChange={event=>{setItem(event.target.value);setSelected(null);}}><option value="">All series and seasons</option>{[...new Map(entries.map(entry=>[entry.item_id,entry.item_title])).entries()].map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label>
  </div>}
  {selected&&<section aria-label="Artwork history preview" className="rounded-xl border border-border bg-surface-2 p-4 space-y-3">
   <h3 className="font-semibold">{selected.item_title} · {selected.kind}</h3>
   <HistoryImage entry={selected}/>
   {selected.adjustments&&<p className="text-sm text-muted">Includes saved artwork adjustments.</p>}
   <p className="text-xs text-muted">{timestamp(selected.created_at)}{selected.source&&` · ${selected.source}`}{selected.actor&&` · ${selected.actor}`}</p>
   <button className={ACTION_BUTTON} disabled={restore.isPending} onClick={()=>{setMessage("");restore.mutate(selected);}}>{restore.isPending?"Restoring…":"Restore artwork"}</button>
  </section>}
  {restore.error&&<p role="alert" className="text-danger">{restore.error.message}</p>}{message&&<p role="status" className="text-sm">{message}</p>}
  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">{visible.map(entry=><button key={entry.id} type="button" disabled={restore.isPending} onClick={()=>{setSelected(entry);setMessage("");restore.reset();}} aria-label={`Preview ${entry.item_title} ${entry.kind} ${timestamp(entry.created_at)}`} className={`rounded-xl border p-3 text-left transition-colors hover:bg-white/5 ${selected?.id===entry.id?"border-accent":"border-border"}`}>
   <div className="mb-2"><HistoryImage entry={entry} thumbnail/></div>
   <strong className="block text-sm">{entry.item_title}</strong><span className="block text-xs text-muted">{entry.kind}{entry.adjustments?" · Adjustments":""}</span><span className="block text-xs text-muted">{timestamp(entry.created_at)}</span>
  </button>)}</div>
 </PopupPage>;
}

export function ArtworkHistoryGrid(){
 const groups=useQuery({queryKey:["artwork-history","groups"],queryFn:artworkHistory.groups}),[selected,setSelected]=useState<HistoryGroup|null>(null),[search,setSearch]=useState("");
 const visible=(groups.data??[]).filter(group=>group.count>0&&group.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
 return <div className="space-y-4">
  <p className="text-sm text-muted">Select a title to preview or restore previous artwork. {retention}</p>
  {groups.isPending&&<p role="status">Loading artwork history…</p>}{groups.error&&<div role="alert"><p>{groups.error.message}</p><button className={ACTION_BUTTON} onClick={()=>void groups.refetch()}>Try again</button></div>}
  {!!groups.data?.length&&<SearchField aria-label="Search artwork history" value={search} onChange={event=>setSearch(event.target.value)} placeholder="Search titles…"/>}
  {!groups.isPending&&!groups.error&&!visible.length&&<p className="text-sm text-muted">{search?"No matching titles.":"No artwork history yet. Titles with saved artwork changes will appear here."}</p>}
  <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">{visible.map(group=><button type="button" key={`${group.server_id}:${group.group_id}`} onClick={()=>setSelected(group)} className="min-w-0 text-left group">
   {group.poster_url?<img src={group.poster_url} alt="" loading="lazy" className="aspect-[2/3] w-full rounded-xl border border-border object-cover group-hover:border-accent"/>:<div className="grid aspect-[2/3] place-items-center rounded-xl border border-border bg-surface-2 p-3 text-muted">{group.title}</div>}
   <strong className="mt-2 block truncate text-sm">{group.title}</strong><span className="block text-xs text-muted">{group.count} saved {group.count===1?"change":"changes"}</span>
  </button>)}</div>
  {selected&&<ArtworkHistory key={`${selected.server_id}:${selected.group_id}`} serverId={selected.server_id} itemId={selected.group_id} title={selected.title} onClose={()=>setSelected(null)}/>}
 </div>;
}
