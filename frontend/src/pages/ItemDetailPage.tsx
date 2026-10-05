import {useArtworkPlugin} from "../lib/artworkPlugin";
import AnimatedArtwork from "../components/AnimatedArtwork";
import {connectedBackdropUrl} from "../lib/backdropFraming";
import { detailActionClass } from "../lib/detailActions";
import DetailSynopsis from "../components/DetailSynopsis";
// Item detail: a cinematic hero (blurred backdrop, large poster, metadata) with
// a seasons row, and the ThePosterDB panel docked on the right for swapping art.

import { useEffect, useState } from "react";
import { useBookInfo } from "../lib/bookInfo";
import { useTrackingOverlays } from "../lib/libraryDisplay";
import { LibraryBackdrop } from "../lib/libraryNavigation";
import { useNavigate, useParams, useSearchParams } from "../lib/libraryNavigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, Images, Pencil, RefreshCw } from "lucide-react";
import { api, imageUrl } from "../api/client";
import PosterCard from "../components/PosterCard";
import ArtworkPanel from "../components/ArtworkPanel";
import MetadataEditorModal from "../components/MetadataEditorModal";
import ItemAbout from "../components/ItemAbout";
import TitleMetadata from "../components/TitleMetadata";
import { Spinner, EmptyState } from "../components/ui";
import type { Library, NfoMetadata } from "../types";
import { isBookRelatedLibraryName, seriesInstallmentInfo, seriesInstallmentSummary } from "../lib/mediaKind";
import { BACKDROP_OVERLAY_EVENT, DASHBOARD_BACKDROP_EVENT, backdropOverlay, backdropOverlayGradients, dashboardBackdropEnabled } from "../lib/dashboardSettings";

function sentenceCaseMetadata(value: string): string {
  const normalized = value.trim().replaceAll("_", " ").toLowerCase();
  return normalized ? normalized[0].toUpperCase() + normalized.slice(1) : normalized;
}

