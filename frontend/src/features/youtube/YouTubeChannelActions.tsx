import {useEffect,useRef,useState,type ReactNode} from "react";
import {createPortal} from "react-dom";
import {useMutation,useQueryClient} from "@tanstack/react-query";
import {Images,Pencil,RefreshCw,X} from "lucide-react";
import {nativeLibraries,type NativeCatalogEntry,type NativeLibrary} from "../../api/nativeLibraries";
import {EntryEditor} from "../../components/NativeCatalogPanel";
import ArtworkPanel from "../../components/ArtworkPanel";
import {useIsAdmin} from "../../lib/authContext";
import {useArtworkPlugin} from "../../lib/artworkPlugin";
import {ytdl} from "../settings/ytdl/client";
import {youtubeMetadata} from "./catalog";

export default function YouTubeChannelActions({library,entry,entries,onUpdated}:{library:NativeLibrary;entry:NativeCatalogEntry;entries:NativeCatalogEntry[];onUpdated:()=>void}){
 const admin=useIsAdmin(),plugin=useArtworkPlugin(),client=useQueryClient();
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
  {plugin.data?.enabled!==false&&<button aria-label="Edit Images" title="Edit Images" onClick={()=>setEditor("artwork")} className="episode-inline-action"><Images className="size-4"/></button>}
  <button aria-label="Refresh" title="Refresh" disabled={refresh.isPending} onClick={()=>{setNotice("");refresh.mutate();}} className="episode-inline-action"><RefreshCw className={`size-4 ${refresh.isPending?"animate-spin":""}`}/></button>
  {refresh.error&&<span role="alert" className="basis-full text-sm text-danger">{refresh.error.message}</span>}
  {notice&&<span role="status" className="basis-full text-sm text-muted">{notice}</span>}
  {editor==="metadata"&&<ChannelEditorDialog onClose={()=>setEditor(null)}><EntryEditor library={library} entry={entry} busy={false} dialog onSaved={()=>{setEditor(null);onUpdated();}}/></ChannelEditorDialog>}
  {editor==="artwork"&&plugin.data?.enabled!==false&&createPortal(<div className="pointer-events-none fixed inset-0 z-50 bg-transparent"><section aria-label={`Artwork for ${entry.title}`} className="pointer-events-auto ml-auto h-full w-full max-w-md shadow-2xl"><ArtworkPanel manualOnly serverId={0} libraryTitle={library.name} libraryType="show" item={{id:`native:${library.id}:${entry.id}`,title:entry.title,type:"show",external_ids:{},members:[],poster:image("poster"),background:image("backdrop"),seasons:entries.filter(e=>e.kind==="season"&&e.parent_path===entry.path).map(e=>({id:`native:${library.id}:${e.id}`,title:e.title}))}} onClose={()=>{setEditor(null);onUpdated();}}/></section></div>,document.body)}
 </>;
}

function ChannelEditorDialog({children,onClose}:{children:ReactNode;onClose:()=>void}){
 const ref=useRef<HTMLDialogElement>(null);
 useEffect(()=>{const dialog=ref.current;dialog?.showModal();return()=>dialog?.close();},[]);
 return createPortal(<dialog ref={ref} aria-label="Edit Metadata" onCancel={onClose} className="relative isolate m-auto h-[85dvh] max-h-[832px] w-[min(80rem,calc(100vw-2rem))] max-w-none overflow-hidden rounded-2xl border border-border bg-sidebar p-0 text-white backdrop:bg-black/70"><header className="flex h-16 items-center gap-4 px-6 sm:px-8"><h2 className="text-lg font-semibold">Edit Metadata</h2><button autoFocus aria-label="Close editor" className="ml-auto p-1 text-muted hover:text-white" onClick={onClose}><X className="size-4"/></button></header><div className="h-[calc(100%-4rem)] min-h-0">{children}</div></dialog>,document.body);
}

