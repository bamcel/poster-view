import {Link, Navigate, useSearchParams} from "react-router-dom";
import {useState} from "react";
import {Search, X, Film} from "lucide-react";
import {useQueries, useQuery} from "@tanstack/react-query";
import LibraryPosterStrip from "../components/LibraryPosterStrip";
import {nativeLibraries, type NativeLibrary} from "../api/nativeLibraries";
import DashboardPage from "./DashboardPage";

function LibraryTile({library}:{library:NativeLibrary}) {
 return <Link to={`/media/${encodeURIComponent(library.id)}`} aria-label={`Open ${library.name}`} className="group block rounded-xl p-2 text-center focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent">
  <div className="overflow-hidden rounded-md transition-transform duration-200 group-hover:scale-[1.03]"><LibraryPosterStrip library={library.id}/></div>
  <h2 className="mt-2 text-sm font-semibold text-white group-hover:text-accent">{library.name}</h2>
 </Link>;
}
function LibraryHome(){
 const libraries=useQuery({queryKey:["native-libraries"],queryFn:nativeLibraries.list});
 const [search,setSearch]=useState("");
 const term=search.trim().toLocaleLowerCase();
 const catalogs=useQueries({queries:(libraries.data??[]).map(library=>({queryKey:["native-catalog",library.id],queryFn:()=>nativeLibraries.catalog(library.id),enabled:!!term,staleTime:60_000}))});
 const results=catalogs.flatMap((catalog,index)=>(catalog.data??[]).filter(entry=>entry.available&&entry.kind!=="season"&&[entry.title,entry.metadata.originaltitle].some(value=>typeof value==="string"&&value.toLocaleLowerCase().includes(term))).map(entry=>({entry,library:libraries.data![index]})));
 const loading=!!term&&(libraries.isPending||catalogs.some(catalog=>catalog.isPending));
 return <main className="h-full overflow-y-auto px-5 py-5 sm:px-8">
  <div role="search" className="mb-8 flex justify-center">
   <div className="relative w-full max-w-[21rem]">
    <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint"/>
    <input aria-label="Search all libraries" placeholder="Search all libraries" value={search} onChange={event=>setSearch(event.target.value)} className="w-full rounded-full border border-border bg-input py-2 pl-9 pr-10 text-[16px] font-medium text-muted outline-none placeholder:text-muted focus:border-accent md:text-sm"/>
    {search&&<button type="button" aria-label="Clear search" onClick={()=>setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-white"><X className="size-4"/></button>}
   </div>
  </div>
  <h1 className="mb-5 text-2xl font-semibold text-white">{term?"Search results":"My Media"}</h1>
  {libraries.isPending&&<p role="status" className="text-muted">Loading libraries…</p>}
  {libraries.error&&<p role="alert" className="text-danger">{libraries.error.message}</p>}
  {libraries.data?.length===0&&<div className="space-y-3 text-muted"><p>Your libraries will appear here once you add them.</p><Link className="text-accent hover:underline" to="/settings/libraries">Add a library</Link></div>}
  {term?<>
   {loading&&<p role="status" className="mb-4 text-muted">Searching libraries…</p>}
   {catalogs.map((catalog,index)=>catalog.error&&<p role="alert" key={libraries.data![index].id} className="mb-3 text-danger">Could not search {libraries.data![index].name}: {catalog.error.message}</p>)}
   {!loading&&results.length===0&&<p className="text-muted">No matching titles found.</p>}
   <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-5 2xl:grid-cols-7">{results.slice(0,100).map(({entry,library})=><Link key={`${library.id}:${entry.id}`} to={`/media/${encodeURIComponent(library.id)}?native_library=${encodeURIComponent(library.id)}&native_item=${encodeURIComponent(entry.id)}`} aria-label={`Open ${entry.title} in ${library.name}`} className="group rounded-lg focus-visible:outline-2 focus-visible:outline-accent">
    <div className="grid aspect-[2/3] place-items-center overflow-hidden rounded-lg bg-elevated">{entry.artwork.some(art=>art.kind==="poster")?<img src={`${nativeLibraries.artworkUrl(library.id,entry.id,"poster")}?v=${entry.revision}`} alt="" loading="lazy" className="h-full w-full object-cover"/>:<Film className="size-10 text-faint"/>}</div>
    <p className="mt-2 truncate text-sm font-medium text-white group-hover:text-accent">{entry.title}</p><p className="text-xs text-muted">{library.name} · {entry.kind.replaceAll("_"," ")}</p>
   </Link>)}</div>
   {results.length>100&&<p className="mt-4 text-sm text-muted">Showing 100 of {results.length} matches. Refine your search to see fewer results.</p>}
  </>:<div className="grid grid-cols-2 gap-x-4 gap-y-7 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-6">{libraries.data?.map(library=><LibraryTile key={library.id} library={library}/>)}</div>}
 </main>;
}
export default function HomePage(){
 const [params]=useSearchParams();
 if(params.has("native_library")) return <Navigate replace to={`/media/${encodeURIComponent(params.get("native_library")!)}?${params}`}/>;
 if(params.has("lib")) return <DashboardPage/>;
 return <LibraryHome/>;
}
