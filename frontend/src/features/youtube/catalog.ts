import {namedSlug,resolveNamed} from "../../lib/mediaPaths";
import type { NativeCatalogEntry } from '../../api/nativeLibraries';

export interface Playlist { id: string; title: string; index?: number; description?: string }
export interface YoutubeMetadata { video_id?: string; channel_id?: string; channel?: string; source_url?: string; duration_seconds?: number; published_at?: string; playlists?: Playlist[] }
export interface Channel { id: string; title: string; description: string; entry?: NativeCatalogEntry; videos: NativeCatalogEntry[]; playlists: Playlist[] }
export const youtubeMetadata = (entry: NativeCatalogEntry): YoutubeMetadata => (entry.metadata.youtube ?? {}) as YoutubeMetadata;
export function channelsFromCatalog(entries: NativeCatalogEntry[]): Channel[] {
  const channels = new Map<string, Channel>();
  for (const entry of entries.filter(e => e.kind === 'series')) {
    const metadata = youtubeMetadata(entry), id = metadata.channel_id ?? entry.path;
    channels.set(id, { id, title: entry.title, description: String(entry.metadata.plot ?? ''), entry, videos: [], playlists: metadata.playlists ?? [] });
  }
  for (const entry of entries.filter(e => e.kind === 'episode' && e.available)) {
    const metadata = youtubeMetadata(entry), id = metadata.channel_id ?? entry.parent_path ?? 'unknown';
    let channel = channels.get(id);
    if (!channel) { channel = { id, title: metadata.channel ?? id, description: '', videos: [], playlists: [] }; channels.set(id, channel); }
    if (!channel.videos.some(video => video.id === entry.id)) channel.videos.push(entry);
    for (const playlist of metadata.playlists ?? []) if (!channel.playlists.some(p => p.id === playlist.id)) channel.playlists.push(playlist);
  }
  return [...channels.values()].sort((a, b) => a.title.localeCompare(b.title));
}
export function playlistVideos(channel: Channel, playlist: string): NativeCatalogEntry[] {
  return channel.videos.filter(video => playlist === 'all' || youtubeMetadata(video).playlists?.some(p => p.id === playlist)).sort((a, b) => {
    // Display order follows upload dates, independently of playlist position or filenames.
    return String(youtubeMetadata(b).published_at ?? b.metadata.aired ?? '').localeCompare(String(youtubeMetadata(a).published_at ?? a.metadata.aired ?? ''))
      || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
  });
}

// Reuse the media route naming and duplicate-title disambiguation rules.
export function youtubeRoute(entries:NativeCatalogEntry[], channelSlug?:string, playlistSlug?:string, videoSlug?:string) {
 const channels=channelsFromCatalog(entries);
 const channel=resolveNamed(channelSlug,channels);
 const playlists=channel?[{id:'all',title:'All Videos'},...channel.playlists]:[];
 const playlist=resolveNamed(playlistSlug,playlists);
 const video=channel&&playlist?resolveNamed(videoSlug,playlistVideos(channel,playlist.id)):undefined;
 return {channel,playlist,video,valid:!channelSlug||!!channel&&(!playlistSlug||!!playlist)&&(!videoSlug||!!video)};
}
export function youtubePath(base:string,entries:NativeCatalogEntry[],channelId:string|null,playlistId:string|null,videoId:string|null) {
 const channels=channelsFromCatalog(entries);
 const video=entries.find(e=>e.id===videoId&&e.kind==='episode');
 const channel=channels.find(c=>c.id===(channelId??(video?youtubeMetadata(video).channel_id:undefined)));
 if(!channel)return base;
 let path=`${base}/${encodeURIComponent(namedSlug(channel,channels))}`;
 const playlists=[{id:'all',title:'All Videos'},...channel.playlists];
 const playlist=playlists.find(p=>p.id===(playlistId??(video?'all':null)));
 if(!playlist)return path;
 path+=`/${encodeURIComponent(namedSlug(playlist,playlists))}`;
 if(video)path+=`/${encodeURIComponent(namedSlug(video,playlistVideos(channel,playlist.id)))}`;
 return path;
}
