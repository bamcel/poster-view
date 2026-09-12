import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, Search } from "lucide-react";
import { api } from "../api/client";
import type {
  ArtworkItem,
  ArtworkSearchResult,
  ImageTarget,
  ItemDetail,
  MangaSelection,
} from "../types";
import { detectManga, normalizeVolume } from "../lib/manga";
import { useToast } from "../lib/toast";
import { ArtImg, ApplyBtn } from "./ArtworkBrowser";
import CustomTargetButton from "./CustomTargetButton";

const field =
  "w-full rounded-lg border border-border bg-surface-2 p-2 text-sm outline-none focus:border-accent";
const button =
  "rounded-lg border border-border px-3 py-2 text-xs text-muted hover:text-white disabled:opacity-50";
const backButton =
  "flex min-w-0 items-center gap-1 text-xs text-muted hover:text-white";

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
  const [batchProgress, setBatchProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);
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
  const memberForCover = (art: ArtworkItem) =>
    item.type === "folder"
      ? item.members.find(
          (member) =>
            normalizeVolume(detectManga(member).volume) ===
            normalizeVolume(art.manga?.volume),
        )
      : undefined;
  const apply = useMutation({
    mutationFn: async ({
      art,
      targetId,
      targetTitle,
      target = "poster",
    }: {
      art: ArtworkItem;
      targetId: string;
      targetTitle: string;
      target?: ImageTarget;
    }) => {
      const result = await api.applyPoster({
        server_id: serverId,
        item_id: targetId,
        target,
        provider: "mangadex",
        download_url: art.download_url,
        item_title: targetTitle,
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
  const assignments =
    item.type === "folder"
      ? item.members.flatMap((member) => {
          const memberVolume = normalizeVolume(detectManga(member).volume);
          if (!memberVolume) return [];
          const art = all.find(
            (candidate) =>
              (!locale || (candidate.manga?.locale ?? "unknown") === locale) &&
              normalizeVolume(candidate.manga?.volume) === memberVolume,
          );
          return art ? [{ member, art }] : [];
        })
      : [];
  const applyAll = async () => {
    setBatchProgress({ current: 0, total: assignments.length });
    let completed = 0;
    let savedFiles = 0;
    try {
      for (const { member, art } of assignments) {
        const result = await api.applyPoster({
          server_id: serverId,
          item_id: member.id,
          target: "poster",
          provider: "mangadex",
          download_url: art.download_url,
          item_title: `${item.title} — ${member.title}`,
        });
        if (!result.ok) throw new Error(`${member.title}: ${result.message}`);
        if (result.message.includes(" and saved ")) savedFiles += 1;
        completed += 1;
        setBatchProgress({ current: completed, total: assignments.length });
      }
      await Promise.all([
        client.invalidateQueries({
          queryKey: ["item-detail", serverId, item.id],
        }),
        client.invalidateQueries({ queryKey: ["items", serverId] }),
      ]);
      toast.push(
        "success",
        savedFiles === completed
          ? `Updated ${completed} volume covers and saved ${savedFiles} companion files.`
          : `Updated ${completed} volume covers; saved ${savedFiles} companion files. Mount the media directory writable in PosterView to save the rest.`,
      );
    } catch (error) {
      toast.push(
        "error",
        `Updated ${completed} covers. ${(error as Error).message}`,
      );
    } finally {
      setBatchProgress(null);
    }
  };
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
          <form
            className="relative"
            onSubmit={(event) => {
              event.preventDefault();
              setDebounced(query.trim());
              setRefresh((value) => value + 1);
            }}
          >
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
            <input
              aria-label="Search MangaDex"
              className="w-full rounded-lg border border-border bg-surface-2 py-2 pl-9 pr-9 text-sm outline-none focus:border-accent"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search a title or paste a MangaDex ID…"
            />
            <a
              href={`https://mangadex.org/search?q=${encodeURIComponent(query.trim())}`}
              target="_blank"
              rel="noreferrer"
              title="Search MangaDex"
              className="absolute right-3 top-1/2 -translate-y-1/2 text-faint transition-colors hover:text-white"
            >
              <ExternalLink className="size-4" />
            </a>
          </form>
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
          <div className="flex items-center justify-between gap-2">
            <button
              className={backButton}
              onClick={() => {
                setChanging(true);
                setPreview(null);
              }}
            >
              <ArrowLeft className="size-3.5 shrink-0" /> Back
            </button>
            <a
              className="flex items-center gap-1 text-xs text-muted hover:text-white"
              href={`https://mangadex.org/title/${seriesId}?tab=art`}
              target="_blank"
              rel="noreferrer"
            >
              MangaDex <ExternalLink className="size-3" />
            </a>
          </div>
          <div className="rounded-lg border border-border bg-surface-2 p-3">
            <p className="text-sm font-medium">
              {selected?.title || all[0]?.title || "Selected series"}
            </p>
            <p className="break-all text-[10px] text-faint">{seriesId}</p>
          </div>
          <div className="flex gap-2">
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
          {item.type === "folder" && assignments.length > 0 && !preview && (
            <button
              className="w-full rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-black disabled:opacity-60"
              disabled={batchProgress != null || apply.isPending}
              onClick={() => void applyAll()}
            >
              {batchProgress
                ? `Applying ${batchProgress.current} of ${batchProgress.total}…`
                : `Apply matching covers to ${assignments.length} volumes`}
            </button>
          )}
          {preview ? (
            <div className="space-y-3 rounded-lg border border-accent/40 bg-surface-2 p-3">
              <button className={backButton} onClick={() => setPreview(null)}>
                <ArrowLeft className="size-3.5 shrink-0" /> Back
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
                label={
                  apply.isPending
                    ? "Applying…"
                    : memberForCover(preview)
                      ? `Use for ${memberForCover(preview)!.title}`
                      : item.type === "folder"
                        ? "No matching library volume"
                        : "Use Cover"
                }
                busy={apply.isPending}
                onClick={() => {
                  const member = memberForCover(preview);
                  if (item.type === "folder" && !member) return;
                  apply.mutate({
                    art: preview,
                    targetId: member?.id ?? item.id,
                    targetTitle: member
                      ? `${item.title} — ${member.title}`
                      : item.title,
                  });
                }}
              />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                {gallery.slice(0, count).map((art) => (
                  <div
                    key={art.id}
                    className={`rounded-lg border bg-surface-2 p-2 text-left ${matching(art) ? "border-accent" : "border-border"}`}
                  >
                    <button
                      onClick={() => setPreview(art)}
                      className="w-full text-left"
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
                    <div className="mt-2 flex items-stretch gap-1">
                      {(() => {
                        const member = memberForCover(art);
                        const automaticTarget =
                          item.type === "folder" ? member : item;
                        return (
                          <ApplyBtn
                            label="Auto"
                            busy={apply.isPending}
                            disabled={!automaticTarget}
                            onClick={() => {
                              if (!automaticTarget) return;
                              apply.mutate({
                                art,
                                targetId: automaticTarget.id,
                                targetTitle: member
                                  ? `${item.title} — ${member.title}`
                                  : item.title,
                              });
                            }}
                          />
                        );
                      })()}
                      <CustomTargetButton
                        item={item}
                        busy={apply.isPending}
                        className="shrink-0 justify-center"
                        onPick={(_target, targetId, label) =>
                          apply.mutate({
                            art,
                            targetId,
                            targetTitle: `${item.title} — ${label}`,
                            target: _target,
                          })
                        }
                      />
                    </div>
                  </div>
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
