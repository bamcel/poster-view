import LibraryPopup from "../components/LibraryPopup";
import {useHomepageBannerLogo} from "../lib/homepagePreferences";
import SearchField from "../components/SearchField";
import CardActionMenu from "../components/CardActionMenu";
import HomeBackground from "../components/HomeBackground";
import {AuthSessionContext,useIsAdmin} from "../lib/authContext";
import HomeMediaRow from "../components/HomeMediaRow";
import {nativeArtworkVersion} from "../lib/nativeArtworkCache";
import ContinueWatching from "../features/playback/components/ContinueWatching";
import {useCatalogPrefetch} from "../lib/catalogPrefetch";
import {HOME_RESET_EVENT} from "../lib/homeNavigation";
import {libraryPath} from "../lib/mediaPaths";
import {Navigate} from "react-router-dom";
import {Link, useSearchParams} from "../lib/libraryNavigation";
import {useContext,useEffect,useState} from "react";
import {createPortal} from "react-dom";
import {HeaderSearchTarget} from "../lib/headerSearch";
import {X, Film, MoreHorizontal} from "lucide-react";
import {useQueries, useQuery,useQueryClient} from "@tanstack/react-query";
import LibraryPosterStrip from "../components/LibraryPosterStrip";
import {nativeLibraries, type NativeLibrary} from "../api/nativeLibraries";
import DashboardPage from "./DashboardPage";
import HomeDiscovery, {FeaturedTitle} from "../components/HomeExperience";
import {catalogQueryOptions, catalogView} from "../lib/nativeCatalogQueries";
import {groupHomeTitles} from "../lib/homeTitleGroups";

