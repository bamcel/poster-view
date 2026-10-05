import SettingsPage from "../pages/SettingsPage";
import ServerSettingsDashboard from "./ServerSettingsDashboard";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createSearchParams, matchPath, type NavigateFunction, type NavigateOptions, type To, type SetURLSearchParams } from "react-router-dom";
import { ArrowLeft, Home, Maximize, X } from "lucide-react";
import Layout from "./Layout";
import { LibraryNavigationContext } from "../lib/libraryNavigation";
import DashboardPage from "../pages/DashboardPage";
import ItemDetailPage from "../pages/ItemDetailPage";
import SeasonDetailPage from "../pages/SeasonDetailPage";

export default function AppearancePreview({ onClose }: { onClose: () => void }) {
  const [fitToWindow, setFitToWindow] = useState(true);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0, screenWidth: window.innerWidth, screenHeight: window.innerHeight });
  useLayoutEffect(() => {
    const viewport = viewportRef.current!;
    const measure = () => setSize({ width: viewport.clientWidth, height: viewport.clientHeight, screenWidth: window.innerWidth, screenHeight: window.innerHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, []);
  const scale = Math.min(1, size.width / Math.max(1, size.screenWidth), size.height / Math.max(1, size.screenHeight));
  const [history, setHistory] = useState({ entries: ["/"], index: 0 });
  const location = history.entries[history.index];
  const url = useMemo(() => new URL(location, "http://preview.local"), [location]);
  const media = matchPath("/media/:libraryId", url.pathname);
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
  const navigation = { navigate, params: (season ?? item ?? media)?.params ?? {}, searchParams: url.searchParams, setSearchParams };
  const libraryNavigation = useRef(navigation);
  const libraryPage = !!media || url.pathname === "/" && url.searchParams.has("native_library");
  if (libraryPage) libraryNavigation.current = navigation;

  return <section aria-label="Live Dashboard preview" className="flex h-full min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-base">
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-3 py-2">
      <button type="button" aria-label="Back in preview" disabled={history.index === 0} onClick={() => navigate(-1)} className="rounded-lg p-2 hover:bg-surface-2 disabled:opacity-40"><ArrowLeft className="size-4" /></button>
      <button type="button" aria-label="Preview library home" onClick={() => navigate("/")} className="rounded-lg p-2 hover:bg-surface-2"><Home className="size-4" /></button>
      <span className="min-w-0 flex-1 text-sm font-semibold">Live Preview</span>
      <button type="button" aria-label="Pane-sized preview" title={fitToWindow ? "Switch to pane-sized preview" : "Fit full desktop layout, including side panels"} aria-pressed={!fitToWindow} onClick={() => setFitToWindow(value => !value)} className={`rounded-lg p-2 hover:bg-surface-2 ${!fitToWindow ? "bg-elevated text-accent" : ""}`}><Maximize className="size-4" /></button>
      <button type="button" aria-label="Close split view" onClick={onClose} className="rounded-lg p-2 hover:bg-surface-2"><X className="size-4" /></button>
    </div>
    <div ref={viewportRef} className="relative min-h-0 flex-1 overflow-hidden">
    <div data-testid="preview-desktop-frame" className={`${fitToWindow ? "" : "appearance-preview"} @container/library relative isolate h-full overflow-hidden [contain:layout_paint]`}
      style={fitToWindow ? { width: size.screenWidth, height: size.screenHeight, transform: `scale(${scale})`, transformOrigin: "top left", left: Math.max(0, (size.width - size.screenWidth * scale) / 2), top: Math.max(0, (size.height - size.screenHeight * scale) / 2) } : undefined}>
      <LibraryNavigationContext.Provider value={navigation}>
      <Layout preview previewPath={url.pathname} showPreviewChrome={fitToWindow}>
      <div className="h-full" hidden={!libraryPage}>
        <LibraryNavigationContext.Provider value={libraryNavigation.current}><DashboardPage /></LibraryNavigationContext.Provider>
      </div>
      <LibraryNavigationContext.Provider value={navigation}>
        {libraryPage ? null : url.pathname === "/" ? <div className="h-full p-6"><h1 className="text-2xl font-semibold">Home</h1></div> : url.pathname === "/settings" ? <ServerSettingsDashboard/> : url.pathname.startsWith("/settings/") ? <SettingsPage previewSection={url.pathname.split("/")[2]}/> : season ? <SeasonDetailPage /> : item ? <ItemDetailPage /> : <div className="p-6 text-sm text-muted">This page is available outside the preview. Use Back or select a Media library to continue previewing.</div>}
      </LibraryNavigationContext.Provider>
      </Layout>
      </LibraryNavigationContext.Provider>
    </div>
    </div>
  </section>;
}
