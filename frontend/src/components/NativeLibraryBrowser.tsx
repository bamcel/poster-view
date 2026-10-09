import FetchBookMetadata from "./FetchBookMetadata";
import {useTrackingOverlays} from "../lib/libraryDisplay";
import BookSeriesMetadata from "./BookSeriesMetadata";
import BookPreferences from "./BookPreferences";
import {useArtworkPlugin} from "../lib/artworkPlugin";
import NativeScanProgress from "./NativeScanProgress";
import {validFraming} from "../lib/backdropFraming";
import LibraryViewPreferences, { useBackdropView, posterGrid, backdropGrid } from "./LibraryViewPreferences";
import PeopleRow from "./PeopleRow";
import { useEffect, useRef, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "../lib/libraryNavigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Database,
  Film,
  Images,
  Fingerprint,
  ListFilter,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Search,
  UserRound,
  X,
} from "lucide-react";
import {
  nativeLibraries,
  type NativeCatalogEntry,
  type NativeLibrary,
} from "../api/nativeLibraries";
import type { ItemDetail } from "../types";
import PosterCard from "./PosterCard";
import AnimatedArtwork from "./AnimatedArtwork";
import ArtworkPanel from "./ArtworkPanel";
import IdentifyPanel from "./IdentifyPanel";
import LibraryPopup from "./LibraryPopup";
import ArtworkPreferences, {animatedArtworkEnabled,useAnimatedArtworkPreference} from "./ArtworkPreferences";
import AnimePreferences, {useAnimePreferences} from "./AnimePreferences";
import { animeVoiceGroups, orderedCharacters, voiceName } from "../lib/nativeVoiceCast";
import { nativeCatalogView } from "../lib/nativeCatalogView";
import DashboardBackdrop from "./DashboardBackdrop";
import TitleMetadata from "./TitleMetadata";
import ItemAbout from "./ItemAbout";
import DetailSynopsis from "./DetailSynopsis";
import { EntryEditor } from "./NativeCatalogPanel";
import { detailActionClass } from "../lib/detailActions";
import { LibraryBackdrop } from "../lib/libraryNavigation";
import {
  BACKDROP_OVERLAY_EVENT,
  DASHBOARD_BACKDROP_EVENT,
  backdropOverlay,
  backdropOverlayGradients,
  dashboardBackdropEnabled,
  panelSolidity,
  panelOverlay,
  backdropBlur,
  translucentPanelColor,
} from "../lib/dashboardSettings";


function number(value: unknown): number | undefined {
  const n = Number(value);
  return value != null && value !== "" && Number.isFinite(n) ? n : undefined;
}
function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(String)
    : typeof value === "string"
      ? [value]
      : [];
}
function artwork(
  library: NativeLibrary,
  entry: NativeCatalogEntry | undefined,
  kind: string,
) {
  if (animatedArtworkEnabled(library.id) && entry?.artwork.some(a=>a.kind===`${kind}-animated`)) kind=`${kind}-animated`;
  const edit = (entry?.metadata.posteredit ?? entry?.metadata.poseredit) as {enabled?:boolean;mode?:string;poster_path?:string} | undefined;
  const overlayEnabled = animatedArtworkEnabled(library.id) && (kind === "poster-animated" || kind === "poster" && edit?.mode === "overlay");
  if (overlayEnabled && kind === "poster" && edit?.poster_path === entry?.artwork.find(a=>a.kind==="poster")?.path && entry?.artwork.some(a=>a.kind==="poster-edit-original")) kind="poster-edit-original";
  const overlay = overlayEnabled && edit?.enabled && entry?.artwork.some(a=>a.kind==="logo") ? `&logoOverlay=${encodeURIComponent(JSON.stringify({...edit,logo:`${nativeLibraries.artworkUrl(library.id,entry.id,"logo")}?v=${entry.revision}`}))}` : "";
  const framing = animatedArtworkEnabled(library.id) && ["backdrop","backdrop-animated"].includes(kind) ? validFraming(entry?.metadata.backdropedit) : undefined;
  if (framing?.logo && entry) framing.logo={...framing.logo,enabled:framing.logo.enabled && entry.artwork.some(a=>a.kind==="logo"),src:`${nativeLibraries.artworkUrl(library.id,entry.id,"logo")}?v=${entry.revision}`};
  return entry?.artwork.some((a) => a.kind === kind)
    ? `${nativeLibraries.artworkUrl(library.id, entry.id, kind)}?v=${entry.revision}&format=${entry.artwork.find(a => a.kind === kind)?.path.split(".").pop()?.toLowerCase() ?? ""}${!animatedArtworkEnabled(library.id) ? "&still=1" : ""}${overlay}${framing ? `&backdropEdit=${encodeURIComponent(JSON.stringify(framing))}` : ""}`
    : undefined;
}
function picture(
  library: NativeLibrary,
  entry: NativeCatalogEntry | undefined,
  kind: string,
) {
  return (
    artwork(library, entry, kind) ??
    (kind === "thumb" ? artwork(library, entry, "landscape") : undefined)
  );
}
function Artwork({
  src,
  alt,
  className = "",
}: {
  src?: string;
  alt: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return src && !failed ? (
    <AnimatedArtwork
      src={src}
      alt={alt}
      onError={() => setFailed(true)}
      className={`h-full w-full object-cover ${className}`}
    />
  ) : (
    <div className="flex h-full w-full items-center justify-center bg-surface-2">
      <Film className="size-10 text-faint" />
      <span className="sr-only">{alt}: no artwork</span>
    </div>
  );
}
function portraitName(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/).sort().join(" ") : "";
}
function portraitIndex(metadata: Record<string, unknown>): Map<string, string> {
  const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const list = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(record) : [];
  const ani = record(metadata.anilist_data);
  const candidates: Record<string, unknown>[] = [];
  for (const edge of list(record(ani.staff).edges)) {
    const node = record(edge.node);
    candidates.push({name: record(node.name).full, image: record(node.image).large});
  }
  for (const edge of list(record(ani.characters).edges)) {
    for (const actor of list(edge.voiceActors)) candidates.push({name: record(actor.name).full, image: record(actor.image).large});
  }
  const tmdb = record(record(metadata.tmdb_data).credits);
  for (const credit of [...list(tmdb.cast), ...list(tmdb.crew)]) candidates.push({name: credit.name, image: credit.profile_path});
  for (const credit of list(record(metadata.tvdb_data).characters)) candidates.push({name: credit.personName, image: credit.personImgURL});
  const images = new Map<string, string>();
  for (const candidate of candidates) {
    const name = portraitName(candidate.name);
    if (name && !images.has(name) && typeof candidate.image === "string" && candidate.image.trim()) images.set(name, candidate.image.trim());
  }
  return images;
}

