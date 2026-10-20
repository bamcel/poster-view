import {startupArtworkState} from "../features/playback/lib/startupArtwork";
import { mediaDescription } from "../lib/mediaDescription";
import {sizedArtwork} from "../lib/artworkSizes";
import {useEffect, useId, useMemo, useRef, useState} from "react";
import {ChevronLeft, ChevronRight, Film, Info, Play} from "lucide-react";
import {nativeLibraries, type NativeCatalogEntry, type NativeLibrary} from "../api/nativeLibraries";
import {Link} from "../lib/libraryNavigation";
import {nativeArtworkVersion} from "../lib/nativeArtworkCache";
import {stillArtwork} from "./AnimatedArtwork";

export type HomeTitle = {entry: NativeCatalogEntry; library: NativeLibrary};

function detailUrl({entry, library}: HomeTitle) {
  return `/media/${encodeURIComponent(library.id)}?native_library=${encodeURIComponent(library.id)}&native_item=${encodeURIComponent(entry.id)}&from=home`;
}

function playable({entry}: HomeTitle) {
  return entry.available && entry.kind === "movie" && (entry.files.length > 0 || entry.metadata._has_files === true);
}

function playUrl({entry, library}: HomeTitle) {
  return `/play/native/${encodeURIComponent(library.id)}/${encodeURIComponent(entry.id)}?return=%2F`;
}

function number(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return;
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}

function genres({entry}: HomeTitle): string[] {
  return Array.isArray(entry.metadata.genres)
    ? [...new Set(entry.metadata.genres.filter((value): value is string => typeof value === "string" && !!value.trim()).map(value => value.trim()))]
    : [];
}

function artwork(title: HomeTitle, kinds: string[]) {
  const kind = kinds.find(candidate => title.entry.artwork.some(image => image.kind === candidate));
  return kind ? stillArtwork(`${nativeLibraries.artworkUrl(title.library.id, title.entry.id, kind)}?v=${encodeURIComponent(nativeArtworkVersion(title.entry, kind))}`) : undefined;
}

function Artwork({title, hero = false}: {title: HomeTitle; hero?: boolean}) {
  const src = artwork(title, hero ? ["backdrop", "landscape", "fanart", "poster"] : ["poster", "thumb", "landscape", "backdrop"]);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!src || failed) return <div className="grid h-full w-full place-items-center bg-elevated text-faint"><Film aria-hidden="true" className={hero ? "size-20 opacity-20" : "size-10"}/></div>;
  return <img src={sizedArtwork(src,hero ? 1920 : 480)} srcSet={`${sizedArtwork(src,hero ? 1280 : 320)} ${hero ? 1280 : 320}w, ${sizedArtwork(src,hero ? 1920 : 480)} ${hero ? 1920 : 480}w`} sizes={hero ? "100vw" : "(min-width: 1024px) 192px, (min-width: 640px) 176px, 144px"} alt="" loading={hero ? "eager" : "lazy"} className="h-full w-full object-cover" onError={() => setFailed(true)}/>;
}

function QuickInfo({title,onQuickView,hero=false}: {title:HomeTitle;onQuickView?:(title:HomeTitle)=>void;hero?:boolean}) {
  const className=hero?"inline-flex min-h-11 items-center gap-2 rounded-full border border-white/20 bg-white/10 px-5 py-2.5 text-sm font-semibold text-[#fff] backdrop-blur-sm hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent":"inline-flex min-h-11 items-center gap-1.5 rounded-full border border-border bg-surface-2 px-3 text-xs font-medium text-muted hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
  const content=<><Info aria-hidden="true" className={hero?"size-5":"size-3.5"}/>{hero?"More Info":"Info"}</>;
  return onQuickView?<button type="button" aria-label={`More info about ${title.entry.title}`} aria-haspopup="dialog" className={className} onClick={()=>onQuickView(title)}>{content}</button>:<Link to={detailUrl(title)} aria-label={`More info about ${title.entry.title}`} className={className}>{content}</Link>;
}

export function FeaturedTitle({titles,onQuickView}: {titles: HomeTitle[];onQuickView?:(title:HomeTitle)=>void}) {
  const title = titles.find(item => artwork(item, ["backdrop", "landscape", "fanart"])) ?? titles[0];
  if (!title) return null;
  const {entry, library} = title;
  const year = number(entry.metadata.year);
  const plot = mediaDescription(entry.metadata.plot);
  const metadata = [year && year > 0 ? String(year) : "", entry.kind === "series" ? "Series" : "Movie", ...genres(title).slice(0, 2)].filter(Boolean);
  return <section aria-label="Featured title" className="relative isolate mb-8 overflow-hidden bg-elevated">
    <div className="absolute inset-0 -z-20"><Artwork key={`${library.id}:${entry.id}`} title={title} hero/></div>
    <div className="absolute inset-0 -z-10 bg-gradient-to-r from-black/90 via-black/65 to-black/10"/>
    <div className="absolute inset-0 -z-10 bg-gradient-to-t from-black/70 to-transparent"/>
    <div className="flex min-h-[max(32rem,75dvh)] flex-col justify-end px-5 pb-14 pt-28 sm:px-8 md:px-12 lg:min-h-[80dvh] lg:pb-20">
      <p className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-accent">Featured · {library.name}</p>
      <h2 className="max-w-2xl break-words text-3xl font-bold text-[#fff] sm:text-4xl lg:text-5xl">{entry.title}</h2>
      <p className="mt-3 text-sm text-white/80">{metadata.join(" · ")}</p>
      {plot && <p className="mt-4 whitespace-pre-line line-clamp-3 max-w-xl text-sm leading-relaxed text-white/80 sm:text-[16px]">{plot}</p>}
      <div className="mt-6 flex flex-wrap gap-3">
        {playable(title) && <Link state={startupArtworkState(title.library.id,title.entry)} to={playUrl(title)} aria-label={`Play ${entry.title}`} className="inline-flex min-h-11 items-center gap-2 rounded-full bg-accent px-6 py-2.5 text-sm font-semibold text-black focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"><Play aria-hidden="true" className="size-5 fill-current"/>Play</Link>}
        <QuickInfo title={title} onQuickView={onQuickView} hero/>
      </div>
    </div>
  </section>;
}

