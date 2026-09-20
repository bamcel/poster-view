// Item detail: a cinematic hero (blurred backdrop, large poster, metadata) with
// a seasons row, and the ThePosterDB panel docked on the right for swapping art.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, Images, Pencil, RefreshCw, X } from "lucide-react";
import { api, imageUrl } from "../api/client";
import PosterCard from "../components/PosterCard";
import ArtworkPanel from "../components/ArtworkPanel";
import MetadataEditorModal from "../components/MetadataEditorModal";
import { Spinner, EmptyState } from "../components/ui";
import type { Library, NfoMetadata } from "../types";
import { seriesInstallmentInfo, seriesInstallmentSummary } from "../lib/mediaKind";
import { DASHBOARD_BACKDROP_EVENT, dashboardBackdropEnabled } from "../lib/dashboardSettings";

function sentenceCaseMetadata(value: string): string {
  const normalized = value.trim().replaceAll("_", " ").toLowerCase();
  return normalized ? normalized[0].toUpperCase() + normalized.slice(1) : normalized;
}

export default function ItemDetailPage() {
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
  const [showBackdrop, setShowBackdrop] = useState(dashboardBackdropEnabled);
  const [metadataEditorOpen, setMetadataEditorOpen] = useState(
    () => searchParams.get("edit_metadata") === "1",
  );
  const [metadataImport, setMetadataImport] = useState<{ fields: NfoMetadata; sourceLabel: string } | null>(null);
  const queryClient = useQueryClient();
  const refreshArtwork = useMutation({
    mutationFn: () => api.refreshArtworkItem(serverId, itemId!),
    onSuccess: (result) => {
      if (!result.ok) return;
      queryClient.invalidateQueries({ queryKey: ["artwork"], predicate: (query) => query.queryKey[2] === serverId && query.queryKey[3] === itemId });
      queryClient.invalidateQueries({ queryKey: ["artwork-search"], predicate: (query) => query.queryKey[2] === serverId && query.queryKey[3] === itemId });
      queryClient.invalidateQueries({ queryKey: ["artwork-cache", serverId] });
    },
  });

  const detailQ = useQuery({
    queryKey: ["item-detail", serverId, itemId],
    queryFn: () => api.getItemDetail(serverId, itemId!),
    enabled: Number.isFinite(serverId) && !!itemId,
  });
  const metadataQ = useQuery({
    queryKey: ["nfo-metadata", serverId, itemId],
    queryFn: () => api.getNfoMetadata(serverId, itemId!),
    enabled: Number.isFinite(serverId) && !!itemId,
    retry: false,
  });
  const saveMetadata = useMutation({
    mutationFn: (fields: NonNullable<typeof metadataQ.data>) =>
      api.updateNfoMetadata(serverId, itemId!, fields),
    onSuccess: (fields) => {
      queryClient.setQueryData(["nfo-metadata", serverId, itemId], fields);
      setMetadataImport(null);
      setMetadataEditorOpen(false);
    },
  });
  const item = detailQ.data;
  const backdrop = imageUrl(serverId, item?.background);
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
    window.addEventListener(DASHBOARD_BACKDROP_EVENT, update);
    return () => window.removeEventListener(DASHBOARD_BACKDROP_EVENT, update);
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
      {showBackdrop && createPortal(
        <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden bg-base" aria-hidden="true" data-testid="item-backdrop">
          {backdrop && (
            <img
              src={backdrop}
              alt=""
              className="h-full w-full scale-[1.02] object-cover"
            />
          )}
          <div className="absolute inset-0 bg-black/55" />
          <div className="absolute inset-0 md:hidden" data-testid="item-backdrop-mobile-shading">
            <div className="absolute inset-0 bg-gradient-to-r from-base/95 via-base/60 via-50% to-transparent to-90%" />
            <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent via-50% to-base/85" />
          </div>
        </div>,
        document.body,
      )}

      {/* Left: hero + seasons */}
      <div className="relative z-[1] h-full flex-1 overflow-y-auto overscroll-y-contain">
        {/* min-h-full lets this wrapper be at least a viewport tall but grow to
            the full scrolled content height. The darkening layer below is
            absolute inset-0 against THIS wrapper, so it covers every season row
            — not just the first viewport. (An absolute inset-0 sized against the
            scroll container itself only spans one visible viewport and scrolls
            away, leaving multi-season shows showing the raw, undarkened backdrop
            at the bottom.) */}
        <div className="relative min-h-full">
          {/* Extra gradients move with the hero column to strengthen contrast
              behind the poster/title/logo and at the end of long content. */}
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            <div className="absolute inset-0 hidden bg-gradient-to-r from-base/95 via-base/60 via-50% to-transparent to-90% md:block" />
            <div className="absolute inset-0 hidden bg-gradient-to-b from-transparent via-transparent via-50% to-base/85 md:block" />
          </div>

          {/* Back button */}
          <button
            onClick={goBack}
            className="absolute left-5 top-5 z-10 grid size-9 place-items-center rounded-full bg-black/40 text-white backdrop-blur transition-colors hover:bg-black/70"
            aria-label="Back"
          >
            <ArrowLeft className="size-5" />
          </button>

          {item && (
            <button
              type="button"
              onClick={() => setArtworkOpen(true)}
              className="absolute right-4 top-5 z-10 flex items-center gap-2 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-black shadow-lg transition-colors hover:bg-accent-hover xl:hidden"
            >
              <Images className="size-4" /> Artwork
            </button>
          )}

          <div className="relative z-[1] px-4 pb-8 pt-16 sm:px-6 sm:pb-10 lg:px-8">
            {detailQ.isLoading && <Spinner label="Loading…" />}
            {detailQ.isError && (
              <EmptyState title="Couldn't load this title">
                {(detailQ.error as Error).message}
              </EmptyState>
            )}

            {item && (
              <>
                <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-start sm:gap-6">
                  {/* Poster */}
                  <div className="w-40 shrink-0 min-[390px]:w-44 sm:w-48 lg:w-56">
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
                  <div className="min-w-0 flex-1 pt-2 text-center [text-shadow:0_2px_12px_rgba(0,0,0,0.8)] sm:text-left">
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        {logo ? (
                          <img
                            src={logo}
                            alt={item.title}
                            className="mx-auto max-h-24 max-w-full object-contain drop-shadow-[0_2px_10px_rgba(0,0,0,0.6)] sm:mx-0 sm:max-h-28 sm:object-left"
                          />
                        ) : (
                          <h1 className="text-3xl font-bold leading-tight sm:text-4xl">
                            {item.title}
                          </h1>
                        )}
                        <p className="mt-2 text-sm text-white/70">
                          {item.type === "show"
                            ? `${item.season_count ?? item.seasons.length} Season${
                                (item.season_count ?? item.seasons.length) === 1 ? "" : "s"
                              }`
                            : item.type === "collection"
                              ? "Collection"
                              : item.type === "book"
                                ? "Book"
                                : item.type === "audiobook"
                                  ? "Audiobook"
                                  : item.type === "folder"
                                    ? seriesInstallmentSummary(item.members)
                                    : item.year}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center justify-center gap-2 sm:justify-end">
                        {metadataQ.data && (
                          <button
                            type="button"
                            onClick={() => { setMetadataImport(null); setMetadataEditorOpen(true); }}
                            className="flex items-center gap-2 rounded-full border border-border bg-black/20 px-4 py-2 text-sm font-medium text-muted backdrop-blur transition-colors hover:border-white/40 hover:text-white"
                          >
                            <Pencil className="size-4" /> Edit Metadata
                          </button>
                        )}
                      <button
                        onClick={() => { void detailQ.refetch(); void metadataQ.refetch(); }}
                        className="hidden items-center gap-2 rounded-full border border-border bg-black/20 px-4 py-2 text-sm font-medium text-muted backdrop-blur transition-colors hover:border-white/40 hover:text-white sm:flex"
                        title="Refresh from server"
                      >
                        <RefreshCw
                          className={`size-4 ${detailQ.isFetching ? "animate-spin" : ""}`}
                        />{" "}
                        Refresh
                      </button>
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center justify-center gap-3 sm:justify-start xl:hidden">
                      <button
                        type="button"
                        onClick={() => refreshArtwork.mutate()}
                        disabled={refreshArtwork.isPending}
                        className="flex min-h-11 items-center gap-2 rounded-full border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:border-white/40 hover:text-white disabled:opacity-50 xl:hidden"
                      >
                        <RefreshCw className={`size-4 shrink-0 ${refreshArtwork.isPending ? "animate-spin" : ""}`} />
                        {refreshArtwork.isPending ? "Refreshing artwork…" : "Refresh artwork"}
                      </button>
                    </div>
                    <div role="status" aria-live="polite" className="mt-2 break-words text-sm xl:hidden">
                      {refreshArtwork.isError ? <p className="text-danger">{refreshArtwork.error.message}</p>
                        : refreshArtwork.data ? <p className={refreshArtwork.data.ok ? "text-success" : "text-danger"}>{refreshArtwork.data.message}</p> : null}
                    </div>

                    {!metadataQ.data && item.summary && (
                      <p className="mt-4 max-w-2xl text-sm leading-relaxed text-white/80">
                        {item.summary}
                      </p>
                    )}
                    {metadataQ.data && (
                      <section className="mt-4 max-w-2xl text-left [text-shadow:0_2px_12px_rgba(0,0,0,0.8)]">
                        <div className="flex flex-wrap items-center gap-2">
                          {[
                            metadataQ.data.year && ["Year", metadataQ.data.year],
                            metadataQ.data.publisher && ["Publisher", metadataQ.data.publisher],
                            metadataQ.data.translation && ["Translation", metadataQ.data.translation],
                            metadataQ.data.volumes && ["Volumes", metadataQ.data.volumes],
                            metadataQ.data.status && ["Status", metadataQ.data.status],
                            metadataQ.data.country && ["Country", metadataQ.data.country],
                            metadataQ.data.source_material && ["Source", metadataQ.data.source_material],
                          ].filter(Boolean).map((entry) => {
                            const [label, value] = entry as string[];
                            const displayValue = label === "Status" || label === "Source" ? sentenceCaseMetadata(value) : value;
                            return <span key={label} className="inline-flex items-center gap-1 rounded-full border border-white/15 bg-black/20 px-3 py-1 text-xs text-white/80"><span><span className="text-white/50">{label}</span> · {displayValue}</span>{label === "Publisher" && publisherArtworkTarget && <button type="button" onClick={() => { setArtworkTarget({ ...publisherArtworkTarget, nonce: Date.now() }); setArtworkOpen(true); }} aria-label={`Open ${publisherArtworkTarget.provider === "comicvine" ? "ComicVine" : "AniList Manga"} artwork`} title={`Open ${publisherArtworkTarget.provider === "comicvine" ? "ComicVine" : "AniList Manga"} artwork`} className="ml-1 rounded-full p-0.5 text-white/50 transition-colors hover:bg-white/10 hover:text-white"><ExternalLink className="size-3.5" /></button>}</span>;
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

                {/* Seasons */}
                {item.seasons.length > 0 && (
                  <section className="mt-10">
                    <h2 className="mb-4 text-lg font-semibold">Seasons</h2>
                    <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(120px,1fr))] sm:gap-5 sm:[grid-template-columns:repeat(auto-fill,minmax(140px,1fr))]">
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
                        />
                      ))}
                    </div>
                  </section>
                )}

                {/* Collection members — each is a full library item with its own
                  detail page/artwork panel, so cards navigate there rather than
                  editing inline (unlike seasons, which have no page of their own). */}
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
                          title={m.title}
                          subtitle={m.year ? String(m.year) : undefined}
                          kind={m.type}
                          onOpen={() =>
                            navigate(`/server/${serverId}/item/${m.id}?${searchParams.toString()}`)
                          }
                        />
                      ))}
                    </div>
                  </section>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Right: dock only when both columns have enough room. */}
      <div className="relative z-[1] hidden h-full w-[clamp(20rem,25vw,23.75rem)] shrink-0 xl:block">
        {item && (
          <ArtworkPanel serverId={serverId} item={item} prefill={prefill} navigationTarget={artworkTarget} anilistMangaId={metadataQ.data?.anilist_id} libraryType={libraryType ?? undefined} libraryTitle={libraryTitle} onReviewMetadata={(fields, sourceLabel) => { setMetadataImport({ fields, sourceLabel }); setMetadataEditorOpen(true); }} />
        )}
      </div>

      {artworkOpen && item && (
        <div
          className="fixed inset-0 z-50 bg-black/65 xl:hidden"
          onClick={() => setArtworkOpen(false)}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label={`Artwork for ${item.title}`}
            className="ml-auto h-full w-full max-w-md shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setArtworkOpen(false)}
              aria-label="Close artwork"
              className="absolute right-3 top-3 z-[60] grid size-9 place-items-center rounded-lg bg-elevated text-muted transition-colors hover:text-white"
            >
              <X className="size-5" />
            </button>
            <ArtworkPanel serverId={serverId} item={item} prefill={prefill} navigationTarget={artworkTarget} anilistMangaId={metadataQ.data?.anilist_id} libraryType={libraryType ?? undefined} libraryTitle={libraryTitle} onReviewMetadata={(fields, sourceLabel) => { setArtworkOpen(false); setMetadataImport({ fields, sourceLabel }); setMetadataEditorOpen(true); }} />
          </section>
        </div>
      )}
      {metadataEditorOpen && (metadataQ.data || metadataImport) && (
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
