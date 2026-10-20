import AnimatedArtwork from "./AnimatedArtwork";
import { useContext, useEffect, useMemo, useState } from "react";
import { AuthSessionContext } from "../lib/authContext";
import { LibraryBackdrop } from "../lib/libraryNavigation";
import { backdropOverlayGradients } from "../lib/dashboardSettings";

function nextUrl(urls: string[], current?: string): string | undefined {
  const choices = urls.filter(url => url !== current);
  return choices[Math.floor(Math.random() * choices.length)];
}

function BackdropLayers({
  urls,
  className,
  source,
  onSelected,
  initialUrl,
}: {
  urls: string[];
  className: string;
  source: "mobile" | "desktop";
  onSelected?: (url: string) => void;
  initialUrl?: string;
}) {
  const [layers, setLayers] = useState(() => {
    const current = initialUrl && urls.includes(initialUrl) ? initialUrl : nextUrl(urls);
    return { current, next: nextUrl(urls, current), previous: undefined as string | undefined };
  });

  const [ready, setReady] = useState<Set<string>>(() => new Set());
  const [failed, setFailed] = useState<Set<string>>(() => new Set());
  const usable = urls.filter(url => !failed.has(url));
  const usableKey = JSON.stringify(usable);
  useEffect(() => {
    setLayers(current => {
      const available: string[] = JSON.parse(usableKey);
      const selected = current.current && available.includes(current.current) ? current.current : nextUrl(available);
      const next = current.previous ? undefined : current.next && current.next !== selected && available.includes(current.next) ? current.next : nextUrl(available, selected);
      if (selected === current.current && next === current.next) return current;
      return { current: selected, next, previous: current.previous };
    });
  }, [usableKey, layers.previous]);

  const currentReady = !!layers.current && ready.has(layers.current);
  const nextReady = !!layers.next && ready.has(layers.next);
  useEffect(() => {
    if (currentReady && layers.current) onSelected?.(layers.current);
  }, [currentReady, layers.current, onSelected]);
  useEffect(() => {
    if (!currentReady || !nextReady || layers.previous) return;
    const timer = window.setTimeout(() => {
      setLayers(current => ({ current: current.next, next: undefined, previous: current.current }));
    }, 12000);
    return () => window.clearTimeout(timer);
  }, [layers.current, layers.next, layers.previous, currentReady, nextReady]);

  useEffect(() => {
    if (!layers.previous) return;
    const timer = window.setTimeout(() => {
      setLayers(current => ({ ...current, previous: undefined }));
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [layers.previous]);

  return (
    <div className={className} data-backdrop-source={source}>
      {[...new Set([layers.previous, layers.current, layers.next].filter((url): url is string => !!url))].map(url => (
        <AnimatedArtwork
          key={url}
          src={url}
          width={source === "mobile" ? 640 : 1920}
          fill
          active={url === layers.current && ready.has(url)}
          onReady={() => setReady(current => current.has(url) ? current : new Set([...current, url]))}
          onError={() => setFailed(current => current.has(url) ? current : new Set([...current, url]))}
          alt=""
          className={`absolute inset-0 h-full w-full object-cover object-top ${layers.previous ? "transition-opacity duration-[2000ms] ease-in-out" : ""} ${url === layers.current && ready.has(url) ? "opacity-100" : "opacity-0"}`}
        />
      ))}
    </div>
  );
}

export default function DashboardBackdrop({
  desktopUrls,
  mobileUrls,
  overlayStrength,
  cacheKey,
  loading = false,
  allowedLibraryIds,
}: {
  desktopUrls: string[];
  mobileUrls: string[];
  overlayStrength: number;
  cacheKey?: string;
  loading?: boolean;
  allowedLibraryIds?: string[];
}) {
  const user = useContext(AuthSessionContext)?.user;
  const gradients = backdropOverlayGradients(overlayStrength);
  const [desktop, setDesktop] = useState(() => window.matchMedia("(min-width: 768px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 768px)");
    const update = () => setDesktop(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const storageKey = cacheKey ? `posterview.backdrop:${user ? `${user.id}:${user.revision}` : "server"}:${cacheKey}:${desktop ? "desktop" : "mobile"}` : undefined;
  const cached = useMemo(() => {
    try { return storageKey ? sessionStorage.getItem(storageKey) : null; } catch { return null; }
  }, [storageKey]);
  const cachedLibrary = cached?.match(/^\/api\/native\/libraries\/([^/]+)\/items\/[^/]+\/artwork\/(?:backdrop|fanart)(?:\?|$)/)?.[1];
  const permitted = cachedLibrary && (!allowedLibraryIds || allowedLibraryIds.includes(cachedLibrary)) &&
    (!user || user.role === "admin" || user.permissions.all_libraries || user.permissions.library_ids.includes(cachedLibrary));
  const urlKey = JSON.stringify([...new Set([...(loading && permitted && cached ? [cached] : []), ...(desktop ? desktopUrls : mobileUrls)])]);
  const urls = useMemo<string[]>(() => JSON.parse(urlKey), [urlKey]);
  // Keep the collection stable during ordinary parent renders, and restart rotation
  // only when the viewport source changes; library arrivals retain the selection.
  const sourceKey = storageKey ?? (desktop ? "desktop" : "mobile");
  return (
    <LibraryBackdrop>
      <div
        className="pointer-events-none fixed inset-0 z-0"
        aria-hidden="true"
        data-testid="dashboard-backdrop"
      >
        {urls.length > 0 && (
          <BackdropLayers
            key={sourceKey}
            urls={urls}
            className="absolute inset-0"
            source={desktop ? "desktop" : "mobile"}
            initialUrl={permitted && cached ? cached : undefined}
            onSelected={url => { if (storageKey) { try { sessionStorage.setItem(storageKey, url); } catch { /* Storage is optional. */ } } }}
          />
        )}
        <div
          className="absolute inset-0 md:hidden"
          style={{ backgroundImage: gradients.mobile }}
        />
        <div
          className="absolute inset-0 hidden md:block"
          style={{ backgroundImage: gradients.desktop }}
        />
      </div>
    </LibraryBackdrop>
  );
}
