import {LibraryPageBack} from "../../lib/libraryHeaderBack";
import ScrollingTitle from "../../components/ScrollingTitle";
import {sizedArtwork} from "../../lib/artworkSizes";
import LibraryViewPreferences, {useBackdropView, posterGrid, backdropGrid} from "../../components/LibraryViewPreferences";
import { useQuery } from '@tanstack/react-query';
import { nativeArtworkVersion } from '../../lib/nativeArtworkCache';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { nativeLibraries, type NativeLibrary, type NativeCatalogEntry } from '../../api/nativeLibraries';
import { useSearchParams } from '../../lib/libraryNavigation';
import NativePlaybackActions from '../playback/components/NativePlaybackActions';
import { channelsFromCatalog, playlistVideos, youtubeMetadata } from './catalog';

export default function YouTubeLibraryBrowser({ library }: { library: NativeLibrary }) {
  const [params, setParams] = useSearchParams();
  const {enabled:backdropView}=useBackdropView(library.id);
  const catalog = useQuery({ queryKey: ['native-catalog', library.id], queryFn: () => nativeLibraries.catalog(library.id), staleTime: 5 * 60_000, gcTime: 30 * 60_000 });
  const channels = channelsFromCatalog(catalog.data ?? []);
  const playlistId = params.get('youtube_playlist');
  const video = catalog.data?.find(e => e.id === params.get('youtube_video') && e.kind === 'episode' && e.available);
  const channelId=params.get('youtube_channel')??(video?youtubeMetadata(video).channel_id:undefined);
  const channel=channels.find(c=>c.id===channelId)??((playlistId||video)&&channels.length===1?channels[0]:undefined);
  const navigate = (channelId?: string, playlist?: string, item?: string) => { const next = new URLSearchParams(params); for (const key of ['youtube_channel', 'youtube_playlist', 'youtube_video']) next.delete(key); if (channelId) next.set('youtube_channel', channelId); if (playlist) next.set('youtube_playlist', playlist); if (item) next.set('youtube_video', item); setParams(next); };
  const image = (entry?: NativeCatalogEntry, detail=false) => {
    const kinds=detail||backdropView?['backdrop','landscape','thumb','poster']:['poster','thumb','backdrop','landscape'];
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
  return <section className="h-full overflow-y-auto px-5 pb-6 pt-5 sm:px-8 md:px-12"><div className="pv-youtube-catalog">
    {(video || playlistId || channel) && <LibraryPageBack><button className="mb-5 flex items-center gap-2 text-muted hover:text-white" onClick={back}><ArrowLeft size={18}/>Back</button></LibraryPageBack>}
    {!video&&<div className="mb-5 max-w-xs"><LibraryViewPreferences library={library.id}/></div>}
    <h1 className="mb-2 text-2xl font-bold">{video?.title ?? (playlistId ? playlistId === 'all' ? 'All Videos' : playlist?.title ?? playlistId : channel?.title ?? library.name)}</h1>
    <p className="mb-6 whitespace-pre-wrap text-muted">{video ? String(video.metadata.plot ?? '') : playlistId ? playlist?.description : channel?.description}</p>
    {video ? <div className="grid gap-6 md:grid-cols-2"><div>{thumbnail(video,true)}</div><div><p>{metadata?.channel}</p><p className="mt-2 text-muted">{String(video.metadata.aired ?? '')}{metadata?.duration_seconds ? ` · ${Math.ceil(metadata.duration_seconds / 60)} min` : ''}</p><NativePlaybackActions library={library.id} item={video.id}/>{source && <a href={source} target="_blank" rel="noreferrer" className="mt-5 inline-flex items-center gap-2 text-accent">View on YouTube<ExternalLink size={16}/></a>}<dl className="mt-5 text-sm text-muted">{video.files.map(file => <div key={file.path}><dt>File</dt><dd className="break-all">{file.path}</dd><dt>Codec</dt><dd>{file.media_info?.streams?.map(s => String(s.codec_name ?? '')).filter(Boolean).join(', ') || 'Unknown'}</dd></div>)}</dl></div></div> : <div className={backdropView?backdropGrid:posterGrid}>
      {!channel ? channels.map(c => <button key={c.id} className="poster-title-card min-w-0 text-left" onClick={() => navigate(c.id)}>{thumbnail(c.entry ?? c.videos[0])}<h2 className="mt-2 text-sm font-semibold"><ScrollingTitle title={c.title}/></h2><p className="text-sm text-muted">{c.videos.length} videos</p></button>) : !playlistId ? [{id:'all',title:'All Videos'}, ...channel.playlists].map(p => {const videos = playlistVideos(channel, p.id); return <button key={p.id} className="poster-title-card min-w-0 text-left" onClick={() => navigate(channel.id, p.id)}>{thumbnail(videos[0])}<h2 className="mt-2 text-sm font-semibold"><ScrollingTitle title={p.title}/></h2><p className="text-sm text-muted">{videos.length} videos</p></button>;}) : playlistVideos(channel, playlistId).map(v => <button key={v.id} className="poster-title-card min-w-0 text-left" onClick={() => navigate(channel.id, playlistId, v.id)}>{thumbnail(v)}<h2 className="mt-2 text-sm font-semibold"><ScrollingTitle title={v.title}/></h2><p className="text-sm text-muted">{String(v.metadata.aired ?? '')}</p></button>)}
    </div>}
    {!channels.length && <p className="text-muted">No downloaded videos yet. Administrators can add content in Settings → Plugins → YTDL.</p>}
  </div></section>;
}
