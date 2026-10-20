import {startupArtworkState} from "../features/playback/lib/startupArtwork";
import ResumePlaybackDialog from "./ResumePlaybackDialog";
import {useEffect, useRef, useState} from "react";
import {useQuery, useQueryClient} from "@tanstack/react-query";
import {Play} from "lucide-react";
import {nativeLibraries} from "../api/nativeLibraries";
import {watchApi} from "../features/playback/api/watch";
import {useNavigate} from "../lib/libraryNavigation";
import {seriesPlaybackSelection} from "../lib/seriesPlaybackSelection";
import type {HomeTitle} from "./HomeDiscovery";

export type SeriesPlayProps = {title: HomeTitle; onInteraction?: () => void; onChoosingChange?: (busy: boolean) => void};
export default function SeriesBannerPlay({title, variant = "banner", onInteraction, onChoosingChange}: SeriesPlayProps & {variant?: "banner" | "preview"}) {
  const {entry, library} = title;
  const client = useQueryClient(), navigate = useNavigate();
  const allowed = entry.kind === "series" && entry.available && entry.metadata.missing !== true;
  const summary = useQuery({queryKey: ["native-catalog", library.id, "summary"], queryFn: () => nativeLibraries.summaries(library.id), enabled: allowed, staleTime: 5 * 60_000, retry: false});
  const states = useQuery({queryKey: ["watch-library-states", library.id], queryFn: () => watchApi.states(library.id), enabled: allowed, staleTime: 0, retry: false});
  const continued = useQuery({queryKey: ["continue-watching"], queryFn: watchApi.continue, enabled: allowed, staleTime: 0, retry: false});
  const [prompt, setPrompt] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const generation = useRef(0), pending = useRef(false);
  const callbacks = useRef({onInteraction, onChoosingChange});
  callbacks.current = {onInteraction, onChoosingChange};
  useEffect(() => {generation.current++; pending.current = false; setBusy(false); setPrompt(false); setError(""); return () => {generation.current++; pending.current = false; callbacks.current.onChoosingChange?.(false);};}, [library.id, entry.id]);
  let choice: ReturnType<typeof seriesPlaybackSelection> | undefined;
  if (summary.data && states.data && continued.data) {
    try {choice = seriesPlaybackSelection(summary.data, entry, library, states.data, continued.data, true);} catch { /* Resolve full records only on explicit playback. */ }
  }
  const loading = summary.isPending || states.isPending || continued.isPending;
  const failed = summary.isError || states.isError || continued.isError;
  const play = async (resume: boolean) => {
    if (pending.current) return;
    pending.current = true;
    const request = ++generation.current;
    callbacks.current.onInteraction?.(); callbacks.current.onChoosingChange?.(true);
    setBusy(true); setError("");
    try {
      let selected = choice;
      if (!selected) {
        const [catalog, freshStates, freshContinue] = await Promise.all([
          client.fetchQuery({queryKey: ["native-catalog", library.id], queryFn: () => nativeLibraries.catalog(library.id), staleTime: 0, retry: false}),
          client.fetchQuery({queryKey: ["watch-library-states", library.id], queryFn: () => watchApi.states(library.id), staleTime: 0, retry: false}),
          client.fetchQuery({queryKey: ["continue-watching"], queryFn: watchApi.continue, staleTime: 0, retry: false}),
        ]);
        selected = seriesPlaybackSelection(catalog, entry, library, freshStates, freshContinue);
      }
      if (request !== generation.current) return;
      const episode = resume ? selected.resume : selected.first;
      navigate(`/play/native/${encodeURIComponent(library.id)}/${encodeURIComponent(episode.id)}?return=%2F${!resume || selected.restart ? "&start=0" : ""}`,{state:startupArtworkState(library.id,entry,episode.id)});
    } catch (failure) {
      if (request === generation.current) setError(failure instanceof Error && failure.message === "No playable episodes are available." ? failure.message : "Playback could not be loaded. Please try again.");
    } finally {
      if (request === generation.current) {pending.current = false; setBusy(false); callbacks.current.onChoosingChange?.(false);}
    }
  };
  if (!allowed) return null;
  return <>
    <button type="button" className={variant === "preview" ? "pv-discovery-hover-play" : "pv-home-action pv-home-action-primary"} disabled={loading || busy} onClick={() => {if(variant === "preview" && choice?.history){setPrompt(true);callbacks.current.onChoosingChange?.(true);}else void play(false);}}><Play aria-hidden="true" size={18}/>{error || failed ? "Retry playback" : variant !== "preview" && choice?.history ? "Play from beginning" : "Play"}</button>
    {variant !== "preview" && choice?.history && <button type="button" title="Continue where you left off" className="pv-home-action" disabled={busy} onClick={() => void play(true)}><Play aria-hidden="true" size={18}/>Resume</button>}
    {prompt && <ResumePlaybackDialog title={entry.title} onClose={()=>{setPrompt(false);callbacks.current.onChoosingChange?.(false);}} onChoose={resume=>{setPrompt(false);void play(resume);}}/>}
    {error && <span role="alert" className="pv-series-preview-error">{error}</span>}
  </>;
}