function TitleCard({title,onQuickView}: {title: HomeTitle;onQuickView?:(title:HomeTitle)=>void}) {
  const {entry, library} = title;
  const year = number(entry.metadata.year);
  return <article className="group w-36 shrink-0 snap-start sm:w-44 lg:w-48">
    <Link to={detailUrl(title)} aria-label={`Open ${entry.title} in ${library.name}`} className="block rounded-xl focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent">
      <div className="aspect-[2/3] overflow-hidden rounded-xl bg-elevated ring-1 ring-white/5 transition-shadow group-hover:ring-accent"><Artwork title={title}/></div>
      <p className="mt-2 truncate text-sm font-medium text-white group-hover:text-accent">{entry.title}</p>
    </Link>
    <p className="mt-1 truncate text-xs text-muted">{year && year > 0 ? `${year} · ` : ""}{library.name}</p>
    <div className="mt-2 flex gap-2">
      {playable(title) && <Link state={startupArtworkState(title.library.id,title.entry)} to={playUrl(title)} aria-label={`Play ${entry.title}`} className="inline-flex min-h-11 items-center gap-1.5 rounded-full bg-accent px-3 text-xs font-semibold text-black focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"><Play aria-hidden="true" className="size-3.5 fill-current"/>Play</Link>}
      <QuickInfo title={title} onQuickView={onQuickView}/>
    </div>
  </article>;
}

function DiscoveryRow({label, titles,onQuickView}: {label: string; titles: HomeTitle[];onQuickView?:(title:HomeTitle)=>void}) {
  const row = useRef<HTMLDivElement>(null);
  const heading = useId();
  const [edges, setEdges] = useState({left: false, right: false});
  useEffect(() => {
    const element = row.current;
    if (!element) return;
    const update = () => setEdges({left: element.scrollLeft > 1, right: element.scrollLeft + element.clientWidth < element.scrollWidth - 1});
    update();
    element.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : undefined;
    observer?.observe(element);
    for (const child of element.children) observer?.observe(child);
    return () => {element.removeEventListener("scroll", update); window.removeEventListener("resize", update); observer?.disconnect();};
  }, [titles]);
  const scroll = (direction: number) => row.current?.scrollBy({left: direction * row.current.clientWidth * 0.8, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth"});
  return <section aria-labelledby={heading}>
    <div className="mb-4 flex items-center justify-between gap-4">
      <h2 id={heading} className="text-xl font-semibold text-white">{label}</h2>
      {(edges.left || edges.right) && <div className="flex gap-2">
        <button type="button" aria-label={`Scroll ${label} left`} disabled={!edges.left} onClick={() => scroll(-1)} className="grid size-11 place-items-center rounded-full border border-border bg-surface-2 text-muted hover:text-white focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-30"><ChevronLeft aria-hidden="true" className="size-5"/></button>
        <button type="button" aria-label={`Scroll ${label} right`} disabled={!edges.right} onClick={() => scroll(1)} className="grid size-11 place-items-center rounded-full border border-border bg-surface-2 text-muted hover:text-white focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-30"><ChevronRight aria-hidden="true" className="size-5"/></button>
      </div>}
    </div>
    <div ref={row} className="scrollbar-hidden flex snap-x snap-proximity gap-4 overflow-x-auto px-1 pb-3 pt-1">{titles.slice(0, 20).map(title => <TitleCard key={`${title.library.id}:${title.entry.id}`} title={title} onQuickView={onQuickView}/>)}</div>
  </section>;
}

export default function HomeDiscovery({titles,onQuickView}: {titles: HomeTitle[];onQuickView?:(title:HomeTitle)=>void}) {
  const rows = useMemo(() => {
    const rated = titles.filter(title => {const rating = number(title.entry.metadata.rating); return rating !== undefined && rating >= 7 && rating <= 10;}).sort((a, b) => number(b.entry.metadata.rating)! - number(a.entry.metadata.rating)!);
    const recent = titles.filter(title => {const year = number(title.entry.metadata.year); return year !== undefined && Number.isInteger(year) && year > 0 && year <= 9999;}).sort((a, b) => number(b.entry.metadata.year)! - number(a.entry.metadata.year)!);
    const genreGroups = new Map<string, {label: string; titles: HomeTitle[]}>();
    for (const title of titles) {
      for (const genre of genres(title)) {
        const key = genre.toLocaleLowerCase();
        const group = genreGroups.get(key) ?? {label: genre, titles: []};
        if (!group.titles.includes(title)) group.titles.push(title);
        genreGroups.set(key, group);
      }
    }
    const result = [{label: "Highly Rated", titles: rated}, {label: "Recent Releases", titles: recent}, ...[...genreGroups.values()].filter(group => group.titles.length >= 2).sort((a, b) => b.titles.length - a.titles.length || a.label.localeCompare(b.label)).slice(0, 2)].filter(group => group.titles.length > 0);
    return result.length ? result : titles.length ? [{label: "Explore Your Libraries", titles}] : [];
  }, [titles]);
  return <div className="space-y-8">{rows.map(row => <DiscoveryRow key={row.label} label={row.label} titles={row.titles} onQuickView={onQuickView}/>)}</div>;
}
