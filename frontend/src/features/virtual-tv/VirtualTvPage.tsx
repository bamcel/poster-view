import PopupPage from "../../components/PopupPage";
import {ACTION_BUTTON} from "../../components/ui";
import {useCollections} from "../collections/client";
import {HeaderBackdropContext,headerBackdropStyle} from "../../lib/headerBackdrop";
import {useCallback,useContext,useEffect,useRef,useState,type FormEvent} from "react";
import {useMutation,useQueries,useQuery,useQueryClient} from "@tanstack/react-query";
import {Link} from "react-router-dom";
import {Tv,Plus,Pencil,Trash2} from "lucide-react";
import {nativeLibraries,type NativeCatalogEntry} from "../../api/nativeLibraries";
import {useIsAdmin} from "../../lib/authContext";
import {virtualTv,type Channel,type ChannelInput,type Program,type YoutubePlaylistSelection} from "./client";
import {isChannelSource} from "./sources";
import YoutubePlaylistSources from "./YoutubePlaylistSources";
import LiveChannelPreview from "./LiveChannelPreview";
import "./VirtualTvPage.css";

const button=ACTION_BUTTON;
const input="mt-1 w-full rounded-lg border border-border bg-input px-3 py-2";
const time=(value:string)=>new Date(value).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
function localDateTime(value:string){const date=new Date(value);return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);}

const WINDOW_MS=3*60*60*1000;
const PAGE_SIZE=8;
const roundWindow=(value:number)=>Math.floor(value/(30*60*1000))*30*60*1000;
function inWindow(program:Program,start:number,end:number){return Date.parse(program.starts_at)<end&&Date.parse(program.ends_at)>start;}

function programLabels(program:Program){
 const series=program.series_title?.trim();
 const episode=[program.season!=null?`S${String(program.season).padStart(2,"0")}`:"",program.episode!=null?`E${String(program.episode).padStart(2,"0")}`:""].filter(Boolean).join(" ");
 const year=program.year&&Number.isInteger(program.year)&&program.year>0&&program.year<=9999?String(program.year):"";
 return {primary:series||program.title,secondary:series?[episode,program.title].filter(Boolean).join(" · "):episode||year};
}

function ProgramImage({channel,program,playbackProgram,clock,preview}:{channel:Channel;program:Program|undefined;playbackProgram:Program|undefined;clock:number;preview:boolean}){
 const src=program?.artwork_url??(!program?`/api/virtual-tv/channels/${encodeURIComponent(channel.id)}/image?revision=${channel.revision}&program=${Math.floor(clock/30000)}`:null);
 const [failed,setFailed]=useState("");
 useEffect(()=>setFailed(""),[src]);
 const [ready,setReady]=useState(false);
 const showingPlayback=preview&&playbackProgram?.id===program?.id;
 return <span className={`vtv-image${showingPlayback&&ready?" vtv-preview-ready":""}`}>{!src||failed===src?<Tv aria-label="Program image unavailable" className="size-10 text-muted"/>:<img src={src} alt={`${program?.title??channel.name} thumbnail`} onError={()=>setFailed(src)}/>}{preview&&playbackProgram&&<span style={{display:"contents"}} aria-hidden={!showingPlayback} inert={!showingPlayback}><LiveChannelPreview channelId={channel.id} programId={playbackProgram.id} endsAt={playbackProgram.ends_at} onReady={setReady}/></span>}</span>;
}

