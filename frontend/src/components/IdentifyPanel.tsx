import {useRef, useState} from "react";
import {Search, Loader2, Check, Fingerprint} from "lucide-react";
import {nativeLibraries, type NativeLibrary, type NativeCatalogEntry, type IdentificationCandidate, type IdentificationGroup} from "../api/nativeLibraries";

const names:Record<string,string>={anilist:"AniList",tmdb:"TheMovieDB",tvdb:"TheTVDB",mal:"MyAnimeList",imdb:"IMDb",anidb:"AniDB"};
const inputClass="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-accent";
export default function IdentifyPanel({library,entry,busy,onSaved}:{library:NativeLibrary;entry:NativeCatalogEntry;busy:boolean;onSaved:()=>void}) {
  const [title,setTitle]=useState(entry.title.replace(/\s*[([](?:19|20)\d{2}[)\]]\s*$/, ""));
  const [year,setYear]=useState("");
  const [ids,setIds]=useState<Record<string,string>>({});
  const [groups,setGroups]=useState<IdentificationGroup[]>([]);
  const [loading,setLoading]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const request=useRef(0);
  const hasIds=Object.values(ids).some(value=>value.trim());
  async function search() {
    const current=++request.current;setLoading(true);setError("");setNotice("");
    try {const result=await nativeLibraries.identifySearch(library.id,entry.id,title,year ? Number(year):null);if(current===request.current){setGroups(result.groups);setIds({});}}
    catch(e){if(current===request.current)setError((e as Error).message);}
    finally{if(current===request.current)setLoading(false);}
  }
  function select(candidate:IdentificationCandidate) {
    setError("");if(candidate.year)setYear(String(candidate.year));
    const next={...ids,...candidate.identifiers};
    // Suggest only unique exact title AND year matches; ambiguous records remain unselected.
    if(candidate.year) for(const group of groups) {
      if(next[group.provider])continue;
      const matches=group.results.filter(result=>result.year===candidate.year && result.title.replace(/[^\p{L}\p{N}]/gu,"").toLowerCase()===candidate.title.replace(/[^\p{L}\p{N}]/gu,"").toLowerCase());
      if(matches.length===1)for(const [key,value] of Object.entries(matches[0].identifiers)){if(!next[key])next[key]=value;}
    }
    setIds(next);
  }
  async function save() {
    setSaving(true);setError("");setNotice("");
    try {
      const result=await nativeLibraries.identify(library.id,entry.id,{revision:entry.revision,title,year:year?Number(year):null,identifiers:Object.fromEntries(Object.entries(ids).filter(([,value])=>value.trim()).map(([key,value])=>[key,value.trim()]))});
      if(result.warnings.length){setNotice(result.warnings.join(" "));}else onSaved();
    } catch(e){setError((e as Error).message);}finally{setSaving(false);}
  }
  return <div className="space-y-5">
    <p className="text-sm text-muted">Search providers together, select the correct series or movie, then review its IDs before saving. Selecting a result keeps your entered title. Existing local and manually chosen artwork is preserved.</p>
    <div className="rounded-xl border border-border bg-surface-2 p-3 text-xs text-muted"><p className="mb-1 font-medium text-white">Media path</p><p className="break-all">{entry.path}</p><p className="mt-2">Current IDs: {Object.entries((entry.metadata.identifiers as Record<string,string>)??{}).map(([key,value])=>`${names[key]??key}: ${value}`).join(" · ")||"None"}</p></div>
    <form className="flex flex-wrap items-end gap-3" onSubmit={event=>{event.preventDefault();void search();}}>
      <label className="min-w-48 flex-1 text-sm">Title<input aria-label="Identification title" className={`${inputClass} mt-1`} value={title} onChange={e=>setTitle(e.target.value)} maxLength={200}/></label>
      <label className="w-28 text-sm">Year<input aria-label="Identification year" type="number" min={1800} max={2200} className={`${inputClass} mt-1`} placeholder="Optional" value={year} onChange={e=>setYear(e.target.value)}/></label>
      <button disabled={loading||saving||title.trim().length<2} className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-black disabled:opacity-50">{loading?<Loader2 className="size-4 animate-spin"/>:<Search className="size-4"/>}Search all providers</button>
    </form>
    {groups.length>0 && <div className="grid gap-4 sm:grid-cols-2">{groups.map(group=><section key={group.provider} className="rounded-xl border border-border p-3"><h3 className="mb-2 text-sm font-semibold">{names[group.provider]??group.provider}</h3>{group.error?<p className="text-xs text-muted">{group.error}</p>:!group.results.length?<p className="text-xs text-muted">No matching titles.</p>:<div className="max-h-72 space-y-2 overflow-y-auto">{group.results.map(candidate=><button type="button" key={candidate.id} disabled={saving} onClick={()=>select(candidate)} className={`w-full rounded-lg border p-3 text-left ${ids[group.provider]===candidate.id?"border-accent bg-accent/10":"border-border hover:bg-surface-2"}`}><span className="flex items-center justify-between gap-2 text-sm font-medium">{candidate.title}{ids[group.provider]===candidate.id&&<Check className="size-4 shrink-0 text-accent"/>}</span><span className="mt-1 block text-xs text-muted">{candidate.year??"Unknown year"} · {candidate.format??entry.kind} · ID {candidate.id}</span>{typeof candidate.overview==="string"&&<span className="mt-2 line-clamp-3 block text-xs text-muted">{candidate.overview.replace(/<[^>]*>/g," ")}</span>}</button>)}</div>}</section>)}</div>}
    <section className="rounded-xl border border-border p-4"><h3 className="mb-1 text-sm font-semibold">Review provider IDs</h3><p className="mb-3 text-xs text-muted">Exact title/year matches may be suggested. Check each ID, especially for anime sequels and seasons. AniDB is searched by title; its media type is verified when saving. IMDb IDs can also be entered manually. Blank IDs remove previous matches.</p><div className="grid gap-3 sm:grid-cols-2">{Object.entries(names).map(([provider,label])=><label key={provider} className="text-xs text-muted">{label}<input aria-label={`${label} identification ID`} className={`${inputClass} mt-1`} value={ids[provider]??""} onChange={event=>setIds(current=>({...current,[provider]:event.target.value}))}/></label>)}</div></section>
    {error&&<p role="alert" className="text-sm text-red-400">{error}</p>}
    {notice&&<p role="alert" className="text-sm text-amber-300">{notice}<button className="ml-2 underline" onClick={onSaved}>Return to library</button></p>}
    <div className="flex flex-wrap items-center gap-3"><button disabled={busy||saving||loading||!hasIds} onClick={()=>void save()} className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-black disabled:opacity-50">{saving?<Loader2 className="size-4 animate-spin"/>:<Fingerprint className="size-4"/>}Save identification</button><p className="text-xs text-muted">Scan files afterward to fetch missing metadata with the corrected IDs.</p></div>
  </div>;
}
