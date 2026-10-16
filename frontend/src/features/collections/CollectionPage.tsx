import ScrollingTitle from "../../components/ScrollingTitle";
import {useEffect,useState} from "react";
import {useParams,useNavigate,Link} from "react-router-dom";
import {useQuery,useQueryClient} from "@tanstack/react-query";
import {nativeLibraries,type NativeCatalogEntry} from "../../api/nativeLibraries";
import {useIsAdmin} from "../../lib/authContext";
import {nativeArtworkVersion} from "../../lib/nativeArtworkCache";
import {Layers,Pencil,Trash2,MoreHorizontal} from "lucide-react";
import LibraryDetailLayout,{LibraryDetailHero,LibraryDetailSection} from "../../components/LibraryDetailLayout";
import DetailSynopsis from "../../components/DetailSynopsis";
import AnimatedArtwork from "../../components/AnimatedArtwork";
import {posterGrid} from "../../components/LibraryViewPreferences";
import {detailActionClass} from "../../lib/detailActions";
import {LibraryBackdrop} from "../../lib/libraryNavigation";
import {DASHBOARD_BACKDROP_EVENT,BACKDROP_OVERLAY_EVENT,dashboardBackdropEnabled,backdropOverlay,backdropOverlayGradients} from "../../lib/dashboardSettings";
import {collectionsApi,useCollectionAccount,memberKey,type Collection,type CollectionMember} from "./client";
import CollectionMetadataDialog from "./CollectionMetadataDialog";
import {useCollectionDialog} from "./useCollectionDialog";
import {orderedMembers,uniqueMembers} from "./grouping";

