import { useCallback, useMemo, useRef, useState } from "react";
import { createSearchParams, matchPath, type NavigateFunction, type NavigateOptions, type To, type SetURLSearchParams } from "react-router-dom";
import { ArrowLeft, Home, X } from "lucide-react";
import { LibraryNavigationContext } from "../lib/libraryNavigation";
import MediaLibraryPage from "../pages/MediaLibraryPage";
import ItemDetailPage from "../pages/ItemDetailPage";
import SeasonDetailPage from "../pages/SeasonDetailPage";

export default function AppearancePreview({ onClose }: { onClose: () => void }) {
  const [history, setHistory] = useState({ entries: ["/"], index: 0 });
  const location = history.entries[history.index];
  const url = useMemo(() => new URL(location, "http://preview.local"), [location]);
  const item = matchPath("/server/:serverId/item/:itemId", url.pathname);
  const season = matchPath("/server/:serverId/series/:seriesId/season/:seasonId", url.pathname);
  const navigate: NavigateFunction = useCallback((to: To | number, options?: NavigateOptions) => {
    setHistory(previous => {
      if (typeof to === "number") return { ...previous, index: Math.max(0, Math.min(previous.entries.length - 1, previous.index + to)) };
      const destination = typeof to === "string" ? to : `${to.pathname ?? url.pathname}${to.search ?? ""}${to.hash ?? ""}`;
      if (options?.replace) return { ...previous, entries: previous.entries.map((entry, index) => index === previous.index ? destination : entry) };
      return { entries: [...previous.entries.slice(0, previous.index + 1), destination], index: previous.index + 1 };
    });
  }, [url.pathname]);
  const setSearchParams = useCallback<SetURLSearchParams>((next, options) => {
    const params = createSearchParams(typeof next === "function" ? next(new URLSearchParams(url.search)) : next);
    void navigate(`${url.pathname}?${params}`, options);
  }, [navigate, url]);
  const navigation = { navigate, params: (season ?? item)?.params ?? {}, searchParams: url.searchParams, setSearchParams };
  const libraryNavigation = useRef(navigation);
  if (url.pathname === "/") libraryNavigation.current = navigation;

  return <section aria-label="Live Media Library preview" className="flex h-full min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-base">
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-3 py-2">
      <button type="button" aria-label="Back in preview" disabled={history.index === 0} onClick={() => navigate(-1)} className="rounded-lg p-2 hover:bg-surface-2 disabled:opacity-40"><ArrowLeft className="size-4" /></button>
      <button type="button" aria-label="Preview library home" onClick={() => navigate("/")} className="rounded-lg p-2 hover:bg-surface-2"><Home className="size-4" /></button>
      <span className="min-w-0 flex-1 text-sm font-semibold">Live Preview</span>
      <button type="button" aria-label="Close split view" onClick={onClose} className="rounded-lg p-2 hover:bg-surface-2"><X className="size-4" /></button>
    </div>
    <div className="appearance-preview @container/library relative isolate min-h-0 flex-1 overflow-hidden [contain:layout_paint]">
      <div className="h-full" hidden={url.pathname !== "/"}>
        <LibraryNavigationContext.Provider value={libraryNavigation.current}><MediaLibraryPage /></LibraryNavigationContext.Provider>
      </div>
      <LibraryNavigationContext.Provider value={navigation}>
        {url.pathname === "/" ? null : season ? <SeasonDetailPage /> : item ? <ItemDetailPage /> : <div className="p-6 text-sm text-muted">This page is available outside the preview. Use Back or Library Home to continue previewing.</div>}
      </LibraryNavigationContext.Provider>
    </div>
  </section>;
}
