import PopupPage from "../../components/PopupPage";
import {useState,type ReactNode} from "react";
import {createPortal} from "react-dom";
import {useMutation,useQueryClient} from "@tanstack/react-query";
import {Images,Pencil,RefreshCw} from "lucide-react";
import {nativeLibraries,type NativeCatalogEntry,type NativeLibrary} from "../../api/nativeLibraries";
import {EntryEditor} from "../../components/NativeCatalogPanel";
import ArtworkPanel from "../artwork/ArtworkPanel";
import {useIsAdmin} from "../../lib/authContext";
import {ytdl} from "../settings/ytdl/client";
import {youtubeMetadata} from "./catalog";

export default function YouTubeChannelActions({library,entry,entries,onUpdated}:{library:NativeLibrary;entry:NativeCatalogEntry;entries:NativeCatalogEntry[];onUpdated:()=>void}){
 const admin=useIsAdmin(),client=useQueryClient();
 const [editor,setEditor]=useState<"metadata"|"artwork"|null>(null);
 const [notice,setNotice]=useState("");
 const refresh=useMutation({mutationFn:async()=>{
  const id=youtubeMetadata(entry).channel_id;
  if(!id||!/^UC[\w-]{22}$/.test(id))throw new Error("This channel has no valid YouTube channel ID. Scan its local metadata first.");
  const directory=entry.path.slice(0,entry.path.lastIndexOf("/"));
  if(!entry.path.includes("/")||!directory)throw new Error("Channel metadata refresh requires a channel folder beneath a YouTube library folder.");
  const config=await ytdl.configuration();
  if(!config.settings.enabled)throw new Error("Enable the YTDL plugin before refreshing channel metadata.");
  return ytdl.submit(`https://www.youtube.com/channel/${id}`,[],{...config.settings,library_id:library.id,directory},true);
 },onSuccess:()=>{setNotice("Channel metadata refresh queued. Follow its progress in Status, then scan the library to load the updated metadata.");void client.invalidateQueries({queryKey:["ytdl-jobs"]});},onError:()=>setNotice("")});
 if(!admin)return null;
 const image=(kind:string)=>entry.artwork.some(a=>a.kind===kind)?nativeLibraries.artworkUrl(library.id,entry.id,kind):undefined;
 return <>
  <button aria-label="Edit Metadata" title="Edit Metadata" onClick={()=>setEditor("metadata")} className="episode-inline-action"><Pencil className="size-4"/></button>
  {<button aria-label="Edit Images" title="Edit Images" onClick={()=>setEditor("artwork")} className="episode-inline-action"><Images className="size-4"/></button>}
  <button aria-label="Refresh" title="Refresh" disabled={refresh.isPending} onClick={()=>{setNotice("");refresh.mutate();}} className="episode-inline-action"><RefreshCw className={`size-4 ${refresh.isPending?"animate-spin":""}`}/></button>
  {refresh.error&&<span role="alert" className="basis-full text-sm text-danger">{refresh.error.message}</span>}
  {notice&&<span role="status" className="basis-full text-sm text-muted">{notice}</span>}
  {editor==="metadata"&&<ChannelEditorDialog onClose={()=>setEditor(null)}><EntryEditor library={library} entry={entry} busy={false} dialog onSaved={()=>{setEditor(null);onUpdated();}}/></ChannelEditorDialog>}
  {editor==="artwork"&&createPortal(<div className="pointer-events-none fixed inset-0 z-50 bg-transparent"><section aria-label={`Artwork for ${entry.title}`} className="pointer-events-auto ml-auto h-full w-full max-w-md shadow-2xl"><ArtworkPanel manualOnly serverId={0} libraryTitle={library.name} libraryType="show" item={{id:`native:${library.id}:${entry.id}`,title:entry.title,type:"show",external_ids:{},members:[],poster:image("poster"),background:image("backdrop"),seasons:entries.filter(e=>e.kind==="season"&&e.parent_path===entry.path).map(e=>({id:`native:${library.id}:${e.id}`,title:e.title}))}} onClose={()=>{setEditor(null);onUpdated();}}/></section></div>,document.body)}
 </>;
}

function ChannelEditorDialog({children,onClose}:{children:ReactNode;onClose:()=>void}){
 return <PopupPage title="Edit Metadata" closeLabel="Close editor" onClose={onClose} bodyClassName="overflow-hidden p-0">{children}</PopupPage>;
}
