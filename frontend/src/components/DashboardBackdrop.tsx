import AnimatedArtwork from "./AnimatedArtwork";
import { useEffect, useMemo, useState } from "react";
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
}: {
  urls: string[];
  className: string;
  source: "mobile" | "desktop";
}) {
  const [layers, setLayers] = useState(() => {
    const current = nextUrl(urls);
    return { current, next: nextUrl(urls, current), previous: undefined as string | undefined };
  });

  useEffect(() => {
    if (urls.length < 2) return;
    const interval = window.setInterval(() => {
      setLayers(current => ({ current: current.next ?? nextUrl(urls, current.current), next: undefined, previous: current.current }));
    }, 12000);
    return () => window.clearInterval(interval);
    // The parent keys this rotation by its source URLs, so its collection stays fixed.
  }, [urls]);

  useEffect(() => {
    if (!layers.previous) return;
    const timer = window.setTimeout(() => {
      setLayers(current => ({ ...current, previous: undefined, next: nextUrl(urls, current.current) }));
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [layers.previous, urls]);

  return (
    <div className={className} data-backdrop-source={source}>
      {urls.filter(url => url === layers.current || url === layers.next || url === layers.previous).map(url => (
        <AnimatedArtwork
          key={url}
          src={url}
          width={source === "mobile" ? 640 : 1920}
          fill
          active={url === layers.current}
          alt=""
          className={`absolute inset-0 h-full w-full object-cover object-top transition-opacity duration-[2000ms] ease-in-out ${url === layers.current ? "opacity-100" : "opacity-0"}`}
        />
      ))}
    </div>
  );
}

export default function DashboardBackdrop({
  desktopUrls,
  mobileUrls,
  overlayStrength,
}: {
  desktopUrls: string[];
  mobileUrls: string[];
  overlayStrength: number;
}) {
  const gradients = backdropOverlayGradients(overlayStrength);
  const [desktop, setDesktop] = useState(() => window.matchMedia("(min-width: 768px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 768px)");
    const update = () => setDesktop(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const urlKey = JSON.stringify([...new Set(desktop ? desktopUrls : mobileUrls)]);
  const urls = useMemo<string[]>(() => JSON.parse(urlKey), [urlKey]);
  // Keep the collection stable during ordinary parent renders, and restart rotation
  // when the artwork collection or viewport source changes.
  const sourceKey = `${desktop ? "desktop" : "mobile"}:${JSON.stringify(urls)}`;
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
