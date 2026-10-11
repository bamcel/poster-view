import {useParams} from "../lib/libraryNavigation";
import {useEffect, useContext, useMemo} from "react";
import {useNavigate, LibraryNavigationContext} from "../lib/libraryNavigation";
import {libraryPath, itemPath, resolveNamed} from "../lib/mediaPaths";
import {nativeCatalogView} from "../lib/nativeCatalogView";
import {createSearchParams, type SetURLSearchParams} from "react-router-dom";
import {useQuery} from "@tanstack/react-query";
import {useSearchParams} from "../lib/libraryNavigation";
import {nativeLibraries} from "../api/nativeLibraries";
import NativeLibraryBrowser from "../components/NativeLibraryBrowser";

export default function DashboardPage() {
 const routeParams=useParams();
 const {libraryId,itemSlug}=routeParams;
 const preview=useContext(LibraryNavigationContext);
 const navigate=useNavigate();
 const [params]=useSearchParams();
 const libraries=useQuery({queryKey:["native-libraries"],queryFn:nativeLibraries.list});
 const library=resolveNamed(libraryId??params.get("native_library")??undefined,libraries.data??[])
   ?? libraries.data?.find(l=>params.has("lib")&&l.options?.server_sync?.library_id===params.get("lib"))
   ?? (!libraryId ? libraries.data?.find(l=>l.id===localStorage.getItem("posterview.manualLibraryTab")) ?? libraries.data?.[0] : undefined);

 const catalog=useQuery({queryKey:["native-catalog",library?.id],queryFn:()=>nativeLibraries.catalog(library!.id),enabled:!!library&&!preview});
 const view=useMemo(()=>nativeCatalogView(catalog.data??[]),[catalog.data]);
 const entries=view.entries;
 const routeItem=resolveNamed(itemSlug,entries);
 const effective=new URLSearchParams(params);
 if(library&&!preview) effective.set("native_library",library.id);
 if(itemSlug&&!preview){effective.delete("native_item");if(routeItem)effective.set("native_item",routeItem.id);}
 const setReadable:SetURLSearchParams=(update,options)=>{
  const next=createSearchParams(typeof update==="function"?update(new URLSearchParams(effective)):update);
  const item=entries.find(entry=>entry.id===(view.aliases.get(next.get("native_item")??"")??next.get("native_item")));
  if(!library)return;
  next.delete("native_library");next.delete("native_item");next.delete("lib");
  const path=item?itemPath(library,libraries.data??[],item,entries):libraryPath(library,libraries.data??[]);
  navigate(`${path}${next.size?`?${next}`:""}`,options);
 };
 useEffect(()=>{
  if(preview||!library||catalog.isPending||catalog.isError)return;
  if(itemSlug&&!routeItem)return;
  if(!itemSlug||params.has("native_library")||params.has("native_item"))setReadable(effective,{replace:true});
 },[library?.id,catalog.data,itemSlug,params.toString(),preview]);
 const navigation=preview??{navigate,params:routeParams,searchParams:effective,setSearchParams:setReadable};
 if(libraryId&&!library&&!libraries.isPending)return <p className="p-5 text-muted">Library not found.</p>;
 if(catalog.isError&&!preview)return <p role="alert" className="p-5 text-danger">{catalog.error.message}</p>;
 if(itemSlug&&!routeItem&&!catalog.isPending&&!preview)return <p className="p-5 text-muted">This title could not be found in {library?.name}.</p>;
 return <LibraryNavigationContext.Provider value={navigation}><div className="flex h-full min-h-0 flex-col">
  {!effective.has("native_item")&&<header aria-label="Library header" className="relative z-20 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 bg-transparent px-4 pt-0 sm:px-6 md:flex-nowrap md:pt-4 lg:px-8">
   <h1 className="py-3 text-xl font-semibold">{library?.name ?? "Media"}</h1>

  </header>}
  <div className="min-h-0 flex-1">{library?<NativeLibraryBrowser key={library.id} library={library}/>:<div className="space-y-3 p-5 text-muted">{libraries.isPending?"Loading libraries…":libraries.error?libraries.error.message:<><p>Add a library or import a connected server library in Settings → Libraries.</p><p>ServerConnect integrations exchange metadata and artwork with your PosterView libraries.</p></>}</div>}</div>
 </div></LibraryNavigationContext.Provider>;
}
