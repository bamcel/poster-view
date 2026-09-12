import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type {
  ArtworkItem,
  ArtworkSearchResult,
  ItemDetail,
  MangaSelection,
} from "../types";
import { detectManga, normalizeVolume } from "../lib/manga";
import { useToast } from "../lib/toast";
import { ArtImg, ApplyBtn } from "./ArtworkBrowser";

const field =
  "w-full rounded-lg border border-border bg-surface-2 p-2 text-sm outline-none focus:border-accent";
const button =
  "rounded-lg border border-border px-3 py-2 text-xs text-muted hover:text-white disabled:opacity-50";

export default function MangaDexPanel({
  serverId,
  item,
  onManual,
}: {
  serverId: number;
  item: ItemDetail;
  onManual: () => void;
}) {
  const detected = useMemo(() => detectManga(item), [item]);
  const client = useQueryClient();
  const toast = useToast();
  const key = ["mangadex-selection", serverId, item.id];
  const saved = useQuery({
    queryKey: key,
    queryFn: () => api.mangaSelection(serverId, item.id),
  });
  const [query, setQuery] = useState(detected.series);
  const [debounced, setDebounced] = useState("");
  const [changing, setChanging] = useState(false);
  const [volume, setVolume] = useState(detected.volume);
  const [locale, setLocale] = useState("");
  const [onlyVolume, setOnlyVolume] = useState(false);
  const [count, setCount] = useState(24);
  const [preview, setPreview] = useState<ArtworkItem | null>(null);
  const [pendingCover, setPendingCover] = useState<ArtworkItem | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const [imageRetry, setImageRetry] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const selected = saved.data;
  const seriesId = selected?.mangadex_id || item.external_ids.mangadex || "";
  const searching = changing || !seriesId;

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 400);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    if (saved.data) setVolume(saved.data.volume ?? detected.volume);
  }, [saved.data, detected.volume]);
  useEffect(() => {
    setCount(24);
    setPreview(null);
  }, [seriesId, locale, onlyVolume, volume]);
  useEffect(() => {
    setImageFailed(false);
    setImageRetry(0);
  }, [preview?.id]);

  const search = useQuery({
    queryKey: [
      "artwork-search",
      "mangadex",
      serverId,
      item.id,
      debounced,
      refresh,
    ],
    queryFn: () =>
      api.searchArtwork("mangadex", serverId, item.id, debounced, refresh > 0),
    enabled: saved.isSuccess && searching && debounced.length > 0,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const covers = useQuery({
    queryKey: ["artwork", "mangadex", serverId, item.id, seriesId, refresh],
    queryFn: () =>
      api.getArtwork("mangadex", serverId, item.id, seriesId, refresh > 0),
    enabled: saved.isSuccess && !!seriesId && !searching,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const save = useMutation({
    mutationFn: (selection: MangaSelection) =>
      api.saveMangaSelection(serverId, item.id, selection),
    onSuccess: (selection) => {
      client.setQueryData(key, selection);
      setPendingCover(null);
      setChanging(false);
    },
    onError: (error: Error) => toast.push("error", error.message),
  });
  const pick = (result: ArtworkSearchResult) =>
    save.mutate({
      mangadex_id: result.id,
      title: result.name,
      volume: volume || null,
      cover: null,
    });
  const apply = useMutation({
    mutationFn: async (art: ArtworkItem) => {
      const result = await api.applyPoster({
        server_id: serverId,
        item_id: item.id,
        target: "poster",
        provider: "mangadex",
        download_url: art.download_url,
        item_title: item.title,
      });
      if (!result.ok) throw new Error(result.message);
      // The existing apply endpoint owns image storage, media-server upload, and revert history.
      await Promise.all([
        client.invalidateQueries({
          queryKey: ["item-detail", serverId, item.id],
        }),
        client.invalidateQueries({ queryKey: ["items", serverId] }),
      ]);
      try {
        const selection = await api.saveMangaSelection(serverId, item.id, {
          mangadex_id: seriesId,
          title: art.title ?? selected?.title ?? item.title,
          volume: volume || null,
          cover: art,
        });
        client.setQueryData(key, selection);
        setPendingCover(null);
      } catch {
        setPendingCover(art);
        toast.push(
          "error",
          "Cover applied, but its MangaDex details could not be saved. Use Retry saving cover details.",
        );
      }
      return result;
    },
    onSuccess: (result) => toast.push("success", result.message),
    onError: (error: Error) => toast.push("error", error.message),
  });
  const all = covers.data?.items ?? [];
  const languages = [
    ...new Set(all.map((a) => a.manga?.locale ?? "unknown")),
  ].sort();
  const matching = (art: ArtworkItem) =>
    !!volume.trim() &&
    normalizeVolume(art.manga?.volume) === normalizeVolume(volume);
  const gallery = all
    .filter(
      (a) =>
        (!locale || (a.manga?.locale ?? "unknown") === locale) &&
        (!onlyVolume || matching(a)),
    )
    .sort(
      (a, b) =>
        Number(matching(b)) - Number(matching(a)) ||
        (a.manga?.volume ?? "\uffff").localeCompare(
          b.manga?.volume ?? "\uffff",
          undefined,
          { numeric: true },
        ) ||
        a.id.localeCompare(b.id),
    );
  const error =
    saved.error?.message ||
    (searching
      ? search.error?.message || search.data?.message
      : covers.error?.message || covers.data?.message);

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold">Manga Cover · MangaDex</h3>
      {saved.isPending && (
        <p className="text-sm text-muted">Loading saved series…</p>
      )}
      {error && (
        <div role="alert" className="space-y-2 text-sm text-danger">
          <p>{error}</p>
          <button
            className={button}
            onClick={() => {
              if (saved.isError) void saved.refetch();
              else setRefresh((v) => v + 1);
            }}
          >
            Retry
          </button>
        </div>
      )}
      {searching ? (
        <>
          <label className="block text-xs text-muted">
            Search MangaDex
            <input
              className={`${field} mt-1`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Title, alternate name, or MangaDex ID"
            />
          </label>
          <div className="flex gap-2">
            <button className={button} onClick={() => setRefresh((v) => v + 1)}>
              Refresh search
            </button>
            {seriesId && (
              <button className={button} onClick={() => setChanging(false)}>
                Back to covers
              </button>
            )}
          </div>
          {(search.isFetching || query.trim() !== debounced) && (
            <p role="status" className="text-sm text-muted">
              Searching MangaDex…
            </p>
          )}
          {search.isSuccess &&
            !search.data.message &&
            !search.data.results.length && (
              <p className="text-sm text-muted">
                No manga found for “{debounced}”. Try another title or an
                alternate name.
              </p>
            )}
          {query.trim() === debounced &&
            search.data?.results.map((result) => (
              <button
                key={result.id}
                disabled={save.isPending}
                onClick={() => pick(result)}
                className="flex w-full gap-3 rounded-lg border border-border bg-surface-2 p-3 text-left hover:border-accent disabled:opacity-50"
              >
                {result.thumb_url && (
                  <img
                    src={result.thumb_url}
                    alt=""
                    loading="lazy"
                    className="h-24 w-16 shrink-0 rounded object-cover"
                  />
                )}
                <span className="min-w-0 space-y-1">
                  <strong className="block text-sm">{result.name}</strong>
                  <span className="block text-xs text-muted">
                    {result.alternate_titles?.join(" · ")}
                  </span>
                  <span className="block text-xs text-faint">
                    {[result.year, result.status].filter(Boolean).join(" · ")}
                  </span>
                  <span className="block break-all text-[10px] text-faint">
                    {result.id}
                  </span>
                  <span className="block text-xs text-accent">
                    Select series
                  </span>
                </span>
              </button>
            ))}
        </>
      ) : (
        <>
          <div className="rounded-lg border border-border bg-surface-2 p-3">
            <p className="text-sm font-medium">
              {selected?.title || all[0]?.title || "Selected series"}
            </p>
            <a
              className="break-all text-[10px] text-faint"
              href={`https://mangadex.org/title/${seriesId}?tab=art`}
              target="_blank"
              rel="noreferrer"
            >
              {seriesId}
            </a>
          </div>
          <div className="flex gap-2">
            <button
              className={button}
              disabled={apply.isPending}
              onClick={() => {
                setChanging(true);
                setPreview(null);
              }}
            >
              Change series
            </button>
            <button className={button} onClick={() => setRefresh((v) => v + 1)}>
              Refresh covers
            </button>
          </div>
          <label className="block text-xs text-muted">
            Volume {detected.volume && `(detected: ${detected.volume})`}
            <input
              className={`${field} mt-1`}
              value={volume}
              onChange={(e) => setVolume(e.target.value)}
              placeholder="Unknown volume"
            />
          </label>
          <button
            className={button}
            disabled={save.isPending || apply.isPending}
            onClick={() =>
              save.mutate({
                mangadex_id: seriesId,
                title: selected?.title || all[0]?.title || item.title,
                volume: volume || null,
                cover: pendingCover ?? selected?.cover ?? null,
              })
            }
          >
            {pendingCover ? "Retry saving cover details" : "Save volume"}
          </button>
          <label className="block text-xs text-muted">
            Language
            <select
              className={`${field} mt-1`}
              value={locale}
              onChange={(e) => setLocale(e.target.value)}
            >
              <option value="">All languages</option>
              {languages.map((lang) => (
                <option key={lang} value={lang}>
                  {lang === "unknown" ? "Unknown language" : lang}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-muted">
            <input
              type="checkbox"
              checked={onlyVolume}
              onChange={(e) => setOnlyVolume(e.target.checked)}
            />
            Only matching volume
          </label>
          {covers.isFetching && (
            <p role="status" className="text-sm text-muted">
              Loading MangaDex covers…
            </p>
          )}
          {covers.isSuccess && !covers.data.message && !all.length && (
            <p className="text-sm text-muted">
              No MangaDex covers were found for this title. Change series or
              choose artwork manually.
            </p>
          )}
          {!!all.length && !gallery.length && (
            <p className="text-sm text-muted">
              No covers match these filters.{" "}
              <button
                className="text-accent"
                onClick={() => {
                  setLocale("");
                  setOnlyVolume(false);
                }}
              >
                Browse all covers
              </button>
            </p>
          )}
          {preview ? (
            <div className="space-y-3 rounded-lg border border-accent/40 bg-surface-2 p-3">
              <button className={button} onClick={() => setPreview(null)}>
                Back to covers
              </button>
              <p className="text-sm font-semibold">
                {preview.title} · Volume {preview.manga?.volume ?? "unknown"}
              </p>
              {imageFailed ? (
                <div role="alert" className="text-sm text-danger">
                  Unable to retrieve this cover.{" "}
                  <button
                    className={button}
                    onClick={() => {
                      setImageFailed(false);
                      setImageRetry((v) => v + 1);
                    }}
                  >
                    Retry image
                  </button>
                </div>
              ) : (
                <img
                  className="max-h-[60vh] w-full object-contain"
                  alt={`Volume ${preview.manga?.volume ?? "unknown"} cover preview`}
                  src={`/api/artwork/mangadex/image?url=${encodeURIComponent(preview.download_url)}&retry=${imageRetry}`}
                  onError={() => setImageFailed(true)}
                />
              )}
              <p className="text-xs text-muted">
                Source: MangaDex · Language:{" "}
                {preview.manga?.locale ?? "unknown"}
              </p>
              {preview.manga?.description && (
                <p className="text-xs text-muted">
                  {preview.manga.description}
                </p>
              )}
              <ApplyBtn
                label={apply.isPending ? "Applying…" : "Use Cover"}
                busy={apply.isPending}
                onClick={() => apply.mutate(preview)}
              />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                {gallery.slice(0, count).map((art) => (
                  <button
                    key={art.id}
                    onClick={() => setPreview(art)}
                    className={`rounded-lg border bg-surface-2 p-2 text-left ${matching(art) ? "border-accent" : "border-border"}`}
                  >
                    <ArtImg art={art} />
                    <p className="mt-2 text-sm">
                      Volume {art.manga?.volume ?? "unknown"}
                    </p>
                    <p className="text-xs text-faint">
                      {art.manga?.locale ?? "Unknown language"}
                    </p>
                    {matching(art) && (
                      <p className="text-xs text-accent">
                        Suggested volume match
                      </p>
                    )}
                  </button>
                ))}
              </div>
              {count < gallery.length && (
                <button
                  className={`${button} w-full`}
                  onClick={() => setCount((v) => v + 24)}
                >
                  Load more ({gallery.length - count} remaining)
                </button>
              )}
            </>
          )}
        </>
      )}
      <button className={`${button} w-full`} onClick={onManual}>
        Choose artwork manually
      </button>
    </div>
  );
}