function LibraryTile({library,libraries}:{library:NativeLibrary;libraries:NativeLibrary[]}) {
 const prefetchCatalog=useCatalogPrefetch(),client=useQueryClient(),isAdmin=useIsAdmin();
 const invalidate=()=>Promise.all([client.invalidateQueries({queryKey:["native-scan",library.id]}),client.invalidateQueries({queryKey:["native-catalog",library.id]})]);
 const tile=<Link onMouseEnter={()=>prefetchCatalog(library.id,library.library_type)} onFocus={()=>prefetchCatalog(library.id,library.library_type)} to={libraryPath(library,libraries)} aria-label={`Open ${library.name}`} className="pv-home-landscape-card pv-home-library-card group block rounded-xl text-left focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent">
  <div className="overflow-hidden rounded-md transition-transform duration-200 group-hover:scale-[1.03]"><LibraryPosterStrip library={library.id}/></div>
  <h3 className="mt-2 text-sm font-medium text-white group-hover:text-accent">{library.name}</h3>
 </Link>;
 return isAdmin?<CardActionMenu label={`${library.name} library actions`} actions={[
  {label:"Scan Library Files",onSelect:async()=>{await nativeLibraries.scan(library.id);await invalidate();},success:`Scan requested for ${library.name}.`},
  {label:"Refresh Metadata",onSelect:async()=>{await nativeLibraries.refresh(library.id,{replaceMetadata:false,replaceImages:false});await invalidate();},success:`Metadata refresh requested for ${library.name}.`}
 ]}>{tile}</CardActionMenu>:tile;
}
function LibraryHome(){
 const searchTarget=useContext(HeaderSearchTarget);
 const [bannerLogo,setBannerLogo]=useHomepageBannerLogo();
 const [bannerSaved,setBannerSaved]=useState(false);
 const user=useContext(AuthSessionContext)?.user;
 const libraries=useQuery({queryKey:["native-libraries"],queryFn:nativeLibraries.list,select:items=>items.filter(library=>!user||user.role==="admin"||user.permissions.all_libraries||user.permissions.library_ids.includes(library.id))});
 const [search,setSearch]=useState("");
 useEffect(()=>{const reset=()=>setSearch("");window.addEventListener(HOME_RESET_EVENT,reset);return()=>window.removeEventListener(HOME_RESET_EVENT,reset);},[]);
 const term=search.trim().toLocaleLowerCase();
 const catalogs=useQueries({queries:(libraries.data??[]).map(library=>({...catalogQueryOptions(library),enabled:!!term||!["books","youtube"].includes(library.library_type),staleTime:5*60_000,gcTime:30*60_000}))});
 const titles=term?[]:groupHomeTitles(catalogs.flatMap((catalog,index)=>catalogView(catalog.data).entries.filter(entry=>entry.metadata.missing!==true&&["movie","series"].includes(entry.kind)).map(entry=>({entry,library:libraries.data![index]}))));
 const results=term?groupHomeTitles(catalogs.flatMap((catalog,index)=>(catalog.data??[]).filter(entry=>entry.available&&entry.kind!=="season"&&[entry.title,entry.metadata.originaltitle].some(value=>typeof value==="string"&&value.toLocaleLowerCase().includes(term))).map(entry=>({entry,library:libraries.data![index]})))):[];
 const sections=[{name:"Movies",kinds:["movie"]},{name:"Series",kinds:["series"]},{name:"Episodes",kinds:["episode"]},{name:"Books",kinds:["book","book_series"]}].map(section=>({...section,results:results.filter(({entry})=>section.kinds.includes(entry.kind))})).filter(section=>section.results.length>0);
 const loading=!!term&&(libraries.isPending||catalogs.some(catalog=>catalog.isPending));
 const bannerLoading=libraries.isPending||catalogs.some((catalog,index)=>!["books","youtube"].includes(libraries.data![index].library_type)&&catalog.isPending);
 const featured=!term&&(bannerLoading||titles.length>0);
 const searchControl=<div role="search" className="flex min-h-11 min-w-0 flex-1 items-center justify-center gap-2">
   <div className="relative w-full max-w-[21rem]">
    <SearchField aria-label="Search all libraries" placeholder="Search" value={search} onChange={event=>setSearch(event.target.value)} trailing={search&&<button type="button" aria-label="Clear search" onClick={()=>setSearch("")} className="text-muted hover:text-white" data-icon-button="true"><X className="size-4"/></button>}/>

   </div>
   <LibraryPopup title="Homepage preferences" label="Homepage preferences" icon={<MoreHorizontal className="size-4"/>}>
    <label className="flex items-center gap-3 text-sm"><input type="checkbox" className="accent-accent" checked={bannerLogo} onChange={event=>{setBannerLogo(event.target.checked);setBannerSaved(true);}}/>Use title logos in the featured banner</label>
    <p className="mt-3 text-xs text-muted">Show the title’s logo when available, with text as a fallback. Saved for your account in this browser.</p>
    {bannerSaved&&<p role="status" className="mt-3 text-xs text-muted">Changes saved automatically</p>}
   </LibraryPopup>
  </div>;
 return <main className="relative z-10 h-full overflow-y-auto pt-5 pb-8">
  <HomeBackground libraries={libraries.data??[]}/>
  <div className="relative z-10 min-h-full">
  {searchTarget&&createPortal(searchControl,searchTarget)}
  <header className={featured&&searchTarget?"sr-only":"mb-3 flex flex-col gap-3 px-5 pt-3 sm:px-8 md:px-12"}>
   <h1 className={featured?"sr-only":"text-2xl font-semibold text-white"}>{term?"Search results":"My Media"}</h1>
   {!searchTarget&&searchControl}
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
    <div className="flex gap-5 overflow-x-auto pb-3">{section.results.slice(0,100).map(({entry,library})=><Link key={`${library.id}:${entry.id}`} to={`/media/${encodeURIComponent(library.id)}?native_library=${encodeURIComponent(library.id)}&native_item=${encodeURIComponent(entry.id)}&from=home`} aria-label={`Open ${entry.title} in ${library.name}`} className={`group shrink-0 rounded-lg focus-visible:outline-2 focus-visible:outline-accent ${entry.kind==="episode"?"w-64 sm:w-72 lg:w-80":"w-36 sm:w-44 lg:w-52"}`}>
    <div className={`grid place-items-center overflow-hidden rounded-lg bg-elevated ${entry.kind==="episode"?"aspect-video":"aspect-[2/3]"}`}>{(()=>{const kind=entry.kind==="episode"?entry.artwork.find(art=>art.kind==="thumb")?.kind??entry.artwork.find(art=>art.kind==="landscape")?.kind:entry.artwork.find(art=>art.kind==="poster")?.kind;return kind?<img src={`${nativeLibraries.artworkUrl(library.id,entry.id,kind)}?v=${encodeURIComponent(nativeArtworkVersion(entry,kind))}`} alt="" loading="lazy" className="h-full w-full object-cover"/>:<Film className="size-10 text-faint"/>;})()}</div>
    <p className="mt-2 truncate text-sm font-medium text-white group-hover:text-accent">{entry.title}</p><p className="text-xs text-muted">{library.name} · {entry.kind.replaceAll("_"," ")}</p>
   </Link>)}</div>
   {section.results.length>100&&<p className="mt-3 text-sm text-muted">Showing 100 of {section.results.length} matches. Refine your search to see fewer results.</p>}
   </section>)}</div>
  </div>:<>
   {bannerLoading?<section className="pv-home-hero" aria-label="Loading featured title" aria-busy="true"><p role="status" className="pv-home-hero-content text-muted">Loading featured titles…</p></section>:<FeaturedTitle titles={titles}/>}
   <div className="px-5 sm:px-8 md:px-12">
   <div className="pv-home-library-section"><HomeMediaRow label="My Libraries" ariaLabel="My libraries" wrap>
    {libraries.data?.map(library=><LibraryTile key={library.id} library={library} libraries={libraries.data??[]}/>)}
   </HomeMediaRow></div>
   <ContinueWatching/>
   {catalogs.some((catalog,index)=>catalog.isPending&&!["books","youtube"].includes(libraries.data![index].library_type))&&<p role="status" className="mt-6 text-muted">Discovering your titles…</p>}
   {catalogs.map((catalog,index)=>catalog.error&&<p role="alert" key={libraries.data![index].id} className="mt-4 text-danger">Could not load discoveries from {libraries.data![index].name}: {catalog.error.message}</p>)}
   <HomeDiscovery titles={titles}/>
   </div>
  </>}
  </div>
 </main>;
}
export default function HomePage(){
 const [params]=useSearchParams();
 if(params.has("native_library")) return <Navigate replace to={`/media/${encodeURIComponent(params.get("native_library")!)}?${params}`}/>;
 if(params.has("lib")) return <DashboardPage/>;
 return <LibraryHome/>;
}
