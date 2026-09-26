// Browse the active server: pick a library, then a searchable grid of titles.
// Double-clicking a poster opens the item detail.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ListFilter, MoreHorizontal, Search, ServerCrash, Sparkles } from "lucide-react";
import { useTrackingOverlays } from "../lib/libraryDisplay";
import { api, imageUrl } from "../api/client";
import { useServers } from "../lib/serverContext";
import PosterCard from "../components/PosterCard";
import LibraryPopup from "../components/LibraryPopup";
import { EmptyState, Spinner, Switch } from "../components/ui";
import { useToast } from "../lib/toast";
import { isBookRelatedLibraryName } from "../lib/mediaKind";
import { BACKDROP_BLUR_EVENT, BACKDROP_OVERLAY_EVENT, DASHBOARD_BACKDROP_EVENT, PANEL_OVERLAY_EVENT, PANEL_SOLIDITY_EVENT, backdropBlur, backdropOverlay, backdropOverlayGradients, dashboardBackdropEnabled, panelOverlay, panelSolidity, translucentPanelColor } from "../lib/dashboardSettings";

const GROUP_COLLECTIONS_KEY = "posterview.groupCollections";
const LAST_VISIT_PREFIX = "posterview.lastVisit.";
const SCROLL_POSITION_PREFIX = "posterview.libraryScroll.";
type ArtworkFilter = "all" | "missing-poster" | "missing-backdrop";
import { useBookInfo, bookTitleOrder } from "../lib/bookInfo";
type TitleSort = "title" | "newest" | "oldest" | "recently-added";

