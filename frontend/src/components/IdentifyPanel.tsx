import ProviderIdPreview from "./ProviderIdPreview";
import TVIdentifyPanel from "./TVIdentifyPanel";
import {useQuery} from "@tanstack/react-query";
import {apiRequest} from "../api/client";
import {useRef, useState} from "react";
import {Search, Loader2, Check, Fingerprint, ImageOff} from "lucide-react";
import {nativeLibraries, type NativeLibrary, type NativeCatalogEntry, type IdentificationCandidate, type IdentificationGroup} from "../api/nativeLibraries";

const names:Record<string,string>={mangadex:"MangaDex",comicvine:"ComicVine",anilist:"AniList",tmdb:"TheMovieDB",tvdb:"TheTVDB",mal:"MyAnimeList",imdb:"IMDb",anidb:"AniDB"};
const inputClass="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-accent";
export default function IdentifyPanel(props:{library:NativeLibrary;entry:NativeCatalogEntry;busy:boolean;onSaved:()=>void}){
 if(props.library.library_type==="shows"&&props.entry.kind==="series")return <TVIdentifyPanel {...props}/>;
 return <ProviderIdentifyPanel {...props}/>;
}
function ProviderIdentifyPanel({library,entry,busy,onSaved}:{library:NativeLibrary;entry:NativeCatalogEntry;busy:boolean;onSaved:()=>void}) {
  const books=entry.kind==="book_series";
  const providers=books?(library.options?.metadata_providers?.book_series??["comicvine","anilist","mal"]):library.library_type==="anime"?Object.keys(names).filter(p=>p!=="comicvine"&&p!=="mangadex"):["tvdb","tmdb","imdb"];
  const [title,setTitle]=useState(entry.title.replace(/\s*[([](?:19|20)\d{2}[)\]]\s*$/, ""));
  const [year,setYear]=useState("");
  const [ids,setIds]=useState<Record<string,string>>(()=>Object.fromEntries(Object.entries((entry.metadata.identifiers as Record<string,string>)??{}).filter(([provider])=>providers.includes(provider))));
  const [groups,setGroups]=useState<IdentificationGroup[]>([]);
  const [loading,setLoading]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [selected,setSelected]=useState<IdentificationCandidate|null>(null);
  const [linked,setLinked]=useState<IdentificationCandidate[]>([]);
  const [resolving,setResolving]=useState(false);
  const [active,setActive]=useState("");
  const request=useRef(0);
  const hasIds=Object.values(ids).some(value=>value.trim());
  async function search() {
    const current=++request.current;setLoading(true);setError("");setNotice("");
    try {const result=await nativeLibraries.identifySearch(library.id,entry.id,title,year ? Number(year):null);if(current===request.current){setGroups(result.groups);setSelected(null);setLinked([]);setActive(result.groups.find(g=>g.results.length)?.provider??result.groups[0]?.provider??"");}}
    catch(e){if(current===request.current)setError((e as Error).message);}
    finally{if(current===request.current)setLoading(false);}
  }
  async function select(candidate:IdentificationCandidate) {
    const current=++request.current;
    setError("");setNotice("");setSelected(candidate);if(candidate.year)setYear(String(candidate.year));
    const next={...(!selected||selected.provider===candidate.provider?{}:ids),...Object.fromEntries(Object.entries(candidate.identifiers).filter(([key])=>providers.includes(key)))};
    setIds(next);setLinked([candidate]);setResolving(true);
    try {
      const result=await nativeLibraries.identifyResolve(library.id,entry.id,candidate.provider,candidate.id);
      if(current!==request.current)return;
      setSelected(result.candidates.find(c=>c.provider===candidate.provider)??candidate);setIds({...next,...Object.fromEntries(Object.entries(result.identifiers).filter(([key])=>providers.includes(key)))});setLinked([result.candidates.find(c=>c.provider===candidate.provider)??candidate,...result.candidates.filter(c=>c.provider!==candidate.provider)]);setNotice(result.warnings.join(" "));
    }catch(e){if(current===request.current)setNotice(`Selected ID retained. Linked IDs could not be resolved: ${(e as Error).message}`);}
    finally{if(current===request.current)setResolving(false);}
  }
  async function save() {
    setSaving(true);setError("");setNotice("");
    try {
      const result=await nativeLibraries.identify(library.id,entry.id,{revision:entry.revision,title,year:year?Number(year):null,identifiers:Object.fromEntries(Object.entries(ids).filter(([,value])=>value.trim()).map(([key,value])=>[key,value.trim()]))});
      if(result.warnings.length){setNotice(result.warnings.join(" "));}else onSaved();
    } catch(e){setError((e as Error).message);}finally{setSaving(false);}
  }
  return <div className="flex h-full min-h-0 flex-col"><div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 pb-5 sm:px-8">
    <p className="text-sm text-muted">Search providers together, select the correct series, movie, or book series, then review its IDs before saving. Selecting a result keeps your entered title. Saving a new identity clears previous descriptive metadata. Existing artwork is preserved.</p>
    <div className="rounded-xl border border-border bg-surface-2 p-3 text-xs text-muted"><p className="mb-1 font-medium text-white">Media path</p><p className="break-all">{entry.path}</p><p className="mt-2">Current IDs: {Object.entries((entry.metadata.identifiers as Record<string,string>)??{}).map(([key,value])=>`${names[key]??key}: ${value}`).join(" · ")||"None"}</p></div>
    <form className="flex flex-wrap items-end gap-3" onSubmit={event=>{event.preventDefault();void search();}}>
      <label className="min-w-48 flex-1 text-sm">Title<input aria-label="Identification title" className={`${inputClass} mt-1`} value={title} onChange={e=>setTitle(e.target.value)} maxLength={200}/></label>
      <label className="w-28 text-sm">Year<input aria-label="Identification year" type="number" min={1800} max={2200} className={`${inputClass} mt-1`} placeholder="Optional" value={year} onChange={e=>setYear(e.target.value)}/></label>
      <button disabled={loading||saving||resolving||title.trim().length<2||providers.length===0} className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-black disabled:opacity-50">{loading?<Loader2 className="size-4 animate-spin"/>:<Search className="size-4"/>}Search all providers</button>
    </form>
    {selected && <section className="rounded-xl border border-accent/50 bg-accent/5 p-4"><div className="flex items-start gap-4"><MatchPoster candidate={selected} className="w-20 shrink-0"/><div><h3 className="font-semibold">Selected match: {selected.title}</h3><p className="mt-1 text-xs text-muted">{selected.year??"Unknown year"} · {names[selected.provider]}</p><p className="mt-3 text-xs text-muted">Your display title stays “{title}”. Review linked IDs before saving.</p></div></div>{resolving?<p role="status" className="mt-4 flex items-center gap-2 text-sm text-muted"><Loader2 className="size-4 animate-spin"/>Finding linked provider IDs…</p>:<div className="mt-4 flex flex-wrap gap-2">{Object.entries(ids).filter(([,id])=>id).map(([provider,id])=><span key={provider} className="rounded-full border border-border bg-surface-2 px-3 py-1 text-xs">{names[provider]??provider}: {id}</span>)}</div>}{linked.length>1&&<p className="mt-3 text-xs text-accent">Linked provider matches appear first below.</p>}</section>}
    {books&&providers.length===0&&<p className="text-sm text-muted">No book metadata providers are enabled for this library. Enable providers in Settings → Libraries, or edit metadata manually.</p>}
    {groups.length>0 && <section className="space-y-4"><div role="tablist" aria-label="Identification providers" className="flex flex-wrap gap-2">{groups.map(group=><button key={group.provider} role="tab" aria-selected={active===group.provider} onClick={()=>setActive(group.provider)} className={`rounded-full border px-3 py-2 text-sm ${active===group.provider?"border-accent bg-accent/15 text-accent":"border-border text-muted"}`}>{names[group.provider]??group.provider} <span className="text-xs opacity-70">{group.results.length}</span></button>)}</div>{groups.filter(group=>group.provider===active).map(group=>{
      const preferred=linked.filter(c=>c.provider===group.provider);
      const cards=[...preferred,...group.results.filter(c=>!preferred.some(p=>p.id===c.id))];
      return <div role="tabpanel" aria-label={`${names[group.provider]} matches`} key={group.provider}>{group.error&&<p className="mb-3 text-sm text-muted">{group.error}</p>}{!cards.length&&!group.error?<p className="text-sm text-muted">No matching titles. Try removing the year or shortening the title.</p>:<div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">{cards.map(candidate=><button type="button" key={candidate.id} disabled={saving||resolving} aria-pressed={ids[group.provider]===candidate.id} onClick={()=>void select(candidate)} className={`overflow-hidden rounded-xl border text-left disabled:opacity-60 ${ids[group.provider]===candidate.id?"border-accent ring-1 ring-accent":"border-border hover:border-accent"}`}><MatchPoster candidate={candidate}/><div className="p-3"><span className="flex items-start justify-between gap-2 text-sm font-medium"><span className="line-clamp-2">{candidate.title}</span>{ids[group.provider]===candidate.id&&<Check className="size-4 shrink-0 text-accent"/>}</span><span className="mt-1 block text-xs text-muted">{candidate.year??"Unknown year"} · {candidate.format??entry.kind}</span>{candidate.provider==="comicvine"&&<><span className="mt-1 block text-xs text-muted">Publisher: {candidate.publisher||"Unknown"}</span><span className="mt-1 block text-xs text-muted">{candidate.volume_count==null?"Volume count unknown":`${candidate.volume_count} ${candidate.volume_count===1?"volume":"volumes"}`}</span></>}<span className="mt-1 block text-xs text-faint">ID {candidate.id}{preferred.some(p=>p.id===candidate.id)?" · Linked match":""}</span></div></button>)}</div>}</div>;
    })}</section>}
    <section className="rounded-xl border border-border p-4"><h3 className="mb-1 text-sm font-semibold">Review provider IDs</h3><p className="mb-3 text-xs text-muted">{books?"Search ComicVine first, then AniList or MyAnimeList for manga and light novels. Review the selected series IDs before saving. Providers are configured for this library in Settings → Libraries. Only provider-declared links are added automatically.":"Provider-supplied ID links are resolved automatically. Check each ID, especially for anime sequels and seasons. AniDB is searched by title; its media type is verified when saving. IMDb IDs can also be entered manually. Blank IDs remove previous matches."}</p><div className="grid gap-3 sm:grid-cols-2">{providers.map(provider=>{const label=names[provider];return <div key={provider}><label className="text-xs text-muted">{label}<input aria-label={`${label} identification ID`} className={`${inputClass} mt-1`} placeholder={provider==="comicvine"?"Volume ID or ComicVine series URL":undefined} value={ids[provider]??""} onChange={event=>setIds(current=>({...current,[provider]:event.target.value}))}/>{provider==="comicvine"&&<button type="button" disabled={resolving||saving||!ids.comicvine?.trim()} onClick={()=>void select({provider:"comicvine",id:ids.comicvine.trim(),title,year:null,overview:null,format:"Book series",identifiers:{comicvine:ids.comicvine.trim()}})} className="mt-2 rounded-lg border border-border px-3 py-2 text-xs disabled:opacity-50">Find ComicVine record</button>}</label><ProviderIdPreview library={library.id} item={entry.id} provider={provider} id={ids[provider]??""} label={label}/></div>;})}</div>{books&&<p className="mt-3 text-xs text-muted">ComicVine accepts a numeric volume ID or a series URL containing 4050-. Use Find ComicVine record to preview it. Individual issue URLs are not series IDs.</p>}</section>
    {error&&<p role="alert" className="text-sm text-red-400">{error}</p>}
    {notice&&<p role="status" className="text-sm text-amber-300">{notice}</p>}
    </div><footer className="flex shrink-0 flex-wrap items-center gap-3 bg-sidebar px-6 py-5 sm:px-8"><button disabled={busy||saving||loading||resolving||!hasIds} onClick={()=>void save()} className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-black disabled:opacity-50">{saving?<Loader2 className="size-4 animate-spin"/>:<Fingerprint className="size-4"/>}Save identification</button><p className="text-xs text-muted">Changes wait for overlapping scans. Scan afterward to fetch missing metadata with the corrected IDs.</p></footer>
  </div>;
}

function MatchPoster({candidate,className=""}:{candidate:IdentificationCandidate;className?:string}){
 const [failed,setFailed]=useState(false);
 const preview=useQuery({queryKey:["anidb-identify-poster",candidate.id],queryFn:()=>apiRequest<{poster:string|null}>(`/native/identify/anidb/${encodeURIComponent(candidate.id)}/poster`),enabled:candidate.provider==="anidb"&&!candidate.poster,staleTime:86400000,retry:false});
 const poster=candidate.poster??(candidate.provider==="anidb"?preview.data?.poster:undefined);

 return <div className={`aspect-[2/3] overflow-hidden rounded-lg bg-surface-2 ${className}`}>{poster&&!failed?<img src={poster} alt={`${candidate.title} poster`} loading="lazy" decoding="async" referrerPolicy="no-referrer" className="h-full w-full object-cover" onError={()=>setFailed(true)}/>:<div title={preview.error?.message} className="flex h-full items-center justify-center text-faint">{preview.isFetching?<Loader2 className="size-8 animate-spin"/>:<ImageOff className="size-8"/>}<span className="sr-only">{preview.isFetching?"Loading AniDB poster":preview.error?.message??"No poster available"}</span></div>}</div>;
}
