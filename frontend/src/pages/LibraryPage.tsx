// Browse the active server: pick a library, then a searchable grid of titles.
// Double-clicking a poster opens the item detail.

import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, ServerCrash, Sparkles } from "lucide-react";
import { api, imageUrl } from "../api/client";
import { useServers } from "../lib/serverContext";
import PosterCard from "../components/PosterCard";
import { EmptyState, Spinner } from "../components/ui";
import { useToast } from "../lib/toast";

const GROUP_COLLECTIONS_KEY = "posterview.groupCollections";
const LAST_VISIT_PREFIX = "posterview.lastVisit.";

export default function LibraryPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { selectedServer, isLoading: serversLoading } = useServers();
  const serverId = selectedServer?.id ?? null;

  // The selected library lives in the URL (?lib=…) so that navigating into a
  // title and pressing Back returns you to the same library, not the first one.
  const [searchParams, setSearchParams] = useSearchParams();
  const libraryId = searchParams.get("lib");
  const [filter, setFilter] = useState("");
  const [refreshingId, setRefreshingId] = useState<string | null>(null);

  const refreshMut = useMutation({
    mutationFn: ({ itemId }: { itemId: string }) => api.refreshArtworkItem(serverId!, itemId),
    onMutate: ({ itemId }) => setRefreshingId(itemId),
    onSuccess: (result, { itemId }) => {
      queryClient.removeQueries({ queryKey: ["artwork"], predicate: (query) => query.queryKey.includes(itemId) });
      queryClient.invalidateQueries({ queryKey: ["artwork-cache"] });
      toast.push(result.ok ? "success" : "error", result.message);
    },
    onError: (error: Error) => toast.push("error", error.message),
    onSettled: () => setRefreshingId(null),
  });

  // Whether a collection's member movies/shows are replaced by a single
  // collection tile (Emby/Jellyfin only — Plex ignores this server-side for
  // now). Persisted since resetting on every navigation would be annoying.
  const [groupCollections, setGroupCollections] = useState(
    () => localStorage.getItem(GROUP_COLLECTIONS_KEY) !== "false",
  );
  const toggleGroupCollections = () =>
    setGroupCollections((v) => {
      const next = !v;
      localStorage.setItem(GROUP_COLLECTIONS_KEY, String(next));
      return next;
    });

  const selectLibrary = (id: string) =>
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.set("lib", id);
        return p;
      },
      { replace: true },
    );

  const librariesQ = useQuery({
    queryKey: ["libraries", serverId],
    queryFn: () => api.getLibraries(serverId!),
    enabled: serverId != null,
  });

  // Default to the first browseable library, or reset if the URL points at a
  // library that doesn't exist on the current server (e.g. after switching).
  useEffect(() => {
    const libs = librariesQ.data;
    if (!libs) return;
    const browseable = libs.filter((l) => l.type !== "other");
    if (!browseable.length) return;
    const valid = libraryId != null && libs.some((l) => l.id === libraryId);
    if (!valid) selectLibrary(browseable[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [librariesQ.data, libraryId]);

  const itemsQ = useQuery({
    queryKey: ["items", serverId, libraryId, groupCollections],
    queryFn: () => api.getItems(serverId!, libraryId!, groupCollections),
    enabled: serverId != null && libraryId != null,
  });

  const items = useMemo(() => {
    const all = itemsQ.data ?? [];
    const q = filter.trim().toLowerCase();
    return q ? all.filter((i) => i.title.toLowerCase().includes(q)) : all;
  }, [itemsQ.data, filter]);

  // "Since last visit": read the stored timestamp for this library BEFORE
  // overwriting it with now, so this render can still flag anything added
  // since that prior visit. No stored value (first-ever visit) means there's
  // nothing to compare against, so nothing gets flagged — not "everything."
  const [sinceTimestamp, setSinceTimestamp] = useState<number | null>(null);
  useEffect(() => {
    if (serverId == null || libraryId == null) return;
    const key = `${LAST_VISIT_PREFIX}${serverId}.${libraryId}`;
    const stored = localStorage.getItem(key);
    setSinceTimestamp(stored ? Number(stored) : null);
    localStorage.setItem(key, String(Date.now()));
  }, [serverId, libraryId]);

  const newMissingIds = useMemo(() => {
    const ids = new Set<string>();
    if (sinceTimestamp == null) return ids;
    for (const item of itemsQ.data ?? []) {
      if (item.poster || !item.added_at) continue;
      const added = Date.parse(item.added_at);
      if (!Number.isNaN(added) && added > sinceTimestamp) ids.add(item.id);
    }
    return ids;
  }, [itemsQ.data, sinceTimestamp]);

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

  const browseableLibs = (librariesQ.data ?? []).filter((l) => l.type !== "other");

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-border px-4 pt-4 sm:px-6 sm:pt-5 lg:px-8 lg:pt-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">{selectedServer.name}</h1>
            <p className="text-sm text-faint">Browse your libraries and update artwork</p>
          </div>
          <div className="relative w-full sm:w-auto">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter titles…"
              className="w-full rounded-lg border border-border bg-surface-2 py-2 pl-9 pr-3 text-sm outline-none focus:border-accent sm:w-64"
            />
          </div>
        </div>

        {/* Library tabs */}
        <div className="mt-4 flex flex-col items-stretch gap-3 sm:mt-5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <div className="flex gap-1 overflow-x-auto pb-px">
            {librariesQ.isLoading && <span className="py-2 text-sm text-faint">Loading libraries…</span>}
            {browseableLibs.map((lib) => (
              <button
                key={lib.id}
                onClick={() => selectLibrary(lib.id)}
                className={`whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
                  libraryId === lib.id
                    ? "border-accent text-white"
                    : "border-transparent text-muted hover:text-white"
                }`}
              >
                {lib.title}
              </button>
            ))}
          </div>

          {libraryId !== "collections" && (
            <label className="flex shrink-0 items-center justify-end gap-2 pb-2 text-sm text-muted sm:pb-px">
              Group Collections
              <button
                type="button"
                role="switch"
                aria-checked={groupCollections}
                onClick={toggleGroupCollections}
                title="Replace a collection's movies/shows with a single tile"
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                  groupCollections ? "bg-accent" : "bg-surface-2"
                }`}
              >
                <span
                  className={`inline-block size-4 transform rounded-full bg-white transition-transform ${
                    groupCollections ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </button>
            </label>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 py-5 sm:px-6 lg:px-8 lg:py-6">
        {librariesQ.isError && (
          <EmptyState icon={<ServerCrash className="size-10" />} title="Couldn't reach the server">
            {(librariesQ.error as Error).message}
          </EmptyState>
        )}
        {itemsQ.isLoading && <Spinner label="Loading titles…" />}
        {itemsQ.isError && (
          <EmptyState icon={<ServerCrash className="size-10" />} title="Couldn't load titles">
            {(itemsQ.error as Error).message}
          </EmptyState>
        )}
        {itemsQ.data && items.length === 0 && (
          <EmptyState title={filter ? "No matches" : "This library is empty"} />
        )}

        {newMissingIds.size > 0 && (
          <div className="mb-5 flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/10 px-4 py-2 text-sm text-accent">
            <Sparkles className="size-4 shrink-0" />
            {newMissingIds.size} new title{newMissingIds.size === 1 ? "" : "s"} missing artwork
            since your last visit
          </div>
        )}

        {items.length > 0 && (
          <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(125px,1fr))] sm:gap-5 sm:[grid-template-columns:repeat(auto-fill,minmax(150px,1fr))]">
            {items.map((item) => (
              <PosterCard
                key={item.id}
                image={imageUrl(serverId!, item.poster)}
                title={item.title}
                subtitle={item.year ? String(item.year) : undefined}
                kind={item.type}
                badge={newMissingIds.has(item.id) ? "NEW" : undefined}
                onOpen={() => navigate(`/server/${serverId}/item/${item.id}`)}
                onRefresh={() => refreshMut.mutate({ itemId: item.id })}
                refreshing={refreshingId === item.id}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