const button="rounded-full border border-border bg-elevated/30 px-3 py-2 text-sm hover:bg-elevated disabled:opacity-50";
const field="mt-1 w-full rounded border border-border bg-input p-2";
export default function CollectionPage(){
 const {id}=useParams(),account=useCollectionAccount(),admin=useIsAdmin(),client=useQueryClient(),navigate=useNavigate();
 const query=useQuery({queryKey:["collections",account,"detail",id],queryFn:()=>collectionsApi.get(id!),enabled:!!id});
 const [editing,setEditing]=useState(false),[error,setError]=useState("");
 const [metadataMenu,setMetadataMenu]=useState(false),[metadataMode,setMetadataMode]=useState<"identify"|"refresh"|"locks"|null>(null);
 const remove=async()=>{if(!query.data||!window.confirm(`Delete ${query.data.title}? Media files will remain.`))return;try{await collectionsApi.remove(query.data.id);await client.invalidateQueries({queryKey:["collections"]});navigate("/collections");}catch(error){setError(String(error));}};
 if(query.isPending)return <p role="status" className="p-8">Loading collection…</p>;
 if(query.error||!query.data)return <p role="alert" className="p-8">{String(query.error??"Collection unavailable")}</p>;
 const collection=query.data;
 const movies=collection.members.filter(member=>member.entry.kind==="movie");
 const series=collection.members.filter(member=>member.entry.kind==="series");
 return <>
  <CollectionBackground collection={collection}/>
  <LibraryDetailLayout
   back={()=>navigate("/collections")}
   hero={<LibraryDetailHero
    artwork={<CollectionPortrait collection={collection}/>}
    synopsis={<DetailSynopsis text={collection.overview} lines={8}/>}
   >
    <div className="flex flex-wrap items-center gap-3">
     <h1 className="text-3xl font-bold leading-tight sm:text-4xl">{collection.title}</h1>
     {admin&&<button aria-label="Edit collection" title="Edit collection" className="episode-inline-action" onClick={()=>setEditing(true)}><Pencil className="size-4"/></button>}
    </div>
    <div aria-label="Title information" className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
     <span>{collection.members.length} titles</span>
     {movies.length>0&&<span>{movies.length} {movies.length===1?"movie":"movies"}</span>}
     {series.length>0&&<span>{series.length} series</span>}
     <span>{collection.ordering==="release"?"Release order":collection.ordering==="title"?"Title order":"Custom order"}</span>
     {collection.metadata?.provider_id&&<a className="text-xs text-muted underline" href={collection.metadata.provider==="tmdb"?`https://www.themoviedb.org/collection/${encodeURIComponent(collection.metadata.provider_id)}`:"https://thetvdb.com"} target="_blank" rel="noreferrer">Metadata from {collection.metadata.provider==="tmdb"?"TMDB":"TheTVDB"}</a>}
    </div>
    {admin&&<div className="mt-5 flex flex-wrap items-center gap-3"><div className="relative"><button aria-label="Collection metadata actions" aria-expanded={metadataMenu} aria-haspopup="menu" className={detailActionClass} onClick={()=>setMetadataMenu(value=>!value)}><MoreHorizontal className="size-4"/></button>{metadataMenu&&<div role="menu" aria-label="Collection metadata" className="absolute left-0 top-full z-20 mt-2 min-w-48 rounded-xl border border-border bg-sidebar p-2 shadow-xl" onKeyDown={event=>{if(event.key==="Escape")setMetadataMenu(false);}}>{([{mode:"identify",label:"Identify"},{mode:"refresh",label:"Refresh metadata"},{mode:"locks",label:"Field locks"}] as const).map(action=><button role="menuitem" key={action.mode} className="block w-full rounded p-2 text-left text-sm hover:bg-elevated" onClick={()=>{setMetadataMenu(false);setMetadataMode(action.mode);}}>{action.label}</button>)}</div>}</div><button aria-label="Delete collection" title="Delete collection" className={detailActionClass} onClick={()=>void remove()}><Trash2 className="size-4"/></button></div>}
    {error&&<p role="alert" className="mt-3">{error}</p>}
   </LibraryDetailHero>}
   related={<>
    {[{name:"Movies",members:movies},{name:"Series",members:series}].filter(group=>group.members.length>0).map(group=><LibraryDetailSection key={group.name} label={group.name}>
     <h2>{group.name}</h2>
     <div className={posterGrid}>{group.members.map(member=><MemberCard key={memberKey(member)} member={member}/>)}</div>
    </LibraryDetailSection>)}
    {!collection.members.length&&<p className="mt-10 text-muted">No accessible titles in this collection.{admin&&" Edit this collection to add titles."}</p>}
   </>}
  />
  {admin&&metadataMode&&<CollectionMetadataDialog key={`${collection.id}:${collection.revision}:${metadataMode}`} collection={collection} mode={metadataMode} onClose={()=>setMetadataMode(null)}/>}
  {editing&&<CollectionEditor key={`${collection.id}:${collection.revision}`} collection={collection} onClose={()=>setEditing(false)}/>}
 </>;
}
function artworkUrl(member:CollectionMember,kinds:string[]){
 const kind=kinds.find(kind=>member.entry.artwork.some(art=>art.kind===kind));
 return kind?`${nativeLibraries.artworkUrl(member.library_id,member.item_id,kind)}?v=${encodeURIComponent(nativeArtworkVersion(member.entry,kind))}`:undefined;
}
function CollectionPortrait({collection}:{collection:Collection}){
 const members=collection.members.slice(0,4);
 const [failed,setFailed]=useState("");
 const poster=collection.metadata?.poster_url;
 if(poster&&failed!==poster)return <img src={poster} onError={()=>setFailed(poster)} alt={`${collection.title} collection artwork`} className="size-full object-cover"/>;
 return <div role="img" aria-label={`${collection.title} collection artwork`} className={`grid size-full ${members.length>1?"grid-cols-2 grid-rows-2":"grid-cols-1"}`}>
  {members.map(member=>{const src=artworkUrl(member,["poster","backdrop","landscape"]);return <div key={memberKey(member)} className="min-h-0 min-w-0 overflow-hidden bg-surface-2">{src?<img src={src} alt="" className="size-full object-cover"/>:<Layers aria-hidden="true" className="m-auto size-8 text-muted"/>}</div>;})}
  {(members.length===0||members.length===3)&&<div className="flex items-center justify-center bg-surface-2"><Layers aria-hidden="true" className="size-8 text-muted"/></div>}
 </div>;
}
function CollectionBackground({collection}:{collection:Collection}){
 const [enabled,setEnabled]=useState(dashboardBackdropEnabled),[overlay,setOverlay]=useState(backdropOverlay);
 useEffect(()=>{const update=()=>{setEnabled(dashboardBackdropEnabled());setOverlay(backdropOverlay());};window.addEventListener(DASHBOARD_BACKDROP_EVENT,update);window.addEventListener(BACKDROP_OVERLAY_EVENT,update);return()=>{window.removeEventListener(DASHBOARD_BACKDROP_EVENT,update);window.removeEventListener(BACKDROP_OVERLAY_EVENT,update);};},[]);
 const [failed,setFailed]=useState("");
 const providerBackdrop=collection.metadata?.backdrop_url;
 const src=(providerBackdrop&&failed!==providerBackdrop?providerBackdrop:undefined)??collection.members.map(member=>artworkUrl(member,["backdrop","landscape","fanart"])).find(Boolean);
 if(!enabled||!src)return null;
 const gradients=backdropOverlayGradients(overlay);
 return <LibraryBackdrop><div aria-hidden="true" className="pointer-events-none fixed inset-0 z-0 overflow-hidden bg-base">{src===providerBackdrop?<img src={src} alt="" onError={()=>setFailed(src)} className="h-full w-full object-cover object-top"/>:<AnimatedArtwork src={src} width={1920} fill alt="" className="h-full w-full origin-top scale-[1.02] object-cover object-top"/>}<div className="absolute inset-0 md:hidden" style={{backgroundImage:gradients.mobile}}/><div className="absolute inset-0 hidden md:block" style={{backgroundImage:gradients.desktop}}/></div></LibraryBackdrop>;
}

