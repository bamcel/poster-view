import { describe, expect, it } from 'vitest';
import type { NativeCatalogEntry } from '../../api/nativeLibraries';
import { channelsFromCatalog, playlistVideos } from './catalog';
const entry = (id: string, playlists: unknown[], channel = 'channel'): NativeCatalogEntry => ({ id, path: `${channel}/${id}.mp4`, kind: 'episode', parent_path: channel, title: id, metadata: { youtube: { video_id: id, channel_id: channel, channel, playlists } }, artwork: [], files: [], nfo_path: null, available: true, revision: 1 });
describe('YouTube catalog hierarchy', () => {
  it('groups a single channel by playlists and preserves original playlist positions', () => {
    const [channel] = channelsFromCatalog([entry('second', [{ id: 'playlist', title: 'A playlist', index: 2 }]), entry('first', [{ id: 'playlist', title: 'A playlist', index: 1 }])]);
    expect(channel.playlists).toEqual([{ id: 'playlist', title: 'A playlist', index: 2 }]);
    expect(playlistVideos(channel, 'playlist').map(v => v.id)).toEqual(['first', 'second']);
  });
  it('keeps channels separate and shares one video across playlist memberships', () => {
    const channels = channelsFromCatalog([entry('shared', [{ id: 'one', title: 'One' }, { id: 'two', title: 'Two' }]), entry('other', [], 'another')]);
    expect(channels).toHaveLength(2);
    const channel = channels.find(c => c.id === 'channel')!;
    expect(playlistVideos(channel, 'one')[0]).toBe(playlistVideos(channel, 'two')[0]);
    expect(playlistVideos(channel, 'all')).toHaveLength(1);
    expect(playlistVideos(channels.find(c => c.id === 'another')!, 'all')).toHaveLength(1);
  });
});
