// Global apply history: every image applied to the active server, newest
// first, across every title — not just the one you happen to have open.
// Grouped by title+target into one tile each (the current image); click a
// tile to open its full version history and revert to any earlier one.

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { History as HistoryIcon, Loader2, RotateCcw, Trash2, X } from "lucide-react";
import { api } from "../api/client";
import { useServers } from "../lib/serverContext";
import { useToast } from "../lib/toast";
import { EmptyState, Spinner } from "../components/ui";
import type { ApplyHistoryEntry } from "../types";

const TARGET_LABEL: Record<string, string> = {
  poster: "Poster",
  background: "Background",
  logo: "Logo",
};

function providerLabel(name: string): string {
  return (
    {
      fanart: "Fanart.tv",
      tvdb: "TheTVDB",
      anilist: "AniList",
      mediux: "MediUX",
      posterdb: "ThePosterDB",
      manual: "Manual",
      url: "URL",
    }[name] ?? name
  );
}

// Stored as SQLite's datetime('now') — "YYYY-MM-DD HH:MM:SS", UTC, no
// timezone marker — so it needs help before Date.parse treats it as UTC.
function relativeTime(sqliteUtc: string): string {
  const then = Date.parse(sqliteUtc.replace(" ", "T") + "Z");
  if (Number.isNaN(then)) return "";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default function HistoryPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { selectedServer, isLoading: serversLoading } = useServers();
  const serverId = selectedServer?.id ?? null;
  const [busyId, setBusyId] = useState<number | null>(null);

  const q = useQuery({
    queryKey: ["apply-history-global", serverId],
    queryFn: () => api.getHistory({ serverId: serverId!, limit: 100 }),
    enabled: serverId != null,
  });

  // Retention: both are user-configurable — a global entry-count cap
  // (always enforced) and an optional extra day-based cutoff on top of it.
  const settingsQ = useQuery({ queryKey: ["history-settings"], queryFn: api.getHistorySettings });
  const [purgeDaysInput, setPurgeDaysInput] = useState("");
  const [maxEntriesInput, setMaxEntriesInput] = useState("");
  useEffect(() => {
    if (!settingsQ.data) return;
    setPurgeDaysInput(settingsQ.data.purge_days ? String(settingsQ.data.purge_days) : "");
    setMaxEntriesInput(String(settingsQ.data.max_entries));
  }, [settingsQ.data]);

  const saveSettingsMut = useMutation({
    mutationFn: () =>
      api.setHistorySettings({
        purge_days: Number(purgeDaysInput) || 0,
        max_entries: Math.max(1, Number(maxEntriesInput) || 50),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["history-settings"] });
      queryClient.invalidateQueries({ queryKey: ["apply-history-global", serverId] });
      toast.push("success", "Retention settings saved.");
    },
    onError: (e: Error) => toast.push("error", e.message),
  });

  const [purging, setPurging] = useState(false);
  async function purgeNow() {
    const days = Number(purgeDaysInput) || 0;
    const msg =
      days > 0
        ? `Delete every history entry older than ${days} day${days === 1 ? "" : "s"}? Reverting to them won't be possible afterward — applied artwork on your server is unaffected.`
        : "Delete ALL history entries? Reverting to them won't be possible afterward — applied artwork on your server is unaffected.";
    if (!confirm(msg)) return;
    setPurging(true);
    try {
      const res = await api.purgeHistory(days);
      toast.push("success", `Purged ${res.purged} ${res.purged === 1 ? "entry" : "entries"}.`);
      await queryClient.invalidateQueries({ queryKey: ["apply-history-global", serverId] });
    } catch (e) {
      toast.push("error", (e as Error).message);
    } finally {
      setPurging(false);
    }
  }

  const entries = q.data ?? [];
  // One tile per title+target: entries are already newest-first from the
  // API, so each group's first element is "Current" and the rest are what
  // the picker modal offers to revert to.
  const groups = useMemo(() => {
    const map = new Map<string, ApplyHistoryEntry[]>();
    for (const e of entries) {
      const key = `${e.item_id}:${e.target}`;
      const arr = map.get(key);
      if (arr) arr.push(e);
      else map.set(key, [e]);
    }
    return Array.from(map.values());
  }, [entries]);

  const [activeKey, setActiveKey] = useState<string | null>(null);
  const activeGroup = activeKey ? groups.find((g) => `${g[0].item_id}:${g[0].target}` === activeKey) : null;
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!activeGroup) return;
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const selector = "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])";
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>(selector) ?? []);
    focusable()[0]?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setActiveKey(null);
        return;
      }
      if (event.key !== "Tab") return;
      const controls = focusable();
      if (!controls.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      returnFocusRef.current?.focus();
    };
  }, [activeGroup]);

  async function revert(id: number) {
    setBusyId(id);
    try {
      const res = await api.revertHistory(id);
      toast.push(res.ok ? "success" : "error", res.message);
      if (res.ok) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["apply-history-global", serverId] }),
          queryClient.invalidateQueries({ queryKey: ["item-detail", serverId] }),
          queryClient.invalidateQueries({ queryKey: ["items", serverId] }),
        ]);
        setActiveKey(null);
      }
    } catch (e) {
      toast.push("error", (e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  if (serversLoading) return <Spinner label="Loading…" />;

  if (!selectedServer) {
    return (
      <div className="grid h-full place-items-center p-8">
        <EmptyState title="No media server yet">
          Add your Plex, Jellyfin, or Emby server in Settings to start browsing your libraries.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 pb-4 pt-4 sm:px-6 sm:pb-5 sm:pt-5 lg:px-8 lg:pt-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold">
              <HistoryIcon className="size-6 text-accent" /> History
            </h1>
            <p className="text-sm text-faint">
              Everything applied to {selectedServer.name}, most recent first — revert any of them
              in one click. Up to {settingsQ.data?.max_entries ?? 50} entries are kept.
            </p>
          </div>

          <div className="flex w-full flex-wrap items-end gap-2 xl:w-auto">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">Keep up to (entries)</span>
              <input
                type="number"
                min={1}
                value={maxEntriesInput}
                onChange={(e) => setMaxEntriesInput(e.target.value)}
                placeholder="50"
                className="w-28 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-accent"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">
                Auto-purge after (days, 0 = off)
              </span>
              <input
                type="number"
                min={0}
                value={purgeDaysInput}
                onChange={(e) => setPurgeDaysInput(e.target.value)}
                placeholder="0"
                className="w-32 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-accent"
              />
            </label>
            <button
              onClick={() => saveSettingsMut.mutate()}
              disabled={saveSettingsMut.isPending}
              className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-black transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {saveSettingsMut.isPending && <Loader2 className="size-4 animate-spin" />}
              Save
            </button>
            <button
              onClick={purgeNow}
              disabled={purging}
              title="Purge now, using the days value above (0 purges everything)"
              className="flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:border-danger hover:text-danger disabled:opacity-50"
            >
              {purging ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
              Purge now
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-5 sm:px-6 lg:px-8 lg:py-6">
        {q.isLoading && <Spinner label="Loading history…" />}
        {q.isError && <EmptyState title="Couldn't load history">{(q.error as Error).message}</EmptyState>}
        {q.data && entries.length === 0 && (
          <EmptyState title="Nothing applied yet">
            Apply a poster, background, or logo to a title and it'll show up here.
          </EmptyState>
        )}

        {groups.length > 0 && (
          <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(125px,1fr))] sm:gap-5 sm:[grid-template-columns:repeat(auto-fill,minmax(150px,1fr))]">
            {groups.map((group) => {
              const current = group[0];
              const key = `${current.item_id}:${current.target}`;
              return (
                <button key={key} onClick={() => setActiveKey(key)} className="group select-none text-left">
                  <div
                    className={`relative overflow-hidden rounded-xl bg-surface-2 ring-1 ring-white/5 transition-all duration-150 group-hover:-translate-y-1 group-hover:ring-2 group-hover:ring-accent ${
                      current.target === "poster" ? "aspect-[2/3]" : "aspect-video"
                    }`}
                  >
                    <img src={current.thumb_url} alt="" loading="lazy" className="h-full w-full object-cover" />
                    {group.length > 1 && (
                      <span className="absolute right-2 top-2 grid min-w-6 place-items-center rounded-full bg-accent px-1.5 py-0.5 text-xs font-bold text-black shadow">
                        {group.length}
                      </span>
                    )}
                  </div>
                  <div className="mt-2 px-0.5">
                    <p className="truncate text-sm font-medium text-white/90">
                      {current.item_title || current.item_id}
                    </p>
                    <p className="truncate text-xs text-faint">
                      {TARGET_LABEL[current.target] ?? current.target} · {relativeTime(current.applied_at)}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Version picker: opened by clicking a tile above. */}
      {activeGroup && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setActiveKey(null)}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="history-dialog-title"
            className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl border border-border bg-surface p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 id="history-dialog-title" className="truncate text-lg font-semibold">
                  {activeGroup[0].item_title || activeGroup[0].item_id}
                </h2>
                <p className="text-xs text-faint">
                  {TARGET_LABEL[activeGroup[0].target] ?? activeGroup[0].target} history
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  onClick={() => navigate(`/server/${activeGroup[0].server_id}/item/${activeGroup[0].item_id}`)}
                  className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:text-white"
                >
                  Open title
                </button>
                <button
                  onClick={() => setActiveKey(null)}
                  className="grid size-8 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:text-white"
                  aria-label="Close"
                >
                  <X className="size-4" />
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {activeGroup.map((e, i) => (
                <div key={e.id} className="rounded-lg border border-border bg-surface-2 p-2">
                  <div
                    className={`overflow-hidden rounded bg-base ${
                      e.target === "poster" ? "aspect-[2/3]" : "aspect-video"
                    }`}
                  >
                    <img src={e.thumb_url} alt="" className="h-full w-full object-cover" />
                  </div>
                  <p className="mt-1.5 truncate text-[11px] text-faint">{providerLabel(e.provider)}</p>
                  <p className="truncate text-[10px] text-faint">{relativeTime(e.applied_at)}</p>
                  {i === 0 ? (
                    <span className="mt-1 block rounded bg-accent/15 px-1.5 py-0.5 text-center text-[10px] font-medium text-accent">
                      Current
                    </span>
                  ) : (
                    <button
                      onClick={() => revert(e.id)}
                      disabled={busyId === e.id}
                      className="mt-1 flex w-full items-center justify-center gap-1 rounded bg-elevated px-1.5 py-1 text-[11px] font-medium text-muted transition-colors hover:text-white disabled:opacity-60"
                    >
                      {busyId === e.id ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <RotateCcw className="size-3" />
                      )}
                      Revert
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
