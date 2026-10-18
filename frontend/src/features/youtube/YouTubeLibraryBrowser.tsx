import LibraryDetailLayout,{LibraryDetailHero,LibraryDetailSection} from "../../components/LibraryDetailLayout";
import DetailSynopsis from "../../components/DetailSynopsis";
import {useEffect,useState} from "react";
import HeaderSearchControl from "../../components/HeaderSearchControl";
import SearchField from "../../components/SearchField";
import LibraryPopup from "../../components/LibraryPopup";
import DashboardBackdrop from "../../components/DashboardBackdrop";
import {dashboardBackdropEnabled,backdropOverlay,DASHBOARD_BACKDROP_EVENT,BACKDROP_OVERLAY_EVENT,translucentPanelColor,panelSolidity,panelOverlay,backdropBlur} from "../../lib/dashboardSettings";
import {LibraryPageBack} from "../../lib/libraryHeaderBack";
import ScrollingTitle from "../../components/ScrollingTitle";
import {sizedArtwork} from "../../lib/artworkSizes";
import LibraryViewPreferences, {useBackdropView, posterGrid, backdropGrid} from "../../components/LibraryViewPreferences";
import { useQuery } from '@tanstack/react-query';
import { nativeArtworkVersion } from '../../lib/nativeArtworkCache';
import { ArrowLeft, ExternalLink, ListFilter, MoreHorizontal } from 'lucide-react';
import { nativeLibraries, type NativeLibrary, type NativeCatalogEntry } from '../../api/nativeLibraries';
import { useSearchParams } from '../../lib/libraryNavigation';
import NativePlaybackActions from '../playback/components/NativePlaybackActions';
import { channelsFromCatalog, playlistVideos, youtubeMetadata } from './catalog';

