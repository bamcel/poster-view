import {useState} from "react";
import {Layers} from "lucide-react";
import {Link} from "../../lib/libraryNavigation";
import {nativeLibraries} from "../../api/nativeLibraries";
import {nativeArtworkVersion} from "../../lib/nativeArtworkCache";
import type {Collection} from "./client";

export function CollectionCard({collection,onOpen,backdropView=false}:{collection:Collection;onOpen?:()=>void;backdropView?:boolean}){
 const [failed,setFailed]=useState("");
 const art=backdropView?collection.metadata?.backdrop_url||collection.metadata?.poster_url:collection.metadata?.poster_url;
 const providerArt=art&&failed!==art;
 return <Link to={`/collections/${encodeURIComponent(collection.id)}`} onClick={onOpen} className="block min-w-0 rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"><div className={`grid ${backdropView?"aspect-[3/2]":"aspect-[2/3]"} ${providerArt?"":"grid-cols-2"} overflow-hidden rounded-xl border border-border bg-elevated`}>{providerArt?<img alt="" loading="lazy" src={art} onError={()=>setFailed(art)} className="size-full min-h-0 object-cover"/>:<>{collection.members.slice(0,4).map(member=>{const art=member.entry.artwork.find(art=>art.kind==="poster")??member.entry.artwork[0];return art?<img key={`${member.library_id}:${member.item_id}`} alt="" loading="lazy" className="size-full min-h-0 object-cover" src={`${nativeLibraries.artworkUrl(member.library_id,member.item_id,art.kind)}?v=${encodeURIComponent(nativeArtworkVersion(member.entry,art.kind))}`}/>:<div key={`${member.library_id}:${member.item_id}`} className="flex items-center justify-center p-2 text-center text-xs text-muted">{member.entry.title}</div>;})}{!collection.members.length&&<Layers className="m-auto size-10 text-muted"/>}</>}</div><h3 className="mt-2 truncate font-semibold">{collection.title}</h3><p className="flex items-center gap-1 text-xs text-muted"><Layers className="size-3"/>{collection.members.length} titles</p></Link>;
}
export default CollectionCard;
