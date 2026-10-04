import {useEffect} from "react";
import {useQuery} from "@tanstack/react-query";
import {useSearchParams} from "../lib/libraryNavigation";
import {nativeLibraries} from "../api/nativeLibraries";
import NativeLibraryBrowser from "../components/NativeLibraryBrowser";
import NativeScanProgress from "../components/NativeScanProgress";

export default function DashboardPage() {
 const [params,setParams]=useSearchParams();
 const libraries=useQuery({queryKey:["native-libraries"],queryFn:nativeLibraries.list});
 const library=libraries.data?.find(l=>l.id===params.get("native_library"))
   ?? libraries.data?.find(l=>params.has("lib")&&l.options?.server_sync?.library_id===params.get("lib"))
   ?? libraries.data?.find(l=>l.id===localStorage.getItem("posterview.manualLibraryTab"))
   ?? libraries.data?.[0];
 const scan=useQuery({queryKey:["native-scan",library?.id],queryFn:()=>nativeLibraries.status(library!.id),enabled:!!library,refetchInterval:q=>q.state.data?.status==="scanning"?2000:false});
 useEffect(()=>{if(!library||params.get("native_library")===library.id&&!params.has("lib"))return;setParams(previous=>{const next=new URLSearchParams(previous);next.set("native_library",library.id);next.delete("lib");next.delete("folder");next.delete("folder_title");return next;});},[library?.id,params,setParams]);
 const select=(id:string)=>{localStorage.setItem("posterview.manualLibraryTab",id);setParams(previous=>{const next=new URLSearchParams(previous);next.set("native_library",id);next.delete("native_item");next.delete("lib");next.delete("folder");next.delete("folder_title");return next;});};
 return <div className="flex h-full min-h-0 flex-col">
  {!params.has("native_item")&&<header aria-label="Library header" className="relative z-20 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-transparent px-4 pt-0 sm:px-6 md:flex-nowrap md:pt-[75px] lg:px-8">
   <div role="group" aria-label="Libraries" className="flex min-w-0 flex-1 basis-full gap-1 overflow-x-auto md:basis-auto">{libraries.data?.map(l=><button key={l.id} title={l.name} aria-pressed={library?.id===l.id} onClick={()=>select(l.id)} className={`min-h-11 max-w-64 shrink-0 truncate border-b-2 px-4 py-2 text-sm font-medium ${library?.id===l.id?"border-accent text-white":"border-transparent text-muted hover:text-white"}`}>{l.name}</button>)}</div>
   {scan.data?.status==="scanning"&&<aside aria-label="Library scan progress" className="ml-auto w-full min-w-0 pb-2 md:w-80 md:shrink-0 md:py-2"><NativeScanProgress status={scan.data} compact/></aside>}
  </header>}
  <div className="min-h-0 flex-1">{library?<NativeLibraryBrowser key={library.id} library={library}/>:<div className="space-y-3 p-5 text-muted">{libraries.isPending?"Loading libraries…":libraries.error?libraries.error.message:<><p>Add a library or import a connected server library in Settings → Libraries.</p><p>ServerConnect integrations exchange metadata and artwork with your PosterView libraries.</p></>}</div>}</div>
 </div>;
}