function PersonPortrait({person, images}: {person: Record<string, unknown>; images: Map<string, string>}) {
  const value = typeof person.image === "string" && person.image.trim() ? person.image.trim() : images.get(portraitName(person.name)) ?? "";
  const source = /^\/[a-zA-Z0-9_-]+\.(jpg|jpeg|png|webp)$/i.test(value)
    ? `https://image.tmdb.org/t/p/w185${value}`
    : value;
  let src: string | undefined;
  try {
    const url = source.startsWith("/api/servers/") ? new URL(source,window.location.origin) : new URL(source);
    if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) src = url.href;
  } catch { /* A missing or unsupported portrait uses the placeholder. */ }
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return <div data-person-portrait className="mb-3 aspect-[2/3] overflow-hidden rounded-lg bg-surface-2">
    {src && !failed ? <img src={src} alt={String(person.name ?? "Portrait")} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center"><UserRound className="size-10 text-muted" aria-hidden="true" /></div>}
  </div>;
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const metadata = title === "Edit Metadata" || title === "Identify" || title === "Fetch Metadata";
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return createPortal(
    <dialog
      ref={ref}
      onCancel={onClose}
      aria-label={title}
      className={metadata ? "m-auto h-[85dvh] max-h-[900px] w-[min(52rem,calc(100vw-2rem))] max-w-4xl overflow-hidden rounded-2xl border border-border bg-sidebar p-0 text-white backdrop:bg-black/70" : "m-auto max-h-[90dvh] w-[min(56rem,calc(100vw-2rem))] max-w-4xl overflow-y-auto rounded-2xl border border-border bg-sidebar p-5 text-white backdrop:bg-black/70"}
    >
      <header className={metadata ? "flex h-16 shrink-0 items-center gap-4 px-6 sm:px-8" : "mb-5 flex items-center justify-between gap-4"}>
        <h2 className={`text-lg font-semibold`}>{title}</h2>
        <button
          autoFocus
          aria-label="Close editor"
          className={metadata ? "ml-auto shrink-0 rounded-md p-1 text-muted hover:text-white" : detailActionClass}
          onClick={onClose}
        >
          <X className="size-4" />
        </button>
      </header>
      <div className={metadata ? "h-[calc(100%-4rem)] min-h-0" : ""}>{children}</div>
    </dialog>,
    document.body,
  );
}