function MemberCard({member}:{member:CollectionMember}){const {entry}=member;const art=entry.artwork.find(art=>art.kind==="poster")??entry.artwork[0];return <Link to={`/media/${encodeURIComponent(member.library_id)}?native_library=${encodeURIComponent(member.library_id)}&native_item=${encodeURIComponent(member.item_id)}`} className="poster-title-card min-w-0"><div className="aspect-[2/3] overflow-hidden rounded-xl bg-elevated">{art&&<img alt="" loading="lazy" className="size-full object-cover" src={`${nativeLibraries.artworkUrl(member.library_id,member.item_id,art.kind)}?v=${encodeURIComponent(nativeArtworkVersion(entry,art.kind))}`}/>}</div><h3 className="mt-2 font-semibold"><ScrollingTitle title={entry.title}/></h3><p className="text-xs text-muted">{member.library_name} · {String(entry.metadata.year??"")}</p></Link>;}

function CollectionEditor({collection,onClose}:{collection:Collection;onClose:()=>void}){
 const client=useQueryClient(),account=useCollectionAccount();const [title,setTitle]=useState(collection.title),[overview,setOverview]=useState(collection.overview),[ordering,setOrdering]=useState(collection.ordering),[members,setMembers]=useState(orderedMembers(collection)),[search,setSearch]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false);
 const dialog=useCollectionDialog(onClose,busy);
 const libraries=useQuery({queryKey:["collections",account,"picker-libraries"],queryFn:nativeLibraries.list});
 const candidates=useQuery({queryKey:["collections",account,"picker-titles",libraries.data?.map(item=>item.id)],enabled:!!libraries.data,queryFn:async()=>{const groups=await Promise.all(libraries.data!.filter(library=>!["books","youtube"].includes(library.library_type)).map(async library=>({library,entries:await nativeLibraries.summaries(library.id)})));return groups.flatMap(({library,entries})=>entries.filter((entry:NativeCatalogEntry)=>entry.available&&entry.metadata.missing!==true&&["movie","series"].includes(entry.kind)).map(entry=>({library_id:library.id,library_name:library.name,item_id:entry.id,entry})));}});
 const move=(index:number,offset:number)=>{setOrdering("custom");setMembers(items=>{const next=[...items];[next[index],next[index+offset]]=[next[index+offset],next[index]];return next;});};
 const save=async()=>{setBusy(true);setError("");try{await collectionsApi.update(collection.id,{revision:collection.revision,title:title.trim(),overview,ordering,members:members.map(({library_id,item_id})=>({library_id,item_id}))});await client.invalidateQueries({queryKey:["collections"]});onClose();}catch(error){setError(String(error));}finally{setBusy(false);}};
 return <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4"><section ref={dialog} role="dialog" aria-modal="true" aria-label="Edit collection" className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-border bg-sidebar p-6"><h2 className="text-xl font-semibold">Edit collection</h2><label className="mt-4 block">Name<input disabled={busy} className={field} value={title} onChange={event=>setTitle(event.target.value)}/></label><label className="mt-3 block">Description<textarea disabled={busy} className={field} value={overview} onChange={event=>setOverview(event.target.value)}/></label><label className="mt-3 block">Order<select disabled={busy} className={field} value={ordering} onChange={event=>{const order=event.target.value as Collection["ordering"];setOrdering(order);setMembers(items=>orderedMembers({...collection,members:items,ordering:order}));}}><option value="release">Release date</option><option value="title">Title</option><option value="custom">Custom</option></select></label><ol className="my-4 space-y-2">{members.map((member,index)=><li key={memberKey(member)} className="flex flex-wrap items-center gap-2 rounded border border-border p-2"><span className="min-w-0 flex-1">{member.entry.title}<small className="ml-2 text-muted">{member.library_name}</small></span><button className={button} aria-label={`Move ${member.entry.title} up`} disabled={busy||index===0} onClick={()=>move(index,-1)}>↑</button><button className={button} aria-label={`Move ${member.entry.title} down`} disabled={busy||index===members.length-1} onClick={()=>move(index,1)}>↓</button><button className={button} disabled={busy} aria-label={`Remove ${member.entry.title}`} onClick={()=>setMembers(items=>items.filter(item=>memberKey(item)!==memberKey(member)))}>Remove</button></li>)}</ol><label className="block">Find titles to add<input disabled={busy} className={field} value={search} onChange={event=>setSearch(event.target.value)}/></label>{candidates.isPending&&<p role="status">Loading titles…</p>}{candidates.error&&<p role="alert">{String(candidates.error)}</p>}<div className="mt-2 max-h-48 overflow-y-auto">{search.trim()&&candidates.data?.filter(member=>member.entry.title.toLocaleLowerCase().includes(search.toLocaleLowerCase())&&!members.some(item=>memberKey(item)===memberKey(member))).slice(0,50).map(member=><button disabled={busy} key={memberKey(member)} className="block w-full rounded p-2 text-left hover:bg-elevated" onClick={()=>setMembers(items=>orderedMembers({...collection,ordering,members:uniqueMembers([...items,member])}))}>+ {member.entry.title} <small className="text-muted">{member.library_name}</small></button>)}</div>{error&&<p role="alert" className="mt-3 text-red-400">{error}</p>}<div className="mt-5 flex gap-3"><button className={button} disabled={busy||!title.trim()} onClick={()=>void save()}>{busy?"Saving…":"Save collection"}</button><button className={button} disabled={busy} onClick={onClose}>Cancel</button></div></section></div>;
}