export default function YouTubeLibraryBrowser({ library }: { library: NativeLibrary }) {
  const [params, setParams] = useSearchParams();
  const [search,setSearch]=useState("");
  const [sort,setSort]=useState("title");
  const [appearance,setAppearance]=useState(()=>({enabled:dashboardBackdropEnabled(),overlay:backdropOverlay()}));
  useEffect(()=>{const update=()=>setAppearance({enabled:dashboardBackdropEnabled(),overlay:backdropOverlay()});window.addEventListener(DASHBOARD_BACKDROP_EVENT,update);window.addEventListener(BACKDROP_OVERLAY_EVENT,update);return()=>{window.removeEventListener(DASHBOARD_BACKDROP_EVENT,update);window.removeEventListener(BACKDROP_OVERLAY_EVENT,update);};},[]);
  useEffect(()=>{setSearch("");setSort(params.get("youtube_playlist")?"newest":"title");},[params.get('youtube_channel'),params.get('youtube_playlist'),params.get('youtube_video')]);
  const {enabled:backdropView}=useBackdropView(library.id,true);
  const catalog = useQuery({ queryKey: ['native-catalog', library.id], queryFn: () => nativeLibraries.catalog(library.id), staleTime: 5 * 60_000, gcTime: 30 * 60_000 });
  const channels = channelsFromCatalog(catalog.data ?? []);
  const playlistId = params.get('youtube_playlist');
  const video = catalog.data?.find(e => e.id === params.get('youtube_video') && e.kind === 'episode' && e.available);
  const channelId=params.get('youtube_channel')??(video?youtubeMetadata(video).channel_id:undefined);
  const channel=channels.find(c=>c.id===channelId)??((playlistId||video)&&channels.length===1?channels[0]:undefined);
  const navigate = (channelId?: string, playlist?: string, item?: string) => { setSearch(""); const next = new URLSearchParams(params); for (const key of ['youtube_channel', 'youtube_playlist', 'youtube_video']) next.delete(key); if (channelId) next.set('youtube_channel', channelId); if (playlist) next.set('youtube_playlist', playlist); if (item) next.set('youtube_video', item); setParams(next); };
  const image = (entry?: NativeCatalogEntry, detail=false) => {
    const kinds=entry?.kind==='series'?(detail||backdropView?['backdrop','landscape']:['poster','thumb']):detail||backdropView?['backdrop','landscape','thumb','poster']:['poster','thumb','backdrop','landscape'];
    const kind=kinds.find(kind=>entry?.artwork.some(a=>a.kind===kind));
    return entry&&kind?sizedArtwork(`${nativeLibraries.artworkUrl(library.id,entry.id,kind)}?v=${encodeURIComponent(nativeArtworkVersion(entry,kind))}`,detail?1280:backdropView?640:480):undefined;
  };
  const thumbnail = (entry?: NativeCatalogEntry, detail=false) => {
    const src=image(entry,detail);
    const className=`w-full rounded-xl object-cover ${detail||backdropView?'aspect-video':'aspect-[2/3]'}`;
    return src?<img src={src} alt="" loading="lazy" decoding="async" className={className}/>:<div className={`${className} bg-white/10`}/>;
  };
  const back = () => video ? navigate(channel?.id, playlistId ?? 'all') : playlistId ? navigate(channel?.id) : navigate();
  if (catalog.isPending) return <p className="p-6 text-muted">Loading YouTube library…</p>;
  if (catalog.isError) return <p role="alert" className="p-6 text-danger">{catalog.error.message}</p>;
  const metadata = video ? youtubeMetadata(video) : undefined;
  const source = metadata?.source_url && /^https:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(metadata.source_url) ? metadata.source_url : undefined;
  const playlist = channel?.playlists.find(p => p.id === playlistId);
  const title=video?.title ?? (playlistId ? playlistId === 'all' ? 'All Videos' : playlist?.title ?? playlistId : channel?.title ?? library.name);
  const cards=!channel?channels.map(c=>({id:c.id,title:c.title,entry:c.entry,detail:`${c.videos.length} videos`,open:()=>navigate(c.id)})):!playlistId?[{id:'all',title:'All Videos'},...channel.playlists].map(p=>({id:p.id,title:p.title,entry:playlistVideos(channel,p.id)[0],detail:`${playlistVideos(channel,p.id).length} videos`,open:()=>navigate(channel.id,p.id)})):playlistVideos(channel,playlistId).map(v=>({id:v.id,title:v.title,entry:v,detail:String(v.metadata.aired??''),open:()=>navigate(channel.id,playlistId,v.id)}));
  const visible=cards.filter(card=>card.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).sort((a,b)=>channel&&!playlistId&&(a.id==='all'||b.id==='all')?(a.id==='all'?-1:1):sort==='title'?a.title.localeCompare(b.title,undefined,{numeric:true}):sort==='reverse'?b.title.localeCompare(a.title,undefined,{numeric:true}):(String(b.entry?youtubeMetadata(b.entry).published_at??b.entry.metadata.aired??'':'').localeCompare(String(a.entry?youtubeMetadata(a.entry).published_at??a.entry.metadata.aired??'':''))||a.title.localeCompare(b.title)));
  const style={backgroundColor:translucentPanelColor("--color-surface-2",panelSolidity(),panelOverlay()),backdropFilter:`blur(${backdropBlur()}px)`};
  const backgrounds=(channel?[channel]:channels).map(c=>image(c.entry,true)).filter((url):url is string=>!!url).slice(0,8);
  const toolbar=<div className="flex w-full min-w-0 items-center justify-center gap-2"><div className="relative min-w-0 w-full max-w-[21rem]"><SearchField aria-label="Search titles" value={search} onChange={event=>setSearch(event.target.value)}/></div>
        <LibraryPopup title="Filters and sorting" label="Filter and sort titles" icon={<ListFilter className="size-4"/>} style={style} editorStyle><label className="block text-sm font-semibold">Sort by<select aria-label="Sort titles" value={sort} onChange={event=>setSort(event.target.value)} className="mt-2 h-10 w-full rounded-lg border border-border bg-input px-3 text-sm text-white"><option value="title">Title A–Z</option><option value="reverse">Title Z–A</option><option value="newest">Newest date</option></select></label></LibraryPopup>
        <LibraryPopup title="Preferences" label="Library preferences" icon={<MoreHorizontal className="size-4"/>} style={style} editorStyle><LibraryViewPreferences library={library.id} defaultBackdrop/></LibraryPopup>
        </div>;
  if(channel&&!playlistId&&!video){
    const posterKind=['poster','thumb'].find(kind=>channel.entry?.artwork.some(art=>art.kind===kind));
    const poster=channel.entry&&posterKind?sizedArtwork(`${nativeLibraries.artworkUrl(library.id,channel.entry.id,posterKind)}?v=${encodeURIComponent(nativeArtworkVersion(channel.entry,posterKind))}`,640):undefined;
    return <section aria-label={`${channel.title} channel`} className="relative flex h-full min-h-0 flex-col overflow-hidden">
      {appearance.enabled&&backgrounds.length>0&&<DashboardBackdrop desktopUrls={backgrounds} mobileUrls={backgrounds} overlayStrength={appearance.overlay}/>}
      <LibraryDetailLayout back={back} toolbar={toolbar}
        hero={<LibraryDetailHero artwork={poster?<img src={poster} alt={`${channel.title} channel poster`} className="h-full w-full object-cover"/>:<div className="h-full w-full bg-white/10" aria-label="No channel poster"/>} synopsis={<DetailSynopsis text={channel.description} lines={8}/>}>
          <h1 className="text-3xl font-bold leading-tight sm:text-4xl">{channel.title}</h1>
          <p className="mt-4 text-sm text-muted">YouTube · {channel.videos.length} videos · {channel.playlists.length} playlists</p>
          <button className="mt-5 inline-flex items-center rounded-full border border-white/20 bg-white/10 px-5 py-2.5 text-sm font-semibold hover:bg-white/20" onClick={()=>navigate(channel.id,'all')}>All Videos</button>
        </LibraryDetailHero>}
        related={<LibraryDetailSection label="Channel playlists"><h2>Playlists</h2><p className="mb-4 text-xs text-faint">{visible.length} playlists</p>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-5 sm:grid-cols-[repeat(auto-fill,minmax(180px,1fr))]">
            {visible.map(card=><button key={card.id} className="poster-title-card min-w-0 text-left" onClick={card.open}>
              <div className="aspect-[2/3] overflow-hidden rounded-xl bg-white/10">{image(card.entry)&&<img src={image(card.entry)} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover"/>}</div>
              <h3 className="mt-2 text-sm font-semibold"><ScrollingTitle title={card.title}/></h3><p className="text-sm text-muted">{card.detail}</p>
            </button>)}
          </div>{cards.length>0&&!visible.length&&<p className="text-muted">No titles match your search.</p>}
        </LibraryDetailSection>}/>
    </section>;
  }
  return <section aria-label={`${library.name} library`} className="relative flex h-full min-h-0 flex-col overflow-hidden">
    {appearance.enabled&&backgrounds.length>0&&<DashboardBackdrop desktopUrls={backgrounds} mobileUrls={backgrounds} overlayStrength={appearance.overlay}/>}
    {(video || playlistId || channel) && <LibraryPageBack><button className="relative z-10 flex items-center gap-2 px-4 pt-3 text-muted hover:text-white sm:px-6 lg:px-8" onClick={back}><ArrowLeft size={18}/>Back</button></LibraryPageBack>}
    <div className="relative z-30 grid shrink-0 items-center gap-3 border-b border-border px-4 pb-3 pt-5 sm:grid-cols-[1fr_auto] sm:px-6 lg:grid-cols-[1fr_auto_1fr] lg:px-8">
      <h1 className="min-w-0 truncate text-xl font-semibold" title={title}>{title}</h1>
      {!video&&<div className="flex items-center justify-center gap-2">
        <HeaderSearchControl>{toolbar}</HeaderSearchControl>
      </div>}
      <div aria-hidden="true" className="hidden lg:block"/>
    </div>
    <div className="scrollbar-hidden relative z-10 min-h-0 flex-1 overflow-y-auto px-4 pb-8 sm:px-6 lg:px-8"><div className="pv-youtube-catalog">
    {!video&&<div className="mb-4 flex items-center justify-between text-xs text-faint"><span>{visible.length} {channel?(playlistId?'video':'playlist'):'channel'}{visible.length===1?'':'s'}</span></div>}
    {Boolean(video ? video.metadata.plot : playlistId ? playlist?.description : channel?.description)&&<p className="mb-6 whitespace-pre-wrap text-muted">{video ? String(video.metadata.plot ?? '') : playlistId ? playlist?.description : channel?.description}</p>}
    {video ? <div className="grid gap-6 md:grid-cols-2"><div>{thumbnail(video,true)}</div><div><p>{metadata?.channel}</p><p className="mt-2 text-muted">{String(video.metadata.aired ?? '')}{metadata?.duration_seconds ? ` · ${Math.ceil(metadata.duration_seconds / 60)} min` : ''}</p><NativePlaybackActions library={library.id} item={video.id}/>{source && <a href={source} target="_blank" rel="noreferrer" className="mt-5 inline-flex items-center gap-2 text-accent">View on YouTube<ExternalLink size={16}/></a>}<dl className="mt-5 text-sm text-muted">{video.files.map(file => <div key={file.path}><dt>File</dt><dd className="break-all">{file.path}</dd><dt>Codec</dt><dd>{file.media_info?.streams?.map(s => String(s.codec_name ?? '')).filter(Boolean).join(', ') || 'Unknown'}</dd></div>)}</dl></div></div> : <div className={backdropView?backdropGrid:posterGrid}>
      {visible.map(card=><button key={card.id} className="poster-title-card min-w-0 text-left" onClick={card.open}>{thumbnail(card.entry)}<h2 className="mt-2 text-sm font-semibold"><ScrollingTitle title={card.title}/></h2><p className="text-sm text-muted">{card.detail}</p></button>)}
    </div>}
    {!channels.length && <p className="text-muted">No downloaded videos yet. Administrators can add content in Settings → Plugins → YTDL.</p>}
    {!video&&cards.length>0&&!visible.length&&<p className="text-muted">No titles match your search.</p>}
  </div></div></section>;
}
