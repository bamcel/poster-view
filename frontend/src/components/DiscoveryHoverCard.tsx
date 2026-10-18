import MoviePreviewPlay from "./MoviePreviewPlay";
import { mediaDescription } from "../lib/mediaDescription";
import {useEffect, useId, useRef, useState, type ReactNode} from "react";
import {createPortal} from "react-dom";
import {Film, Info, X} from "lucide-react";
import {nativeLibraries} from "../api/nativeLibraries";
import {Link} from "../lib/libraryNavigation";
import {nativeArtworkVersion} from "../lib/nativeArtworkCache";
import {stillArtwork} from "./AnimatedArtwork";
import {sizedArtwork} from "../lib/artworkSizes";
import SeriesPreviewPlay from "./SeriesPreviewPlay";
import type {HomeTitle} from "./HomeDiscovery";
import "./DiscoveryHoverCard.css";

const openedEvent = "posterview:discovery-preview-open";
function text(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
function positive(value: unknown, max: number) {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= max ? number : undefined;
}

export default function DiscoveryHoverCard({title, children}: {title: HomeTitle; children: ReactNode}) {
  const id = useId();
  const anchor = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const dismissed = useRef(false);
  const choosingPlayback=useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [position, setPosition] = useState<{left: number; top: number; width: number} | null>(null);
  const [failed, setFailed] = useState(false);
  const {entry, library} = title;
  const detail = `/media/${encodeURIComponent(library.id)}?native_library=${encodeURIComponent(library.id)}&native_item=${encodeURIComponent(entry.id)}&from=home`;
  const artworkKind = ["backdrop", "landscape", "fanart", "thumb", "poster"].find(kind => entry.artwork.some(image => image.kind === kind));
  const artwork = artworkKind ? stillArtwork(`${nativeLibraries.artworkUrl(library.id, entry.id, artworkKind)}?v=${encodeURIComponent(nativeArtworkVersion(entry, artworkKind))}`) : undefined;
  const cancel = () => {clearTimeout(timer.current); timer.current = undefined;};
  const close = () => {cancel(); choosingPlayback.current=false; setPosition(null);};
  const open = () => {
    cancel();
    if (dismissed.current || !anchor.current) return;
    const rect = anchor.current.getBoundingClientRect();
    const width = Math.min(390, window.innerWidth<640?window.innerWidth-24:Math.max(1, rect.width * 1.5), Math.max(1, window.innerWidth - 24));
    window.dispatchEvent(new CustomEvent(openedEvent, {detail: id}));
    setPosition({width, left: Math.max(12, Math.min(rect.left - (width - rect.width) / 2, window.innerWidth - width - 12)), top: Math.max(12, Math.min(rect.top - 20, window.innerHeight - Math.min(440, window.innerHeight - 24) - 12))});
  };
  const scheduleClose = () => {cancel(); if(!choosingPlayback.current)timer.current = setTimeout(close, 180);};
  useEffect(() => {setFailed(false);}, [artwork]);
  useEffect(() => {
    const anotherOpened = (event: Event) => {if ((event as CustomEvent<string>).detail !== id) close();};
    window.addEventListener(openedEvent, anotherOpened);
    return () => {clearTimeout(timer.current); window.removeEventListener(openedEvent, anotherOpened);};
  }, [id]);
  useEffect(() => {
    if (!position) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      dismissed.current = true;
      close();
      opener.current?.focus();
    };
    const scroll = (event: Event) => {if (!(event.target instanceof Node && panel.current?.contains(event.target))) close();};
    const outside = (event: PointerEvent) => {if (!anchor.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) close();};
    window.addEventListener("keydown", escape);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", close);
    document.addEventListener("pointerdown", outside);
    return () => {window.removeEventListener("keydown", escape); window.removeEventListener("scroll", scroll, true); window.removeEventListener("resize", close); document.removeEventListener("pointerdown", outside);};
  }, [position]);
  const onBlur = (target: EventTarget | null) => {
    if (target instanceof Node && (anchor.current?.contains(target) || panel.current?.contains(target))) return;
    dismissed.current = false;
    scheduleClose();
  };
  const year = positive(entry.metadata.year, 9999);
  const runtime = positive(entry.metadata.runtime, 10000);
  const rating = positive(entry.metadata.rating, 10);
  const genres = Array.isArray(entry.metadata.genres) ? entry.metadata.genres.filter((genre): genre is string => typeof genre === "string" && !!genre.trim()).slice(0, 3) : [];
  return <div ref={anchor} className="pv-discovery-hover-anchor" onMouseEnter={() => {dismissed.current = false; cancel(); timer.current = setTimeout(open, 350);}} onMouseLeave={scheduleClose} onFocus={event => {if (anchor.current?.contains(event.target)) {opener.current = event.target; open();}}} onKeyDown={event => {if (position && event.key === "Tab" && !event.shiftKey && event.target instanceof HTMLElement && anchor.current?.contains(event.target)) {event.preventDefault(); panel.current?.querySelector<HTMLElement>(".pv-discovery-hover-actions button,.pv-discovery-hover-actions a")?.focus();}}} onBlur={event => onBlur(event.relatedTarget)}>
    {children}
    {position && createPortal(<div ref={panel} id={id} role="region" aria-label={`Preview of ${entry.title}`} className="pv-discovery-hover-panel" style={{...position, maxHeight: `calc(100dvh - ${position.top + 12}px)`}} onMouseEnter={cancel} onMouseLeave={scheduleClose} onFocus={cancel} onBlur={event => onBlur(event.relatedTarget)}>
      <div className="pv-discovery-hover-art">{artwork && !failed ? <img src={sizedArtwork(artwork,640)} srcSet={`${sizedArtwork(artwork,640)} 640w, ${sizedArtwork(artwork,1280)} 1280w`} sizes="(max-width: 414px) calc(100vw - 24px), 390px" alt="" decoding="async" onError={() => setFailed(true)}/> : <Film aria-hidden="true" size={44}/>}</div>
      <button type="button" className="pv-discovery-hover-dismiss" aria-label={`Close preview of ${entry.title}`} onClick={() => {dismissed.current = true; close(); opener.current?.focus();}}><X size={18} aria-hidden="true"/></button>
      <div className="pv-discovery-hover-body">
        {artwork&&!failed&&<img className="pv-discovery-hover-tint" src={sizedArtwork(artwork,640)} alt="" aria-hidden="true" decoding="async"/>}
        <h3>{entry.title}</h3>
        <p className="pv-discovery-hover-metadata">{[year ? String(year) : "", text(entry.metadata.mpaa), entry.kind === "series" ? "Series" : runtime ? `${Math.round(runtime)} min` : "Movie", rating ? `${Number(rating.toFixed(1))}/10` : ""].filter(Boolean).join(" · ")}</p>
        {genres.length > 0 && <p className="pv-discovery-hover-genres">{genres.join(" · ")}</p>}
        {mediaDescription(entry.metadata.plot) && <p className="pv-discovery-hover-plot">{mediaDescription(entry.metadata.plot)}</p>}
        <div className="pv-discovery-hover-actions">
          {entry.kind==="series"&&entry.available&&entry.metadata.missing!==true&&<SeriesPreviewPlay title={title} onChoosingChange={choosing=>{choosingPlayback.current=choosing;cancel();}}/>}
          {entry.kind==="movie"&&<MoviePreviewPlay title={title}/>}
          <Link to={detail} aria-label={`More info about ${entry.title}`}><Info size={16} aria-hidden="true"/>More Info</Link>
        </div>
      </div>
    </div>, document.body)}
  </div>;
}