export default function ItemDetailPage() {
  const artworkPlugin=useArtworkPlugin();
  const navigate = useNavigate();
  const { serverId: serverIdParam, itemId } = useParams();
  const [searchParams] = useSearchParams();
  const serverId = Number(serverIdParam);
  const libraryType = searchParams.get("library_type") as Library["type"] | null;
  const libraryTitle = searchParams.get("library_title") ?? undefined;
  const returnLibrary = searchParams.get("return_library");
  const returnFolder = searchParams.get("return_folder");
  const returnFolderTitle = searchParams.get("return_folder_title");
  const goBack = () => {
    if (!returnLibrary) {
      navigate(-1);
      return;
    }
    const destination = new URLSearchParams({ lib: returnLibrary });
    if (returnFolder) destination.set("folder", returnFolder);
    if (returnFolderTitle) destination.set("folder_title", returnFolderTitle);
    navigate(`/?${destination.toString()}`);
  };
  const [prefill, setPrefill] = useState<{ term: string; nonce: number }>();
  const [artworkTarget, setArtworkTarget] = useState<{ provider: string; value: string; nonce: number }>();
  const [artworkOpen, setArtworkOpen] = useState(false);
  useEffect(() => { setArtworkOpen(false); }, [serverId, itemId]);
  const [showBackdrop, setShowBackdrop] = useState(dashboardBackdropEnabled);
  const [overlayStrength, setOverlayStrength] = useState(backdropOverlay);
  const [metadataEditorOpen, setMetadataEditorOpen] = useState(
    () => searchParams.get("edit_metadata") === "1",
  );
  const [metadataImport, setMetadataImport] = useState<{ fields: NfoMetadata; sourceLabel: string } | null>(null);
  const queryClient = useQueryClient();
  const detailQ = useQuery({
    queryKey: ["item-detail", serverId, itemId],
    queryFn: () => api.getItemDetail(serverId, itemId!),
    enabled: Number.isFinite(serverId) && !!itemId,
  });
  const metadataQ = useQuery({
    queryKey: ["nfo-metadata", serverId, itemId],
    queryFn: () => api.getNfoMetadata(serverId, itemId!),
    enabled: Number.isFinite(serverId) && !!itemId && !!detailQ.data && !["movie", "show"].includes(detailQ.data.type),
    retry: false,
  });
  const saveMetadata = useMutation({
    mutationFn: (fields: NonNullable<typeof metadataQ.data>) =>
      api.updateNfoMetadata(serverId, itemId!, fields),
    onSuccess: (fields) => {
      queryClient.setQueryData(["nfo-metadata", serverId, itemId], fields);
      void queryClient.invalidateQueries({ queryKey: ["book-info"] });
      setMetadataImport(null);
      setMetadataEditorOpen(false);
    },
  });
  const bookContext = libraryType === "book" || libraryType === "audiobook" ||
    (libraryType === "other" && isBookRelatedLibraryName(libraryTitle ?? "")) ||
    (!libraryType && (detailQ.data?.type === "book" || detailQ.data?.members.some(member => member.type === "book") === true));
  const [trackingOverlays, , displayStatus] = useTrackingOverlays(bookContext);
  const item = detailQ.data && { ...detailQ.data, title: bookContext && detailQ.data.type === "folder" ? metadataQ.data?.title.trim() || detailQ.data.title : detailQ.data.title };
  const memberInfo = useBookInfo(serverId, item?.members, bookContext);
  const isSeries = item?.type === "show";
  const backdrop = connectedBackdropUrl(imageUrl(serverId, item?.background),serverId,item?.id??"");
  const poster = imageUrl(serverId, item?.poster);
  const logo = imageUrl(serverId, item?.logo);
  const installmentInfo = item?.type === "folder" ? seriesInstallmentInfo(item.members) : null;
  const expectedInstallments = Number.parseInt(metadataQ.data?.volumes ?? "", 10);
  const missingInstallments =
    installmentInfo && Number.isFinite(expectedInstallments)
      ? Math.max(0, expectedInstallments - installmentInfo.count)
      : 0;
  const publisherArtworkTarget = metadataQ.data?.source_url
    .split(/\r?\n/)
    .map((url) => url.trim())
    .filter(Boolean)
    .map((url) => {
      if (url.includes("comicvine.gamespot.com")) {
        const comicVineId = metadataQ.data?.comicvine_id || url.match(/\/volume\/4050-(\d+)/i)?.[1];
        return comicVineId ? { provider: "comicvine", value: comicVineId } : null;
      }
      const anilistId = url.match(/anilist\.co\/manga\/(\d+)/i)?.[1];
      if (anilistId) return { provider: "anilist-manga", value: anilistId };
      return null;
    })
    .find((target) => target !== null);

  // Auto-run the artwork search for this title when it loads (once per item).
  useEffect(() => {
    if (item?.title) setPrefill({ term: item.title, nonce: Date.now() });
  }, [item?.id, item?.title]);

  useEffect(() => {
    const update = (event: Event) => setShowBackdrop((event as CustomEvent<boolean>).detail);
    const updateOverlay = (event: Event) => setOverlayStrength((event as CustomEvent<number>).detail);
    window.addEventListener(DASHBOARD_BACKDROP_EVENT, update);
    window.addEventListener(BACKDROP_OVERLAY_EVENT, updateOverlay);
    return () => {
      window.removeEventListener(DASHBOARD_BACKDROP_EVENT, update);
      window.removeEventListener(BACKDROP_OVERLAY_EVENT, updateOverlay);
    };
  }, []);

  useEffect(() => {
    if (!artworkOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setArtworkOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [artworkOpen]);

  return (
    <div className="relative flex h-full overflow-hidden">
      {showBackdrop && (<LibraryBackdrop>
        <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden bg-base" aria-hidden="true" data-testid="item-backdrop">
          {backdrop && (
            <AnimatedArtwork
              fill
              src={backdrop}
              alt=""
              className="h-full w-full origin-top scale-[1.02] object-cover object-top"
            />
          )}
          <div className="absolute inset-0 md:hidden" data-testid="item-backdrop-overlay-mobile" style={{ backgroundImage: backdropOverlayGradients(overlayStrength).mobile }} />
          <div className="absolute inset-0 hidden md:block" data-testid="item-backdrop-overlay-desktop" style={{ backgroundImage: backdropOverlayGradients(overlayStrength).desktop }} />
        </div></LibraryBackdrop>)}

      {/* Left: hero + seasons */}
      <div className={`${isSeries ? "media-detail " : ""}scrollbar-hidden relative z-[1] h-full flex-1 overflow-y-auto overscroll-y-contain`}>
        {/* min-h-full lets this wrapper be at least a viewport tall but grow to
            the full scrolled content height. The darkening layer below is
            absolute inset-0 against THIS wrapper, so it covers every season row
            — not just the first viewport. (An absolute inset-0 sized against the
            scroll container itself only spans one visible viewport and scrolls
            away, leaving multi-season shows showing the raw, undarkened backdrop
            at the bottom.) */}
        <div className="relative min-h-full">
          {/* Back button */}
          <button
            onClick={goBack}
            className="absolute left-5 top-5 z-10 grid size-9 place-items-center rounded-full bg-black/40 text-white backdrop-blur transition-colors hover:bg-black/70"
            aria-label="Back"
          >
            <ArrowLeft className="size-5" />
          </button>

          <div className="relative z-[1] px-4 pb-8 pt-16 sm:px-6 sm:pb-10 lg:px-10 lg:pt-20">
            {detailQ.isLoading && <Spinner label="Loading…" />}
            {detailQ.isError && (
              <EmptyState title="Couldn't load this title">
                {(detailQ.error as Error).message}
              </EmptyState>
            )}

            {item && (
              <>
                <div className={isSeries ? "flex flex-row items-start gap-5 sm:gap-8 lg:gap-9" : "flex flex-col items-center gap-5 sm:flex-row sm:items-start sm:gap-6"}>
                  {/* Poster */}
                  <div className={isSeries ? "w-28 shrink-0 sm:w-[25%] sm:max-w-[328px]" : "w-40 shrink-0 min-[390px]:w-44 sm:w-48 lg:w-56"}>
                    <div className="aspect-[2/3] overflow-hidden rounded-xl bg-surface-2 shadow-2xl shadow-black/50 ring-1 ring-white/10">
                      {poster ? (
                        <img
                          src={poster}
                          alt={item.title}
                          className="h-full w-full object-cover"
                        />
                      ) : null}
                    </div>
                  </div>

                  {/* Metadata — a text-shadow (not just the gradient) keeps this
                    legible over a vivid/bright backdrop image, since the exact
                    gradient fade point can't account for every image. */}
                  <div className={`min-w-0 flex-1 pt-2 [text-shadow:0_2px_12px_rgba(0,0,0,0.8)] ${isSeries ? "text-left" : "text-center sm:text-left"}`}>
                    <div className="flex flex-col gap-4">
                      <div className="min-w-0">
                        {logo ? (
                          <img
                            src={logo}
                            alt={item.title}
                            className={isSeries ? "max-h-24 max-w-full object-contain object-left sm:max-w-[400px]" : "mx-auto max-h-24 max-w-full object-contain sm:mx-0 sm:max-h-28 sm:object-left"}
                          />
                        ) : (
                          <h1 className="text-3xl font-bold leading-tight sm:text-4xl">
                            {item.title}
                          </h1>
                        )}
                        {item.type === "show" || item.type === "movie" ? <TitleMetadata item={item} /> : <p className="mt-2 text-sm text-white/70">
                          {item.type === "collection"
                              ? "Collection"
                              : item.type === "book"
                                ? "Book"
                                : item.type === "audiobook"
                                  ? "Audiobook"
                                  : item.type === "folder"
                                    ? seriesInstallmentSummary(item.members)
                                    : item.year}
                        </p>}
                      </div>
                      <div data-testid="detail-actions" className="flex flex-wrap items-center gap-2">
                        {metadataQ.data && (
                          <button
                            type="button"
                            onClick={() => { setMetadataImport(null); setMetadataEditorOpen(true); }}
                            className={detailActionClass}
                            aria-label="Edit Metadata"
                            title="Edit Metadata"
                          >
                            <Pencil className="size-4" aria-hidden="true" />
                          </button>
                        )}
                      <button
                        onClick={() => { void detailQ.refetch(); if (item.type !== "show" && item.type !== "movie") void metadataQ.refetch(); }}
                        className={detailActionClass}
                        aria-label={isSeries ? "Refresh Series" : "Refresh"}
                        title={isSeries ? "Refresh Series" : "Refresh from server"}
                      >
                        <RefreshCw
                          className={`size-4 ${detailQ.isFetching ? "animate-spin" : ""}`} aria-hidden="true"
                        />

                      </button>
                      {artworkPlugin.data?.enabled !== false && <button type="button" onClick={() => setArtworkOpen(true)} aria-label="Edit Artwork" title="Edit Artwork" aria-expanded={artworkOpen} aria-controls="item-artwork-panel" className={detailActionClass}>
                        <Images className="size-4" aria-hidden="true" />
                      </button>}
                      </div>
                    </div>

                    {!isSeries && !metadataQ.data && item.summary && (
                      <p className="mt-4 max-w-2xl text-sm leading-relaxed text-white/80">
                        {item.summary}
                      </p>
                    )}
                    {isSeries && <div className="hidden sm:block"><DetailSynopsis key={item.id} text={item.summary} /></div>}
                    {metadataQ.data && (
                      <section className="mt-4 max-w-2xl text-left [text-shadow:0_2px_12px_rgba(0,0,0,0.8)]">
                        <div className="flex flex-wrap items-center gap-2">
                          {[
                            metadataQ.data.year && ["Year", metadataQ.data.year],
                            metadataQ.data.publisher && ["Publisher", metadataQ.data.publisher],
                            metadataQ.data.translation && ["Translation", metadataQ.data.translation],
                            metadataQ.data.volumes && ["Volumes", metadataQ.data.volumes],
                            metadataQ.data.edition && ["Edition", metadataQ.data.edition],
                            metadataQ.data.status && ["Status", metadataQ.data.status],
                            metadataQ.data.country && ["Country", metadataQ.data.country],
                            metadataQ.data.source_material && ["Source", metadataQ.data.source_material],
                          ].filter(Boolean).map((entry) => {
                            const [label, value] = entry as string[];
                            const displayValue = label === "Status" || label === "Source" ? sentenceCaseMetadata(value) : value;
                            return <span key={label} className="inline-flex max-w-full shrink-0 items-center gap-1 rounded-full border border-white/15 bg-black/20 px-3 py-1 text-xs text-white/80"><span className="min-w-0 truncate"><span className="text-white/50">{label}</span> · {displayValue}</span>{label === "Publisher" && publisherArtworkTarget && <button type="button" onClick={() => { setArtworkTarget({ ...publisherArtworkTarget, nonce: Date.now() }); setArtworkOpen(true); }} aria-label={`Open ${publisherArtworkTarget.provider === "comicvine" ? "ComicVine" : "AniList Manga"} artwork`} title={`Open ${publisherArtworkTarget.provider === "comicvine" ? "ComicVine" : "AniList Manga"} artwork`} className="ml-1 shrink-0 rounded-full p-0.5 text-white/50 transition-colors hover:bg-white/10 hover:text-white"><ExternalLink className="size-3.5" /></button>}</span>;
                          })}
                          {missingInstallments > 0 && installmentInfo && (
                            <span className="rounded-full border border-amber-400/40 bg-amber-400/15 px-3 py-1 text-xs font-medium text-amber-200">
                              {missingInstallments} {installmentInfo.unit}{missingInstallments === 1 ? "" : "s"} Missing
                            </span>
                          )}
                        </div>
                        {metadataQ.data.plot && <p className="mt-3 text-sm leading-relaxed text-white/75">{metadataQ.data.plot}</p>}
                      </section>
                    )}
                  </div>
                </div>

                {isSeries && <div className="sm:hidden"><DetailSynopsis key={item.id} text={item.summary} /></div>}

                {/* Seasons */}
                {item.seasons.length > 0 && (
                  <section className="mt-10">
                    <h2 className="mb-3 text-xl font-semibold">Seasons</h2>
                    <div className="-mx-2 -mt-2 flex gap-5 overflow-x-auto px-2 pb-3 pt-2 [&>div]:w-[150px] [&>div]:shrink-0 sm:[&>div]:w-[180px]">
                      {item.seasons.map((s) => (
                        <PosterCard
                          key={s.id}
                          image={imageUrl(serverId, s.poster)}
                          title={s.title}
                          subtitle={
                            s.index != null ? `Season ${s.index}` : undefined
                          }
                          kind="show"
                          badge={s.episode_count ?? undefined}
                          onOpen={() => {
                            const context = new URLSearchParams(searchParams);
                            context.delete("edit_metadata");
                            navigate(`/server/${serverId}/series/${encodeURIComponent(item.id)}/season/${encodeURIComponent(s.id)}?${context}`);
                          }}
                        />
                      ))}
                    </div>
                  </section>
                )}

                {item.type === "book" && <button className="mt-5 rounded-full bg-accent px-5 py-2 text-sm font-semibold text-base hover:bg-accent-hover" onClick={()=>navigate(`/read/${serverId}/${encodeURIComponent(item.id)}?${new URLSearchParams({return:window.location.pathname+window.location.search})}`)}>Read Book</button>}
                {item.type === "movie" && <ItemAbout item={item} />}
                {/* Volume cards open the reader; nested folders keep their detail pages. */}
                {item.members.length > 0 && (
                  <section className="mt-10">
                    <h2 className="mb-4 text-lg font-semibold">
                      {item.type === "folder"
                        ? "Volumes"
                        : "Titles in this collection"}
                    </h2>
                    <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(120px,1fr))] sm:gap-5 sm:[grid-template-columns:repeat(auto-fill,minmax(140px,1fr))]">
                      {item.members.map((m) => (
                        <PosterCard
                          key={m.id}
                          image={imageUrl(serverId, m.poster)}
                          title={memberInfo.data?.[m.id]?.title || m.title}
                          coloredEffect={memberInfo.data?.[m.id]?.colored_edition ? displayStatus.coloredEffect : "off"}
                          coloredTitle={memberInfo.data?.[m.id]?.colored_edition && displayStatus.coloredTitle}
                          badge={trackingOverlays ? memberInfo.data?.[m.id]?.status : undefined}
                          subtitle={m.year ? String(m.year) : undefined}
                          kind={m.type}
                          openLabel={m.type === "book" ? "Read" : "Open"}
                          onOpen={m.type === "book"
                            ? () => navigate(`/read/${serverId}/${encodeURIComponent(m.id)}?${new URLSearchParams({return:window.location.pathname+window.location.search})}`)
                            : item.type !== "folder" || m.type === "folder"
                            ? () => navigate(`/server/${serverId}/item/${m.id}?${searchParams.toString()}`)
                            : undefined}
                        />
                      ))}
                    </div>
                  </section>
                )}
                {item.type === "show" && <ItemAbout item={item} />}
              </>
            )}
          </div>
        </div>
      </div>

      {artworkOpen && item && (
        <div className="item-artwork-overlay pointer-events-none fixed inset-0 z-50 bg-transparent xl:relative xl:inset-auto xl:z-[1] xl:h-full xl:w-[clamp(20rem,25vw,23.75rem)] xl:shrink-0 xl:bg-transparent">
          <section id="item-artwork-panel" aria-label={`Artwork for ${item.title}`} className="pointer-events-auto ml-auto h-full w-full max-w-md shadow-2xl xl:max-w-none" onClick={event => event.stopPropagation()}>
            <ArtworkPanel serverId={serverId} item={item} prefill={prefill} navigationTarget={artworkTarget} anilistMangaId={metadataQ.data?.anilist_id} libraryType={libraryType ?? undefined} libraryTitle={libraryTitle} onClose={() => setArtworkOpen(false)} onReviewMetadata={(fields, sourceLabel) => { setArtworkOpen(false); setMetadataImport({ fields, sourceLabel }); setMetadataEditorOpen(true); }} />
          </section>
        </div>
      )}
      {metadataEditorOpen && item?.type !== "movie" && item?.type !== "show" && (metadataQ.data || metadataImport) && (
        <MetadataEditorModal
          metadata={metadataQ.data ?? {
            title: "", year: "", publisher: "", edition: "", volumes: "", status: "", plot: "",
            anilist_id: "", comicvine_id: "", source_url: "", native_title: "", translation: "", mal_id: "",
            genres: "", tags: "", creators: "", country: "", source_material: "",
          }}
          incoming={metadataImport?.fields}
          sourceLabel={metadataImport?.sourceLabel}
          saving={saveMetadata.isPending}
          error={saveMetadata.isError ? saveMetadata.error.message : undefined}
          onClose={() => { saveMetadata.reset(); setMetadataImport(null); setMetadataEditorOpen(false); }}
          onSave={(fields) => saveMetadata.mutate(fields)}
        />
      )}
    </div>
  );
}
