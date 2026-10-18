import {youtubeRoute,youtubePath} from "../features/youtube/catalog";
import {useParams} from "../lib/libraryNavigation";
import {useEffect, useContext, useMemo} from "react";
import {useNavigate, LibraryNavigationContext} from "../lib/libraryNavigation";
import {libraryPath, itemPath, resolveNamed, resolveNumbered} from "../lib/mediaPaths";
import {catalogQueryOptions, catalogView} from "../lib/nativeCatalogQueries";
import {createSearchParams, type SetURLSearchParams} from "react-router-dom";
import {useQuery} from "@tanstack/react-query";
import {useSearchParams} from "../lib/libraryNavigation";
import {nativeLibraries} from "../api/nativeLibraries";
import YouTubeLibraryBrowser from "../features/youtube/YouTubeLibraryBrowser";
import NativeLibraryBrowser from "../components/NativeLibraryBrowser";

export default function DashboardPage() {
 const routeParams=useParams();
 const {libraryId,itemSlug,seasonSlug,episodeSlug}=routeParams;
 const preview=useContext(LibraryNavigationContext);
 const navigate=useNavigate();
 const [params]=useSearchParams();
 const libraries=useQuery({queryKey:["native-libraries"],queryFn:nativeLibraries.list});
 const library=resolveNamed(libraryId??params.get("native_library")??undefined,libraries.data??[])
   ?? (!libraryId ? libraries.data?.find(l=>l.id===localStorage.getItem("posterview.manualLibraryTab")) ?? libraries.data?.[0] : undefined);

 const catalog=useQuery({...catalogQueryOptions(library??{id:"",library_type:"movies"}),enabled:!!library&&!preview});
 const view=useMemo(()=>catalogView(catalog.data),[catalog.data]);
 const entries=view.entries;
 const series=seasonSlug ? resolveNamed(itemSlug,entries.filter(entry=>entry.kind==="series")) : undefined;
 const season=series ? resolveNumbered(seasonSlug,entries.filter(entry=>entry.kind==="season"&&entry.parent_path===series.path)) : undefined;
 const routeItem=episodeSlug ? (season ? resolveNumbered(episodeSlug,entries.filter(entry=>entry.kind==="episode"&&entry.parent_path===season.path)) : undefined) : seasonSlug ? season : resolveNamed(itemSlug,entries);
 const youtube=library?.library_type==="youtube";
 const youtubeResolved=youtubeRoute(entries,itemSlug,seasonSlug,episodeSlug);
 const effective=new URLSearchParams(params);
 if(library&&!preview) effective.set("native_library",library.id);
 if(library?.library_type==="youtube"){
  if(itemSlug&&youtubeResolved.channel){
   for(const key of ["youtube_channel","youtube_playlist","youtube_video"])effective.delete(key);
   effective.set("youtube_channel",youtubeResolved.channel.id);
   if(youtubeResolved.playlist)effective.set("youtube_playlist",youtubeResolved.playlist.id);
   if(youtubeResolved.video)effective.set("youtube_video",youtubeResolved.video.id);
  }
  const video=params.get("native_item")??(!youtubeResolved.channel?routeItem?.id:undefined);
  if(video)effective.set("youtube_video",video);
  effective.delete("native_item");
 }
 if(itemSlug&&!preview&&library?.library_type!=="youtube"){effective.delete("native_item");if(routeItem)effective.set("native_item",routeItem.id);}
 const setReadable:SetURLSearchParams=(update,options)=>{
  const next=createSearchParams(typeof update==="function"?update(new URLSearchParams(effective)):update);
  const item=entries.find(entry=>entry.id===(view.aliases.get(next.get("native_item")??"")??next.get("native_item")));
  if(!library)return;
  if(next.get("from")==="home"&&!next.has("native_item")) {navigate("/");return;}
  next.delete("native_library");next.delete("native_item");next.delete("lib");
  const path=library.library_type==="youtube"?youtubePath(libraryPath(library,libraries.data??[]),entries,next.get("youtube_channel"),next.get("youtube_playlist"),next.get("youtube_video")):item?itemPath(library,libraries.data??[],item,entries):libraryPath(library,libraries.data??[]);
  if(youtube)for(const key of ["youtube_channel","youtube_playlist","youtube_video"])next.delete(key);
  navigate(`${path}${next.size?`?${next}`:""}`,options);
 };
 useEffect(()=>{
  if(preview||!library||catalog.isPending||catalog.isError)return;
  if(youtube){if(youtubeResolved.valid||routeItem)setReadable(effective,{replace:true});return;}
  if(itemSlug&&!routeItem)return;
  if(!itemSlug||(routeItem&&itemPath(library,libraries.data??[],routeItem,entries)!==`/media/${encodeURIComponent(libraryId??"")}/${encodeURIComponent(itemSlug??"")}${seasonSlug?`/${encodeURIComponent(seasonSlug)}`:""}${episodeSlug?`/${encodeURIComponent(episodeSlug)}`:""}`)||params.has("native_library")||params.has("native_item"))setReadable(effective,{replace:true});
 },[library?.id,catalog.data,itemSlug,seasonSlug,episodeSlug,params.toString(),preview]);
 const navigation=preview??{navigate,params:routeParams,searchParams:effective,setSearchParams:setReadable};
 if(libraryId&&!library&&!libraries.isPending)return <p className="p-5 text-muted">Library not found.</p>;
 if(catalog.isError&&!catalog.data&&!preview)return <p role="alert" className="p-5 text-danger">{catalog.error.message}</p>;
 if(itemSlug&&!(youtube?youtubeResolved.valid||routeItem:routeItem)&&!catalog.isPending&&!preview)return <p className="p-5 text-muted">This title could not be found in {library?.name}.</p>;
 return <LibraryNavigationContext.Provider value={navigation}><div className="flex h-full min-h-0 flex-col">

  <div className="min-h-0 flex-1">{library?(library.library_type==="youtube"?<YouTubeLibraryBrowser key={library.id} library={library}/>:<NativeLibraryBrowser key={library.id} library={library}/>):<div className="space-y-3 p-5 text-muted">{libraries.isPending?"Loading libraries…":libraries.error?libraries.error.message:<><p>Add a library in Settings → Libraries.</p></>}</div>}</div>
 </div></LibraryNavigationContext.Provider>;
}
