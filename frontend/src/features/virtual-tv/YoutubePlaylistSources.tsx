import {useEffect, useMemo, useRef, useState} from "react";
import {useQueries} from "@tanstack/react-query";
import {nativeLibraries, type NativeLibrary} from "../../api/nativeLibraries";
import {channelsFromCatalog, playlistVideos} from "../youtube/catalog";
import type {YoutubePlaylistSelection} from "./client";

interface Props {
 libraries:NativeLibrary[];
 selections:YoutubePlaylistSelection[];
 onChange:(selections:YoutubePlaylistSelection[])=>void;
 onLoadingChange?:(loading:boolean)=>void;
 legacyShowIds?:string[];
}
const channelKey=(library:string,channel:string)=>JSON.stringify([library,channel]);
const selectionKey=(value:YoutubePlaylistSelection)=>JSON.stringify([value.library_id,value.channel_id,value.playlist_id]);

export default function YoutubePlaylistSources({libraries,selections,onChange,onLoadingChange,legacyShowIds}:Props){
 const queries=useQueries({queries:libraries.map(library=>({queryKey:["native-catalog",library.id],queryFn:()=>nativeLibraries.catalog(library.id),staleTime:5*60_000,gcTime:30*60_000}))});
 const loading=queries.some(query=>query.isPending||query.isFetching);
 useEffect(()=>{onLoadingChange?.(loading);return()=>onLoadingChange?.(false);},[loading,onLoadingChange]);
 const [openChannels,setOpenChannels]=useState<Set<string>>(()=>new Set(selections.map(value=>channelKey(value.library_id,value.channel_id))));
 const groups=libraries.map((library,index)=>({library,channels:channelsFromCatalog(queries[index].data??[]).map(channel=>({...channel,playlists:channel.playlists.filter(playlist=>playlist.id!=="all"&&playlistVideos(channel,playlist.id).length>0)}))}));
 const legacyInitialized=useRef(false);
 useEffect(()=>{
  if(legacyShowIds===undefined||legacyInitialized.current||loading||queries.some(query=>query.isError))return;
  legacyInitialized.current=true;
  const initial=groups.flatMap(({library,channels})=>channels.filter(channel=>legacyShowIds.length===0||legacyShowIds.includes(channel.entry?.id??"")).flatMap(channel=>channel.playlists.map(playlist=>({library_id:library.id,channel_id:channel.id,playlist_id:playlist.id}))));
  setOpenChannels(new Set(initial.map(value=>channelKey(value.library_id,value.channel_id))));
  onChange(initial);
 });
 const selected=useMemo(()=>new Set(selections.map(selectionKey)),[selections]);
 const checked=(library:string,channel:string,playlist:string)=>selected.has(selectionKey({library_id:library,channel_id:channel,playlist_id:playlist}));
 const replace=(library:string,channel:string,ids:string[],enabled:boolean)=>{
  const retained=selections.filter(value=>!(value.library_id===library&&value.channel_id===channel&&ids.includes(value.playlist_id)));
  onChange(enabled?[...retained,...ids.map(playlist_id=>({library_id:library,channel_id:channel,playlist_id}))]:retained);
 };
 const toggleChannels=(library:string,channels:typeof groups[number]["channels"],enabled:boolean)=>{
  setOpenChannels(previous=>{const next=new Set(previous);for(const channel of channels){const key=channelKey(library,channel.id);if(enabled)next.add(key);else next.delete(key);}return next;});
  const ids=new Set(channels.map(channel=>channel.id));
  const retained=selections.filter(value=>!(value.library_id===library&&ids.has(value.channel_id)));
  onChange(enabled?[...retained,...channels.flatMap(channel=>channel.playlists.map(playlist=>({library_id:library,channel_id:channel.id,playlist_id:playlist.id})))]:retained);
 };
 const isOpen=(library:string,channel:typeof groups[number]["channels"][number])=>openChannels.has(channelKey(library,channel.id))||selections.some(value=>value.library_id===library&&value.channel_id===channel.id);
 return <div>{groups.map(({library,channels},index)=>{
  const multi=library.options?.youtube_mode==="multiple_channels";
  const displayed=multi?channels.filter(channel=>isOpen(library.id,channel)):channels;
  return <section className="space-y-2" key={library.id} aria-label={`${library.name} YouTube sources`}>
   <h4 className="mb-2 font-medium">{library.name}</h4>
   {queries[index].isPending?<p>Loading YouTube playlists…</p>:queries[index].isError?<p role="alert">Could not load playlists for {library.name}.</p>:<div className={`grid grid-cols-1 gap-4 ${multi?"sm:grid-cols-2":""}`}>
    {multi&&<div><h5 className="mb-2 font-medium">Channels</h5><label className="mb-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={channels.length>0&&channels.every(channel=>isOpen(library.id,channel))} onChange={event=>toggleChannels(library.id,channels,event.target.checked)}/> Select all channels</label>
     <div className="max-h-60 space-y-2 overflow-y-auto rounded border border-border bg-input p-3">{channels.map(channel=><label key={channel.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={isOpen(library.id,channel)} onChange={event=>toggleChannels(library.id,[channel],event.target.checked)}/> {channel.title} ({channel.playlists.length} playlists)</label>)}</div>
    </div>}
    <div><h5 className="mb-2 font-medium">Playlists</h5>{displayed.length===0&&<p>{multi?"Select a channel to see its playlists.":"No downloaded playlists found."}</p>}
     <div className="max-h-60 space-y-2 overflow-y-auto rounded border border-border bg-input p-3">{displayed.map(channel=><div className="space-y-1" key={channel.id}>
      {multi&&<strong className="mb-2 block text-sm font-medium">{channel.title}</strong>}
      {channel.playlists.length===0?<p>No downloaded playlists found.</p>:<><label className="flex items-center gap-2 text-sm"><input type="checkbox" aria-label={`Select all playlists for ${channel.title}`} checked={channel.playlists.every(playlist=>checked(library.id,channel.id,playlist.id))} onChange={event=>replace(library.id,channel.id,channel.playlists.map(playlist=>playlist.id),event.target.checked)}/> Select all playlists</label>
      {channel.playlists.map(playlist=><label key={playlist.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={checked(library.id,channel.id,playlist.id)} onChange={event=>replace(library.id,channel.id,[playlist.id],event.target.checked)}/> {playlist.title} ({playlistVideos(channel,playlist.id).length} videos)</label>)}</>}
     </div>)}</div>
    </div>
   </div>}
  </section>;
 })}</div>;
}


