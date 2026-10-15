import {useEffect, useId, useMemo, useRef, useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {Film, Play, X} from "lucide-react";
import {nativeLibraries} from "../api/nativeLibraries";
import {Link} from "../lib/libraryNavigation";
import {nativeArtworkVersion} from "../lib/nativeArtworkCache";
import {nativeCatalogView} from "../lib/nativeCatalogView";
import {watchApi} from "../features/playback/api/watch";
import NativeSeriesPlay from "../features/playback/components/NativeSeriesPlay";
import {stillArtwork} from "./AnimatedArtwork";
import type {HomeTitle} from "./HomeDiscovery";

function numeric(value: unknown) {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return undefined;
  const result = Number(value);
  return Number.isFinite(result) && result > 0 ? result : undefined;
}

function MovieAction({title: {entry, library}}: {title: HomeTitle}) {
  const state = useQuery({queryKey: ["watch-state", library.id, entry.id], queryFn: () => watchApi.state(library.id, entry.id), retry: false, staleTime: 0});
  if (state.isPending) return <p role="status" className="text-sm text-muted">Loading playback…</p>;
  const resume = (state.data?.position_seconds ?? 0) > 0;
  return <div>
    <Link to={`/play/native/${encodeURIComponent(library.id)}/${encodeURIComponent(entry.id)}?return=%2F`} className="inline-flex min-h-11 items-center gap-2 rounded-full bg-accent px-6 py-2.5 text-sm font-semibold text-black focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"><Play aria-hidden="true" className="size-5 fill-current"/>{resume ? "Resume" : "Play"}</Link>
    {state.isError && <p role="status" className="mt-2 text-sm text-muted">Watch progress is unavailable. You can still play this title.</p>}
  </div>;
}

function SeriesAction({title: {entry, library}}: {title: HomeTitle}) {
  const catalog = useQuery({queryKey: ["native-catalog", library.id], queryFn: () => nativeLibraries.catalog(library.id), retry: false});
  const includeIds = useMemo(() => {
    const entries = catalog.data ?? [];
    const {aliases} = nativeCatalogView(entries);
    const canonical = aliases.get(entry.id) ?? entry.id;
    const paths = entries.filter(item => item.kind === "series" && (aliases.get(item.id) ?? item.id) === canonical).map(item => item.path);
    return entries.filter(item => item.kind === "episode" && paths.some(path => item.path.startsWith(`${path}/`))).map(item => item.id);
  }, [catalog.data, entry.id]);
  if (catalog.isPending) return <p role="status" className="text-sm text-muted">Loading episodes…</p>;
  if (catalog.isError) return <p role="status" className="text-sm text-muted">Episodes could not be loaded. Open full details to try again.</p>;
  const hasEpisodes = catalog.data.some(item => item.kind === "episode" && item.available && item.metadata.missing !== true && item.files.length && (item.path.startsWith(`${entry.path}/`) || includeIds.includes(item.id)));
  if (!hasEpisodes) return <p className="text-sm text-muted">No playable episodes are available.</p>;
  return <NativeSeriesPlay library={library.id} path={entry.path} entries={catalog.data} includeIds={includeIds} specialsInSeasons={library.options?.show_specials_in_seasons === true}/>;
}

export default function HomeQuickView({title, onClose}: {title: HomeTitle; onClose: () => void}) {
  const {entry, library} = title;
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const heading = useId();
  const [failedArtwork, setFailedArtwork] = useState(false);
  const kind = ["backdrop", "landscape", "fanart", "poster"].find(candidate => entry.artwork.some(image => image.kind === candidate));
  const artwork = kind ? stillArtwork(`${nativeLibraries.artworkUrl(library.id, entry.id, kind)}?v=${encodeURIComponent(nativeArtworkVersion(entry, kind))}`) : undefined;
  useEffect(() => setFailedArtwork(false), [artwork]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = dialog.current!;
    const previousOverflow = document.body.style.overflow;
    element.showModal();
    document.body.style.overflow = "hidden";
    close.current?.focus();
    return () => {
      element.close();
      document.body.style.overflow = previousOverflow;
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  const year = numeric(entry.metadata.year);
  const rating = numeric(entry.metadata.rating);
  const runtime = numeric(entry.metadata.runtime);
  const certification = typeof entry.metadata.mpaa === "string" ? entry.metadata.mpaa.trim() : "";
  const genres = Array.isArray(entry.metadata.genres) ? entry.metadata.genres.filter((genre): genre is string => typeof genre === "string" && !!genre.trim()).map(genre => genre.trim()) : [];
  const plot = typeof entry.metadata.plot === "string" ? entry.metadata.plot.trim() : "";
  const available = entry.available && entry.metadata.missing !== true;
  return <dialog ref={dialog} aria-labelledby={heading} aria-modal="true" onCancel={event => {event.preventDefault(); onClose();}} onClick={event => {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
  }} className="m-auto max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-3xl overflow-y-auto rounded-2xl border border-border bg-surface p-0 text-white shadow-2xl backdrop:bg-black/75 backdrop:backdrop-blur-sm">
    <div className="relative">
      <div className="relative aspect-[16/7] max-h-[30dvh] w-full overflow-hidden bg-elevated">
        {artwork && !failedArtwork ? <img src={artwork} alt="" onError={() => setFailedArtwork(true)} className="h-full w-full object-cover"/> : <div className="grid h-full place-items-center text-faint"><Film aria-hidden="true" className="size-20 opacity-25"/></div>}
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent"/>
      </div>
      <button ref={close} type="button" aria-label="Close quick view" onClick={onClose} className="absolute right-4 top-4 grid size-11 place-items-center rounded-full border border-white/20 bg-black/70 text-[#fff] hover:bg-black focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"><X aria-hidden="true" className="size-5"/></button>
    </div>
    <div className="space-y-5 p-5 sm:p-8">
      <div><p className="mb-2 text-xs font-semibold uppercase tracking-widest text-accent">{library.name}</p><h2 id={heading} className="break-words text-3xl font-bold">{entry.title}</h2></div>
      <div aria-label="Title information" className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted">
        {year && <span>{year}</span>}<span>{entry.kind === "series" ? "Series" : "Movie"}</span>
        {rating && rating <= 10 && <span>★ {rating.toFixed(1)}</span>}
        {certification && <span className="rounded border border-border px-1.5">{certification}</span>}
        {runtime && <span>{runtime} min</span>}
      </div>
      {genres.length > 0 && <p className="text-sm text-muted">{[...new Set(genres)].join(" · ")}</p>}
      <p className="whitespace-pre-line text-sm leading-relaxed text-muted sm:text-[16px]">{plot || "No synopsis is available for this title."}</p>
      <div className="flex flex-wrap items-start gap-3">
        {available && entry.kind === "movie" && entry.files.length > 0 ? <MovieAction key={`${library.id}:${entry.id}`} title={title}/> : available && entry.kind === "series" ? <SeriesAction key={`${library.id}:${entry.id}`} title={title}/> : <p className="text-sm text-muted">This title is currently unavailable for playback.</p>}
        <Link to={`/media/${encodeURIComponent(library.id)}?native_library=${encodeURIComponent(library.id)}&native_item=${encodeURIComponent(entry.id)}`} className="inline-flex min-h-11 items-center rounded-full border border-border bg-surface-2 px-5 py-2.5 text-sm font-semibold text-white hover:bg-elevated focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent">Full Details</Link>
      </div>
    </div>
  </dialog>;
}