export default function VirtualTvPage(){
 const admin=useIsAdmin(),client=useQueryClient();
 const setHeaderBackdrop=useContext(HeaderBackdropContext);
 const [preferencesOpen,setPreferencesOpen]=useState(false);
 const [previewEnabled,setPreviewEnabled]=useState(()=>{try{return localStorage.getItem("posterview-virtual-tv-live-preview")!=="false";}catch{return true;}});
 const togglePreview=(enabled:boolean)=>{setPreviewEnabled(enabled);try{localStorage.setItem("posterview-virtual-tv-live-preview",String(enabled));}catch{/* The setting still works for this visit. */}};
 const [selected,setSelected]=useState(""),[focusedProgram,setFocusedProgram]=useState(""),[editing,setEditing]=useState<Channel|null|undefined>();
 const [clock,setClock]=useState(Date.now()),[windowStart,setWindowStart]=useState(()=>roundWindow(Date.now())),[page,setPage]=useState(0),[managing,setManaging]=useState(false);
 const windowEnd=windowStart+WINDOW_MS,from=new Date(windowStart).toISOString(),until=new Date(windowEnd).toISOString();
 const settings=useQuery({queryKey:["virtual-tv-settings"],queryFn:virtualTv.settings,refetchInterval:30000});
 const enabled=settings.data?.enabled===true&&!settings.error;
 const channels=useQuery({queryKey:["virtual-tv-channels"],queryFn:virtualTv.channels,enabled,refetchInterval:30000});
 const accessible=enabled&&!channels.error?channels.data??[]:[];
 const pageCount=Math.max(1,Math.ceil(accessible.length/PAGE_SIZE)),activePage=Math.min(page,pageCount-1);
 const visible=accessible.slice(activePage*PAGE_SIZE,(activePage+1)*PAGE_SIZE);
 const current=visible.find(channel=>channel.id===selected)??visible[0];
 const guides=useQueries({queries:visible.map(channel=>({queryKey:["virtual-tv-guide",channel.id,from,until],queryFn:()=>virtualTv.guide(channel.id,from,until),enabled,refetchInterval:30000}))});
 const selectedGuide=guides[visible.findIndex(channel=>channel.id===current?.id)];
 const programs=selectedGuide?.error?[]:selectedGuide?.data??[];
 const currentProgram=programs.find(program=>Date.parse(program.starts_at)<=clock&&Date.parse(program.ends_at)>clock);
 const previewProgram=useRef<{channel:string;program:Program}|undefined>(undefined);
 if(currentProgram&&current)previewProgram.current={channel:current.id,program:currentProgram};
 const playbackProgram=currentProgram??(previewProgram.current&&previewProgram.current.channel===current?.id&&Date.parse(previewProgram.current.program.ends_at)>clock?previewProgram.current.program:undefined);
 const featured=programs.find(program=>program.id===focusedProgram)??currentProgram??programs[0];
 const live=featured&&Date.parse(featured.starts_at)<=clock&&Date.parse(featured.ends_at)>clock;
 const elapsed=featured?Math.max(0,Math.min(100,(clock-Date.parse(featured.starts_at))/(Date.parse(featured.ends_at)-Date.parse(featured.starts_at))*100)):0;
 const remove=useMutation({mutationFn:virtualTv.remove,onSuccess:()=>{void client.invalidateQueries({queryKey:["virtual-tv-channels"]});}});
 useEffect(()=>{const timer=window.setInterval(()=>setClock(Date.now()),15000);return()=>clearInterval(timer);},[]);
 const error=settings.error||channels.error||remove.error;
 const changeWindow=(value:number)=>{setWindowStart(value);setFocusedProgram("");};
 const nowOffset=(clock-windowStart)/WINDOW_MS*100;
 const selectedArtwork=enabled&&!channels.error&&!selectedGuide?.error?featured?.artwork_url:null;
 const backdrop=selectedArtwork?`${selectedArtwork}${selectedArtwork.includes("?")?"&":"?"}kind=backdrop`:null;
 useEffect(()=>{setHeaderBackdrop?.(backdrop);return()=>setHeaderBackdrop?.(null);},[backdrop,setHeaderBackdrop]);
 return <div className="vtv-page" style={setHeaderBackdrop?{backgroundColor:"transparent"}:backdrop?headerBackdropStyle(backdrop):undefined}><header className="vtv-header"><h1><Tv/>Virtual TV</h1>{enabled&&<div className="flex gap-2"><button className={button} onClick={()=>setPreferencesOpen(true)}>Preferences</button>{admin&&<><button className={button} onClick={()=>setEditing(null)}><Plus className="mr-1 inline size-4"/>Create channel</button><button className={button} onClick={()=>setManaging(true)}><Pencil className="mr-1 inline size-4"/>Edit channels</button></>}</div>}</header>
 {error&&<p role="alert" className="mb-4 text-red-400">{String(error)}</p>}
 {settings.isPending&&<p role="status">Loading Virtual TV…</p>}
 {settings.data&&!settings.data.enabled&&<p>Virtual TV is disabled. {admin&&"Enable it in Settings → Plugins."}</p>}
 {enabled&&!channels.error&&<>
 {current&&!selectedGuide?.error&&<section aria-label="Selected program" className="vtv-hero"><div className="vtv-hero-details"><p className="vtv-clock">{time(new Date(clock).toISOString())}</p><h2>{featured?.title??current.name}</h2>{featured&&<><div className="vtv-program-state">{live?<><span role="progressbar" aria-label="Current program progress" aria-valuenow={Math.round(elapsed)} aria-valuemin={0} aria-valuemax={100} className="vtv-progress"><span style={{width:`${elapsed}%`}}/></span><span>{Math.max(1,Math.ceil((Date.parse(featured.ends_at)-clock)/60000))} min left</span></>:<span>{Date.parse(featured.starts_at)>clock?"Upcoming":"Previously aired"} · {time(featured.starts_at)}</span>}</div><p className="vtv-meta">{current.number} · {current.name} · {new Date(featured.starts_at).toLocaleDateString(undefined,{month:"short",day:"numeric"})}, {time(featured.starts_at)}{featured.series_title&&` · ${featured.series_title}`}{featured.season!==null&&featured.episode!==null&&` · S${featured.season} E${featured.episode}`}</p></>}{current.genres.length>0&&<p className="vtv-genres">{current.genres.join(" · ")}</p>}<Link aria-label={`Watch ${current.name} live`} className="vtv-watch" to={`/play/virtual-tv/${encodeURIComponent(current.id)}`}>Watch live</Link></div><div className="vtv-hero-image"><ProgramImage key={current.id} channel={current} program={featured} playbackProgram={playbackProgram} clock={clock} preview={previewEnabled}/></div></section>}
 <section aria-label="TV guide" className="mb-7"><header className="vtv-guide-controls"><div className="flex flex-wrap items-center gap-2"><button className={button} aria-label="Previous 3 hours" onClick={()=>changeWindow(windowStart-WINDOW_MS)}>←</button><button className={button} onClick={()=>changeWindow(roundWindow(Date.now()))}>Now</button><button className={button} aria-label="Next 3 hours" onClick={()=>changeWindow(windowStart+WINDOW_MS)}>→</button></div><p className="text-xs text-muted">{time(from)} – {time(until)} · Local time</p></header>
 {channels.isPending&&<p role="status">Loading channels…</p>}{channels.data?.length===0&&<p className="text-muted">No channels available.{admin&&" Create a channel to get started."}</p>}
 {visible.length>0&&<div className="vtv-guide-scroll"><div className="vtv-guide" role="table" aria-label="Channel schedule"><div role="row" className="vtv-row vtv-times"><div role="columnheader" className="vtv-channel-heading">Channels</div><div className="vtv-time-track" role="columnheader" aria-label="Program times">{Array.from({length:6},(_,index)=><span key={index} className="vtv-time" style={{left:`${index/6*100}%`}}>{time(new Date(windowStart+index*WINDOW_MS/6).toISOString())}</span>)}{nowOffset>=0&&nowOffset<100&&<span className="vtv-now" style={{left:`${nowOffset}%`}}>Now</span>}</div></div>
 {visible.map((channel,index)=>{const guide=guides[index];const rowPrograms=guide.error?[]:(guide.data??[]).filter(program=>inWindow(program,windowStart,windowEnd));return <div role="row" key={channel.id} className="vtv-row"><div role="rowheader" className="vtv-channel"><span className="vtv-channel-number" aria-hidden="true">{channel.number}</span><button aria-label={`Select channel ${channel.number} ${channel.name}`} aria-pressed={current?.id===channel.id} title={channel.name} className="vtv-channel-button" onClick={()=>{setSelected(channel.id);setFocusedProgram("");setWindowStart(roundWindow(Date.now()));}}><span className="vtv-channel-name">{channel.name}</span></button></div><div role="cell" className="vtv-program-track">{guide.error?<p className="p-3 text-sm text-red-400">Guide unavailable. {String(guide.error)}</p>:guide.isPending?<p role="status" className="p-3 text-sm text-muted">Loading guide…</p>:rowPrograms.length===0?<p className="p-3 text-sm text-muted">No scheduled programs</p>:rowPrograms.map(program=>{const start=Math.max(windowStart,Date.parse(program.starts_at)),end=Math.min(windowEnd,Date.parse(program.ends_at)),active=current.id===channel.id&&featured?.id===program.id,labels=programLabels(program),full=[labels.primary,labels.secondary].filter(Boolean).join(" · ");return <button key={program.id} title={`${full} · ${time(program.starts_at)} – ${time(program.ends_at)}`} aria-label={`${channel.name}: ${program.title}, ${full}, ${time(program.starts_at)} to ${time(program.ends_at)}`} aria-pressed={active} onClick={()=>{setSelected(channel.id);setFocusedProgram(program.id);}} className={`vtv-program${active?" vtv-program-selected":""}`} style={{left:`${(start-windowStart)/WINDOW_MS*100}%`,width:`calc(${(end-start)/WINDOW_MS*100}% - 6px)`}}><span className="vtv-program-title">{labels.primary}</span>{labels.secondary&&<span className="vtv-program-detail">{labels.secondary}</span>}</button>;})}{nowOffset>=0&&nowOffset<100&&<span aria-hidden="true" className="vtv-now-line" style={{left:`${nowOffset}%`}}/>}</div></div>;})}</div></div>}
 {pageCount>1&&<nav aria-label="Channel pages" className="mt-3 flex items-center justify-end gap-3"><button className={button} disabled={activePage===0} onClick={()=>{setPage(activePage-1);setSelected("");setFocusedProgram("");}}>Previous channels</button><span className="text-sm text-muted">Page {activePage+1} of {pageCount}</span><button className={button} disabled={activePage+1>=pageCount} onClick={()=>{setPage(activePage+1);setSelected("");setFocusedProgram("");}}>Next channels</button></nav>}</section>
 </>}
 {enabled&&preferencesOpen&&<GuidePreferences previewEnabled={previewEnabled} onPreviewChange={togglePreview} onClose={()=>setPreferencesOpen(false)}/>}
 {admin&&enabled&&managing&&<ChannelManager channels={accessible} busy={remove.isPending} error={remove.error} onClose={()=>setManaging(false)} onEdit={channel=>{setManaging(false);setEditing(channel);}} onRemove={channel=>{if(window.confirm(`Delete channel ${channel.name}?`))remove.mutate(channel.id);}}/>}
 {admin&&enabled&&editing!==undefined&&<ChannelEditor channel={editing} onClose={()=>setEditing(undefined)}/>}
 </div>;
}

