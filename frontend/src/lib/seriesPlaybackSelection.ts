import type {NativeCatalogEntry} from "../api/nativeLibraries";
import type {WatchState, ContinueItem} from "../features/playback/api/watch";
import {nativeCatalogView} from "./nativeCatalogView";
import {compareEpisodeOrder} from "./episodeOrder";

export function seriesPlaybackSelection(catalog: NativeCatalogEntry[], entry: NativeCatalogEntry, library: {id: string}, states: Record<string, WatchState>, continued: ContinueItem[], allowSummaries = false) {
  const {aliases} = nativeCatalogView(catalog);
  const canonical = aliases.get(entry.id) ?? entry.id;
  const paths = new Set([entry.path, ...catalog.filter(item => item.kind === "series" && (aliases.get(item.id) ?? item.id) === canonical).map(item => item.path)]);
  const episodes = catalog.filter(item => item.kind === "episode" && item.available && item.metadata.missing !== true && (item.files.length > 0 || (allowSummaries && item.metadata._has_files === true)) && [...paths].some(path => item.path.startsWith(`${path}/`)))
    .sort((a, b) => compareEpisodeOrder(a, b, false));
  const regular = episodes.filter(item => Number(item.metadata.season) > 0);
  const first = regular.find(item => Number(item.metadata.season) === 1 && Number(item.metadata.episode) === 1) ?? regular[0] ?? episodes[0];
  if (!first) throw new Error("No playable episodes are available.");
  const resumeItem = continued.find(item => item.library_id === library.id && episodes.some(episode => episode.id === item.item_id));
  const history = !!resumeItem || episodes.some(episode => {const state = states[episode.id]; return state && (state.watched || state.play_count > 0 || state.position_seconds > 0 || !!state.last_played_at);});

  const unfinished = episodes.filter(episode => !states[episode.id]?.watched && (states[episode.id]?.position_seconds ?? 0) > 0)
    .sort((a, b) => String(states[b.id]?.last_played_at ?? "").localeCompare(String(states[a.id]?.last_played_at ?? "")));
  const ordered = [...regular, ...episodes.filter(item => !regular.includes(item))];
  const resume = episodes.find(episode => episode.id === resumeItem?.item_id) ?? unfinished[0] ?? ordered.find(episode => !states[episode.id]?.watched) ?? first;
  const restart = !resumeItem && unfinished.length === 0 && !ordered.some(episode => !states[episode.id]?.watched);
  return {first, resume, restart, history};
}
