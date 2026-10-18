import SearchField from "./SearchField";
import HeaderSearchControl from "./HeaderSearchControl";
import LibraryDetailLayout, {LibraryDetailHero, LibraryDetailSection} from "./LibraryDetailLayout";
import CharacterHoverCard from "./CharacterHoverCard";
import LibrarySelection, {useLibrarySelection} from "../features/collections/LibrarySelection";
import {collectionsApi,useCollections,useCollectionAccount} from "../features/collections/client";
import {groupLibraryTitles} from "../features/collections/grouping";
import CollectionCard from "../features/collections/CollectionCard";
import CollectionMembershipDialog from "../features/collections/CollectionMembershipDialog";
import {sizedArtwork} from "../lib/artworkSizes";
import {compareEpisodeOrder,placedSpecials} from "../lib/episodeOrder";
import { nativeArtworkVersion } from "../lib/nativeArtworkCache";
import AdminOnly from "./AdminOnly";
import {useIsAdmin} from "../lib/authContext";
import NativeSeriesPlay from "../features/playback/components/NativeSeriesPlay";
import {titleSortKey} from "../lib/titleSort";
import NativePlaybackActions from "../features/playback/components/NativePlaybackActions";
import EpisodeMediaInfo from "./EpisodeMediaInfo";
import VideoPreferences,{useVideoPreferences} from "./VideoPreferences";
import {stillArtwork} from "./AnimatedArtwork";
import {HOME_RESET_EVENT} from "../lib/homeNavigation";
import AnimeDubEditor from "./AnimeDubEditor";
import SeriesActionsDialog from "./SeriesActionsDialog";
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
import { useNavigate, useSearchParams } from "../lib/libraryNavigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Database,
  Film,
  Images,
  Fingerprint,
  ListFilter,
  MoreHorizontal,
  Pencil,
  RefreshCw,
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
import {catalogQueryOptions, useCatalogDetails} from "../lib/nativeCatalogQueries";
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
  BACKDROP_BLUR_EVENT,
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
  const overlay = overlayEnabled && edit?.enabled && entry?.artwork.some(a=>a.kind==="logo") ? `&logoOverlay=${encodeURIComponent(JSON.stringify({...edit,logo:`${nativeLibraries.artworkUrl(library.id,entry.id,"logo")}?v=${encodeURIComponent(nativeArtworkVersion(entry,"logo"))}`}))}` : "";
  const framing = animatedArtworkEnabled(library.id) && ["backdrop","backdrop-animated"].includes(kind) ? validFraming(entry?.metadata.backdropedit) : undefined;
  if (framing?.logo && entry) framing.logo={...framing.logo,enabled:framing.logo.enabled && entry.artwork.some(a=>a.kind==="logo"),src:`${nativeLibraries.artworkUrl(library.id,entry.id,"logo")}?v=${encodeURIComponent(nativeArtworkVersion(entry,"logo"))}`};
  if(kind==="thumb" && entry?.metadata.missing===true && !entry.artwork.some(a=>a.kind==="thumb") && typeof entry.metadata.expected_thumb_url==="string" && /^https:\/\/(?:image\.tmdb\.org|artworks\.thetvdb\.com)\//.test(entry.metadata.expected_thumb_url)) return entry.metadata.expected_thumb_url;
  return entry?.artwork.some((a) => a.kind === kind)
    ? `${nativeLibraries.artworkUrl(library.id, entry.id, kind)}?v=${encodeURIComponent(nativeArtworkVersion(entry,kind))}&format=${entry.artwork.find(a => a.kind === kind)?.path.split(".").pop()?.toLowerCase() ?? ""}${!animatedArtworkEnabled(library.id) ? "&still=1" : ""}${overlay}${framing ? `&backdropEdit=${encodeURIComponent(JSON.stringify(framing))}` : ""}`
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
function sizedPicture(src: string | undefined,width: number) {
  return src ? sizedArtwork(src,width) : undefined;
}
function Artwork({
  src,
  alt,
  className = "",
  width = 480,
}: {
  src?: string;
  alt: string;
  className?: string;
  width?: number;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return src && !failed ? (
    <AnimatedArtwork
      src={src}
      width={width}
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
  backdrop,
}: {
  backdrop?: string;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const [appearance,setAppearance]=useState(()=>({blur:backdropBlur(),overlay:backdropOverlay()}));
  useEffect(()=>{
    const update=()=>setAppearance({blur:backdropBlur(),overlay:backdropOverlay()});
    window.addEventListener(BACKDROP_BLUR_EVENT,update);
    window.addEventListener(BACKDROP_OVERLAY_EVENT,update);
    window.addEventListener("storage",update);
    return ()=>{window.removeEventListener(BACKDROP_BLUR_EVENT,update);window.removeEventListener(BACKDROP_OVERLAY_EVENT,update);window.removeEventListener("storage",update);};
  },[]);
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
      className={metadata ? "relative isolate m-auto h-[85dvh] max-h-[832px] w-[min(80rem,calc(100vw-2rem))] max-w-none overflow-hidden rounded-2xl border border-border bg-sidebar p-0 text-white backdrop:bg-black/70" : "relative isolate m-auto max-h-[90dvh] w-[min(80rem,calc(100vw-2rem))] max-w-none overflow-y-auto rounded-2xl border border-border bg-sidebar p-5 text-white backdrop:bg-black/70"}
    >
      {backdrop&&<div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden rounded-2xl"><img src={sizedArtwork(stillArtwork(backdrop),1280)} alt="" className="h-full w-full scale-110 object-cover" style={{filter:`blur(${appearance.blur}px)`}} onError={event=>{event.currentTarget.style.visibility="hidden";}}/><div className="absolute inset-0 md:hidden" style={{backgroundImage:backdropOverlayGradients(appearance.overlay).mobile}}/><div className="absolute inset-0 hidden md:block" style={{backgroundImage:backdropOverlayGradients(appearance.overlay).desktop}}/></div>}
      {title==="Identify"&&backdrop&&<div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 rounded-2xl bg-gradient-to-b from-black/10 via-black/25 to-black/50"/>}
      <header className={metadata ? "flex h-16 shrink-0 items-center gap-4 px-6 sm:px-8" : "mb-5 flex items-center justify-between gap-4"}>
        <h2 className={`text-lg font-semibold`}>{title}</h2>
        <button
          autoFocus
          aria-label="Close editor"
          className={metadata ? "ml-auto shrink-0 rounded-md p-1 text-muted hover:text-white" : detailActionClass}
          onClick={onClose}
         data-icon-button="true">
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
  const isAdmin=useIsAdmin();
  const collectionAccount=useCollectionAccount();
  const collections=useCollections(library.id);
  const collectionPreference=useQuery({queryKey:["collections",collectionAccount,"preferences",library.id],queryFn:()=>collectionsApi.preferences(library.id)});
  const [collectionError,setCollectionError]=useState("");
  const [savingCollectionPreference,setSavingCollectionPreference]=useState(false);
  const [membershipOpen,setMembershipOpen]=useState(false);
  useEffect(()=>setMembershipOpen(false),[collectionAccount,library.id]);
  const { enabled: backdropView } = useBackdropView(library.id);
  const [, , bookDisplay] = useTrackingOverlays(library.library_type === "books");
  const {hoverOnly}=useAnimatedArtworkPreference(library.id);
  const artworkPlugin=useArtworkPlugin();
  const artworkEnabled=isAdmin&&artworkPlugin.data?.enabled!==false;
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const navigate=useNavigate();
  const status = useQuery({
    enabled:isAdmin,
    queryKey: ["native-scan", library.id],
    queryFn: () => nativeLibraries.status(library.id),
    refetchInterval: (q) =>
      q.state.data?.status === "scanning" ? 2000 : library.options?.real_time_monitor ? 5000 : false,
  });
  const catalog = useQuery({
    ...catalogQueryOptions(library),
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    refetchInterval: status.data?.status === "scanning" ? 5000 : false,
  });
  useEffect(() => {
    const revision = status.data?.artwork_revision;
    if (revision == null) return;
    const key = ["native-catalog-artwork-revision", library.id];
    const previous = client.getQueryData<string>(key);
    client.setQueryDefaults(key, {gcTime: 30 * 60_000});
    client.setQueryData(key, revision);
    if (previous !== undefined && previous !== revision) {
      void client.invalidateQueries({queryKey: ["native-catalog", library.id]});
    }
  }, [status.data?.artwork_revision, library.id, client]);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("title");
  const [artFilter, setArtFilter] = useState("all");
  const [metadataFilter,setMetadataFilter]=useState("all");
  useEffect(()=>{const reset=()=>{setSearch("");setSort("title");setArtFilter("all");setMetadataFilter("all");};window.addEventListener(HOME_RESET_EVENT,reset);return()=>window.removeEventListener(HOME_RESET_EVENT,reset);},[]);
  const providerNames:Record<string,string>={comicvine:"ComicVine",anilist:"AniList",mal:"MyAnimeList",mangadex:"MangaDex",tmdb:"TheMovieDB",tvdb:"TheTVDB",anidb:"AniDB",imdb:"IMDb"};
  const providerKind=library.library_type==="books"?"book_series":library.library_type==="movies"?"movie":"series";
  const metadataProviders=(library.options?.metadata_providers?.[providerKind]??(library.library_type==="books"?["comicvine","anilist","mal"]:library.library_type==="anime"?["anilist","tmdb","tvdb","mal","anidb"]:library.library_type==="movies"?["tmdb","imdb"]:["tmdb","tvdb","imdb"])).filter(p=>providerNames[p]);
  const hasId=(entry:NativeCatalogEntry,provider:string)=>{const ids=entry.metadata.identifiers as Record<string,unknown>|undefined;const value=ids?.[provider];return (typeof value==="string"&&!!value.trim()&&value.trim()!=="0")||(typeof value==="number"&&value>0);};
  const [editor, setEditor] = useState<{
    id: string;
    kind: "metadata" | "artwork" | "identify" | "fetch-metadata" | "remove-identification" | "refresh-metadata" | "missing-files";
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
  useEffect(() => {
    if (!status.data) return;
    const current = {status: status.data.status, count: status.data.count};
    const key = ["native-catalog-scan-state", library.id];
    const previous = client.getQueryData<typeof current>(key);
    client.setQueryDefaults(key, {gcTime: 30 * 60_000});
    client.setQueryData(key, current);
    if (previous && current.status !== "scanning" && (previous.status === "scanning" || previous.count !== current.count)) {
      void client.invalidateQueries({queryKey: ["native-catalog", library.id]});
    }
  }, [status.data?.status, status.data?.count, client, library.id]);
  const details=useCatalogDetails(library,catalog.data,[params.get("native_library")===library.id?params.get("native_item")??undefined:undefined,editor?.id]);
  const view = details.view;
  const entries = view.entries;
  const requested =
    params.get("native_library") === library.id
      ? entries.find(
          (e) =>
            e.id ===
            (view.aliases.get(params.get("native_item") ?? "") ??
              params.get("native_item")),
        )
      : undefined;
  const selected=library.library_type==="books" && requested?.kind==="book" ? entries.find(e=>e.path===requested.parent_path && e.kind==="book_series") : requested;
  const pendingArtworkPage=useRef<string|null>(null);
  useEffect(()=>{if(!artworkEnabled){pendingArtworkPage.current=null;setEditor(current=>current?.kind==="artwork"?null:current);}},[artworkEnabled]);
  const pageItem = params.get("native_item");
  const pageLibrary = params.get("native_library");
  useEffect(() => {
    const target=pendingArtworkPage.current;
    pendingArtworkPage.current=null;
    if(artworkEnabled && target && target===pageItem && pageLibrary===library.id) setEditor({id:target,kind:"artwork"});
    else setEditor(current => current?.kind === "artwork" ? null : current);
  }, [pageItem, pageLibrary]);
  const open = (entry: NativeCatalogEntry) => {
    if(library.library_type==="books" && entry.kind==="book") {
      if(entry.metadata.missing===true) {if(!artworkEnabled)return;setEditor({id:entry.id,kind:"artwork"});return;}
      const parent=entries.find(e=>e.path===entry.parent_path && e.kind==="book_series");
      const back=new URLSearchParams(params);back.set("native_library",library.id);
      if(parent)back.set("native_item",parent.id);else back.delete("native_item");
      const returnPath=`/media/${encodeURIComponent(library.id)}?${back}`;
      navigate(`/read/native/${encodeURIComponent(library.id)}/${encodeURIComponent(entry.id)}?return=${encodeURIComponent(returnPath)}`);return;
    }
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
  const [refreshingArtwork,setRefreshingArtwork]=useState(false);
  const [refreshError,setRefreshError]=useState("");
  const refresh = async () => {
    if(refreshingArtwork)return;
    setRefreshingArtwork(true);setRefreshError("");
    try {if(selected){const result=await nativeLibraries.refreshArtwork(library.id,selected.id);setRefreshError(result.warnings.join(" · "));}await Promise.all([catalog.refetch(),details.refetch()]);}
    catch(error){setRefreshError((error as Error).message);}
    finally {setRefreshingArtwork(false);}
  };
  const [scanningFolder,setScanningFolder]=useState(false);
  const scanFolder=async(entry:NativeCatalogEntry)=>{setScanningFolder(true);setRefreshError("");try{await nativeLibraries.scanFolder(library.id,entry.id);await client.invalidateQueries({queryKey:["native-scan",library.id]});}catch(e){setRefreshError((e as Error).message);}finally{setScanningFolder(false);}};
  const visible = entries
    .filter(e=>showMissingEntry(library,e))
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
            a.kind === (artFilter === "missing-poster" ? "poster" : artFilter === "missing-banner" ? "banner" : "backdrop"),
        ),
    )
    .filter(e=>metadataFilter==="all" || (metadataFilter==="missing-ids" ? !Object.keys(providerNames).some(p=>hasId(e,p)) : metadataFilter==="missing-configured-ids" ? metadataProviders.some(p=>!hasId(e,p)) : metadataFilter==="missing-description" ? !String(e.metadata.plot??"").trim() : metadataFilter==="missing-year" ? !number(e.metadata.year) : !hasId(e,metadataFilter.replace("missing-id-",""))))
    .sort((a, b) =>
      sort === "title"
        ? titleSortKey(a.title, a.metadata.sorttitle).localeCompare(titleSortKey(b.title, b.metadata.sorttitle))
        : sort === "newest"
          ? (number(b.metadata.year) ?? 0) - (number(a.metadata.year) ?? 0)
          : (number(a.metadata.year) ?? 0) - (number(b.metadata.year) ?? 0),
    );
  const selectable=visible.filter(entry=>["movie","series"].includes(entry.kind)&&entry.available&&entry.metadata.missing!==true);
  const selection=useLibrarySelection(`${collectionAccount}:${library.id}`,selectable.map(entry=>entry.id),isAdmin&&!selected);
  const groupEnabled=collectionPreference.data?.group_collections===true&&!search.trim()&&artFilter==="all"&&metadataFilter==="all"&&!selection.active;
  const grouped=groupEnabled?groupLibraryTitles(visible,collections.data??[],library.id):{collections:[],entries:visible};
  const gridItems=[...grouped.entries.map(entry=>({entry,collection:undefined})),...grouped.collections.map(collection=>({entry:undefined,collection}))].sort((a,b)=>{
    const aTitle=a.entry?.title??a.collection!.title,bTitle=b.entry?.title??b.collection!.title;
    if(sort==="title")return titleSortKey(aTitle,a.entry?.metadata.sorttitle).localeCompare(titleSortKey(bTitle,b.entry?.metadata.sorttitle));
    const year=(item:typeof a)=>{if(item.entry)return number(item.entry.metadata.year)??0;const years=item.collection!.members.map(member=>number(member.entry.metadata.year)).filter((year):year is number=>year!=null);return years.length?Math.min(...years):0;};
    return sort==="newest"?year(b)-year(a):year(a)-year(b);
  });
  const saveGrouping=async(value:boolean)=>{
    setSavingCollectionPreference(true);setCollectionError("");
    try{const result=await collectionsApi.setPreferences(library.id,{group_collections:value});client.setQueryData(["collections",collectionAccount,"preferences",library.id],result);}
    catch(error){setCollectionError((error as Error).message);}finally{setSavingCollectionPreference(false);}
  };
  const updated = () => {
    if(editor) void client.invalidateQueries({queryKey:["item-detail0",0,`native:${library.id}:${editor.id}`]});
    void client.invalidateQueries({ queryKey: ["native-catalog", library.id] });
    setEditor(null);
  };
  const editEntry = editor && details.isReady(editor.id) && entries.find((e) => e.id === editor.id);
  let posterEntry=editEntry || undefined;
  const posterParents=new Set<string>();
  while(posterEntry?.parent_path&&!posterParents.has(posterEntry.path)){
    posterParents.add(posterEntry.path);
    const parent=entries.find(e=>e.path===posterEntry?.parent_path);
    if(!parent)break;
    posterEntry=parent;
  }
  const editorBackdrop=picture(library,posterEntry,"backdrop")??picture(library,editEntry || undefined,"backdrop");
  const backgroundUrls = useMemo(
    () =>
      (catalog.data ?? [])
        .filter((e) => e.available && !e.parent_path)
        .map((e) => picture(library, e, "backdrop"))
        .filter((url): url is string => !!url)
        .map(url=>sizedArtwork(url,1920))
        .slice(0, 8),
    [catalog.data, library],
  );
  const posterUrls = useMemo(
    () =>
      (catalog.data ?? [])
        .filter((e) => e.available && !e.parent_path)
        .map((e) => picture(library, e, "poster"))
        .filter((url): url is string => !!url)
        .map(url=>sizedArtwork(url,640))
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
          {catalog.error.message} <button onClick={()=>void catalog.refetch()}>Retry</button>
        </p>
      )}
      {details.error && <p role="alert" className="relative z-10 px-6 py-2 text-danger">{details.error.message} <button onClick={()=>void details.refetch()}>Retry</button></p>}
      {editor && !editEntry && details.pending && <p role="status" className="p-8 text-muted">Loading editor…</p>}
      {refreshError && <p role="alert" className="relative z-10 px-6 py-2 text-sm text-danger">{refreshError}</p>}
      {selected ? (details.isReady(selected.id) ? <NativeDetail
          key={selected.id}
          library={library}
          entry={selected}
          entries={entries}
          open={open}
          back={back}
          refresh={refresh}
          fetching={catalog.isFetching || refreshingArtwork}
          edit={(kind, id = selected.id) => setEditor({ id, kind })}
          showBackdrop={showBackdrop}
          overlay={overlay}
        /> : <p role="status" className="p-8 text-muted">Loading title…</p>
      ) : (
        <>
          <div className="relative z-30 grid shrink-0 items-center gap-3 border-b border-border px-4 pb-3 pt-5 sm:grid-cols-[1fr_auto] sm:px-6 lg:grid-cols-[1fr_auto_1fr] lg:px-8">
            <h1 className="min-w-0 truncate text-xl font-semibold">{library.name}</h1>
            <div className="flex items-center justify-center gap-2">
              <HeaderSearchControl><div className="flex w-full min-w-0 items-center justify-center gap-2"><div className="relative min-w-0 w-full max-w-[21rem]">
                <SearchField aria-label="Search titles" value={search} onChange={e=>setSearch(e.target.value)}/>
              </div>
              <LibraryPopup title="Filters and sorting" label="Filter and sort titles" icon={<ListFilter className="size-4"/>} style={style} editorStyle>
                  <h3 className="mb-3 text-sm font-semibold">Artwork</h3>
                  <label className="block text-xs text-muted">
                    Artwork availability
                    <select
                      aria-label="Filter by artwork"
                      className="mt-2 h-10 w-full rounded-lg border border-border bg-input px-3 text-sm text-white"
                      value={artFilter}
                      onChange={(e) => setArtFilter(e.target.value)}
                    >
                      <option value="all">All titles</option>
                      <option value="missing-poster">Missing poster</option>
                      <option value="missing-backdrop">Missing backdrop</option>
                      <option value="missing-banner">Missing banner</option>
                    </select>
                  </label>
                  <h3 className="mb-3 mt-6 border-t border-border pt-5 text-sm font-semibold">Metadata</h3>
                  <label className="block text-xs text-muted">Metadata availability
                    <select aria-label="Filter by metadata" className="mt-2 h-10 w-full rounded-lg border border-border bg-input px-3 text-sm text-white" value={metadataFilter} onChange={e=>setMetadataFilter(e.target.value)}>
                      <option value="all">All titles</option><option value="missing-ids">No provider IDs</option><option value="missing-configured-ids">Missing configured provider IDs</option>
                      {metadataProviders.map(p=><option key={p} value={`missing-id-${p}`}>Missing {providerNames[p]} ID</option>)}
                      <option value="missing-description">Missing description</option><option value="missing-year">Missing year</option>
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
              </LibraryPopup>
              <LibraryPopup title="Preferences" label="Library preferences" icon={<MoreHorizontal className="size-4"/>} style={style} editorStyle>
                <div className="space-y-7">
                {library.library_type!=="books"&&<label className="flex items-center justify-between gap-3 text-sm">Group titles into collections<input type="checkbox" checked={collectionPreference.data?.group_collections===true} disabled={collectionPreference.isPending||savingCollectionPreference} onChange={event=>void saveGrouping(event.target.checked)}/></label>}
                {isAdmin&&library.library_type!=="books"&&<button type="button" className="rounded-full border border-border px-3 py-2 text-sm" onClick={event=>{event.currentTarget.closest("dialog")?.close();selection.start();}}>Select titles</button>}
                {collectionError&&<p role="alert" className="text-sm text-danger">{collectionError}</p>}
                <LibraryViewPreferences library={library.id}/>
                <ArtworkPreferences library={library.id}/>{library.library_type === "books" && <BookPreferences/>}{library.library_type === "anime" && <AnimePreferences library={library.id}/>} {(["shows","movies"].includes(library.library_type))&&<VideoPreferences library={library.id}/>}</div>
              </LibraryPopup>
              </div></HeaderSearchControl>
            </div>
            {status.data?.status === "scanning" && status.data.show_progress !== false ? <aside aria-label="Library scan progress" className="w-full min-w-0 lg:ml-auto lg:max-w-80"><NativeScanProgress status={status.data} compact/></aside> : <div aria-hidden="true" className="hidden lg:block"/>}
          </div>
          <div className="scrollbar-hidden relative z-10 min-h-0 flex-1 overflow-y-auto px-4 pb-8 sm:px-6 lg:px-8">
            {collectionPreference.data?.group_collections&&collections.isError&&<p role="alert" className="mb-3 text-sm text-muted">Collections could not be loaded. Showing individual titles. <button type="button" className="underline" onClick={()=>void collections.refetch()}>Retry collections</button></p>}
            {selection.active&&<LibrarySelection count={selection.ids.size} hidden={selection.hidden} onAll={selection.selectAll} onClear={selection.clear} onAdd={()=>setMembershipOpen(true)}/>}
            <div className="mb-4 flex items-center justify-between text-xs text-faint">
              <span>{grouped.collections.length?`${grouped.entries.length} titles · ${grouped.collections.length} collections`:`${visible.length} titles`}</span>
            </div>
            <div className={backdropView ? backdropGrid : posterGrid}>
              {gridItems.map(({entry,collection}) => collection?<CollectionCard key={`collection-${collection.id}`} collection={collection} backdropView={backdropView}/>:entry&&(
                <PosterCard
                  selected={selection.ids.has(entry.id)}
                  selectionMode={selection.active}
                  onSelect={isAdmin&&selectable.some(item=>item.id===entry.id)?range=>selection.toggle(entry.id,range):undefined}
                  animationOnHover={hoverOnly}
                  key={entry.id}
                  coloredEffect={library.library_type === "books" && String(entry.metadata.edition ?? "").trim().toLowerCase() === "colored" ? bookDisplay.coloredEffect : "off"}
                  coloredTitle={library.library_type === "books" && String(entry.metadata.edition ?? "").trim().toLowerCase() === "colored" && bookDisplay.coloredTitle}
                  title={entry.title}
                  menuImage={sizedPicture(entry.artwork.some(a=>a.kind==="poster-animated")?`${nativeLibraries.artworkUrl(library.id,entry.id,"poster-animated")}?v=${encodeURIComponent(nativeArtworkVersion(entry,"poster-animated"))}&format=${entry.artwork.find(a=>a.kind==="poster-animated")?.path.split(".").pop()?.toLowerCase()}&still=1`:picture(library,entry,"poster"),480)}
                  backdropView={backdropView}
                    image={sizedPicture((backdropView ? picture(library, entry, "backdrop") ?? picture(library, entry, "landscape") : undefined) ?? picture(library, entry, "poster"),backdropView ? 640 : 480)}
                  subtitle={String(entry.metadata.year ?? "")}
                  kind={
                    entry.kind === "series"
                      ? "show"
                      : entry.kind.startsWith("book")
                        ? "book"
                        : "movie"
                  }
                  onOpen={() => open(entry)}
                  onEditMetadata={isAdmin ? () => setEditor({ id: entry.id, kind: "metadata" }) : undefined}
                  onRefresh={isAdmin?refresh:undefined}
                  actions={isAdmin&&["series","book_series","movie"].includes(entry.kind)?[
                    ...(artworkEnabled?[{label:"Edit Images",icon:<Images className="size-4 shrink-0"/>,onClick:()=>{pendingArtworkPage.current=entry.id;open(entry);}}]:[]),
                    {label:"Identify",icon:<Fingerprint className="size-4 shrink-0"/>,onClick:()=>setEditor({id:entry.id,kind:"identify"})},
                    {label:"Remove Identification",icon:<ListFilter className="size-4 shrink-0"/>,disabled:status.data?.status==="scanning",onClick:()=>setEditor({id:entry.id,kind:"remove-identification"})},
                    {label:"Refresh Metadata",icon:<RefreshCw className="size-4 shrink-0"/>,onClick:()=>setEditor({id:entry.id,kind:"refresh-metadata"})},
                    ...(entry.kind==="series"||entry.kind==="book_series"?[{label:entry.kind==="series"?"View Missing Episodes":"View Missing Files",icon:<ListFilter className="size-4 shrink-0"/>,onClick:()=>setEditor({id:entry.id,kind:"missing-files"})}]:[])
                  ]:[]}
                  onScan={isAdmin&&["series","book_series","season"].includes(entry.kind)&&entry.metadata.missing!==true?()=>void scanFolder(entry):undefined}
                  scanning={scanningFolder||status.data?.status==="scanning"}
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
      {membershipOpen&&isAdmin&&<CollectionMembershipDialog members={[...selection.ids].map(item_id=>({library_id:library.id,item_id}))} onClose={()=>setMembershipOpen(false)} onSaved={()=>{selection.clear();}}/>}
      {isAdmin && editEntry && (editor?.kind === "artwork" ? (
        artworkEnabled && <div className="pointer-events-none fixed inset-0 z-50 bg-transparent">
          <section aria-label={`Artwork for ${editEntry.title}`} className="pointer-events-auto ml-auto h-full w-full max-w-md shadow-2xl" onClick={event => event.stopPropagation()}>
            <ArtworkPanel serverId={0} item={nativeArtworkItem(library, editEntry, entries)} libraryTitle={library.name} libraryType={library.library_type === "anime" ? "anime" : library.library_type === "books" ? "book" : library.library_type === "movies" ? "movie" : "show"} onClose={() => setEditor(null)} />
          </section>
        </div>
      ) : editor && ["remove-identification","refresh-metadata","missing-files"].includes(editor.kind) ? (
        <Modal backdrop={editorBackdrop} title={editor.kind==="remove-identification"?"Remove Identification":editor.kind==="refresh-metadata"?"Refresh Metadata":editEntry.kind==="series"?"Missing Episodes":"Missing Files"} onClose={()=>setEditor(null)}><SeriesActionsDialog action={editor.kind} library={library} entry={editEntry} entries={entries} onSaved={()=>{updated();void client.invalidateQueries({queryKey:["native-scan",library.id]});}}/></Modal>
      ) : editor?.kind === "fetch-metadata" ? (
        <Modal backdrop={editorBackdrop} title="Fetch Metadata" onClose={()=>setEditor(null)}><FetchBookMetadata library={library} entry={editEntry} busy={status.data?.status === "scanning"} onSaved={updated}/></Modal>
      ) : editor?.kind === "identify" ? (
        <Modal backdrop={editorBackdrop} title="Identify" onClose={() => setEditor(null)}>
          <IdentifyPanel library={library} entry={editEntry} busy={false} onSaved={updated}/>
        </Modal>
      ) : (
        <Modal backdrop={editorBackdrop} title="Edit Metadata" onClose={() => setEditor(null)}>
          <EntryEditor library={library} entry={editEntry} busy={false} onSaved={updated} dialog />
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
  edit: (kind: "metadata" | "artwork" | "identify" | "fetch-metadata", id?: string) => void;
  showBackdrop: boolean;
  overlay: number;
}) {
  const isAdmin=useIsAdmin();
  const [editingDubs,setEditingDubs]=useState(false);
  const [versionId,setVersionId]=useState<string|undefined>();
  useEffect(()=>setVersionId(undefined),[entry.id]);
  const dubClient=useQueryClient();
  const {hoverOnly}=useAnimatedArtworkPreference(library.id);
  const {value:animePreferences} = useAnimePreferences(library.id);
  const {value:videoPreferences}=useVideoPreferences(library.id);
  const parent = entries.find((e) => e.path === entry.parent_path);
  const series =
    entry.kind === "series"
      ? entry
      : entry.kind === "season"
        ? parent
        : entries.find((e) => e.path === parent?.parent_path);
  const artworkPlugin=useArtworkPlugin();
  const inlineSpecials=new Set(placedSpecials(entries,entry,series,library.options?.show_specials_in_seasons===true).map(special=>special.id));
  const children = entries
    .filter((e) => e.available && (e.parent_path === entry.path || inlineSpecials.has(e.id)))
    .sort(
      (a, b) =>
        (a.kind==="episode"&&b.kind==="episode"&&library.options?.show_specials_in_seasons?compareEpisodeOrder(a,b,true):0)||
        (number(a.kind === "season" ? a.metadata.season : a.kind === "book" ? a.metadata.volume ?? a.metadata.chapter : a.metadata.episode) ??
          0) -
          (number(
            b.kind === "season" ? b.metadata.season : b.kind === "book" ? b.metadata.volume ?? b.metadata.chapter : b.metadata.episode,
          ) ?? 0) || titleSortKey(a.title, a.metadata.sorttitle).localeCompare(titleSortKey(b.title, b.metadata.sorttitle), undefined, {numeric:true}),
    );
  const [search, setSearch] = useState("");
  const [, , bookDisplay] = useTrackingOverlays(library.library_type === "books");
  const coloredBook = library.library_type === "books" && String(entry.metadata.edition ?? parent?.metadata.edition ?? "").trim().toLowerCase() === "colored";
  const isBookSeries = entry.kind === "book_series";
  useEffect(()=>setSearch(""),[entry.id]);
  const bookMatches=(child:NativeCatalogEntry)=>{
    const term=search.trim().toLocaleLowerCase();
    if(!term)return true;
    const numeric=term.match(/^(?:(volume|vol|chapter|ch)\s*)?(\d+(?:\.\d+)?)$/);
    if(numeric){const value=Number(numeric[2]);return (numeric[1]?.startsWith("ch")?[child.metadata.chapter]:numeric[1]?[child.metadata.volume]:[child.metadata.volume,child.metadata.chapter]).some(v=>v!=null&&Number(v)===value);}
    return [child.title,child.path.split("/").pop()].some(v=>v?.toLocaleLowerCase().includes(term));
  };
  const visibleBooks=children.filter(e=>e.kind!=="episode"&&showMissingEntry(library,e)&&(!isBookSeries||bookMatches(e)));
  const bookUnit = children.length > 0 && children.some(e=>e.metadata.chapter!=null) && children.every(e=>e.metadata.volume==null) ? "Chapter" : "Volume";
  const isSeries = entry.kind === "series" || entry.kind === "season";
  const isEpisode = entry.kind === "episode";
  const playable = entry.available && ["episode","movie"].includes(entry.kind) && entry.files.length>0;
  const siblings=isEpisode?entries.filter(sibling=>sibling.available&&sibling.kind==="episode"&&sibling.parent_path===entry.parent_path&&sibling.id!==entry.id&&showMissingEntry(library,sibling)).sort((a,b)=>(number(a.metadata.episode)??0)-(number(b.metadata.episode)??0)):[];
  const selectedFile=entry.files.find(file=>(file.version_id??file.path)===versionId)??entry.files[0];
  const streams=selectedFile?.media_info?.streams??[];
  const episodeTracks=["video","audio","subtitle"].map(type=>({type,values:streams.filter(stream=>stream.codec_type===type).map(stream=>[stream.width&&stream.height?`${stream.width}×${stream.height}`:"",String((stream.tags as Record<string,unknown>|undefined)?.language??""),String(stream.codec_name??"").toUpperCase()].filter(Boolean).join(" "))})).filter(track=>track.values.length>0);
  const headerMetadata = entry.kind === "season" ? {...series?.metadata,...Object.fromEntries(Object.entries(entry.metadata).filter(([,value])=>value!=null&&value!==""&&(!Array.isArray(value)||value.length>0)))} : entry.metadata;
  const headerSeasons = entry.kind === "season" && series ? entries.filter(e=>e.available&&e.parent_path===series.path&&e.kind==="season") : children.filter(e=>e.kind==="season");
  const detail: ItemDetail = {
    id: entry.id,
    title: entry.title,
    type:
      isSeries
        ? "show"
        : entry.kind.startsWith("book")
          ? "book"
          : "movie",
    year: number(headerMetadata.year),
    rating: number(headerMetadata.rating),
    content_rating: String(headerMetadata.mpaa ?? ""),
    tags: strings(headerMetadata.tags),
    genres: strings(headerMetadata.genres),
    studios: strings(headerMetadata.studios),
    season_count: headerSeasons.filter(e => number(e.metadata.season) !== 0 && !/^specials?$/i.test(e.title.trim())).length,
    seasons: headerSeasons
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
    (["season","episode"].includes(entry.kind) ? picture(library, series, "logo") : undefined);
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
      if (["shows","movies"].includes(library.library_type) && (credit.category==="crew"?!videoPreferences.crew:!videoPreferences.casts)) return false;
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
              width={1920}
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
      <LibraryDetailLayout
        back={back}
        landscape={isEpisode}
        toolbar={(isBookSeries || entry.kind === "season") && <div role="search" className="relative mx-auto w-full max-w-[21rem]">
              <SearchField aria-label={isBookSeries?"Search volumes and chapters":"Search episodes"} value={search} onChange={event=>setSearch(event.target.value)}/>
            </div>}
        hero={<LibraryDetailHero landscape={isEpisode}
          artwork={<>
            <Artwork src={poster} width={isEpisode ? 1280 : 640} alt={entry.title} />
                  {coloredBook && poster && ["shimmer","both"].includes(bookDisplay.coloredEffect) && <span aria-hidden="true" className="poster-colored-shimmer pointer-events-none absolute inset-0"/>}
                  {coloredBook && ["badge","both"].includes(bookDisplay.coloredEffect) && <span aria-label="Colored edition" className="poster-colored-badge pointer-events-none absolute bottom-2 right-2 rounded-md px-2 py-1 text-[10px] font-bold tracking-wider shadow">COLORED</span>}
          </>}
          synopsis={<DetailSynopsis text={overview} lines={isEpisode?3:8}/>}
        >
                <div className="flex flex-wrap items-center gap-3">
                {isEpisode ? (<><button onClick={()=>series&&open(series)} disabled={!series} className="block text-left" aria-label={series?`Open ${series.title}`:undefined}>{logo?<AnimatedArtwork src={logo} width={640} alt={series?.title??entry.title} className="max-h-20 max-w-[240px] object-contain object-left"/>:<span className="text-2xl font-semibold">{series?.title??"Episode"}</span>}</button><div className="mt-4 flex flex-wrap items-center gap-3"><h1 className="text-[17px] font-medium leading-snug">S{String(entry.metadata.season??parent?.metadata.season??1)}:E{String(entry.metadata.episode??"")} - {entry.title}</h1><AdminOnly><button aria-label="Edit Metadata" title="Edit Metadata" onClick={()=>edit("metadata")} className="episode-inline-action"><Pencil className="size-4"/></button></AdminOnly>{artworkPlugin.data?.enabled!==false&&<AdminOnly><button aria-label="Edit Images" title="Edit Images" onClick={()=>edit("artwork")} className="episode-inline-action"><Images className="size-4"/></button></AdminOnly>}<AdminOnly><button aria-label="Refresh" title="Refresh" disabled={fetching} onClick={refresh} className="episode-inline-action"><RefreshCw className={`size-4 ${fetching ? "animate-spin" : ""}`} /></button></AdminOnly></div></>) : logo ? (
                  <AnimatedArtwork
                    src={logo}
                    width={1280}
                    alt={entry.title}
                    className={isEpisode?"max-h-20 max-w-[240px] object-contain object-left":"max-h-24 max-w-full object-contain object-left sm:max-w-[400px]"}
                  />
                ) : (
                  <h1 className={`text-3xl font-bold leading-tight sm:text-4xl ${coloredBook && bookDisplay.coloredTitle ? "poster-colored-title" : ""}`}>
                    {entry.title}
                    {entry.metadata.missing === true && <span className="ml-3 inline-flex align-middle rounded-full border border-amber-400/40 bg-amber-400/15 px-3 py-1 text-xs text-amber-200">Missing</span>}
                  </h1>
                )}
                {!isEpisode&&<div data-testid="detail-actions" className="flex flex-wrap items-center gap-3">
                  <AdminOnly><button aria-label="Edit Metadata" title="Edit Metadata" onClick={()=>edit("metadata")} className="episode-inline-action"><Pencil className="size-4"/></button></AdminOnly>
                  {artworkPlugin.data?.enabled!==false&&<AdminOnly><button aria-label="Edit Images" title="Edit Images" onClick={()=>edit("artwork")} className="episode-inline-action"><Images className="size-4"/></button></AdminOnly>}
                  <AdminOnly><button aria-label="Refresh" title="Refresh" disabled={fetching} onClick={refresh} className="episode-inline-action"><RefreshCw className={`size-4 ${fetching?"animate-spin":""}`}/></button></AdminOnly>
                  {entry.kind.startsWith("book")&&<AdminOnly><button aria-label="Fetch Metadata" title="Fetch Metadata" onClick={()=>edit("fetch-metadata")} className="episode-inline-action"><Database className="size-4"/></button></AdminOnly>}
                  {["series","season","movie","book_series","book"].includes(entry.kind)&&<AdminOnly><button aria-label="Identify" title="Identify" onClick={()=>edit("identify")} className="episode-inline-action"><Fingerprint className="size-4"/></button></AdminOnly>}
                </div>}
                </div>
                {entry.kind === "season" && series && (
                  <button
                    className="mt-2 text-sm text-accent"
                    onClick={() => open(series)}
                  >
                    {entry.title} · {children.filter(e=>e.kind==="episode"&&showMissingEntry(library,e)).length} Episodes
                  </button>
                )}
                {isBookSeries ? <p className="mt-2 text-sm text-white/70">{children.filter(e=>e.metadata.missing!==true).length} {children.filter(e=>e.metadata.missing!==true).length === 1 ? bookUnit : `${bookUnit}s`}</p> : isEpisode ? <div aria-label="Title information" className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">{detail.rating!=null&&<span>★ {detail.rating.toFixed(1)}</span>}{typeof entry.metadata.aired==="string"&&entry.metadata.aired&&<span>{new Date(`${entry.metadata.aired.slice(0,10)}T12:00:00Z`).toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric",timeZone:"UTC"})}</span>}{entry.metadata.runtime!=null&&<span>{String(entry.metadata.runtime)}m</span>}{detail.content_rating&&<span className="rounded border border-white/40 px-1.5 text-xs">{detail.content_rating}</span>}</div> : <TitleMetadata item={detail} />}
                {entry.kind.startsWith("book") && <BookSeriesMetadata unit={isBookSeries ? bookUnit : entry.metadata.chapter!=null && entry.metadata.volume==null ? "Chapter" : "Volume"} metadata={entry.metadata} count={isBookSeries ? children.filter(e=>e.metadata.missing!==true).length : 1}/>}
                {playable&&episodeTracks.length>0&&<dl aria-label={isEpisode?"Episode media tracks":"Movie media tracks"} className="mt-4 flex flex-wrap gap-x-6 gap-y-3 text-sm">{episodeTracks.map(track=><div key={track.type} className="flex items-baseline gap-2"><dt className="font-medium capitalize">{track.type==="subtitle"?"Subtitles":track.type}</dt><dd className="text-muted">{track.values.join(" · ")}</dd></div>)}</dl>}
                {playable&&entry.files.length>1&&<label className="mt-4 flex items-center gap-3 text-sm">Version<select aria-label="Version" className="rounded-full border border-white/20 bg-black/50 px-5 py-2.5" value={selectedFile?.version_id??selectedFile?.path} onChange={event=>setVersionId(event.target.value)}>{entry.files.map(file=><option key={file.path} value={file.version_id??file.path}>{file.version_name??file.path.split("/").pop()}</option>)}</select></label>}
                {playable&&<NativePlaybackActions library={library.id} item={entry.id} versionId={selectedFile?.version_id??selectedFile?.path}/>}
                {(isSeries||entry.kind==="season")&&<NativeSeriesPlay library={library.id} path={entry.path} entries={entries} includeIds={[...inlineSpecials]} specialsInSeasons={library.options?.show_specials_in_seasons===true}/>}
        </LibraryDetailHero>}
        related={<>
            {children.some((e) => e.kind !== "episode" && showMissingEntry(library,e)) && (
              <LibraryDetailSection>
                <div className="mb-4">
                <h2 className="text-xl font-semibold">
                  {entry.kind === "series" ? "Seasons" : children.some(e=>e.metadata.chapter!=null) && children.every(e=>e.metadata.volume==null) ? "Chapters" : "Volumes"}
                </h2>

                </div>
                {isBookSeries&&visibleBooks.length===0&&<p role="status" className="py-4 text-muted">No matching volumes or chapters.</p>}
                <div className={isBookSeries ? posterGrid : "-mx-2 -mt-2 flex gap-5 overflow-x-auto px-2 pb-3 pt-2 [&>div]:w-[150px] [&>div]:shrink-0 sm:[&>div]:w-[180px]"}>
                  {visibleBooks
                    .map((child) => (
                      <PosterCard
                  animationOnHover={hoverOnly}
                        key={child.id}
                        coloredEffect={library.library_type === "books" && String(child.metadata.edition ?? entry.metadata.edition ?? "").trim().toLowerCase() === "colored" ? bookDisplay.coloredEffect : "off"}
                        coloredTitle={library.library_type === "books" && String(child.metadata.edition ?? entry.metadata.edition ?? "").trim().toLowerCase() === "colored" && bookDisplay.coloredTitle}
                        title={child.title}
                        titleBadge={child.metadata.missing === true ? "Missing" : undefined}
                        image={sizedPicture(picture(library, child, "poster"),480)}
                        kind={child.kind.startsWith("book") ? "book" : "show"}
                        openLabel={child.kind==="book" ? child.metadata.missing===true ? "Edit Images" : "Read" : "Open"}
                        onOpen={() => open(child)}
                      />
                    ))}
                </div>
              </LibraryDetailSection>
            )}
            {children.some((e) => e.kind === "episode" && showMissingEntry(library,e)) && (
              <LibraryDetailSection>
                <h2 className="mb-4 text-xl font-semibold">Episodes</h2>
                <div className="space-y-5">
                  {children
                    .filter(
                      (e) =>
                        e.kind === "episode" && (showMissingEntry(library,e)) &&
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
                          className="relative aspect-video w-32 shrink-0 overflow-hidden rounded-lg bg-base sm:w-64 lg:w-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
                          <Artwork
                            src={picture(library, episode, "thumb")}
                            width={640}
                            alt={`${episode.title} episode still`}
                          />
                        </button>
                        <div className="min-w-0 flex-1 py-1">
                          <div className="flex items-start gap-2">
                          <button
                            onClick={() => open(episode)}
                            className="text-left text-base font-semibold leading-snug text-white"
                          >
                            {String(episode.metadata.episode ?? "")}.{" "}
                            {episode.title}
                            {inlineSpecials.has(episode.id)&&<span className="ml-2 text-xs text-accent">Special</span>}
                            {episode.metadata.missing===true&&<span className="ml-2 rounded-full border border-amber-400/40 bg-amber-400/15 px-2 py-0.5 text-xs text-amber-200">Missing</span>}
                          </button>
                          <AdminOnly><button type="button" aria-label={`Edit NFO metadata for ${episode.title}`} title="Edit NFO metadata" onClick={()=>edit("metadata",episode.id)} className="episode-inline-action shrink-0"><Pencil aria-hidden="true" className="size-4"/></button></AdminOnly>
                          </div>
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
              </LibraryDetailSection>
            )}
            {isEpisode&&siblings.length>0&&<LibraryDetailSection><h2 className="mb-4 text-xl font-semibold">More from {parent?.title??`Season ${entry.metadata.season??1}`}</h2><div className="flex gap-5 overflow-x-auto pb-3">{siblings.map(sibling=><button key={sibling.id} aria-label={`Open episode ${sibling.metadata.episode??""}: ${sibling.title}`} onClick={()=>open(sibling)} className="group w-60 shrink-0 text-left sm:w-64"><div className="aspect-video overflow-hidden rounded-lg bg-surface-2"><Artwork src={picture(library,sibling,"thumb")} width={640} alt={`${sibling.title} episode still`}/></div><p className="mt-2 truncate text-sm font-medium">{String(sibling.metadata.episode??"")}. {sibling.title}</p></button>)}</div></LibraryDetailSection>}
        </>}
        people={<>
            {(library.library_type !== "anime" || animePreferences.characters) && Array.isArray(entry.metadata.characters) &&
              entry.metadata.characters.length > 0 && (
                <LibraryDetailSection>
                  <h2 className="mb-4 text-xl font-semibold">Characters</h2>
                  <PeopleRow label="characters">
                    {orderedCharacters(entry.metadata.characters, portraitImages).map((character, i) => (
                      <CharacterHoverCard key={i} person={character} portrait={<PersonPortrait person={character} images={portraitImages} />}>
                        <PersonPortrait person={character} images={portraitImages} />
                        <p className="text-sm font-medium">{String(character.name ?? "")}</p>
                        <p className="mt-1 text-xs text-muted">{String(character.role ?? "")}</p>
                      </CharacterHoverCard>
                    ))}
                  </PeopleRow>
                </LibraryDetailSection>
              )}

            {isAdmin && editingDubs && library.library_type==="anime" && <Modal backdrop={picture(library,entry,"backdrop")} title="Edit Dub Credits" onClose={()=>setEditingDubs(false)}><AnimeDubEditor library={library} entry={entry} onSaved={()=>{setEditingDubs(false);void dubClient.invalidateQueries({queryKey:["native-catalog",library.id]});}}/></Modal>}
            {animePreferences.casts && voiceCast?.groups.filter((_,index)=> index===0 ? animePreferences.original || (voiceCast.groups.length===1 && animePreferences.dub) : animePreferences.dub).map(group => <LibraryDetailSection key={group.title}>
              <div className="mb-4 flex items-center gap-3"><h2 className="text-xl font-semibold">{group.title}</h2><AdminOnly><button aria-label={`Edit dub credits for ${group.title}`} title="Edit dub credits" className="rounded-full border border-border p-2 text-muted hover:text-white" onClick={()=>setEditingDubs(true)} data-icon-button="true"><Pencil className="size-4"/></button></AdminOnly></div>
              {group.cast.length ? <PeopleRow label={group.title}>{group.cast.map((person, i) => <div key={i} className="w-48 shrink-0 rounded-xl p-4">
                <PersonPortrait person={person} images={portraitImages} />
                <p className="text-sm font-medium">{String(person.name ?? "")}</p>
                <p className="mt-1 text-xs text-muted">{String(person.role ?? "")}</p>
              </div>)}</PeopleRow> : <p className="text-sm text-muted">{group.empty}</p>}
            </LibraryDetailSection>)}
            {library.library_type !== "anime" && library.library_type !== "books" && credits.length > 0 && (
              <LibraryDetailSection>
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
              </LibraryDetailSection>
            )}
        </>}
        about={(entry.kind==="series"||entry.metadata.missing!==true)&&!entry.kind.startsWith("book")&&<ItemAbout item={detail}/>}
        media={<>
            {entry.files.length > 0 && (isEpisode ? <EpisodeMediaInfo files={entry.files}/> : (
              <LibraryDetailSection>
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
              </LibraryDetailSection>
            ))}
        </>}
      />
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
    seasons: entries.filter(e => e.kind === "season" && e.parent_path === entry.path && showMissingEntry(library,e)).map(e => ({id:target(e.id),title:e.title,index:number(e.metadata.season)})), members: entries.filter(e=>e.kind==="book" && e.available && e.parent_path===entry.path).map(e=>({id:target(e.id),title:e.title,type:"book",volume:e.metadata.volume == null ? null : String(e.metadata.volume),file_name:e.path.split("/").pop(),poster:picture(library,e,"poster")})),
  };
}

function showMissingEntry(library:NativeLibrary,e:NativeCatalogEntry){return e.metadata.missing!==true || (library.options?.show_missing_files!==false && (library.options?.show_missing_specials===true || Number(e.metadata.season)!==0));}