function GuidePreferences({previewEnabled,onPreviewChange,onClose}:{previewEnabled:boolean;onPreviewChange:(enabled:boolean)=>void;onClose:()=>void}){
 return <PopupPage title="Virtual TV preferences" onClose={onClose} footer={<button className={button} onClick={onClose}>Done</button>}><label className="flex items-center gap-3"><input type="checkbox" checked={previewEnabled} onChange={event=>onPreviewChange(event.target.checked)}/>Live preview</label><p className="mt-3 text-sm text-muted">Applies to all Virtual TV channels in this browser. Previews start automatically for the selected program while it is airing, without hovering. Sound starts muted; use the speaker icon to change it. The thumbnail stays visible until video is ready.</p></PopupPage>;
}
function ChannelManager({channels,busy,error,onClose,onEdit,onRemove}:{channels:Channel[];busy:boolean;error:Error|null;onClose:()=>void;onEdit:(channel:Channel)=>void;onRemove:(channel:Channel)=>void}){
 return <PopupPage title="Edit channels" closeDisabled={busy} onClose={onClose} footer={<button className={button} disabled={busy} onClick={onClose}>Done</button>}>{error&&<p role="alert" className="mb-3 text-danger">{error.message}</p>}{channels.length===0&&<p className="text-muted">No channels to edit.</p>}<ul className="divide-y divide-border">{channels.map(channel=><li key={channel.id} className="flex items-center justify-between gap-3 py-3"><span className="min-w-0 truncate">{channel.number} · {channel.name}</span><div className="flex shrink-0 gap-2"><button className={button} aria-label={`Edit ${channel.name}`} disabled={busy} onClick={()=>onEdit(channel)}><Pencil className="mr-1 inline size-4"/>Edit</button><button className={button} aria-label={`Remove ${channel.name}`} disabled={busy} onClick={()=>onRemove(channel)}><Trash2 className="mr-1 inline size-4"/>Remove</button></div></li>)}</ul></PopupPage>;
}

