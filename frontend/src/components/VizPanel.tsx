import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { detectManga, normalizeVolume } from "../lib/manga";
import { useToast } from "../lib/toast";
import type { ArtworkItem, ImageTarget, ItemDetail } from "../types";
import { ArtImg, ApplyBtn } from "./ArtworkBrowser";
import CustomTargetButton from "./CustomTargetButton";

const field =
  "w-full rounded-lg border border-border bg-surface-2 p-2 text-sm outline-none focus:border-accent";
const button =
  "rounded-lg border border-border px-3 py-2 text-xs text-muted hover:text-white disabled:opacity-50";

export default function VizPanel({
  serverId,
  item,
}: {
  serverId: number;
  item: ItemDetail;
}) {
  const storageKey = `viz-catalog:${serverId}:${item.id}`;
  const savedCatalog = localStorage.getItem(storageKey) ?? "";
  const [input, setInput] = useState(
    () => savedCatalog || detectManga(item).series || item.title,
  );
  const [catalogUrl, setCatalogUrl] = useState(savedCatalog);
  const [debounced, setDebounced] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [batchProgress, setBatchProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);
  const client = useQueryClient();
  const toast = useToast();
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!input.trim().startsWith("http")) setDebounced(input.trim());
    }, 400);
    return () => window.clearTimeout(timer);
  }, [input]);
  const search = useQuery({
    queryKey: ["artwork-search", "viz", serverId, item.id, debounced],
    queryFn: () => api.searchArtwork("viz", serverId, item.id, debounced),
    enabled: !catalogUrl && debounced.length > 0,
    retry: false,
  });
  const covers = useQuery({
    queryKey: ["artwork", "viz", serverId, item.id, catalogUrl, refresh],
    queryFn: () =>
      api.getArtwork("viz", serverId, item.id, catalogUrl, refresh > 0),
    enabled: catalogUrl.length > 0,
    retry: false,
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
    mutationFn: ({
      art,
      targetId,
      targetTitle,
      target = "poster",
    }: {
      art: ArtworkItem;
      targetId: string;
      targetTitle: string;
      target?: ImageTarget;
    }) =>
      api.applyPoster({
        server_id: serverId,
        item_id: targetId,
        target,
        provider: "viz",
        download_url: art.download_url,
        item_title: targetTitle,
      }),
    onSuccess: async (result) => {
      if (!result.ok) throw new Error(result.message);
      await Promise.all([
        client.invalidateQueries({
          queryKey: ["item-detail", serverId, item.id],
        }),
        client.invalidateQueries({ queryKey: ["items", serverId] }),
      ]);
      toast.push("success", result.message);
    },
    onError: (error: Error) => toast.push("error", error.message),
  });
  const artwork = covers.data?.items ?? [];
  const assignments = useMemo(
    () =>
      item.type === "folder"
        ? item.members.flatMap((member) => {
            const volume = normalizeVolume(detectManga(member).volume);
            const art = artwork.find(
              (candidate) =>
                normalizeVolume(candidate.manga?.volume) === volume,
            );
            return volume && art ? [{ member, art }] : [];
          })
        : [],
    [artwork, item],
  );
  const applyAll = async () => {
    setBatchProgress({ current: 0, total: assignments.length });
    let completed = 0;
    try {
      for (const { member, art } of assignments) {
        const result = await api.applyPoster({
          server_id: serverId,
          item_id: member.id,
          target: "poster",
          provider: "viz",
          download_url: art.download_url,
          item_title: `${item.title} — ${member.title}`,
        });
        if (!result.ok) throw new Error(`${member.title}: ${result.message}`);
        completed += 1;
        setBatchProgress({ current: completed, total: assignments.length });
      }
      await Promise.all([
        client.invalidateQueries({
          queryKey: ["item-detail", serverId, item.id],
        }),
        client.invalidateQueries({ queryKey: ["items", serverId] }),
      ]);
      toast.push("success", `Updated ${completed} volume covers.`);
    } catch (error) {
      toast.push(
        "error",
        `Updated ${completed} covers. ${(error as Error).message}`,
      );
    } finally {
      setBatchProgress(null);
    }
  };

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold">Manga Covers · VIZ</h3>
      <label className="block text-xs text-muted">
        Search VIZ or paste a series catalog URL
        <input
          className={`${field} mt-1`}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Series title or https://www.viz.com/.../all"
        />
      </label>
      <button
        className={button}
        disabled={!input.trim() || covers.isFetching}
        onClick={() => {
          const value = input.trim();
          if (value.startsWith("http")) {
            localStorage.setItem(storageKey, value);
            setCatalogUrl(value);
            if (value === catalogUrl) setRefresh((current) => current + 1);
          } else {
            setCatalogUrl("");
            setDebounced(value);
          }
        }}
      >
        {search.isFetching || covers.isFetching
          ? "Searching VIZ…"
          : "Search VIZ"}
      </button>
      {search.error && (
        <p role="alert" className="text-sm text-danger">
          {search.error.message}
        </p>
      )}
      {!catalogUrl && search.isSuccess && !search.data.results.length && (
        <p className="text-sm text-muted">
          No VIZ manga series found for “{debounced}”.
        </p>
      )}
      {!catalogUrl &&
        search.data?.results.map((result) => (
          <button
            key={result.id}
            className="flex w-full gap-3 rounded-lg border border-border bg-surface-2 p-3 text-left hover:border-accent"
            onClick={() => {
              localStorage.setItem(storageKey, result.id);
              setCatalogUrl(result.id);
            }}
          >
            {result.thumb_url && (
              <img
                src={result.thumb_url}
                alt=""
                className="h-24 w-20 rounded object-cover"
              />
            )}
            <span>
              <strong className="block text-sm">{result.name}</strong>
              <span className="mt-1 block text-xs text-accent">
                Select series
              </span>
            </span>
          </button>
        ))}
      {covers.data?.message && (
        <p role="alert" className="text-sm text-danger">
          {covers.data.message}
        </p>
      )}
      {covers.error && (
        <p role="alert" className="text-sm text-danger">
          {covers.error.message}
        </p>
      )}
      {assignments.length > 0 && (
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
      <div className="grid grid-cols-2 gap-3">
        {artwork.map((art) => {
          const member = memberForCover(art);
          const automaticTarget = item.type === "folder" ? member : item;
          return (
            <div
              key={art.id}
              className="rounded-lg border border-border bg-surface-2 p-2"
            >
              <a
                href={art.source_url ?? art.download_url}
                target="_blank"
                rel="noreferrer"
              >
                <ArtImg art={art} />
              </a>
              <p className="mt-2 truncate text-sm">
                Volume {art.manga?.volume ?? "unknown"}
              </p>
              <div className="mt-2 flex items-stretch gap-1">
                <ApplyBtn
                  label="Auto"
                  busy={apply.isPending}
                  disabled={!automaticTarget}
                  onClick={() =>
                    automaticTarget &&
                    apply.mutate({
                      art,
                      targetId: automaticTarget.id,
                      targetTitle: member
                        ? `${item.title} — ${member.title}`
                        : item.title,
                    })
                  }
                />
                <CustomTargetButton
                  item={item}
                  busy={apply.isPending}
                  className="shrink-0 justify-center"
                  onPick={(target, targetId, label) =>
                    apply.mutate({
                      art,
                      targetId,
                      target,
                      targetTitle: `${item.title} — ${label}`,
                    })
                  }
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
