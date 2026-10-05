import {useParams} from "../lib/libraryNavigation";
import {useEffect} from "react";
import {useQuery} from "@tanstack/react-query";
import {useSearchParams} from "../lib/libraryNavigation";
import {nativeLibraries} from "../api/nativeLibraries";
import NativeLibraryBrowser from "../components/NativeLibraryBrowser";

export default function DashboardPage() {
 const {libraryId}=useParams();
 const [params,setParams]=useSearchParams();
 const libraries=useQuery({queryKey:["native-libraries"],queryFn:nativeLibraries.list});
 const library=libraries.data?.find(l=>l.id===(libraryId??params.get("native_library")))
   ?? libraries.data?.find(l=>params.has("lib")&&l.options?.server_sync?.library_id===params.get("lib"))
   ?? libraries.data?.find(l=>l.id===localStorage.getItem("posterview.manualLibraryTab"))
   ?? libraries.data?.[0];

 useEffect(()=>{if(!library||params.get("native_library")===library.id&&!params.has("lib"))return;setParams(previous=>{const next=new URLSearchParams(previous);next.set("native_library",library.id);next.delete("lib");next.delete("folder");next.delete("folder_title");return next;});},[library?.id,params,setParams]);
 return <div className="flex h-full min-h-0 flex-col">
  {!params.has("native_item")&&<header aria-label="Library header" className="relative z-20 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 bg-transparent px-4 pt-0 sm:px-6 md:flex-nowrap md:pt-4 lg:px-8">
   <h1 className="py-3 text-xl font-semibold">{library?.name ?? "Media"}</h1>

  </header>}
  <div className="min-h-0 flex-1">{library?<NativeLibraryBrowser key={library.id} library={library}/>:<div className="space-y-3 p-5 text-muted">{libraries.isPending?"Loading libraries…":libraries.error?libraries.error.message:<><p>Add a library or import a connected server library in Settings → Libraries.</p><p>ServerConnect integrations exchange metadata and artwork with your PosterView libraries.</p></>}</div>}</div>
 </div>;
}