function ChannelEditor({channel,onClose}:{channel:Channel|null;onClose:()=>void}){
 const client=useQueryClient();
 const [draft,setDraft]=useState<ChannelInput>(()=>channel?{name:channel.name,number:channel.number,library_ids:channel.source_library_ids??channel.library_ids,show_ids:channel.show_ids,movie_ids:channel.movie_ids,genres:channel.genres,order:channel.order,start_at:channel.start_at,revision:channel.revision,...(channel.collection_ids?{collection_ids:channel.collection_ids}:{}),...(channel.genre_library_ids!=null?{genre_library_ids:channel.genre_library_ids}:channel.genres.length?{genre_library_ids:channel.library_ids}:{}),...(channel.youtube_playlists?{youtube_playlists:channel.youtube_playlists}:{})}:{name:"",number:1,library_ids:[],show_ids:[],movie_ids:[],genres:[],order:"sequential",start_at:new Date().toISOString()});
 useEffect(()=>{const close=(event:KeyboardEvent)=>{if(event.key==="Escape")onClose();};window.addEventListener("keydown",close);return()=>window.removeEventListener("keydown",close);},[onClose]);
 const libraries=useQuery({queryKey:["native-libraries"],queryFn:nativeLibraries.list});
 const collections=useCollections();
 const [collectionsEnabled,setCollectionsEnabled]=useState(Boolean(channel?.collection_ids?.length));
 const [genresEnabled,setGenresEnabled]=useState(Boolean(channel?.genres.length));
 const [youtubeLoading,setYoutubeLoading]=useState(false);
 const setYoutubePlaylists=useCallback((youtube_playlists:YoutubePlaylistSelection[])=>setDraft(previous=>({...previous,youtube_playlists})),[]);
 const youtubeLibraries=(libraries.data??[]).filter(library=>library.library_type==="youtube"&&draft.library_ids.includes(library.id));
 const eligibleLibraries=(libraries.data??[]).filter(library=>library.library_type!=="books"&&library.library_type!=="youtube");
 const regularLibraryIds=eligibleLibraries.filter(library=>draft.library_ids.includes(library.id)).map(library=>library.id);
 const genreLibraryIds=genresEnabled?(draft.genre_library_ids??eligibleLibraries.map(library=>library.id)):[];
 const sourceLibraryIds=[...new Set([...regularLibraryIds,...genreLibraryIds])].sort();
 const selectedCollections=(collections.data??[]).filter(collection=>(draft.collection_ids??[]).includes(collection.id));
 const entries=useQuery({queryKey:["virtual-tv-sources",...sourceLibraryIds],queryFn:async()=>{const groups=await Promise.all(sourceLibraryIds.map(async library_id=>({library_id,entries:(await nativeLibraries.summaries(library_id)).filter(isChannelSource)})));return groups;},enabled:sourceLibraryIds.length>0});
 const sourceEntries=sourceLibraryIds.length?entries.data??[]:[];
 const collectionTitles=uniqueTitles(selectedCollections.flatMap(collection=>collection.members.map(member=>member.entry)));
 const collectionTitleIds=new Set(collectionTitles.map(entry=>entry.id));
 const libraryTitles=uniqueTitles(sourceEntries.filter(group=>regularLibraryIds.includes(group.library_id)).flatMap(group=>group.entries));
 const titles=libraryTitles.filter(entry=>!collectionTitleIds.has(entry.id));
 const genreTitles=uniqueTitles(sourceEntries.filter(group=>genreLibraryIds.includes(group.library_id)).flatMap(group=>group.entries));
 const genres=[...new Set([...draft.genres,...genreTitles.flatMap(sourceGenres)])].sort();
 const genreMatches=genreTitles.filter(entry=>sourceGenres(entry).some(genre=>draft.genres.some(selected=>selected.toLowerCase()===genre.toLowerCase())));
 const validTitles=uniqueTitles([...libraryTitles,...collectionTitles]);
 const save=useMutation({mutationFn:()=>virtualTv.save(draft.youtube_playlists!=null?{...draft,show_ids:draft.show_ids.filter(id=>validTitles.some(entry=>entry.kind==="series"&&entry.id===id))}:draft,channel?.id),onSuccess:()=>{void client.invalidateQueries({queryKey:["virtual-tv-channels"]});void client.invalidateQueries({queryKey:["virtual-tv-guide"]});onClose();}});
 const toggle=(key:"library_ids"|"show_ids"|"movie_ids"|"genres"|"collection_ids",value:string)=>setDraft(previous=>({...previous,[key]:(previous[key]??[]).includes(value)?(previous[key]??[]).filter(item=>item!==value):[...(previous[key]??[]),value],...(key==="library_ids"?{show_ids:[],movie_ids:[],...(libraries.data?.find(library=>library.id===value)?.library_type==="youtube"?{youtube_playlists:(previous.youtube_playlists??[]).filter(selection=>selection.library_id!==value)}:{})}:{} )}));
 const toggleCollections=(enabled:boolean)=>{setCollectionsEnabled(enabled);if(!enabled)setDraft(previous=>({...previous,collection_ids:[]}));};
 const toggleGenres=(enabled:boolean)=>{setGenresEnabled(enabled);setDraft(previous=>({...previous,genres:enabled?previous.genres:[],genre_library_ids:enabled?(previous.genre_library_ids??eligibleLibraries.map(library=>library.id)):undefined}));};
 const excludeGenreLibrary=(id:string)=>setDraft(previous=>({...previous,genre_library_ids:genreLibraryIds.includes(id)?genreLibraryIds.filter(value=>value!==id):[...genreLibraryIds,id]}));
 const allSelected=titles.length>0&&titles.every(entry=>(entry.kind==="series"?draft.show_ids:draft.movie_ids).includes(entry.id));
 const selectedCount=titles.filter(entry=>(entry.kind==="series"?draft.show_ids:draft.movie_ids).includes(entry.id)).length;
 const titleLabel=titles.some(entry=>entry.kind==="series")?titles.some(entry=>entry.kind==="movie")?"Shows and movies":"Shows":"Movies";
 const selectAll=(checked:boolean)=>setDraft(previous=>({...previous,show_ids:checked?titles.filter(entry=>entry.kind==="series").map(entry=>entry.id):[],movie_ids:checked?titles.filter(entry=>entry.kind==="movie").map(entry=>entry.id):[]}));
 const submit=(event:FormEvent)=>{event.preventDefault();save.mutate();};
 return <PopupPage title={channel?"Edit Virtual TV channel":"Create Virtual TV channel"} closeDisabled={save.isPending} onClose={onClose} footer={<><button type="button" className={button} disabled={save.isPending} onClick={onClose}>Cancel</button><button type="submit" form="virtual-tv-channel-form" className={button} disabled={save.isPending||(!draft.library_ids.length&&!draft.collection_ids?.length&&!(draft.genres.length&&genreLibraryIds.length))||!draft.name.trim()||entries.isFetching||youtubeLoading}>{save.isPending?"Saving…":"Save channel"}</button></>}><form id="virtual-tv-channel-form" onSubmit={submit} className="space-y-4"><div className="grid grid-cols-[1fr_7rem] gap-4"><label>Channel name<input className={input} value={draft.name} required maxLength={120} onChange={event=>setDraft({...draft,name:event.target.value})}/></label><label>Number<input className={input} type="number" min={1} required value={draft.number} onChange={event=>setDraft({...draft,number:Number(event.target.value)})}/></label></div>
 <fieldset><legend>Sources</legend><p className="my-2 text-xs text-muted">A viewer must have access to every library used by this channel. Select libraries, collections, or genres.</p><div className="flex flex-wrap gap-x-4 gap-y-2">{libraries.data?.filter(library=>library.library_type!=="books").sort((a,b)=>Number(a.library_type==="youtube")-Number(b.library_type==="youtube")).map(library=><label key={library.id} className="inline-flex gap-2"><input type="checkbox" checked={draft.library_ids.includes(library.id)} onChange={()=>toggle("library_ids",library.id)}/>{library.name}</label>)}<label className="inline-flex gap-2"><input type="checkbox" checked={collectionsEnabled} onChange={event=>toggleCollections(event.target.checked)}/>Collections</label><label className="inline-flex gap-2"><input type="checkbox" checked={genresEnabled} disabled={libraries.isPending} onChange={event=>toggleGenres(event.target.checked)}/>Genres</label></div></fieldset>
 {youtubeLibraries.length>0&&<YoutubePlaylistSources libraries={youtubeLibraries} selections={draft.youtube_playlists??[]} onChange={setYoutubePlaylists} onLoadingChange={setYoutubeLoading} legacyShowIds={draft.youtube_playlists==null?draft.show_ids:undefined}/>}
 {collectionsEnabled&&<fieldset className="space-y-3 rounded-lg border border-border p-4"><legend className="px-1 font-medium">Source collections</legend>{collections.isPending&&<p role="status">Loading collections…</p>}<div className="flex flex-wrap gap-3">{collections.data?.filter(collection=>collection.members.length>0&&collection.members.every(member=>isChannelSource(member.entry))).map(collection=><label key={collection.id} className="inline-flex gap-2"><input type="checkbox" checked={(draft.collection_ids??[]).includes(collection.id)} onChange={()=>toggle("collection_ids",collection.id)}/>{collection.title}</label>)}</div><p className="text-xs text-muted">Selected collections include all their shows and movies. Viewers need access to every library represented in them.</p>{selectedCollections.length>0&&<SourceTitleList entries={collectionTitles} label="Collection titles"/>}</fieldset>}
 {genresEnabled&&<fieldset className="space-y-3 rounded-lg border border-border p-4"><legend className="px-1 font-medium">Genre sources</legend><fieldset><legend className="text-sm font-medium">Exclude libraries</legend><p className="my-2 text-xs text-muted">Genres include matching titles from all eligible libraries except those excluded here.</p><div className="flex flex-wrap gap-3">{eligibleLibraries.map(library=><label key={library.id} className="inline-flex gap-2 text-sm"><input type="checkbox" checked={!genreLibraryIds.includes(library.id)} onChange={()=>excludeGenreLibrary(library.id)}/>{`Exclude ${library.name}`}</label>)}</div></fieldset><fieldset><legend className="text-sm font-medium">Select genres</legend><div className="mt-2 flex flex-wrap gap-3">{genres.map(genre=><label key={genre} className="inline-flex gap-2 text-sm"><input type="checkbox" checked={draft.genres.includes(genre)} onChange={()=>toggle("genres",genre)}/>{genre}</label>)}</div></fieldset>{!entries.isFetching&&!genres.length&&<p className="text-sm text-muted">No genres found in these libraries.</p>}{draft.genres.length>0&&<SourceTitleList entries={genreMatches} label="Genre matches"/>}</fieldset>}
 {entries.isFetching&&<p role="status">Loading source titles…</p>} {regularLibraryIds.length>0&&<>{titles.length>0?<fieldset><legend className="flex items-center gap-4 font-medium">{titleLabel}<label className="flex items-center gap-2 text-xs font-normal"><input aria-label={`Select all ${titleLabel.toLowerCase()}`} type="checkbox" checked={allSelected} ref={element=>{if(element)element.indeterminate=selectedCount>0&&!allSelected;}} onChange={event=>selectAll(event.target.checked)}/>Select all</label></legend><div className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded border border-border p-3">{titles.map((entry:NativeCatalogEntry)=><label key={entry.id} className="flex items-center gap-2 text-sm"><input aria-label={entry.title} type="checkbox" checked={(entry.kind==="series"?draft.show_ids:draft.movie_ids).includes(entry.id)} onChange={()=>toggle(entry.kind==="series"?"show_ids":"movie_ids",entry.id)}/><span className="min-w-0 flex-1">{entry.title}</span><span className="text-xs text-muted">{entry.kind==="series"?"Show":"Movie"}</span></label>)}</div></fieldset>:!entries.isFetching&&<p className="text-sm text-muted">No additional shows or movies found in these libraries.</p>}</>}
 <p className="text-xs text-muted">Selections are combined: a video is included when it matches a selected title, collection, or genre. A library with no selections includes all its playable videos.</p>
 <label className="block">Playback order<select className={input} value={draft.order} onChange={event=>setDraft({...draft,order:event.target.value as ChannelInput["order"]})}><option value="sequential">In order</option><option value="random">Random without repeats</option><option value="random_shows">Random shows, episodes in order</option></select></label><label className="block">Channel start (local time)<input type="datetime-local" required className={input} value={localDateTime(draft.start_at)} onChange={event=>{if(event.target.value)setDraft({...draft,start_at:new Date(event.target.value).toISOString()});}}/></label><p className="text-xs text-muted">The schedule is saved and remains stable across refreshes and restarts.</p>
 {(libraries.error||collections.error||entries.error||save.error)&&<p role="alert" className="text-red-400">{String(libraries.error||collections.error||entries.error||save.error)}</p>}</form></PopupPage>;
}

function sourceGenres(entry:NativeCatalogEntry):string[]{return [...new Set(["genres","genre"].flatMap(key=>{const value=entry.metadata[key];return Array.isArray(value)?value.filter((genre):genre is string=>typeof genre==="string").map(genre=>genre.trim()).filter(Boolean):typeof value==="string"?value.split(/[|,/]/).map(genre=>genre.trim()).filter(Boolean):[];}))];}
function uniqueTitles(entries:NativeCatalogEntry[]):NativeCatalogEntry[]{return [...new Map(entries.filter(isChannelSource).map(entry=>[entry.id,entry])).values()].sort((a,b)=>a.title.localeCompare(b.title));}
function SourceTitleList({entries,label}:{entries:NativeCatalogEntry[];label:string}){
 return <section aria-label={label} className="space-y-3">{(["series","movie"] as const).map(kind=>{const titles=entries.filter(entry=>entry.kind===kind);return titles.length>0?<div key={kind} className="rounded border border-border p-3"><h3 className="mb-2 text-sm font-medium">{kind==="series"?"Shows":"Movies"} · {titles.length}</h3><ul className="max-h-40 space-y-1 overflow-y-auto text-sm">{titles.map(entry=><li key={entry.id}>{entry.title}</li>)}</ul></div>:null;})}{!entries.length&&<p className="text-sm text-muted">No matching shows or movies.</p>}</section>;
}
