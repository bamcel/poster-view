import { describe, expect, it } from 'vitest';
import type { NativeCatalogEntry } from '../../api/nativeLibraries';
import { channelsFromCatalog, playlistVideos, youtubePath, youtubeRoute } from './catalog';
const entry = (id: string, playlists: unknown[], channel = 'channel'): NativeCatalogEntry => ({ id, path: `${channel}/${id}.mp4`, kind: 'episode', parent_path: channel, title: id, metadata: { youtube: { video_id: id, channel_id: channel, channel, playlists } }, artwork: [], files: [], nfo_path: null, available: true, revision: 1 });
describe('YouTube catalog hierarchy', () => {
  it('groups a single channel by playlists and shows the newest uploads first despite playlist positions', () => {
    const [channel] = channelsFromCatalog([entry('second', [{ id: 'playlist', title: 'A playlist', index: 2 }]), entry('first', [{ id: 'playlist', title: 'A playlist', index: 1 }])]);
    expect(channel.playlists).toEqual([{ id: 'playlist', title: 'A playlist', index: 2 }]);
    channel.videos[0].metadata.aired='2026-10-13';
    channel.videos[1].metadata.aired='2026-09-01';
    expect(playlistVideos(channel, 'playlist').map(v => v.id)).toEqual(['second', 'first']);
    expect(playlistVideos(channel,'all').map(v=>v.id)).toEqual(['second','first']);
  });
  it('keeps channels separate and shares one video across playlist memberships', () => {
    const channels = channelsFromCatalog([entry('shared', [{ id: 'one', title: 'One' }, { id: 'two', title: 'Two' }]), entry('other', [], 'another')]);
    expect(channels).toHaveLength(2);
    const channel = channels.find(c => c.id === 'channel')!;
    expect(playlistVideos(channel, 'one')[0]).toBe(playlistVideos(channel, 'two')[0]);
    expect(playlistVideos(channel, 'all')).toHaveLength(1);
    expect(playlistVideos(channels.find(c => c.id === 'another')!, 'all')).toHaveLength(1);
  });
  it('puts undated videos last and uses readable titles for same-day ties',()=>{
    const videos=[entry('unknown',[]),entry('z',[]),entry('a',[])];
    videos[1].metadata.aired='2026-10-13';videos[2].metadata.aired='2026-10-13';
    videos[1].title='Zebra';videos[2].title='A readable video title';
    const [channel]=channelsFromCatalog(videos);
    expect(playlistVideos(channel,'all').map(v=>v.title)).toEqual(['A readable video title','Zebra','unknown']);
  });

  it('uses publication time to order same-day uploads when available',()=>{
    const videos=[entry('early',[]),entry('late',[])];
    for(const video of videos)video.metadata.aired='2026-10-13';
    (videos[0].metadata.youtube as Record<string,unknown>).published_at='2026-10-13T08:00:00+00:00';
    (videos[1].metadata.youtube as Record<string,unknown>).published_at='2026-10-13T17:00:00+00:00';
    expect(playlistVideos(channelsFromCatalog(videos)[0],'all').map(v=>v.id)).toEqual(['late','early']);
  });

});

it("uses readable channel playlist and video paths and disambiguates duplicate titles",()=>{
 const videos=[entry('one',[{id:'camp',title:'Camping'}]),entry('two',[{id:'camp',title:'Camping'}])];
 for(const video of videos){video.title='A Trip';(video.metadata.youtube as Record<string,unknown>).channel='Outdoor Boys';}
 expect(youtubePath('/media/Youtube',videos,'channel',null,null)).toBe('/media/Youtube/Outdoor-Boys');
 expect(youtubePath('/media/Youtube',videos,'channel','all',null)).toBe('/media/Youtube/Outdoor-Boys/All-Videos');
 expect(youtubePath('/media/Youtube',videos,'channel','camp','one')).toBe('/media/Youtube/Outdoor-Boys/Camping/A-Trip~one');
 expect(youtubeRoute(videos,'Outdoor-Boys','Camping','A-Trip~one').video?.id).toBe('one');
 expect(youtubeRoute(videos,'Outdoor-Boys','Camping','A-Trip').valid).toBe(false);
 expect(youtubeRoute(videos,'Missing').valid).toBe(false);
});