export default function NativeLibraryBrowser({
  library,
}: {
  library: NativeLibrary;
}) {
  const { enabled: backdropView } = useBackdropView(library.id);
  const [, , bookDisplay] = useTrackingOverlays(library.library_type === "books");
  const {hoverOnly}=useAnimatedArtworkPreference(library.id);
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const status = useQuery({
    queryKey: ["native-scan", library.id],
    queryFn: () => nativeLibraries.status(library.id),
    refetchInterval: (q) =>
      q.state.data?.status === "scanning" ? 2000 : library.options?.real_time_monitor ? 5000 : false,
  });
  const catalog = useQuery({
    queryKey: ["native-catalog", library.id],
    queryFn: () => nativeLibraries.catalog(library.id),
    staleTime: 60_000,
    gcTime: 30 * 60_000,
    refetchInterval: status.data?.status === "scanning" ? 5000 : library.options?.server_sync?.enabled ? 30_000 : false,
  });
  useEffect(()=>{if(status.data?.artwork_revision) void client.invalidateQueries({queryKey:["native-catalog",library.id]});},[status.data?.artwork_revision,library.id,client]);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("title");
  const [artFilter, setArtFilter] = useState("all");
  const [editor, setEditor] = useState<{
    id: string;
    kind: "metadata" | "artwork" | "identify" | "fetch-metadata";
  } | null>(null);
  const [showBackdrop, setShowBackdrop] = useState(dashboardBackdropEnabled);
  const [overlay, setOverlay] = useState(backdropOverlay);
  useEffect(() => {
    const update = () => {
      setShowBackdrop(dashboardBackdropEnabled());
      setOverlay(backdropOverlay());
    };
    window.addEventListener(DASHBOARD_BACKDROP_EVENT, update);
    window.addEventListener(BACKDROP_OVERLAY_EVENT, update);
    return () => {
      window.removeEventListener(DASHBOARD_BACKDROP_EVENT, update);
      window.removeEventListener(BACKDROP_OVERLAY_EVENT, update);
    };
  }, []);
  const previousScanStatus = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (previousScanStatus.current === "scanning" && status.data?.status && status.data.status !== "scanning")
      void client.invalidateQueries({
        queryKey: ["native-catalog", library.id],
      });
    previousScanStatus.current = status.data?.status;
  }, [status.data?.status, client, library.id]);
  const view = useMemo(
    () => nativeCatalogView(catalog.data ?? []),
    [catalog.data],
  );
  const entries = view.entries;
  const selected =
    params.get("native_library") === library.id
      ? entries.find(
          (e) =>
            e.id ===
            (view.aliases.get(params.get("native_item") ?? "") ??
              params.get("native_item")),
        )
      : undefined;
  const pageItem = params.get("native_item");
  const pageLibrary = params.get("native_library");
  useEffect(() => {
    setEditor(current => current?.kind === "artwork" ? null : current);
  }, [pageItem, pageLibrary]);
  const open = (entry: NativeCatalogEntry) => {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set("native_library", library.id);
      next.set("native_item", entry.id);
      return next;
    });
  };
  const back = () => {
    const parent = entries.find((e) => e.path === selected?.parent_path);
    if (parent) open(parent);
    else
      setParams((previous) => {
        const next = new URLSearchParams(previous);
        next.delete("native_item");
        return next;
      });
  };
  const refresh = () => {
    void catalog.refetch();
  };
  const visible = entries
    .filter((e) =>
      search
        ? e.title.toLowerCase().includes(search.toLowerCase())
        : !e.parent_path,
    )
    .filter(
      (e) =>
        artFilter === "all" ||
        !e.artwork.some(
          (a) =>
            a.kind === (artFilter === "missing-poster" ? "poster" : "backdrop"),
        ),
    )
    .sort((a, b) =>
      sort === "title"
        ? a.title.localeCompare(b.title)
        : sort === "newest"
          ? (number(b.metadata.year) ?? 0) - (number(a.metadata.year) ?? 0)
          : (number(a.metadata.year) ?? 0) - (number(b.metadata.year) ?? 0),
    );
  const updated = () => {
    if(editor) void client.invalidateQueries({queryKey:["item-detail0",0,`native:${library.id}:${editor.id}`]});
    void client.invalidateQueries({ queryKey: ["native-catalog", library.id] });
    setEditor(null);
  };
  const editEntry = editor && entries.find((e) => e.id === editor.id);
  const backgroundUrls = useMemo(
    () =>
      (catalog.data ?? [])
        .filter((e) => e.available && !e.parent_path)
        .map((e) => picture(library, e, "backdrop"))
        .filter((url): url is string => !!url)
        .slice(0, 8),
    [catalog.data, library],
  );
  const posterUrls = useMemo(
    () =>
      (catalog.data ?? [])
        .filter((e) => e.available && !e.parent_path)
        .map((e) => picture(library, e, "poster"))
        .filter((url): url is string => !!url)
        .slice(0, 8),
    [catalog.data, library],
  );
  const style = {
    backgroundColor: translucentPanelColor(
      "--color-surface-2",
      panelSolidity(),
      panelOverlay(),
    ),
    backdropFilter: `blur(${backdropBlur()}px)`,
  };
  return (
    <section
      aria-label={`${library.name} library`}
      className="relative flex h-full min-h-0 flex-col overflow-hidden"
    >
      {!selected &&
        showBackdrop &&
        (backgroundUrls.length > 0 || posterUrls.length > 0) && (
          <DashboardBackdrop
            desktopUrls={backgroundUrls}
            mobileUrls={posterUrls}
            overlayStrength={overlay}
          />
        )}
      {catalog.isPending && (
        <p role="status" className="p-8 text-muted">
          Loading catalog…
        </p>
      )}
      {catalog.error && (
        <p role="alert" className="p-8 text-danger">
          {catalog.error.message} <button onClick={refresh}>Retry</button>
        </p>
      )}
      {selected ? (
        <NativeDetail
          key={selected.id}
          library={library}
          entry={selected}
          entries={entries}
          open={open}
          back={back}
          refresh={refresh}
          fetching={catalog.isFetching}
          edit={(kind) => setEditor({ id: selected.id, kind })}
          showBackdrop={showBackdrop}
          overlay={overlay}
        />
      ) : (
        <>
          <div className="relative z-30 grid shrink-0 items-center gap-3 border-b border-border px-4 py-3 sm:px-6 lg:grid-cols-[1fr_auto_1fr] lg:px-8">
            <div aria-hidden="true" className="hidden lg:block"/>
            <div className="flex items-center justify-center gap-2">
              <div className="relative w-[min(21rem,calc(100vw-10rem))]">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
                <input
                  aria-label="Search titles"
                  placeholder="Search titles"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full rounded-full border border-border py-2 pl-9 pr-3 text-[16px] font-medium text-muted outline-none placeholder:text-muted focus:border-accent md:text-sm"
                  style={style}
                />
              </div>
              <details className="relative">
                <summary
                  aria-label="Filter and sort titles"
                  className="grid size-10 max-md:size-[44px] cursor-pointer list-none place-items-center rounded-full border border-border text-muted marker:hidden"
                  style={style}
                >
                  <ListFilter className="size-4" />
                </summary>
                <div className="absolute right-0 z-30 mt-2 w-64 rounded-xl border border-border bg-sidebar p-4 shadow-2xl">
                  <label className="block text-xs font-semibold text-muted">
                    Artwork
                    <select
                      aria-label="Filter by artwork"
                      className="mt-2 h-10 w-full rounded-lg border border-border bg-input px-3 text-sm text-white"
                      value={artFilter}
                      onChange={(e) => setArtFilter(e.target.value)}
                    >
                      <option value="all">All titles</option>
                      <option value="missing-poster">Missing poster</option>
                      <option value="missing-backdrop">Missing backdrop</option>
                    </select>
                  </label>
                  <label className="mt-4 block text-xs font-semibold text-muted">
                    Sort by
                    <select
                      aria-label="Sort titles"
                      className="mt-2 h-10 w-full rounded-lg border border-border bg-input px-3 text-sm text-white"
                      value={sort}
                      onChange={(e) => setSort(e.target.value)}
                    >
                      <option value="title">Title A–Z</option>
                      <option value="newest">Newest year</option>
                      <option value="oldest">Oldest year</option>
                    </select>
                  </label>
                </div>
              </details>
              <LibraryPopup title="Preferences" label="Library preferences" icon={<MoreHorizontal className="size-4"/>} style={style} editorStyle={library.library_type === "anime"}>
                <div className="space-y-7"><LibraryViewPreferences library={library.id}/>
                <ArtworkPreferences library={library.id}/>{library.library_type === "books" && <BookPreferences/>}{library.library_type === "anime" && <AnimePreferences library={library.id}/>}</div>
              </LibraryPopup>
            </div>
            {status.data?.status === "scanning" && status.data.show_progress !== false ? <aside aria-label="Library scan progress" className="w-full min-w-0 lg:ml-auto lg:max-w-80"><NativeScanProgress status={status.data} compact/></aside> : <div aria-hidden="true" className="hidden lg:block"/>}
          </div>
          <div className="scrollbar-hidden relative z-10 min-h-0 flex-1 overflow-y-auto px-4 pb-8 sm:px-6 lg:px-8">
            <div className="mb-4 flex items-center justify-between text-xs text-faint">
              <span>{visible.length} titles</span>
            </div>
            <div className={backdropView ? backdropGrid : posterGrid}>
              {visible.map((entry) => (
                <PosterCard
                  animationOnHover={hoverOnly}
                  key={entry.id}
                  coloredEffect={library.library_type === "books" && String(entry.metadata.edition ?? "").trim().toLowerCase() === "colored" ? bookDisplay.coloredEffect : "off"}
                  coloredTitle={library.library_type === "books" && String(entry.metadata.edition ?? "").trim().toLowerCase() === "colored" && bookDisplay.coloredTitle}
                  title={entry.title}
                  backdropView={backdropView}
                    image={(backdropView ? picture(library, entry, "backdrop") ?? picture(library, entry, "landscape") : undefined) ?? picture(library, entry, "poster")}
                  subtitle={String(entry.metadata.year ?? "")}
                  kind={
                    entry.kind === "series"
                      ? "show"
                      : entry.kind.startsWith("book")
                        ? "book"
                        : "movie"
                  }
                  onOpen={() => open(entry)}
                  onEditMetadata={() =>
                    setEditor({ id: entry.id, kind: "metadata" })
                  }
                  onRefresh={refresh}
                />
              ))}
            </div>
            {!catalog.isPending && !visible.length && (
              <p className="py-12 text-center text-muted">
                No matching items. Scan the library to discover media.
              </p>
            )}
          </div>
        </>
      )}
      {editEntry && (editor?.kind === "artwork" ? (
        <div className="pointer-events-none fixed inset-0 z-50 bg-transparent">
          <section aria-label={`Artwork for ${editEntry.title}`} className="pointer-events-auto ml-auto h-full w-full max-w-md shadow-2xl" onClick={event => event.stopPropagation()}>
            <ArtworkPanel serverId={0} item={nativeArtworkItem(library, editEntry, entries)} libraryTitle={library.name} libraryType={library.library_type === "books" ? "book" : library.library_type === "movies" ? "movie" : "show"} onClose={() => setEditor(null)} />
          </section>
        </div>
      ) : editor?.kind === "fetch-metadata" ? (
        <Modal title="Fetch Metadata" onClose={()=>setEditor(null)}><FetchBookMetadata library={library} entry={editEntry} busy={status.data?.status === "scanning"} onSaved={updated}/></Modal>
      ) : editor?.kind === "identify" ? (
        <Modal title="Identify" onClose={() => setEditor(null)}>
          <IdentifyPanel library={library} entry={editEntry} busy={status.data?.status === "scanning"} onSaved={updated}/>
        </Modal>
      ) : (
        <Modal title="Edit Metadata" onClose={() => setEditor(null)}>
          <EntryEditor library={library} entry={editEntry} busy={status.data?.status === "scanning"} onSaved={updated} dialog />
        </Modal>
      ))}

    </section>
  );
}

