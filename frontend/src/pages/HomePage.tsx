import {Link, Navigate, useSearchParams} from "react-router-dom";
import {useQuery} from "@tanstack/react-query";
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
 return <main className="h-full overflow-y-auto px-5 py-8 sm:px-8 sm:py-12">
  <h1 className="mb-5 text-2xl font-semibold text-white">My Media</h1>
  {libraries.isPending&&<p role="status" className="text-muted">Loading libraries…</p>}
  {libraries.error&&<p role="alert" className="text-danger">{libraries.error.message}</p>}
  {libraries.data?.length===0&&<div className="space-y-3 text-muted"><p>Your libraries will appear here once you add them.</p><Link className="text-accent hover:underline" to="/settings/libraries">Add a library</Link></div>}
  <div className="grid grid-cols-2 gap-x-4 gap-y-7 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-6">{libraries.data?.map(library=><LibraryTile key={library.id} library={library}/>)}</div>
 </main>;
}
export default function HomePage(){
 const [params]=useSearchParams();
 if(params.has("native_library")) return <Navigate replace to={`/media/${encodeURIComponent(params.get("native_library")!)}?${params}`}/>;
 if(params.has("lib")) return <DashboardPage/>;
 return <LibraryHome/>;
}