export default function DashboardPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { selectedServer, isLoading: serversLoading } = useServers();
  const serverId = selectedServer?.id ?? null;
  const libraryTabKey = serverId == null ? null : `posterview.libraryTab.${serverId}`;

  // The selected library lives in the URL (?lib=…) so that navigating into a
  // title and pressing Back returns you to the same library, not the first one.
  const [searchParams, setSearchParams] = useSearchParams();
  const libraryId = searchParams.get("lib");
  const folderId = searchParams.get("folder");
  const folderTitle = searchParams.get("folder_title");
  const [filter, setFilter] = useState("");
  const [artworkFilter, setArtworkFilter] = useState<ArtworkFilter>("all");
  const [titleSort, setTitleSort] = useState<TitleSort>("title");
  const [automaticRootId, setAutomaticRootId] = useState<string | null>(null);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [showBackdrop, setShowBackdrop] = useState(dashboardBackdropEnabled);
  const [overlayStrength, setOverlayStrength] = useState(backdropOverlay);
  const [panelSolid, setPanelSolid] = useState(panelSolidity);
  const [panelBlur, setPanelBlur] = useState(backdropBlur);
  const [panelOverlayStrength, setPanelOverlayStrength] = useState(panelOverlay);
  const libraryBodyRef = useRef<HTMLDivElement>(null);
  const [trackingOverlays, setTrackingOverlays, displayStatus] = useTrackingOverlays();
  const restoredScrollKeyRef = useRef<string | null>(null);

  const refreshMut = useMutation({
    mutationFn: ({ itemId }: { itemId: string }) =>
      api.refreshArtworkItem(serverId!, itemId),
    onMutate: ({ itemId }) => setRefreshingId(itemId),
    onSuccess: (result, { itemId }) => {
      queryClient.removeQueries({
        queryKey: ["artwork"],
        predicate: (query) => query.queryKey.includes(itemId),
      });
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

  const selectLibrary = (id: string) => {
    if (libraryTabKey) sessionStorage.setItem(libraryTabKey, id);
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.set("lib", id);
        p.delete("folder");
        p.delete("folder_title");
        return p;
      },
      { replace: true },
    );
  };

  const clearLibrary = () =>
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.delete("lib");
        return p;
      },
      { replace: true },
    );

  const librariesQ = useQuery({
    queryKey: ["libraries", serverId],
    queryFn: () => api.getLibraries(serverId!),
    enabled: serverId != null,
  });
  const selectedLibrary = librariesQ.data?.find(
    (library) => library.id === libraryId,
  );
  const browsesFolders =
    selectedLibrary?.type === "book" ||
    selectedLibrary?.type === "audiobook" ||
    (selectedLibrary?.type === "other" &&
      isBookRelatedLibraryName(selectedLibrary.title));
  const showGroupCollections = libraryId !== "collections" && !browsesFolders;
  const parentId =
    folderId ?? automaticRootId ?? (browsesFolders ? libraryId : null);

  // Default to the first browseable library, or reset if the URL points at a
  // library that doesn't exist on the current server (e.g. after switching).
  useEffect(() => {
    const libs = librariesQ.data;
    if (!libs) return;
    const browseable = libs;
    if (!browseable.length) {
      if (libraryId != null) clearLibrary();
      return;
    }
    const valid =
      libraryId != null && browseable.some((l) => l.id === libraryId);
    if (!valid) {
      const storedLibrary = libraryTabKey ? sessionStorage.getItem(libraryTabKey) : null;
      const fallback = browseable.find((library) => library.id === storedLibrary) ?? browseable[0];
      selectLibrary(fallback.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [librariesQ.data, libraryId, libraryTabKey]);

  const itemsQ = useQuery({
    queryKey: ["items", serverId, libraryId, groupCollections, parentId],
    queryFn: () =>
      api.getItems(
        serverId!,
        libraryId!,
        groupCollections,
        parentId ?? undefined,
      ),
    enabled: serverId != null && libraryId != null,
  });

  // Some servers expose a book library named "Manga" whose only meaningful
  // content is another folder named "manga". Treat that same-name folder as
  // the library root so users land on series instead of traversing a duplicate level.
  useEffect(() => {
    if (
      !browsesFolders ||
      folderId ||
      automaticRootId ||
      !itemsQ.data ||
      !selectedLibrary
    )
      return;
    const sameName = itemsQ.data.find(
      (item) =>
        item.type === "folder" &&
        item.title.localeCompare(selectedLibrary.title, undefined, {
          sensitivity: "accent",
        }) === 0,
    );
    if (sameName) setAutomaticRootId(sameName.id);
  }, [automaticRootId, browsesFolders, folderId, itemsQ.data, selectedLibrary]);

  useEffect(() => setAutomaticRootId(null), [serverId, libraryId]);

  const bookInfo = useBookInfo(serverId, itemsQ.data, browsesFolders);
  const items = useMemo(() => {
    const all = (itemsQ.data ?? []).map(item => ({ ...item, title: bookInfo.data?.[item.id]?.title || item.title }));
    const q = filter.trim().toLowerCase();
    const filtered = all.filter((item) => {
      if (q && !item.title.toLowerCase().includes(q)) return false;
      if (artworkFilter === "missing-poster") return !item.poster;
      if (artworkFilter === "missing-backdrop") return !item.background;
      return true;
    });
    return filtered.sort((a, b) => {
      if (titleSort === "newest") return (b.year ?? -Infinity) - (a.year ?? -Infinity);
      if (titleSort === "oldest") return (a.year ?? Infinity) - (b.year ?? Infinity);
      if (titleSort === "recently-added") {
        return Date.parse(b.added_at ?? "") - Date.parse(a.added_at ?? "") || a.title.localeCompare(b.title);
      }
      return bookTitleOrder(a, b, bookInfo.data ?? {});
    });
  }, [artworkFilter, filter, itemsQ.data, titleSort, bookInfo.data]);

  useEffect(() => {
    const update = (event: Event) => setShowBackdrop((event as CustomEvent<boolean>).detail);
    const updateOverlay = (event: Event) => setOverlayStrength((event as CustomEvent<number>).detail);
    const updateSolidity = (event: Event) => setPanelSolid((event as CustomEvent<number>).detail);
    const updateBlur = (event: Event) => setPanelBlur((event as CustomEvent<number>).detail);
    const updatePanelOverlay = (event: Event) => setPanelOverlayStrength((event as CustomEvent<number>).detail);
    const updateFromStorage = () => setShowBackdrop(dashboardBackdropEnabled());
    window.addEventListener(DASHBOARD_BACKDROP_EVENT, update);
    window.addEventListener(BACKDROP_OVERLAY_EVENT, updateOverlay);
    window.addEventListener(PANEL_SOLIDITY_EVENT, updateSolidity);
    window.addEventListener(BACKDROP_BLUR_EVENT, updateBlur);
    window.addEventListener(PANEL_OVERLAY_EVENT, updatePanelOverlay);
    window.addEventListener("storage", updateFromStorage);
    return () => {
      window.removeEventListener(DASHBOARD_BACKDROP_EVENT, update);
      window.removeEventListener(BACKDROP_OVERLAY_EVENT, updateOverlay);
      window.removeEventListener(PANEL_SOLIDITY_EVENT, updateSolidity);
      window.removeEventListener(BACKDROP_BLUR_EVENT, updateBlur);
      window.removeEventListener(PANEL_OVERLAY_EVENT, updatePanelOverlay);
      window.removeEventListener("storage", updateFromStorage);
    };
  }, []);

  const backdropUrls = useMemo(
    () => Array.from(new Set((itemsQ.data ?? []).map((item) => imageUrl(serverId!, item.background)).filter((url): url is string => Boolean(url)))),
    [itemsQ.data, serverId],
  );
  const posterBackdropUrls = useMemo(
    () => Array.from(new Set((itemsQ.data ?? []).map((item) => imageUrl(serverId!, item.poster)).filter((url): url is string => Boolean(url)))),
    [itemsQ.data, serverId],
  );

  const scrollPositionKey =
    serverId != null && libraryId != null
      ? `${SCROLL_POSITION_PREFIX}${serverId}.${libraryId}.${folderId ?? "root"}`
      : null;

  // Restore only after this browsing context's items render. Tracking the key
  // prevents filters and background query refreshes from moving the user again.
  useLayoutEffect(() => {
    if (
      !scrollPositionKey ||
      !itemsQ.data ||
      restoredScrollKeyRef.current === scrollPositionKey
    )
      return;

    const storedPosition = sessionStorage.getItem(scrollPositionKey);
    const savedPosition = storedPosition == null ? 0 : Number(storedPosition);
    if (Number.isFinite(savedPosition) && libraryBodyRef.current) {
      libraryBodyRef.current.scrollTop = savedPosition;
    }
    restoredScrollKeyRef.current = scrollPositionKey;
  }, [itemsQ.data, scrollPositionKey]);

  const rememberScrollPosition = () => {
    if (scrollPositionKey && libraryBodyRef.current) {
      sessionStorage.setItem(scrollPositionKey, String(libraryBodyRef.current.scrollTop));
    }
  };

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
          Add your Plex, Jellyfin, or Emby server in Settings to start browsing
          your libraries.
        </EmptyState>
      </div>
    );
  }

  const browseableLibs = librariesQ.data ?? [];
  const itemDetailUrl = (itemId: string, editMetadata = false) => {
    const context = new URLSearchParams();
    if (selectedLibrary) {
      context.set("library_type", selectedLibrary.type);
      context.set("library_title", selectedLibrary.title);
    }
    if (libraryId) context.set("return_library", libraryId);
    if (folderId) context.set("return_folder", folderId);
    if (folderTitle) context.set("return_folder_title", folderTitle);
    if (editMetadata) context.set("edit_metadata", "1");
    const query = context.toString();
    return `/server/${serverId}/item/${itemId}${query ? `?${query}` : ""}`;
  };
  const openItem = (item: (typeof items)[number]) => {
    if (item.type !== "folder") {
      navigate(itemDetailUrl(item.id));
      return;
    }
    // A folder whose immediate children are media items is a manga series.
    // Open its detail/artwork page; deeper category folders remain browseable.
    api
      .getItems(serverId!, libraryId!, groupCollections, item.id)
      .then((children) => {
        if (children.some((child) => child.type !== "folder")) {
          navigate(itemDetailUrl(item.id));
        } else {
          setSearchParams((previous) => {
            const next = new URLSearchParams(previous);
            next.set("folder", item.id);
            next.set("folder_title", item.title);
            return next;
          });
        }
      })
      .catch((error: Error) => toast.push("error", error.message));
  };

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      {showBackdrop && (backdropUrls.length > 0 || posterBackdropUrls.length > 0) && (
        <DashboardBackdrop desktopUrls={backdropUrls} mobileUrls={posterBackdropUrls} overlayStrength={overlayStrength} />
      )}
      {/* Header */}
      <div className="relative z-10 border-b border-border px-4 pt-0 sm:px-6 md:pt-[75px] lg:px-8">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3">
          {/* Library tabs */}
          <div className="col-start-1 row-start-1 min-w-0">
            <div role="group" aria-label="Libraries" className="flex gap-1 overflow-x-auto pb-px">
              {librariesQ.isLoading && (
                <span className="py-2 text-sm text-faint">
                  Loading libraries…
                </span>
              )}
              {browseableLibs.map((lib) => (
                <button
                  key={lib.id}
                  title={lib.title}
                  aria-pressed={libraryId === lib.id}
                  onClick={() => selectLibrary(lib.id)}
                  className={`min-h-11 max-w-64 shrink-0 truncate border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
                    libraryId === lib.id
                      ? "border-accent text-white"
                      : "border-transparent text-muted hover:text-white"
                  }`}
                >
                  {lib.title}
                </button>
              ))}
            </div>
          </div>
          {showGroupCollections && (
            <label className="col-start-2 row-start-1 hidden items-center justify-end gap-2 text-sm text-muted md:flex">
              <span className="max-w-20 text-center sm:max-w-none sm:text-left">Group Collections</span>
              <Switch label="Group Collections" checked={groupCollections} onChange={toggleGroupCollections} />
            </label>
          )}
        </div>
      </div>

      <div className="relative z-30 shrink-0 px-4 py-3 sm:px-6 lg:px-8">
        <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3">
          {folderId && (
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="col-start-1 flex min-w-0 items-center gap-2 justify-self-start text-sm text-muted hover:text-white"
            >
              <ArrowLeft className="size-4 shrink-0" />
              <span className="truncate">Back{folderTitle ? ` from ${folderTitle}` : ""}</span>
            </button>
          )}
          <div className="col-start-2 flex items-center gap-2">
          <div className="relative w-[min(21rem,calc(100vw-13rem))]">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="Search titles"
              placeholder="Search titles"
              className="w-full rounded-full border border-border py-2 pl-9 pr-3 text-[16px] font-medium text-muted outline-none placeholder:text-muted focus:border-accent focus:text-white md:text-sm"
              style={{ backgroundColor: translucentPanelColor("--color-surface-2", panelSolid, panelOverlayStrength), backdropFilter: `blur(${panelBlur}px)`, WebkitBackdropFilter: `blur(${panelBlur}px)` }}
            />
          </div>
          <LibraryPopup title="Filter & Sort" label="Filter and sort titles" icon={<ListFilter className="size-4" />} style={{ backgroundColor: translucentPanelColor("--color-surface-2", panelSolid, panelOverlayStrength), backdropFilter: `blur(${panelBlur}px)` }}>
              <label className="block text-xs font-semibold text-muted">
                Artwork
                <select
                  aria-label="Filter by artwork"
                  value={artworkFilter}
                  onChange={(event) => setArtworkFilter(event.target.value as ArtworkFilter)}
                  className="mt-2 h-10 w-full rounded-lg border border-border bg-input px-3 text-sm font-normal text-white outline-none focus:border-accent"
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
                  value={titleSort}
                  onChange={(event) => setTitleSort(event.target.value as TitleSort)}
                  className="mt-2 h-10 w-full rounded-lg border border-border bg-input px-3 text-sm font-normal text-white outline-none focus:border-accent"
                >
                  <option value="title">Title A–Z</option>
                  <option value="newest">Newest year</option>
                  <option value="oldest">Oldest year</option>
                  <option value="recently-added">Recently added</option>
                </select>
              </label>
              {showGroupCollections && (
                <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-3">
                  <span className="text-sm font-medium text-muted">Group Collections</span>
                  <Switch label="Group Collections filter" checked={groupCollections} onChange={toggleGroupCollections} />
                </div>
              )}
          </LibraryPopup>
          <LibraryPopup title="Preferences" label="Library preferences" icon={<MoreHorizontal className="size-4" />}>
              {browsesFolders ? <>
                <div className="mt-4 flex items-center justify-between gap-3">
                  <span className="text-sm text-muted">Tracking Overlays</span>
                  <Switch label="Show tracking overlays" checked={trackingOverlays} onChange={() => { if (!displayStatus.busy) setTrackingOverlays(!trackingOverlays); }} />
                </div>
                <p className="mt-2 text-xs text-faint">Show New, Reading, and Finished badges in book libraries. Saved on PosterView for your account across browsers and devices; reading progress is still saved.</p>
                <form key={`${displayStatus.readingThreshold}:${displayStatus.finishedThreshold}`} className="mt-6 space-y-4 border-t border-border pt-4" onSubmit={event => {
                  event.preventDefault();
                  const values = new FormData(event.currentTarget);
                  displayStatus.saveThresholds(Number(values.get("reading")), Number(values.get("finished")));
                }}>
                  <label className="block text-sm text-muted">Reading Starts At (%)<input name="reading" type="number" required min="0" max="99" step="1" defaultValue={displayStatus.readingThreshold} className="mt-2 w-full rounded-lg border border-border bg-input p-3 text-white" /></label>
                  <label className="block text-sm text-muted">Finished Starts At (%)<input name="finished" type="number" required min="1" max="100" step="1" defaultValue={displayStatus.finishedThreshold} className="mt-2 w-full rounded-lg border border-border bg-input p-3 text-white" /></label>
                  <p className="text-xs text-faint">Below Reading: no progress badge. At or above Finished: automatically finished. A series is finished when all its volumes are finished.</p>
                  <button type="submit" disabled={displayStatus.busy} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-black disabled:opacity-50">Save Thresholds</button>
                </form>
                {displayStatus.error && <p role="alert" className="mt-2 text-xs text-muted">{displayStatus.error}</p>}
              </> : <p className="mt-3 text-xs text-muted">No display options for this library type yet.</p>}
          </LibraryPopup>
          </div>
        </div>
      </div>

      {/* Body */}
      <div
        ref={libraryBodyRef}
        onScroll={rememberScrollPosition}
        className="scrollbar-hidden relative z-10 flex-1 overflow-y-auto px-4 py-5 sm:px-6 lg:px-8 lg:py-6"
      >
        {librariesQ.isError && (
          <EmptyState
            icon={<ServerCrash className="size-10" />}
            title="Couldn't reach the server"
          >
            {(librariesQ.error as Error).message}
          </EmptyState>
        )}
        {librariesQ.data && browseableLibs.length === 0 && (
          <EmptyState title="No libraries are shown">
            Choose which libraries to display in Settings → Server.
          </EmptyState>
        )}
        {itemsQ.isLoading && <Spinner label="Loading titles…" />}
        {itemsQ.isError && (
          <EmptyState
            icon={<ServerCrash className="size-10" />}
            title="Couldn't load titles"
          >
            {(itemsQ.error as Error).message}
          </EmptyState>
        )}
        {itemsQ.data && items.length === 0 && (
          <EmptyState title={filter ? "No matches" : "This library is empty"} />
        )}

        {newMissingIds.size > 0 && (
          <div className="mb-5 flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/10 px-4 py-2 text-sm text-accent">
            <Sparkles className="size-4 shrink-0" />
            {newMissingIds.size} new title{newMissingIds.size === 1 ? "" : "s"}{" "}
            missing artwork since your last visit
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
                badge={browsesFolders && !trackingOverlays ? undefined : bookInfo.data?.[item.id]?.status ?? (newMissingIds.has(item.id) ? "NEW" : undefined)}
                onOpen={() => openItem(item)}
                onRefresh={() => refreshMut.mutate({ itemId: item.id })}
                onEditMetadata={() => navigate(itemDetailUrl(item.id, true))}
                refreshing={refreshingId === item.id}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function BackdropLayers({ urls, className, source }: { urls: string[]; className: string; source: "mobile" | "desktop" }) {
  const [activeIndex, setActiveIndex] = useState(() => Math.floor(Math.random() * urls.length));

  useEffect(() => {
    setActiveIndex(Math.floor(Math.random() * urls.length));
    if (urls.length < 2) return;
    const interval = window.setInterval(() => {
      setActiveIndex((current) => {
        const offset = 1 + Math.floor(Math.random() * (urls.length - 1));
        return (current + offset) % urls.length;
      });
    }, 12000);
    return () => window.clearInterval(interval);
  }, [urls]);

  return (
    <div className={className} data-backdrop-source={source}>
      {urls.map((url, index) => (
        <img
          key={url}
          src={url}
          alt=""
          aria-hidden="true"
          draggable={false}
          className={`absolute inset-0 h-full w-full object-cover object-top transition-opacity duration-[2000ms] ease-in-out ${index === activeIndex ? "opacity-100" : "opacity-0"}`}
        />
      ))}
    </div>
  );
}

function DashboardBackdrop({ desktopUrls, mobileUrls, overlayStrength }: { desktopUrls: string[]; mobileUrls: string[]; overlayStrength: number }) {
  const gradients = backdropOverlayGradients(overlayStrength);
  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-0" aria-hidden="true" data-testid="dashboard-backdrop">
      {mobileUrls.length > 0 && <BackdropLayers urls={mobileUrls} className="absolute inset-0 md:hidden" source="mobile" />}
      {desktopUrls.length > 0 && <BackdropLayers urls={desktopUrls} className="absolute inset-0 hidden md:block" source="desktop" />}
      <div className="absolute inset-0 md:hidden" style={{ backgroundImage: gradients.mobile }} />
      <div className="absolute inset-0 hidden md:block" style={{ backgroundImage: gradients.desktop }} />
    </div>,
    document.body,
  );
}
