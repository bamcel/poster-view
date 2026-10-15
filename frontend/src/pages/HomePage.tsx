import {nativeArtworkVersion} from "../lib/nativeArtworkCache";
import ContinueWatching from "../features/playback/components/ContinueWatching";
import {useCatalogPrefetch} from "../lib/catalogPrefetch";
import {HOME_RESET_EVENT} from "../lib/homeNavigation";
import {libraryPath} from "../lib/mediaPaths";
import {Navigate} from "react-router-dom";
import {Link, useSearchParams} from "../lib/libraryNavigation";
import {useEffect,useState} from "react";
import {Search, X, Film} from "lucide-react";
import {useQueries, useQuery} from "@tanstack/react-query";
import LibraryPosterStrip from "../components/LibraryPosterStrip";
import {nativeLibraries, type NativeLibrary} from "../api/nativeLibraries";
import DashboardPage from "./DashboardPage";
import HomeDiscovery, {FeaturedTitle, type HomeTitle} from "../components/HomeDiscovery";
import HomeQuickView from "../components/HomeQuickView";
import {nativeCatalogView} from "../lib/nativeCatalogView";

function LibraryTile({library,libraries}:{library:NativeLibrary;libraries:NativeLibrary[]}) {
 const prefetchCatalog=useCatalogPrefetch();
 return <Link onMouseEnter={()=>prefetchCatalog(library.id)} onFocus={()=>prefetchCatalog(library.id)} to={libraryPath(library,libraries)} aria-label={`Open ${library.name}`} className="group block rounded-xl text-center focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent">
  <div className="overflow-hidden rounded-md transition-transform duration-200 group-hover:scale-[1.03]"><LibraryPosterStrip library={library.id}/></div>
  <h2 className="mt-2 text-sm font-semibold text-white group-hover:text-accent">{library.name}</h2>
 </Link>;
}
function LibraryHome(){
 const libraries=useQuery({queryKey:["native-libraries"],queryFn:nativeLibraries.list});
 const [search,setSearch]=useState("");
 const [quickView,setQuickView]=useState<HomeTitle|null>(null);
 useEffect(()=>{const reset=()=>{setSearch("");setQuickView(null);};window.addEventListener(HOME_RESET_EVENT,reset);return()=>window.removeEventListener(HOME_RESET_EVENT,reset);},[]);
 const term=search.trim().toLocaleLowerCase();
 const catalogs=useQueries({queries:(libraries.data??[]).map(library=>({queryKey:["native-catalog",library.id],queryFn:()=>nativeLibraries.catalog(library.id),enabled:!!term||!["books","youtube"].includes(library.library_type),staleTime:5*60_000,gcTime:30*60_000}))});
 const titles=term?[]:catalogs.flatMap((catalog,index)=>nativeCatalogView(catalog.data??[]).entries.filter(entry=>entry.metadata.missing!==true&&["movie","series"].includes(entry.kind)).map(entry=>({entry,library:libraries.data![index]})));
 const results=term?catalogs.flatMap((catalog,index)=>(catalog.data??[]).filter(entry=>entry.available&&entry.kind!=="season"&&[entry.title,entry.metadata.originaltitle].some(value=>typeof value==="string"&&value.toLocaleLowerCase().includes(term))).map(entry=>({entry,library:libraries.data![index]}))):[];
 const sections=[{name:"Movies",kinds:["movie"]},{name:"Series",kinds:["series"]},{name:"Episodes",kinds:["episode"]},{name:"Books",kinds:["book","book_series"]}].map(section=>({...section,results:results.filter(({entry})=>section.kinds.includes(entry.kind))})).filter(section=>section.results.length>0);
 const loading=!!term&&(libraries.isPending||catalogs.some(catalog=>catalog.isPending));
 const featured=!term&&titles.length>0;
 return <main className="relative h-full overflow-y-auto pb-8">
  <header className={featured?"absolute inset-x-0 top-0 z-10 px-5 pt-5 sm:px-8 md:px-12":"mb-3 flex flex-col gap-7 px-5 pt-5 sm:px-8 md:gap-10 md:px-12"}>
   <h1 className={featured?"sr-only":"order-2 text-2xl font-semibold text-white"}>{term?"Search results":"My Media"}</h1>
  <div role="search" className="order-1 grid min-h-11 grid-cols-[44px_minmax(0,1fr)_44px] items-center gap-3">
   <div className="relative col-start-2 mx-auto w-full max-w-[21rem]">
    <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint"/>
    <input aria-label="Search all libraries" placeholder="Search" value={search} onChange={event=>{setSearch(event.target.value);setQuickView(null);}} className="w-full rounded-full border border-border bg-input py-2 pl-9 pr-10 text-[16px] font-medium text-muted outline-none placeholder:text-muted focus:border-accent md:text-sm"/>
    {search&&<button type="button" aria-label="Clear search" onClick={()=>setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-white" data-icon-button="true"><X className="size-4"/></button>}
   </div>
  </div>
  </header>
  {libraries.isPending&&<p role="status" className="px-5 text-muted sm:px-8 md:px-12">Loading libraries…</p>}
  {libraries.error&&<p role="alert" className="px-5 text-danger sm:px-8 md:px-12">{libraries.error.message}</p>}
  {libraries.data?.length===0&&<div className="space-y-3 px-5 text-muted sm:px-8 md:px-12"><p>Your libraries will appear here once you add them.</p><Link className="text-accent hover:underline" to="/settings/libraries">Add a library</Link></div>}
  {term?<div className="px-5 sm:px-8 md:px-12">
   {loading&&<p role="status" className="mb-4 text-muted">Searching libraries…</p>}
   {catalogs.map((catalog,index)=>catalog.error&&<p role="alert" key={libraries.data![index].id} className="mb-3 text-danger">Could not search {libraries.data![index].name}: {catalog.error.message}</p>)}
   {!loading&&results.length===0&&<p className="text-muted">No matching titles found.</p>}
   <div className="space-y-8">{sections.map(section=><section key={section.name} aria-label={section.name}>
    <h2 className="mb-4 text-xl font-semibold text-white">{section.name}</h2>
    <div className="flex gap-5 overflow-x-auto pb-3">{section.results.slice(0,100).map(({entry,library})=><Link key={`${library.id}:${entry.id}`} to={`/media/${encodeURIComponent(library.id)}?native_library=${encodeURIComponent(library.id)}&native_item=${encodeURIComponent(entry.id)}`} aria-label={`Open ${entry.title} in ${library.name}`} className={`group shrink-0 rounded-lg focus-visible:outline-2 focus-visible:outline-accent ${entry.kind==="episode"?"w-64 sm:w-72 lg:w-80":"w-36 sm:w-44 lg:w-52"}`}>
    <div className={`grid place-items-center overflow-hidden rounded-lg bg-elevated ${entry.kind==="episode"?"aspect-video":"aspect-[2/3]"}`}>{(()=>{const kind=entry.kind==="episode"?entry.artwork.find(art=>art.kind==="thumb")?.kind??entry.artwork.find(art=>art.kind==="landscape")?.kind:entry.artwork.find(art=>art.kind==="poster")?.kind;return kind?<img src={`${nativeLibraries.artworkUrl(library.id,entry.id,kind)}?v=${encodeURIComponent(nativeArtworkVersion(entry,kind))}`} alt="" loading="lazy" className="h-full w-full object-cover"/>:<Film className="size-10 text-faint"/>;})()}</div>
    <p className="mt-2 truncate text-sm font-medium text-white group-hover:text-accent">{entry.title}</p><p className="text-xs text-muted">{library.name} · {entry.kind.replaceAll("_"," ")}</p>
   </Link>)}</div>
   {section.results.length>100&&<p className="mt-3 text-sm text-muted">Showing 100 of {section.results.length} matches. Refine your search to see fewer results.</p>}
   </section>)}</div>
  </div>:<>
   <FeaturedTitle titles={titles} onQuickView={setQuickView}/>
   <div className="px-5 sm:px-8 md:px-12">
   <ContinueWatching/>
   <section aria-label="My libraries" className="mt-8">
    <h2 className="mb-4 text-xl font-semibold text-white">My Libraries</h2>
    <div className="grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-3 lg:gap-x-7 lg:gap-y-10 xl:grid-cols-4 2xl:grid-cols-6">{libraries.data?.map(library=><LibraryTile key={library.id} library={library} libraries={libraries.data??[]}/>)}</div>
   </section>
   {catalogs.some((catalog,index)=>catalog.isPending&&!["books","youtube"].includes(libraries.data![index].library_type))&&<p role="status" className="mt-6 text-muted">Discovering your titles…</p>}
   {catalogs.map((catalog,index)=>catalog.error&&<p role="alert" key={libraries.data![index].id} className="mt-4 text-danger">Could not load discoveries from {libraries.data![index].name}: {catalog.error.message}</p>)}
   <HomeDiscovery titles={titles} onQuickView={setQuickView}/>
   </div>
  </>}
  {quickView&&<HomeQuickView key={`${quickView.library.id}:${quickView.entry.id}`} title={quickView} onClose={()=>setQuickView(null)}/>}
 </main>;
}
export default function HomePage(){
 const [params]=useSearchParams();
 if(params.has("native_library")) return <Navigate replace to={`/media/${encodeURIComponent(params.get("native_library")!)}?${params}`}/>;
 if(params.has("lib")) return <DashboardPage/>;
 return <LibraryHome/>;
}
