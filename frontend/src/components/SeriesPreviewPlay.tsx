import {useEffect, useRef, useState} from "react";
import {useQueryClient} from "@tanstack/react-query";
import {Play} from "lucide-react";
import {nativeLibraries, type NativeCatalogEntry} from "../api/nativeLibraries";
import {useNavigate} from "../lib/libraryNavigation";
import {nativeCatalogView} from "../lib/nativeCatalogView";
import {compareEpisodeOrder} from "../lib/episodeOrder";
import {watchApi} from "../features/playback/api/watch";
import type {HomeTitle} from "./HomeDiscovery";

type Choice = {first: NativeCatalogEntry; resume: NativeCatalogEntry; restart: boolean};
export default function SeriesPreviewPlay({title, onInteraction, onChoosingChange}: {
  title: HomeTitle; onInteraction?: () => void; onChoosingChange?: (choosing: boolean) => void;
}) {
  const {entry, library} = title;
  const client = useQueryClient(), navigate = useNavigate();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [choice, setChoice] = useState<Choice | null>(null);
  const generation = useRef(0), pending = useRef(false), firstChoice = useRef<HTMLButtonElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const callbacks = useRef({onInteraction, onChoosingChange});
  callbacks.current = {onInteraction, onChoosingChange};
  useEffect(() => {
    generation.current++;
    pending.current = false;
    setBusy(false); setChoice(null); setError("");
    return () => {generation.current++; pending.current = false; callbacks.current.onChoosingChange?.(false);};
  }, [library.id, entry.id]);
  useEffect(() => {if (choice) firstChoice.current?.focus(); else if (restoreFocus.current) {restoreFocus.current = false; trigger.current?.focus();}}, [choice]);
  const play = (episode: NativeCatalogEntry, beginning: boolean) => {
    callbacks.current.onChoosingChange?.(false);
    navigate(`/play/native/${encodeURIComponent(library.id)}/${encodeURIComponent(episode.id)}?return=%2F${beginning ? "&start=0" : ""}`);
  };
  const load = async () => {
    if (pending.current) return;
    pending.current = true;
    const request = ++generation.current;
    callbacks.current.onInteraction?.(); callbacks.current.onChoosingChange?.(true);
    setBusy(true); setError("");
    try {
      const [catalog, states, continued] = await Promise.all([
        client.fetchQuery({queryKey: ["native-catalog", library.id], queryFn: () => nativeLibraries.catalog(library.id), staleTime: 0, retry: false}),
        client.fetchQuery({queryKey: ["watch-library-states", library.id], queryFn: () => watchApi.states(library.id), staleTime: 0, retry: false}),
        client.fetchQuery({queryKey: ["continue-watching"], queryFn: watchApi.continue, staleTime: 0, retry: false}),
      ]);
      if (request !== generation.current) return;
      const {aliases} = nativeCatalogView(catalog);
      const canonical = aliases.get(entry.id) ?? entry.id;
      const paths = new Set([entry.path, ...catalog.filter(item => item.kind === "series" && (aliases.get(item.id) ?? item.id) === canonical).map(item => item.path)]);
      const episodes = catalog.filter(item => item.kind === "episode" && item.available && item.metadata.missing !== true && item.files.length > 0 && [...paths].some(path => item.path.startsWith(`${path}/`)))
        .sort((a, b) => compareEpisodeOrder(a, b, false));
      const regular = episodes.filter(item => Number(item.metadata.season) > 0);
      const first = regular.find(item => Number(item.metadata.season) === 1 && Number(item.metadata.episode) === 1) ?? regular[0] ?? episodes[0];
      if (!first) throw new Error("No playable episodes are available.");
      const resumeItem = continued.find(item => item.library_id === library.id && episodes.some(episode => episode.id === item.item_id));
      const history = !!resumeItem || episodes.some(episode => {const state = states[episode.id]; return state && (state.watched || state.play_count > 0 || state.position_seconds > 0 || !!state.last_played_at);});
      if (!history) {play(first, true); return;}
      const unfinished = episodes.filter(episode => !states[episode.id]?.watched && (states[episode.id]?.position_seconds ?? 0) > 0)
        .sort((a, b) => String(states[b.id]?.last_played_at ?? "").localeCompare(String(states[a.id]?.last_played_at ?? "")));
      const ordered = [...regular, ...episodes.filter(item => !regular.includes(item))];
      const resume = episodes.find(episode => episode.id === resumeItem?.item_id) ?? unfinished[0] ?? ordered.find(episode => !states[episode.id]?.watched) ?? first;
      const restart = !resumeItem && unfinished.length === 0 && !ordered.some(episode => !states[episode.id]?.watched);
      setChoice({first, resume, restart});
    } catch (failure) {
      if (request !== generation.current) return;
      setError(failure instanceof Error && failure.message === "No playable episodes are available." ? failure.message : "Playback history could not be loaded. Please try again.");
      callbacks.current.onChoosingChange?.(false);
    } finally {
      if (request === generation.current) {pending.current = false; setBusy(false);}
    }
  };
  if (entry.kind !== "series" || !entry.available || entry.metadata.missing === true) return null;
  return <div className="pv-series-preview-play">
    {!choice && <button ref={trigger} type="button" className="pv-discovery-hover-play" aria-label={`Play ${entry.title}`} disabled={busy} onClick={() => void load()}><Play aria-hidden="true" className="size-4 fill-current"/>{busy ? "Loading playback…" : error ? "Retry playback" : "Play"}</button>}
    {error && <p role="alert" className="pv-series-preview-error">{error}</p>}
    {choice && <div role="group" aria-label={`Playback options for ${entry.title}`} className="pv-series-preview-options">
      <button ref={firstChoice} type="button" className="pv-discovery-hover-play" onClick={() => play(choice.first, true)}>Play from beginning</button>
      <button type="button" className="pv-discovery-hover-play" onClick={() => play(choice.resume, choice.restart)}>Continue where you left off</button>
      <button type="button" className="pv-discovery-hover-info" onClick={() => {restoreFocus.current = true; setChoice(null); callbacks.current.onChoosingChange?.(false);}}>Cancel</button>
    </div>}
  </div>;
}