function NativeDetail({
  library,
  entry,
  entries,
  open,
  back,
  refresh,
  fetching,
  edit,
  showBackdrop,
  overlay,
}: {
  library: NativeLibrary;
  entry: NativeCatalogEntry;
  entries: NativeCatalogEntry[];
  open: (e: NativeCatalogEntry) => void;
  back: () => void;
  refresh: () => void;
  fetching: boolean;
  edit: (kind: "metadata" | "artwork" | "identify" | "fetch-metadata") => void;
  showBackdrop: boolean;
  overlay: number;
}) {
  const {hoverOnly}=useAnimatedArtworkPreference(library.id);
  const {value:animePreferences} = useAnimePreferences(library.id);
  const parent = entries.find((e) => e.path === entry.parent_path);
  const series =
    entry.kind === "series"
      ? entry
      : entry.kind === "season"
        ? parent
        : entries.find((e) => e.path === parent?.parent_path);
  const artworkPlugin=useArtworkPlugin();
  const children = entries
    .filter((e) => e.available && e.parent_path === entry.path)
    .sort(
      (a, b) =>
        (number(a.kind === "season" ? a.metadata.season : a.kind === "book" ? a.metadata.volume ?? a.metadata.chapter : a.metadata.episode) ??
          0) -
          (number(
            b.kind === "season" ? b.metadata.season : b.kind === "book" ? b.metadata.volume ?? b.metadata.chapter : b.metadata.episode,
          ) ?? 0) || a.title.localeCompare(b.title, undefined, {numeric:true}),
    );
  const [search, setSearch] = useState("");
  const [, , bookDisplay] = useTrackingOverlays(library.library_type === "books");
  const coloredBook = library.library_type === "books" && String(entry.metadata.edition ?? parent?.metadata.edition ?? "").trim().toLowerCase() === "colored";
  const isBookSeries = entry.kind === "book_series";
  const bookUnit = children.length > 0 && children.some(e=>e.metadata.chapter!=null) && children.every(e=>e.metadata.volume==null) ? "Chapter" : "Volume";
  const isSeries = entry.kind === "series" || entry.kind === "season";
  const isEpisode = entry.kind === "episode";
  const detail: ItemDetail = {
    id: entry.id,
    title: entry.title,
    type:
      entry.kind === "series"
        ? "show"
        : entry.kind.startsWith("book")
          ? "book"
          : "movie",
    year: number(entry.metadata.year),
    rating: number(entry.metadata.rating),
    content_rating: String(entry.metadata.mpaa ?? ""),
    tags: strings(entry.metadata.tags),
    genres: strings(entry.metadata.genres),
    studios: strings(entry.metadata.studios),
    seasons: children
      .filter((e) => e.kind === "season")
      .map((e) => ({ id: e.id, title: e.title })),
    members: [],
    external_ids: Object.fromEntries(
      Object.entries(
        typeof entry.metadata.identifiers === "object" &&
          entry.metadata.identifiers
          ? entry.metadata.identifiers
          : {},
      ).map(([key, value]) => [key, String(value)]),
    ),
  };
  const backdrop =
    picture(library, entry, "backdrop") ?? picture(library, series, "backdrop");
  const logo =
    picture(library, entry, "logo") ??
    (entry.kind === "season" ? picture(library, series, "logo") : undefined);
  const poster =
    picture(library, entry, isEpisode ? "thumb" : "poster") ??
    picture(library, series, "poster");
  const overview = String(
    entry.metadata.plot ??
      (entry.kind === "season" ? series?.metadata.plot : "") ??
      "",
  );
  const portraitImages = useMemo(() => portraitIndex(entry.metadata), [entry.metadata]);
  const voiceCast = useMemo(() => library.library_type === "anime" && ["series", "movie"].includes(entry.kind) ? animeVoiceGroups(entry.metadata, library.options?.metadata_language ?? "en", portraitImages) : undefined, [entry.metadata, entry.kind, library.library_type, library.options?.metadata_language, portraitImages]);
  const characterNames = new Set((Array.isArray(entry.metadata.characters) ? entry.metadata.characters as Record<string, unknown>[] : []).map(character => voiceName(character.name)).filter(Boolean));
  const credits = (Array.isArray(entry.metadata.credits)
    ? (entry.metadata.credits as Record<string, unknown>[])
    : []).filter(credit => {
      if (credit.category === "crew") return true;
      if (credit.category === "character" || characterNames.has(voiceName(credit.name))) return false;
      return !voiceCast || (credit.category !== "voice" && !voiceCast.names.has(voiceName(credit.name)));
    });
  return (
    <>
      {showBackdrop && backdrop && (
        <LibraryBackdrop>
          <div
            aria-hidden="true"
            className="pointer-events-none fixed inset-0 z-0 overflow-hidden bg-base"
          >
            <AnimatedArtwork
              src={backdrop}
              fill
              alt=""
              className="h-full w-full origin-top scale-[1.02] object-cover object-top"
            />
            <div
              className="absolute inset-0 md:hidden"
              style={{
                backgroundImage: backdropOverlayGradients(overlay).mobile,
              }}
            />
            <div
              className="absolute inset-0 hidden md:block"
              style={{
                backgroundImage: backdropOverlayGradients(overlay).desktop,
              }}
            />
          </div>
        </LibraryBackdrop>
      )}
      <div className="media-detail scrollbar-hidden relative z-[1] h-full flex-1 overflow-y-auto overscroll-y-contain">
        <div className="relative min-h-full">
          <button
            onClick={back}
            aria-label="Back"
            className="absolute left-5 top-5 z-10 grid size-9 max-md:size-[44px] place-items-center rounded-full bg-black/40 text-white backdrop-blur hover:bg-black/70"
          >
            <ArrowLeft className="size-5" />
          </button>
          <div className="relative z-[1] px-4 pb-8 pt-16 sm:px-6 sm:pb-10 lg:px-10 lg:pt-20">
            <div
              className={
                isSeries || isBookSeries
                  ? "flex flex-row items-start gap-5 sm:gap-8 lg:gap-9"
                  : "flex flex-col items-center gap-5 sm:flex-row sm:items-start sm:gap-6"
              }
            >
              <div
                className={
                  isSeries
                    ? "w-28 shrink-0 sm:w-[25%] sm:max-w-[328px]"
                    : isEpisode
                      ? "w-full max-w-md shrink-0 sm:w-[35%]"
                      : "w-40 shrink-0 min-[390px]:w-44 sm:w-48 lg:w-56"
                }
              >
                <div
                  className={`relative ${isEpisode ? "aspect-video" : "aspect-[2/3]"} overflow-hidden rounded-xl bg-surface-2 shadow-2xl shadow-black/50 ring-1 ring-white/10`}
                >
                  <Artwork src={poster} alt={entry.title} />
                  {coloredBook && poster && ["shimmer","both"].includes(bookDisplay.coloredEffect) && <span aria-hidden="true" className="poster-colored-shimmer pointer-events-none absolute inset-0"/>}
                  {coloredBook && ["badge","both"].includes(bookDisplay.coloredEffect) && <span aria-label="Colored edition" className="poster-colored-badge pointer-events-none absolute bottom-2 right-2 rounded-md px-2 py-1 text-[10px] font-bold tracking-wider shadow">COLORED</span>}
                </div>
              </div>
              <div
                className={`min-w-0 flex-1 pt-2 [text-shadow:0_2px_12px_rgba(0,0,0,0.8)] ${isSeries || isBookSeries ? "text-left" : "text-center sm:text-left"}`}
              >
                {logo ? (
                  <AnimatedArtwork
                    src={logo}
                    alt={entry.title}
                    className="max-h-24 max-w-full object-contain object-left sm:max-w-[400px]"
                  />
                ) : (
                  <h1 className={`text-3xl font-bold leading-tight sm:text-4xl ${coloredBook && bookDisplay.coloredTitle ? "poster-colored-title" : ""}`}>
                    {entry.title}
                    {entry.metadata.missing === true && <span className="ml-3 inline-flex align-middle rounded-full border border-amber-400/40 bg-amber-400/15 px-3 py-1 text-xs text-amber-200">Missing</span>}
                  </h1>
                )}
                {entry.kind === "season" && series && (
                  <button
                    className="mt-2 text-sm text-accent"
                    onClick={() => open(series)}
                  >
                    {series.title}
                  </button>
                )}
                {isBookSeries ? <p className="mt-2 text-sm text-white/70">{children.filter(e=>e.metadata.missing!==true).length} {children.filter(e=>e.metadata.missing!==true).length === 1 ? bookUnit : `${bookUnit}s`}</p> : <TitleMetadata item={detail} />}
                {isEpisode && (
                  <p className="mt-2 text-sm text-muted">
                    Season {String(entry.metadata.season ?? "")} · Episode{" "}
                    {String(entry.metadata.episode ?? "")}
                  </p>
                )}
                <div
                  data-testid="detail-actions"
                  className="mt-4 flex flex-wrap items-center gap-2"
                >
                  <button
                    className={detailActionClass}
                    aria-label="Edit Metadata"
                    title="Edit Metadata"
                    onClick={() => edit("metadata")}
                  >
                    <Pencil className="size-4" />
                  </button>
                  <button
                    className={detailActionClass}
                    aria-label="Refresh"
                    title="Refresh"
                    onClick={refresh}
                  >
                    <RefreshCw
                      className={`size-4 ${fetching ? "animate-spin" : ""}`}
                    />
                  </button>
                  {artworkPlugin.data?.enabled !== false && <button
                    className={detailActionClass}
                    aria-label="Edit Artwork"
                    title="Edit Artwork"
                    onClick={() => edit("artwork")}
                  >
                    <Images className="size-4" />
                  </button>}
                  {entry.kind === "book_series" && <button className={detailActionClass} aria-label="Fetch Metadata" title="Fetch Metadata" onClick={()=>edit("fetch-metadata")}><Database className="size-4"/></button>}
                  {["series","movie","book_series"].includes(entry.kind) && <button className={detailActionClass} aria-label="Identify" title="Identify" onClick={()=>edit("identify")}><Fingerprint className="size-4"/></button>}
                </div>
                {entry.kind.startsWith("book") && <BookSeriesMetadata unit={isBookSeries ? bookUnit : entry.metadata.chapter!=null && entry.metadata.volume==null ? "Chapter" : "Volume"} metadata={entry.metadata} count={isBookSeries ? children.filter(e=>e.metadata.missing!==true).length : 1}/>}
                <div className={isSeries ? "hidden sm:block" : "text-left"}>
                  <DetailSynopsis text={overview} />
                </div>
              </div>
            </div>
            {isSeries && (
              <div className="sm:hidden">
                <DetailSynopsis text={overview} />
              </div>
            )}
            {children.some((e) => e.kind !== "episode") && (
              <section className="mt-10">
                <h2 className="mb-3 text-xl font-semibold">
                  {entry.kind === "series" ? "Seasons" : children.some(e=>e.metadata.chapter!=null) && children.every(e=>e.metadata.volume==null) ? "Chapters" : "Volumes"}
                </h2>
                <div className={isBookSeries ? posterGrid : "-mx-2 -mt-2 flex gap-5 overflow-x-auto px-2 pb-3 pt-2 [&>div]:w-[150px] [&>div]:shrink-0 sm:[&>div]:w-[180px]"}>
                  {children
                    .filter((e) => e.kind !== "episode")
                    .map((child) => (
                      <PosterCard
                  animationOnHover={hoverOnly}
                        key={child.id}
                        coloredEffect={library.library_type === "books" && String(child.metadata.edition ?? entry.metadata.edition ?? "").trim().toLowerCase() === "colored" ? bookDisplay.coloredEffect : "off"}
                        coloredTitle={library.library_type === "books" && String(child.metadata.edition ?? entry.metadata.edition ?? "").trim().toLowerCase() === "colored" && bookDisplay.coloredTitle}
                        title={child.title}
                        titleBadge={child.metadata.missing === true ? "Missing" : undefined}
                        image={picture(library, child, "poster")}
                        kind={child.kind.startsWith("book") ? "book" : "show"}
                        onOpen={() => open(child)}
                      />
                    ))}
                </div>
              </section>
            )}
            {children.some((e) => e.kind === "episode") && (
              <section className="mt-10">
                <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
                  <h2 className="text-xl font-semibold">Episodes</h2>
                  <label className="flex items-center gap-2 rounded-full border border-border bg-surface px-4 py-2.5 text-muted">
                    <Search className="size-4" />
                    <input
                      aria-label="Search episodes"
                      placeholder="Find an episode"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      className="w-40 bg-transparent text-sm outline-none"
                    />
                  </label>
                </div>
                <div className="space-y-5">
                  {children
                    .filter(
                      (e) =>
                        e.kind === "episode" &&
                        e.title.toLowerCase().includes(search.toLowerCase()),
                    )
                    .map((episode) => (
                      <article
                        key={episode.id}
                        className="group flex items-start gap-4 sm:gap-6"
                      >
                        <button
                          aria-label={`Open ${episode.title}`}
                          onClick={() => open(episode)}
                          className="relative aspect-video w-32 shrink-0 overflow-hidden rounded-lg bg-base sm:w-64 lg:w-80"
                        >
                          <Artwork
                            src={picture(library, episode, "thumb")}
                            alt={`${episode.title} episode still`}
                          />
                        </button>
                        <div className="min-w-0 flex-1 py-1">
                          <button
                            onClick={() => open(episode)}
                            className="text-left text-base font-semibold leading-snug text-white"
                          >
                            {String(episode.metadata.episode ?? "")}.{" "}
                            {episode.title}
                          </button>
                          <p className="mt-2 text-xs text-muted">
                            {String(episode.metadata.aired ?? "")}
                            {episode.metadata.runtime
                              ? ` · ${episode.metadata.runtime} min`
                              : ""}
                          </p>
                          <DetailSynopsis
                            text={String(episode.metadata.plot ?? "")}
                          />
                        </div>
                      </article>
                    ))}
                </div>
              </section>
            )}
            {entry.kind !== "series" && !entry.kind.startsWith("book") && <ItemAbout item={detail} />}
            {(library.library_type !== "anime" || animePreferences.characters) && Array.isArray(entry.metadata.characters) &&
              entry.metadata.characters.length > 0 && (
                <section className="mt-8">
                  <h2 className="mb-4 text-xl font-semibold">Characters</h2>
                  <PeopleRow label="characters">
                    {orderedCharacters(entry.metadata.characters, portraitImages).map((character, i) => (
                      <div
                        key={i}
                        className="w-48 shrink-0 rounded-xl p-4"
                      >
                        <PersonPortrait person={character} images={portraitImages} />
                        <p className="text-sm font-medium">
                          {String(character.name ?? "")}
                        </p>
                        <p className="mt-1 text-xs text-muted">
                          {String(character.role ?? "")}
                        </p>

                      </div>
                    ))}
                  </PeopleRow>
                </section>
              )}

            {animePreferences.casts && voiceCast?.groups.filter((_,index)=> index===0 ? animePreferences.original || (voiceCast.groups.length===1 && animePreferences.dub) : animePreferences.dub).map(group => <section key={group.title} className="mt-8">
              <h2 className="mb-4 text-xl font-semibold">{group.title}</h2>
              {group.cast.length ? <PeopleRow label={group.title}>{group.cast.map((person, i) => <div key={i} className="w-48 shrink-0 rounded-xl p-4">
                <PersonPortrait person={person} images={portraitImages} />
                <p className="text-sm font-medium">{String(person.name ?? "")}</p>
                <p className="mt-1 text-xs text-muted">{String(person.role ?? "")}</p>
              </div>)}</PeopleRow> : <p className="text-sm text-muted">{group.empty}</p>}
            </section>)}
            {library.library_type !== "anime" && library.library_type !== "books" && credits.length > 0 && (
              <section className="mt-8">
                <h2 className="mb-4 text-xl font-semibold">Cast and crew</h2>
                <PeopleRow label="cast and crew">
                  {credits.map((credit, i) => (
                    <div
                      key={i}
                      className="w-48 shrink-0 rounded-xl p-4"
                    >
                      <PersonPortrait person={credit} images={portraitImages} />
                      <p className="text-sm font-medium">
                        {String(credit.name ?? "")}
                      </p>
                      <p className="mt-1 text-xs text-muted">
                        {String(credit.role ?? credit.category ?? "")}
                      </p>
                    </div>
                  ))}
                </PeopleRow>
              </section>
            )}
            {entry.files.length > 0 && (
              <section className="mt-8">
                <h2 className="mb-4 text-xl font-semibold">
                  Media information
                </h2>
                {entry.files.map((file) => (
                  <div
                    key={file.path}
                    className="mb-3 rounded-xl border border-border bg-black/20 p-4"
                  >
                    <p className="break-all text-sm text-muted">{file.path}</p>
                    <p className="mt-2 text-xs text-faint">
                      {file.extension.toUpperCase()} ·{" "}
                      {(file.size / 1024 / 1024).toFixed(1)} MB
                      {file.media_info?.streams
                        ?.map(
                          (stream) =>
                            ` · ${String(stream.codec_name ?? "")}${stream.width ? ` ${stream.width}×${stream.height}` : ""}`,
                        )
                        .join("")}
                    </p>
                  </div>
                ))}
              </section>
            )}
            {entry.kind === "series" && <ItemAbout item={detail} />}
          </div>
        </div>
      </div>
    </>
  );
}


