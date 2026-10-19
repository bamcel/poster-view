import {useEffect,useRef,useState} from "react";
import {useQuery,useQueryClient} from "@tanstack/react-query";
import {useSearchParams} from "react-router-dom";
import {Info,Scale} from "lucide-react";
import {sizedArtwork} from "../../lib/artworkSizes";
import {mediaDescription} from "../../lib/mediaDescription";
import {ApiError} from "../../api/client";
import {nativeLibraries} from "../../api/nativeLibraries";
import HeaderSearchControl from "../../components/HeaderSearchControl";
import SearchField from "../../components/SearchField";
import PopupPage from "../../components/PopupPage";
import PosterCard from "../../components/PosterCard";
import {ACTION_BUTTON,EmptyState,Spinner} from "../../components/ui";
import {pairwise,type RankingAction,type RankingTitle,type RankingView} from "./client";
import "./pairwise.css";

export default function PairwisePage(){
 const [params,setParams]=useSearchParams(),library=params.get("library")??"",client=useQueryClient();
 const [comparing,setComparing]=useState(false),[search,setSearch]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false),[detail,setDetail]=useState<RankingTitle|null>(null);
 const inFlight=useRef(false);
 const currentLibrary=useRef(library);currentLibrary.current=library;
 useEffect(()=>{setComparing(false);setError("");setSearch("");setDetail(null);},[library]);
 const settings=useQuery({queryKey:["pairwise-settings"],queryFn:pairwise.settings});
 const libraries=useQuery({queryKey:["pairwise-libraries"],queryFn:pairwise.libraries,enabled:settings.data?.enabled===true});
 const ranking=useQuery({queryKey:["pairwise-ranking",library],queryFn:()=>pairwise.ranking(library),enabled:!!library&&settings.data?.enabled===true});
 const view=ranking.error?undefined:ranking.data,selectedLibrary=libraries.data?.find(item=>item.id===library);
 async function act(action:RankingAction["action"],item_id?:string){
  if(!view||inFlight.current)return;
  inFlight.current=true;setBusy(true);setError("");
  try{const next=await pairwise.action(library,{revision:view.revision,action,...(view.pair?{token:view.pair.token}:{}),...(item_id?{item_id}:{})});client.setQueryData<RankingView>(["pairwise-ranking",library],next);if(action==="start"&&currentLibrary.current===library)setComparing(true);}
  catch(reason){if(currentLibrary.current===library){if(reason instanceof ApiError&&reason.status===409){const refreshed=await ranking.refetch();setError(refreshed.isError?"Your ranking changed in another tab, but its latest state could not be loaded. Please reload before choosing again.":"Your ranking changed in another tab. The latest comparison has been loaded; please choose again.");if(refreshed.isError)setComparing(false);}else setError(reason instanceof Error?reason.message:"Could not save your choice. Please try again.");}}
  finally{inFlight.current=false;setBusy(false);}
 }
 function chooseLibrary(value:string){setComparing(false);setError("");setSearch("");setParams(value?{library:value}:{});}
 const active=view?.titles.filter(title=>!title.excluded)??[];
 const pair=view?.pair;
 const left=view?.titles.find(title=>title.entry.id===pair?.left_id),right=view?.titles.find(title=>title.entry.id===pair?.right_id);
 const visible=(view?.titles??[]).filter(title=>title.entry.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
 function poster(title:RankingTitle,choose?:()=>void){const entry=title.entry;return <PosterCard title={entry.title} subtitle={entry.metadata.year?String(entry.metadata.year):undefined} image={entry.artwork.some(art=>art.kind==="poster")?sizedArtwork(nativeLibraries.artworkUrl(library,entry.id,"poster"),480):undefined} kind={entry.kind==="movie"?"movie":"show"} onOpen={choose} openLabel={choose?`Choose ${entry.title}`:undefined}/>;}
 return <div className="pv-pairwise p-4 md:p-6">
  <HeaderSearchControl><SearchField type="search" aria-label="Search ranking titles" placeholder="Search ranking titles" value={search} disabled={comparing} onChange={event=>setSearch(event.target.value)} containerClassName="w-full max-w-[21rem]"/></HeaderSearchControl>
  <header className="mb-6"><h1 className="flex items-center gap-3 text-2xl font-semibold"><Scale className="size-6"/>PairWise Ranking</h1><p className="mt-2 text-sm text-muted">Your personal preferences, one comparison at a time. Every choice saves automatically.</p></header>
  {settings.isPending?<Spinner label="Loading PairWise Ranking"/>:settings.error?<p role="alert" className="text-danger">{String(settings.error)}</p>:!settings.data?.enabled?<EmptyState title="PairWise Ranking is disabled">Ask an administrator to enable it in Plugins.</EmptyState>:<>
   <label className="flex max-w-md flex-col gap-2 text-sm">Library<select aria-label="Library" disabled={busy} value={library} onChange={event=>chooseLibrary(event.target.value)} className="rounded-full border border-border bg-input px-4 py-3"><option value="">Choose a library</option>{libraries.data?.map(item=><option key={item.id} value={item.id}>{item.name} ({item.title_count} titles)</option>)}</select></label>
   {libraries.error&&<p role="alert" className="text-danger">{String(libraries.error)}</p>}
   {!library&&libraries.data?.length===0&&<EmptyState title="No eligible libraries">Add a movie or series library to start ranking.</EmptyState>}
   {library&&ranking.isPending&&<Spinner label="Loading your ranking"/>}
   {ranking.error&&<p role="alert" className="text-danger">{String(ranking.error)}</p>}
   {error&&<p role="alert" className="my-4 text-danger">{error}</p>}
   {view&&<>
    <div className="my-5 flex flex-wrap items-center gap-3"><p className="mr-auto text-sm text-muted" aria-live="polite">{view.decision_count} comparisons · {view.ranked_count} ranked · {view.excluded_count} excluded</p><button className={ACTION_BUTTON} disabled={busy||!view.can_undo} onClick={()=>void act("undo")}>Undo last decision</button>{comparing?<button className={ACTION_BUTTON} disabled={busy} onClick={()=>setComparing(false)}>Pause / View rankings</button>:<button className={ACTION_BUTTON} disabled={busy||active.length<2} onClick={()=>void act("start")}>{view.decision_count?"Continue ranking":"Start ranking"}</button>}</div>
    {active.length<2&&<p role="status" className="mb-5 text-sm text-muted">At least two included titles are needed. Allow excluded titles below or add more titles to this library.</p>}
    {comparing&&left&&right?<section aria-label="Title comparison" aria-busy={busy}>
     <h2 className="mb-5 text-center text-xl font-semibold">Which do you prefer?</h2>
     <div className="pv-pairwise-comparison">{([left,right] as const).map((title,index)=><article key={title.entry.id} className="pv-pairwise-choice"><div className={busy?"pointer-events-none opacity-60":""} inert={busy}>{poster(title,()=>void act(index===0?"left":"right"))}</div><div className="mt-auto flex flex-col gap-2 pt-3"><button className={ACTION_BUTTON} disabled={busy} onClick={()=>void act(index===0?"left":"right")}>Choose {title.entry.title}</button><button className={ACTION_BUTTON} disabled={busy} onClick={()=>setDetail(title)}><Info className="size-4"/>Details</button><button className="rounded-full px-2 py-2 text-xs text-muted hover:text-white disabled:opacity-50" disabled={busy} onClick={()=>void act("exclude",title.entry.id)}>Don’t rank this title<span className="sr-only">: {title.entry.title}</span></button></div></article>)}</div>
     <div className="mt-5 flex flex-wrap justify-center gap-3"><button className={ACTION_BUTTON} disabled={busy} onClick={()=>void act("tie")}>About equal</button><button className={ACTION_BUTTON} disabled={busy} onClick={()=>void act("skip")}>Skip pair</button></div><p className="mt-4 text-center text-xs text-muted" role="status">{busy?"Saving your choice…":"Skip changes neither score. Don’t rank excludes a title until you allow it again."}</p>
    </section>:<section aria-label="Personal rankings"><h2 className="text-xl font-semibold">{selectedLibrary?.name??"Library"} rankings</h2><p className="my-3 max-w-3xl text-sm text-muted">All titles are included by default. Optionally exclude any title you haven’t watched or don’t want to rank. Scores are relative personal preferences from 0–100 within this library; they are not review ratings.</p>
     {(["ranked","unranked","excluded"] as const).map(group=>{const titles=visible.filter(title=>group==="excluded"?title.excluded:!title.excluded&&(group==="ranked"?title.rank!==null:title.rank===null)).sort((a,b)=>(a.rank??Number.MAX_SAFE_INTEGER)-(b.rank??Number.MAX_SAFE_INTEGER)||a.entry.title.localeCompare(b.entry.title));return <section key={group} className="mt-6"><h3 className="mb-3 font-semibold">{group==="ranked"?"Ranked":group==="unranked"?"Not ranked yet":"Not ranked — excluded by you"} ({titles.length})</h3><div className="pv-pairwise-results">{titles.map(title=><article key={title.entry.id} className="rounded-xl border border-border bg-input p-3"><div className="pv-pairwise-result-poster">{poster(title)}</div><div className="mt-3 text-sm">{title.rank!==null&&!title.excluded?<><strong>#{title.rank}</strong> · Preference score {title.score===null?"—":Math.round(title.score)}</>:<strong>Not ranked</strong>}<p className="mt-1 text-xs text-muted">{title.comparisons} comparisons{title.provisional&&!title.excluded&&title.rank!==null?" · Provisional":""}</p></div><div className="mt-3 flex flex-wrap gap-2"><button className={ACTION_BUTTON} disabled={busy} onClick={()=>setDetail(title)}>Details</button><button className={ACTION_BUTTON} disabled={busy} onClick={()=>void act(title.excluded?"allow":"exclude",title.entry.id)}>{title.excluded?"Allow ranking":"Don’t rank title"}<span className="sr-only">: {title.entry.title}</span></button></div></article>)}</div></section>;})}
    </section>}
    {comparing&&(!left||!right)&&<p role="status" className="my-6 text-sm text-muted">No comparison is available. View rankings to review included titles.</p>}
   </>}
  </>}
  {detail&&<PopupPage title={detail.entry.title} onClose={()=>setDetail(null)} footer={<button className={ACTION_BUTTON} onClick={()=>setDetail(null)}>Done</button>}><p className="whitespace-pre-line text-sm leading-relaxed">{mediaDescription(detail.entry.metadata.overview??detail.entry.metadata.plot??"No description available.")}</p></PopupPage>}
 </div>;
}