function nativeArtworkItem(library: NativeLibrary, entry: NativeCatalogEntry, entries: NativeCatalogEntry[]): ItemDetail {
  const target = (id: string) => `native:${library.id}:${id}`;
  const parent = entries.find(e => e.path === entry.parent_path);
  const series = entry.kind === "episode" ? entries.find(e => e.path === parent?.parent_path) : parent;
  const ids = {...(series?.metadata.identifiers as Record<string, unknown> ?? {}), ...(entry.metadata.identifiers as Record<string, unknown> ?? {})};
  return {
    id: target(entry.id), title: entry.title, year: number(entry.metadata.year),
    type: entry.kind === "book_series" ? "folder" : ["series", "season", "episode"].includes(entry.kind) ? "show" : entry.kind.startsWith("book") ? "book" : "movie",
    poster: picture(library, entry, entry.kind === "episode" ? "thumb" : "poster"),
    background: picture(library, entry, "backdrop"), logo: picture(library, entry, "logo"),
    external_ids: Object.fromEntries(Object.entries(ids as Record<string, unknown>).map(([key, value]) => [key.toLowerCase(), String(value)])),
    volume: entry.metadata.volume == null ? null : String(entry.metadata.volume), file_name: entry.path.split("/").pop(),
    seasons: entries.filter(e => e.kind === "season" && e.parent_path === entry.path).map(e => ({id:target(e.id),title:e.title,index:number(e.metadata.season)})), members: entries.filter(e=>e.kind==="book" && e.available && e.parent_path===entry.path).map(e=>({id:target(e.id),title:e.title,type:"book",volume:e.metadata.volume == null ? null : String(e.metadata.volume),file_name:e.path.split("/").pop(),poster:picture(library,e,"poster")})),
  };
}
